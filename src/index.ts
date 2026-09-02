import http from 'http';
import WebSocket, { WebSocketServer } from "ws"
import env from "env-var";
import { makeConfigFromParams, setConfigFor, logDeviceConfig } from "./config.js";
import { broadcaster, ensureDeviceAsync, cleanupIdleAsync, getDevicesSnapshot, captureDevicePngAsync } from './deviceManager.js';
import { InputRouter } from "./inputRouter.js";
import { bootstrapAsync } from './browser.js';
import { MsgType, parseFrameAckPacket } from './protocol.js';

const SERVER_VERSION = process.env.npm_package_version ?? "1.1.20";
const WS_PORT = env.get("WS_PORT").default("8081").asIntPositive();
const HEALTH_PORT = env.get("HEALTH_PORT").default("18080").asIntPositive();
// WebSocket-level heartbeat. A peer that does not answer a ping within one
// interval is terminated so a dead ESP (reboot, WiFi drop, power cut) does
// not linger as an OPEN socket whose kernel send buffer we keep filling.
const WS_HEARTBEAT_MS = env.get("WS_HEARTBEAT_MS").default("15000").asIntPositive();

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
        if (fid !== null) broadcaster.handleFrameAck(id, fid);
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

http.createServer(async (_req, res) => {
  try {
    res.writeHead(200); res.end('ok');
  } catch (e) {
    res.writeHead(500); res.end('err');
  }
}).listen(HEALTH_PORT);

setInterval(() => cleanupIdleAsync(), 60_000);

wsHttp.listen(WS_PORT, () => console.log(`[server] WebSocket listening on :${WS_PORT} (GET /stats for status)`));
