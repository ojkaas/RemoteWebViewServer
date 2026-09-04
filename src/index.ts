import http from 'http';
import WebSocket, { WebSocketServer } from "ws"
import env from "env-var";
import { makeConfigFromParams, setConfigFor, logDeviceConfig } from "./config.js";
import { broadcaster, ensureDeviceAsync, cleanupIdleAsync, getDevicesSnapshot, captureDevicePngAsync, livenessAsync, reloadAllDevicesAsync, probeGpuAsync, getGpuInfo, blankRecoveryAsync } from './deviceManager.js';
import { InputRouter } from "./inputRouter.js";
import { bootstrapAsync } from './browser.js';
import { MsgType, parseFrameAckPacket } from './protocol.js';

const SERVER_VERSION = process.env.npm_package_version ?? "1.1.28";
const WS_PORT = env.get("WS_PORT").default("8081").asIntPositive();
const HEALTH_PORT = env.get("HEALTH_PORT").default("18080").asIntPositive();
// WebSocket-level heartbeat. A peer that does not answer a ping within one
// interval is terminated so a dead ESP (reboot, WiFi drop, power cut) does
// not linger as an OPEN socket whose kernel send buffer we keep filling.
const WS_HEARTBEAT_MS = env.get("WS_HEARTBEAT_MS").default("15000").asIntPositive();
// Liveness watchdog: after this many consecutive failed checks (30 s apart)
// the process exits so Docker's restart policy brings up a fresh Chromium.
const WATCHDOG_FAILS_TO_EXIT = env.get("WATCHDOG_FAILS_TO_EXIT").default("3").asIntPositive();
// Daily page reload (local time HH:MM) against SPA memory growth; empty disables.
const PAGE_RELOAD_AT = env.get("PAGE_RELOAD_AT").default("04:00").asString();

type AliveWebSocket = WebSocket & { isAlive?: boolean };

const startedAt = Date.now();

// Plain HTTP on the WebSocket port: GET /stats (JSON) for closed-loop
// testing and monitoring, everything else is a WebSocket upgrade.
const wsHttp = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && path === '/screenshot') {
    // GET /screenshot?id=<device id> -> PNG of the page as Chromium renders it
    const id = new URL(req.url || '/', 'http://x').searchParams.get('id') || getDevicesSnapshot()[0]?.id;
    if (!id) { res.writeHead(404); res.end('no device'); return; }
    captureDevicePngAsync(id).then(png => {
      if (!png) { res.writeHead(404); res.end('unknown device'); return; }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(png);
    }).catch(e => { res.writeHead(500); res.end(String((e as Error).message)); });
    return;
  }
  if (req.method === 'GET' && (path === '/stats' || path === '/stats/')) {
    const body = JSON.stringify({
      version: SERVER_VERSION,
      uptimeMs: Date.now() - startedAt,
      wsClients: wss.clients.size,
      chromeArgsPreset: process.env.CHROME_ARGS_PRESET ?? process.env.CHROME_ARGS_PRESET_BUILD ?? 'default',
      gpu: getGpuInfo() ?? null,
      pageReloadAt: PAGE_RELOAD_AT || null,
      quantize565: !/^(0|false|no|off)$/i.test(process.env.QUANTIZE_565 ?? '1'),
      devices: getDevicesSnapshot(),
    }, null, 2);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  res.writeHead(426, { 'content-type': 'text/plain' });
  res.end('WebSocket endpoint; GET /stats for status');
});
const wss = new WebSocketServer({ server: wsHttp, perMessageDeflate: false });
const inputRouter = new InputRouter();

await bootstrapAsync();

