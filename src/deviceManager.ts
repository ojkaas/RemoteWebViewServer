import { CDPSession } from "playwright-core";
import sharp from "sharp";
import { DeviceConfig, deviceConfigsEqual } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { hash32 } from "./util.js";
import { SelfTestRunner } from "./selfTest.js";

export type DeviceSession = {
  id: string;
  deviceId: string;
  cdp: CDPSession;
  cfg: DeviceConfig;
  url: string;
  lastActive: number;
  frameId: number;
  prevFrameHash: number;
  processor: FrameProcessor;
  selfTestRunner: SelfTestRunner

  // trailing throttle state
  pendingB64?: string;
  throttleTimer?: NodeJS.Timeout;
  fallbackTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;
  processing?: boolean;
};

const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');

const devices = new Map<string, DeviceSession>();
let _cleanupRunning = false;
export const broadcaster = new DeviceBroadcaster();

export async function ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  if (device) {
    if (deviceConfigsEqual(device.cfg, cfg)) {
      device.lastActive = Date.now();
      device.processor.requestFullFrame();
      return device;
    } else {
      console.log(`[device] Reconfiguring device ${id}`);
      await deleteDeviceAsync(device);
    }
  }

  const { targetId } = await root.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    width: cfg.width,
    height: cfg.height,
  });

  const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  });
  const session = (root as any).session(sessionId);

  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: cfg.width,
    height: cfg.height,
    deviceScaleFactor: 1,
    mobile: true
  });
  if (PREFERS_REDUCED_MOTION) {
    await session.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  }

  await session.send('Page.startScreencast', {
    format: 'png',
    maxWidth: cfg.width,
    maxHeight: cfg.height,
    everyNthFrame: cfg.everyNthFrame
  });

  const processor = new FrameProcessor({
    tileSize: cfg.tileSize,
    fullframeTileCount: cfg.fullFrameTileCount,
    fullframeAreaThreshold: cfg.fullFrameAreaThreshold,
    jpegQuality: cfg.jpegQuality,
    fullFrameEvery: cfg.fullFrameEvery,
    maxBytesPerMessage: cfg.maxBytesPerMessage,
  });

  const newDevice: DeviceSession = {
    id: targetId,
    deviceId: id,
    cdp: session,
    cfg: cfg,
    url: '',
    lastActive: Date.now(),
    frameId: 0,
    prevFrameHash: 0,
    processor,
    selfTestRunner: new SelfTestRunner(broadcaster),
    pendingB64: undefined,
    throttleTimer: undefined,
    fallbackTimer: undefined,
    lastProcessedMs: undefined,
    processing: false,
  };
  devices.set(id, newDevice);
  newDevice.processor.requestFullFrame();

  let _scFrameCount = 0;
  let _lastScLog = 0;

  const flushPending = async () => {
    const dev = newDevice;
    dev.throttleTimer = undefined;

    // Prevent concurrent processing — re-schedule if busy
    if (dev.processing) {
      console.log(`[diag:${id}] flushPending: busy, rescheduling`);
      if (dev.pendingB64 && !dev.throttleTimer) {
        dev.throttleTimer = setTimeout(flushPending, cfg.minFrameInterval);
      }
      return;
    }

    const b64 = dev.pendingB64;
    dev.pendingB64 = undefined;
    if (!b64) return;

    dev.processing = true;
    const t0 = Date.now();
    try {
      const pngFull = Buffer.from(b64, 'base64');

      const h32 = hash32(pngFull);
      if (dev.prevFrameHash === h32) {
        console.log(`[diag:${id}] flushPending: hash unchanged, skipping (${pngFull.length}B)`);
        dev.lastProcessedMs = Date.now();
        return;
      }
      dev.prevFrameHash = h32;

      let img = sharp(pngFull);
      if (dev.cfg.rotation) img = img.rotate(dev.cfg.rotation);

      const { data, info } = await img
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const out = await processor.processFrameAsync({ data, width: info.width, height: info.height });
      const elapsed = Date.now() - t0;
      if (out.rects.length > 0) {
        dev.frameId = (dev.frameId + 1) >>> 0;
        console.log(`[diag:${id}] flushPending: processed fid=${dev.frameId} rects=${out.rects.length} full=${out.isFullFrame} ${elapsed}ms`);
        broadcaster.sendFrameChunked(id, out, dev.frameId, cfg.maxBytesPerMessage);
      } else {
        console.log(`[diag:${id}] flushPending: 0 rects (no change) ${elapsed}ms`);
      }
    } catch (e) {
      console.warn(`[device] Failed to process frame for ${id}: ${(e as Error).message}`);
    } finally {
      dev.processing = false;
      dev.lastProcessedMs = Date.now();

      // Process any frame that arrived during encoding
      if (dev.pendingB64 && !dev.throttleTimer) {
        dev.throttleTimer = setTimeout(flushPending, 0);
      }
    }
  };

  // --- Fallback screenshot mechanism ---
  // Chrome's compositor stops producing screencast frames for static pages
  // (no CSS animations). When the screencast goes quiet, we force a
  // Page.captureScreenshot to ensure content transitions are captured.
  const FALLBACK_DELAY_MS = 800;    // ms after last screencast frame
  const FALLBACK_REPEAT_MS = 2000;  // periodic recheck during static content

  const scheduleFallback = () => {
    if (newDevice.fallbackTimer) clearTimeout(newDevice.fallbackTimer);
    newDevice.fallbackTimer = setTimeout(fallbackCapture, FALLBACK_DELAY_MS);
  };

  const fallbackCapture = async () => {
    newDevice.fallbackTimer = undefined;

    if (broadcaster.getClientCount(newDevice.deviceId) === 0) {
      // No clients watching — check again later in case clients reconnect
      newDevice.fallbackTimer = setTimeout(fallbackCapture, 5000);
      return;
    }

    try {
      const result: any = await session.send('Page.captureScreenshot', { format: 'png' });
      if (result?.data) {
        newDevice.processor.requestFullFrame();
        newDevice.pendingB64 = result.data;
        if (!newDevice.throttleTimer) {
          newDevice.throttleTimer = setTimeout(flushPending, 0);
        }
      }
    } catch {
      // Session may be closed — ignore
    }

    // Schedule next fallback for ongoing static content
    if (!newDevice.fallbackTimer && broadcaster.getClientCount(newDevice.deviceId) > 0) {
      newDevice.fallbackTimer = setTimeout(fallbackCapture, FALLBACK_REPEAT_MS);
    }
  };

  session.on('Page.screencastFrame', async (evt: any) => {
    // ACK immediately to keep producer running
    session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });

    // Reset fallback timer — screencast is active, no fallback needed
    scheduleFallback();

    _scFrameCount++;
    const now = Date.now();
    // Log every screencast frame received, but throttle to 1/sec during bursts
    if (now - _lastScLog > 1000 || _scFrameCount <= 5) {
      console.log(`[diag:${id}] screencastFrame #${_scFrameCount} ts=${evt.metadata?.timestamp?.toFixed(3) ?? '?'} dataLen=${evt.data?.length ?? 0}`);
      _lastScLog = now;
    }

    if (broadcaster.getClientCount(newDevice.deviceId) === 0)
      return;
    newDevice.lastActive = Date.now();
    newDevice.pendingB64 = evt.data;

    const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
    if (!newDevice.throttleTimer) {
      const delay = Math.max(0, cfg.minFrameInterval - (Number.isFinite(since) ? since : 0));
      newDevice.throttleTimer = setTimeout(flushPending, delay);
    }
  });

  // Kick off the initial fallback timer
  scheduleFallback();

  return newDevice;
}

export async function cleanupIdleAsync(ttlMs = 5 * 60_000) {
  if (_cleanupRunning) return;
  _cleanupRunning = true;

  try {
    const now = Date.now();
    const staleIds = Array.from(devices.values())
      .filter(d => now - d.lastActive > ttlMs)
      .map(d => d.deviceId);

    for (const id of staleIds) {
      const dev = devices.get(id);
      if (!dev) continue;

      console.log(`[device] Cleaning up idle device ${id}`);
      await deleteDeviceAsync(dev).catch(() => { /* swallow */ });
    }
  } finally {
    _cleanupRunning = false;
  }
}

async function deleteDeviceAsync(device: DeviceSession) {
  const root = getRoot();

  if (!devices.delete(device.deviceId))
    return;

  if (device.throttleTimer)
    clearTimeout(device.throttleTimer);
  if (device.fallbackTimer)
    clearTimeout(device.fallbackTimer);

  try { await device.cdp.send("Page.stopScreencast").catch(() => { }); } catch { }
  try { await root?.send("Target.closeTarget", { targetId: device.id }); } catch { }
}