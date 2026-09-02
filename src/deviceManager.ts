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
  mutationCaptureTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;
  processing?: boolean;
  waitingForAck?: boolean;
  // Chrome screencast frame not yet acked. Chrome allows only a couple of
  // un-acked frames, so withholding the ack throttles its capture rate to
  // what the pipeline can actually use (instead of 50+ PNGs/s over CDP).
  pendingScreencastSessions: number[];
  // Screencast is paused (Page.stopScreencast) while the client pipeline is
  // full, so Chrome does not capture+encode+ship frames nobody can use.
  screencastPaused: boolean;
  screencastPauses: number;

  // stats
  screencastFrames: number;
  processedFrames: number;
  skippedUnchanged: number;
  lastProcessMs?: number;
  timing: { decodeMs: number; diffEncodeMs: number; captureWaitMs: number; n: number };
  lastCaptureAt?: number;
  createdAt: number;

  /**
   * Take a screenshot of the current page and push it as a full frame.
   * `force` bypasses the unchanged-hash skip, which is required whenever a
   * client needs the frame even though the page itself did not change
   * (reconnect after an ESP reboot, explicit refresh).
   */
  captureAndPush: (reason: string, force: boolean) => Promise<void>;
};

const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');
// Screencast capture format. PNG is lossless but Chrome encodes it slowly and
// ships ~1 MB base64 per 1024x600 frame over CDP; JPEG is several times
// smaller and faster at the cost of a second lossy step before our tiles.
// (defaults come from env via config.ts; per-device overrides via URL params scf/scq/chroma)

const devices = new Map<string, DeviceSession>();
let _cleanupRunning = false;
export const broadcaster = new DeviceBroadcaster();

function screencastParams(cfg: DeviceConfig) {
  return {
    format: cfg.screencastFormat,
    ...(cfg.screencastFormat === 'jpeg' ? { quality: cfg.screencastQuality } : {}),
    maxWidth: cfg.width,
    maxHeight: cfg.height,
    everyNthFrame: cfg.everyNthFrame,
  };
}