wss.on("connection", async (ws: AliveWebSocket, req) => {
  const url = new URL(req.url || "", `ws://localhost:${WS_PORT}`);
  const id = url.searchParams.get("id") || "default";
  const ackFlowControl = url.searchParams.get("ack") === "1";

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // The ESP sends OpenURL immediately after the handshake, while we are still
  // awaiting device setup below. EventEmitter drops messages that arrive
  // before a listener exists, so buffer them and replay once the device is ready.
  const early: Array<{ msg: WebSocket.RawData; isBinary: boolean }> = [];
  const earlyHandler = (msg: WebSocket.RawData, isBinary: boolean) => { early.push({ msg, isBinary }); };
  ws.on("message", earlyHandler);

  let dev;
  try {
    const cfg = makeConfigFromParams(url.searchParams);
    setConfigFor(id, cfg);
    logDeviceConfig(id, cfg);

    broadcaster.addClient(id, ws, { ack: ackFlowControl });
    dev = await ensureDeviceAsync(id, cfg);
    // after ensureDeviceAsync: a reconfigure deletes the old device and forgets its limit
    broadcaster.setMaxInflight(id, cfg.maxInflight || undefined);
  } catch (e) {
    console.error(`[server] setup failed for ${id}, closing connection: ${(e as Error).message}`);
    ws.off("message", earlyHandler);
    broadcaster.removeClient(id, ws);
    try { ws.close(); } catch { }
    return;
  }

  const device = dev;
  const dispatch = (msg: WebSocket.RawData, isBinary: boolean) => {
    if (!isBinary) return;

    const buf: Buffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as ArrayBuffer);
    if (buf.length === 0) return;
    switch (buf.readUInt8(0)) {
      case MsgType.Touch:
        inputRouter.handleTouchPacketAsync(device, buf).catch(e => console.warn(`Failed to handle touch packet: ${(e as Error).message}`));
        break;
      case MsgType.Keepalive:
        device.lastActive = Date.now();
        break;
      case MsgType.FrameAck: {
        const fid = parseFrameAckPacket(buf);
        if (fid !== null) broadcaster.handleFrameAck(id, fid, ws);
        break;
      }
      case MsgType.FrameStats:
        inputRouter.handleFrameStatsPacketAsync(device, buf).catch(() => console.warn(`Failed to handle Self test packet`));
        break;
      case MsgType.OpenURL:
        inputRouter.handleOpenURLPacketAsync(device, buf).catch(e => console.warn(`Failed to handle OpenURL packet: ${(e as Error).message}`));
        break;
    }
  };

  ws.off("message", earlyHandler);
  ws.on("message", dispatch);
  if (ws.readyState === WebSocket.OPEN) {
    for (const { msg, isBinary } of early) dispatch(msg, isBinary);
  }

  ws.on("close", () => {
    device.lastActive = Date.now();
    broadcaster.removeClient(id, ws);
  })
});

const heartbeat = setInterval(() => {
  for (const client of wss.clients as Set<AliveWebSocket>) {
    if (client.isAlive === false) {
      console.warn(`[server] peer did not answer ping within ${WS_HEARTBEAT_MS}ms, terminating`);
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try { client.ping(); } catch { }
  }
}, WS_HEARTBEAT_MS);
heartbeat.unref();

// Health: 200 only when Chromium answers and every viewed device is alive.
// Docker's healthcheck hits this; the watchdog below turns persistent failure
// into a restart.
http.createServer(async (_req, res) => {
  try {
    const l = await livenessAsync();
    res.writeHead(l.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(l));
  } catch (e) {
    res.writeHead(500); res.end('err');
  }
}).listen(HEALTH_PORT);

let watchdogFails = 0;
setInterval(async () => {
  try {
    const blank = await blankRecoveryAsync();
    if (blank.fatal.length) {
      console.error(`[blank] still white after reloads on ${blank.fatal.join(',')}; exiting so Chromium restarts`);
      setTimeout(() => process.exit(1), 100);
      return;
    }
    const l = await livenessAsync();
    if (l.ok) { watchdogFails = 0; return; }
    // Only a dead/hung Chromium justifies a restart. Stale devices while CDP
    // still answers usually mean the host is starved (observed at load >100
    // during an Android build); restarting then only adds Chromium relaunches
    // to an overloaded box and drops the panels for nothing.
    if (l.cdp) { watchdogFails = 0; console.warn(`[watchdog] stale but CDP alive (host busy?): ${l.stale.join(',')}`); return; }
    watchdogFails++;
    console.error(`[watchdog] unhealthy (${watchdogFails}/${WATCHDOG_FAILS_TO_EXIT}): cdp=${l.cdp} stale=${l.stale.join(',') || '-'}`);
    if (watchdogFails >= WATCHDOG_FAILS_TO_EXIT) {
      console.error('[watchdog] exiting so the container restarts');
      setTimeout(() => process.exit(1), 100);
    }
  } catch { /* ignore */ }
}, 30_000).unref();

let lastReloadDay = '';
if (PAGE_RELOAD_AT) {
  setInterval(async () => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const day = now.toDateString();
    if (hhmm === PAGE_RELOAD_AT && lastReloadDay !== day) {
      lastReloadDay = day;
      const n = await reloadAllDevicesAsync(`scheduled ${PAGE_RELOAD_AT}`);
      console.log(`[maintenance] reloaded ${n} page(s)`);
    }
  }, 30_000).unref();
}

setInterval(() => cleanupIdleAsync(), 60_000);
probeGpuAsync().then(g => console.log(`[cdp] gpu: ${JSON.stringify(g)}`)).catch(() => {});

wsHttp.listen(WS_PORT, () => console.log(`[server] WebSocket listening on :${WS_PORT} (GET /stats for status)`));