export async function ensureDeviceAsync(id: string, cfg: DeviceConfig): Promise<DeviceSession> {
  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  if (device) {
    if (deviceConfigsEqual(device.cfg, cfg)) {
      device.lastActive = Date.now();
      try {
        // A (re)connecting client has no idea what is on screen. Chrome will
        // not emit a screencast frame for a page that did not change, and the
        // unchanged-hash check would skip the fallback screenshot, so push a
        // forced full frame right now. Restarting the screencast makes sure
        // the compositor is producing frames again for live updates.
        await device.cdp.send('Page.stopScreencast').catch(() => { });
        device.pendingScreencastSessions = [];  // old session ids are void
        device.screencastPaused = false;
        await device.cdp.send('Page.startScreencast', screencastParams(device.cfg));
        await device.captureAndPush('reconnect', true);
        return device;
      } catch (e) {
        console.warn(`[device] CDP session broken for ${id}, recreating: ${(e as Error).message}`);
        await deleteDeviceAsync(device).catch(() => { });
      }
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

  await session.send('Page.startScreencast', screencastParams(cfg));

  // --- DOM mutation detection ---
  // Chrome's compositor doesn't produce screencast frames for DOM-only changes
  // (no CSS animations). Inject a MutationObserver that signals back via CDP
  // binding when the page content changes, so we can capture immediately.
  await session.send('Runtime.enable');
  await session.send('Runtime.addBinding', { name: '__rwvFrameDirty' });

  await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(function() {
    let dirty = false;
    new MutationObserver(function() {
      if (!dirty) {
        dirty = true;
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            dirty = false;
            try { __rwvFrameDirty(); } catch(e) {}
          });
        });
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, characterData: true
    });
  })();`
  });

  const processor = new FrameProcessor({
    tileSize: cfg.tileSize,
    fullframeTileCount: cfg.fullFrameTileCount,
    fullframeAreaThreshold: cfg.fullFrameAreaThreshold,
    jpegQuality: cfg.jpegQuality,
    fullFrameEvery: cfg.fullFrameEvery,
    maxBytesPerMessage: cfg.maxBytesPerMessage,
    chroma: cfg.chroma,
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
    mutationCaptureTimer: undefined,
    lastProcessedMs: undefined,
    processing: false,
    waitingForAck: false,
    screencastFrames: 0,
    processedFrames: 0,
    skippedUnchanged: 0,
    lastProcessMs: undefined,
    timing: { decodeMs: 0, diffEncodeMs: 0, captureWaitMs: 0, n: 0 },
    lastCaptureAt: undefined,
    createdAt: Date.now(),
    pendingScreencastSessions: [],
    screencastPaused: false,
    screencastPauses: 0,
    captureAndPush: async () => { },
  };
  devices.set(id, newDevice);
  newDevice.processor.requestFullFrame();

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

    if (!dev.pendingB64) return;

    // Ack-based flow control: while the client still has a frame in flight,
    // keep the newest screenshot and wait. The tile diff is then computed
    // against the last frame actually sent, so nothing is ever skipped.
    if (!broadcaster.canSend(id)) {
      pauseScreencast();
      if (!dev.waitingForAck) {
        dev.waitingForAck = true;
        broadcaster.onReady(id, () => {
          dev.waitingForAck = false;
          resumeScreencast();
          if (dev.pendingB64 && !dev.throttleTimer) dev.throttleTimer = setTimeout(flushPending, 0);
        });
      }
      return;
    }

    const b64 = dev.pendingB64;
    dev.pendingB64 = undefined;
    const screencastToAck = dev.pendingScreencastSessions;
    dev.pendingScreencastSessions = [];

    dev.processing = true;
    const t0 = Date.now();
    try {
      const pngFull = Buffer.from(b64, 'base64');

      const h32 = hash32(pngFull);
      if (dev.prevFrameHash === h32) {
        dev.skippedUnchanged++;
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
      const t1 = Date.now();
      const out = await processor.processFrameAsync({ data, width: info.width, height: info.height });
      const elapsed = Date.now() - t0;
      dev.timing.decodeMs += t1 - t0;
      dev.timing.diffEncodeMs += Date.now() - t1;
      if (dev.lastCaptureAt) dev.timing.captureWaitMs += t0 - dev.lastCaptureAt;
      dev.timing.n++;
      dev.lastProcessMs = elapsed;
      dev.processedFrames++;
      if (out.rects.length > 0) {
        dev.frameId = (dev.frameId + 1) >>> 0;
        broadcaster.sendFrameChunked(id, out, dev.frameId, cfg.maxBytesPerMessage);
      }
    } catch (e) {
      console.warn(`[device] Failed to process frame for ${id}: ${(e as Error).message}`);
    } finally {
      dev.processing = false;
      dev.lastProcessedMs = Date.now();
      // Release Chrome for the next capture now that this one is consumed.
      for (const sid of screencastToAck) ackScreencast(sid);

      // Process any frame that arrived during encoding
      if (dev.pendingB64 && !dev.throttleTimer) {
        dev.throttleTimer = setTimeout(flushPending, 0);
      }
    }
  };

  const pauseScreencast = () => {
    if (newDevice.screencastPaused) return;
    newDevice.screencastPaused = true;
    newDevice.screencastPauses++;
    // Release whatever Chrome still has outstanding, then stop the producer.
    for (const sid of newDevice.pendingScreencastSessions) session.send('Page.screencastFrameAck', { sessionId: sid }).catch(() => { });
    newDevice.pendingScreencastSessions = [];
    session.send('Page.stopScreencast').catch(() => { });
  };

  const resumeScreencast = () => {
    if (!newDevice.screencastPaused) return;
    newDevice.screencastPaused = false;
    session.send('Page.startScreencast', screencastParams(cfg)).catch(() => { });
  };

  const ackScreencast = (sessionId?: number) => {
    if (sessionId === undefined) return;
    session.send('Page.screencastFrameAck', { sessionId }).catch(() => { });
  };

  const queueScreenshot = (b64: string, force: boolean) => {
    if (force) newDevice.prevFrameHash = 0;
    newDevice.processor.requestFullFrame();
    newDevice.pendingB64 = b64;
    if (!newDevice.throttleTimer) {
      newDevice.throttleTimer = setTimeout(flushPending, 0);
    }
  };

  newDevice.captureAndPush = async (reason: string, force: boolean) => {
    // CDP errors (closed session) propagate to the caller; the periodic
    // fallback path below swallows them, the reconnect path recreates the device.
    const result: any = await session.send('Page.captureScreenshot', { format: 'png' });
    if (result?.data) {
      console.log(`[device] ${id}: pushing screenshot (${reason}${force ? ', forced' : ''})`);
      queueScreenshot(result.data, force);
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
      if (result?.data) queueScreenshot(result.data, false);
    } catch {
      // Session may be closed — ignore
    }

    // Schedule next fallback for ongoing static content
    if (!newDevice.fallbackTimer && broadcaster.getClientCount(newDevice.deviceId) > 0) {
      newDevice.fallbackTimer = setTimeout(fallbackCapture, FALLBACK_REPEAT_MS);
    }
  };

  session.on('Page.screencastFrame', async (evt: any) => {
    // Reset fallback timer — screencast is active, no fallback needed
    scheduleFallback();

    newDevice.screencastFrames++;
    const now = Date.now();

    if (broadcaster.getClientCount(newDevice.deviceId) === 0) {
      // Nobody watching: ack right away so Chrome keeps the page alive but
      // don't process anything.
      ackScreencast(evt.sessionId);
      return;
    }
    // Hold the ack until this capture (or a newer one) is consumed. Chrome
    // stops capturing after a couple of un-acked frames, which is exactly the
    // throttle we want. Superseded captures are acked together with the one
    // that is consumed, so the in-flight count returns to zero. Safety cap in
    // case Chrome's limit is higher than expected.
    // Ack right away: gating is done by pausing the screencast, not by
    // withholding acks (Chrome has no small in-flight limit to lean on).
    ackScreencast(evt.sessionId);

    newDevice.lastActive = Date.now();
    newDevice.lastCaptureAt = Date.now();
    newDevice.pendingB64 = evt.data;

    const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
    if (!newDevice.throttleTimer) {
      const delay = Math.max(0, cfg.minFrameInterval - (Number.isFinite(since) ? since : 0));
      newDevice.throttleTimer = setTimeout(flushPending, delay);
    }
  });

  // Kick off the initial fallback timer
  scheduleFallback();

  // --- Listen for DOM mutation signals ---
  session.on('Runtime.bindingCalled', async (evt: any) => {
    if (evt.name !== '__rwvFrameDirty') return;
    if (broadcaster.getClientCount(newDevice.deviceId) === 0) return;

    // Debounce server-side: if a capture is already scheduled, let it handle this
    if (newDevice.mutationCaptureTimer) return;

    newDevice.mutationCaptureTimer = setTimeout(async () => {
      newDevice.mutationCaptureTimer = undefined;
      try {
        await newDevice.captureAndPush('dom-mutation', false);
      } catch { /* session may be closed */ }
    }, 0);
  });

  return newDevice;
}

export function getDevicesSnapshot() {
  const now = Date.now();
  return Array.from(devices.values()).map(d => ({
    id: d.deviceId,
    url: d.url,
    width: d.cfg.width,
    height: d.cfg.height,
    tileSize: d.cfg.tileSize,
    jpegQuality: d.cfg.jpegQuality,
    minFrameInterval: d.cfg.minFrameInterval,
    ageMs: now - d.createdAt,
    lastActiveAgeMs: now - d.lastActive,
    frameId: d.frameId,
    screencastFrames: d.screencastFrames,
    screencastPaused: d.screencastPaused,
    screencastPauses: d.screencastPauses,
    processedFrames: d.processedFrames,
    skippedUnchanged: d.skippedUnchanged,
    lastProcessMs: d.lastProcessMs ?? null,
    avgDecodeMs: d.timing.n ? Math.round(d.timing.decodeMs / d.timing.n * 10) / 10 : null,
    avgDiffEncodeMs: d.timing.n ? Math.round(d.timing.diffEncodeMs / d.timing.n * 10) / 10 : null,
    avgCaptureWaitMs: d.timing.n ? Math.round(d.timing.captureWaitMs / d.timing.n * 10) / 10 : null,
    screencastFormat: d.cfg.screencastFormat,
    chroma: d.cfg.chroma,
    waitingForAck: !!d.waitingForAck,
    pendingFrame: !!d.pendingB64,
    transport: broadcaster.getStats(d.deviceId),
  }));
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
  if (device.mutationCaptureTimer)
    clearTimeout(device.mutationCaptureTimer);

  try { await device.cdp.send("Page.stopScreencast").catch(() => { }); } catch { }
  try { await root?.send("Target.closeTarget", { targetId: device.id }); } catch { }
  broadcaster.forgetDevice(device.deviceId);
}
