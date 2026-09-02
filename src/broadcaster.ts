import { WebSocket } from "ws";
import { buildFrameStatsPacket, buildFramePackets } from "./protocol.js";
import type { FrameOut } from "./frameProcessor.js";

type OutFrame = { frameId: number; packets: Buffer[] };

type Inflight = { frameId: number; sentAt: number; bytes: number };

export type DeviceStats = {
  clients: number;
  ackClients: number;
  ackMode: boolean;
  inflightFrameId: number | null;   // oldest unacked frame
  inflightCount: number;
  maxInflight: number;
  inflightAgeMs: number | null;
  framesSent: number;
  bytesSent: number;
  ackTimeouts: number;
  acksReceived: number;
  lastAckLatencyMs: number | null;
  avgAckLatencyMs: number | null;
  fps: number;                 // frames sent over the last FPS_WINDOW_MS
  lastFrameId: number | null;
  lastSentAgeMs: number | null;
};

type BroadcasterState = {
  queue: OutFrame[];
  sending: boolean;
  inflight: Inflight[];   // oldest first
  readyCallbacks: Array<() => void>;
  // stats
  framesSent: number;
  bytesSent: number;
  ackTimeouts: number;
  acksReceived: number;
  lastAckLatencyMs?: number;
  ackLatencySum: number;
  lastFrameId?: number;
  lastSentAt?: number;
  sentTimes: number[];
};

// Legacy pacing (clients that do not send FrameAck): minimum gap between
// frames plus a userspace-buffer drain wait. Note that ws.bufferedAmount only
// covers Node's buffers, not the kernel send buffer, which is why ack-based
// flow control below is preferred.
const MIN_FRAME_GAP_MS = 100;
const DRAIN_POLL_MS = 5;
const DRAIN_MAX_MS = 2000;
const BACKPRESSURE_LOW = 16 * 1024;

// Ack-based flow control: a frame is considered lost if the client did not
// ack it within this time; the next frame is then sent regardless.
export const ACK_TIMEOUT_MS = 3000;
// Frames allowed in flight per device in ack mode. 1 = strictly serial
// (lowest latency), 2 = encode the next frame while the client decodes the
// previous one (about double the throughput, worst-case latency two frames).
export const DEFAULT_MAX_INFLIGHT = Math.max(1, Number(process.env.ACK_MAX_INFLIGHT ?? 2) || 2);
const FPS_WINDOW_MS = 5000;

export class DeviceBroadcaster {
  private _clients = new Map<string, Set<WebSocket>>();
  private _ackPeers = new WeakSet<WebSocket>();
  private _state = new Map<string, BroadcasterState>();
  private readonly _maxInflight: number;

  constructor(opts: { maxInflight?: number } = {}) {
    this._maxInflight = Math.max(1, opts.maxInflight ?? DEFAULT_MAX_INFLIGHT);
  }

  addClient(id: string, ws: WebSocket, opts: { ack?: boolean } = {}): void {
    const old = this._clients.get(id);
    if (old && old.size) {
      for (const sock of old) {
        try { sock.close(); } catch {}
      }
      old.clear();
    }

    if (!this._clients.has(id)) this._clients.set(id, new Set());
    this._clients.get(id)!.add(ws);
    if (opts.ack) this._ackPeers.add(ws);

    const st = this._ensureState(id);
    // A fresh connection has nothing in flight, whatever the old one had.
    st.inflight = [];
    st.queue.length = 0;
    this._fireReady(st);

    console.log(`[broadcaster] Client connected to device ${id} (ack=${opts.ack ? 1 : 0}), total clients: ${this._clients.get(id)?.size}`);
    ws.once("close", () => this.removeClient(id, ws));
    ws.once("error", () => this.removeClient(id, ws));
  }

  removeClient(id: string, ws: WebSocket): void {
    this._clients.get(id)?.delete(ws);
    if ((this._clients.get(id)?.size ?? 0) === 0) this._clients.delete(id);
    // Keep the per-device stats across reconnects; only the transport state
    // is reset. forgetDevice() drops everything when the device is deleted.
    const st = this._state.get(id);
    if (st) { st.inflight = []; st.queue.length = 0; this._fireReady(st); }
    console.log(`[broadcaster] Client disconnected from device ${id}, total clients: ${this._clients.get(id)?.size ?? 0}`);
  }

  forgetDevice(id: string): void {
    this._state.delete(id);
  }

  getClientCount(id: string): number {
    return this._clients.get(id)?.size ?? 0;
  }

  /** True when at least one connected peer of this device sends FrameAck. */
  isAckMode(id: string): boolean {
    const peers = this._clients.get(id);
    if (!peers) return false;
    for (const ws of peers) if (this._ackPeers.has(ws)) return true;
    return false;
  }

  /**
   * Whether a new frame may be produced for this device right now. In ack
   * mode this is false while a frame is in flight (until its ack, or until
   * ACK_TIMEOUT_MS has passed, in which case the frame is written off).
   */
  canSend(id: string): boolean {
    if (!this.isAckMode(id)) return true;
    const st = this._state.get(id);
    if (!st) return true;
    const now = Date.now();
    while (st.inflight.length && now - st.inflight[0].sentAt >= ACK_TIMEOUT_MS) {
      const dead = st.inflight.shift()!;
      st.ackTimeouts++;
      console.warn(`[broadcaster] ${id}: no ack for frame ${dead.frameId} after ${now - dead.sentAt}ms, continuing`);
    }
    return st.inflight.length < this._maxInflight;
  }

  /** Register a one-shot callback for when the device becomes ready to send. */
  onReady(id: string, cb: () => void): void {
    const st = this._ensureState(id);
    st.readyCallbacks.push(cb);
    // Arm a timer so a lost ack does not stall the pipeline forever.
    if (st.inflight.length) {
      const wait = Math.max(0, ACK_TIMEOUT_MS - (Date.now() - st.inflight[0].sentAt)) + 1;
      setTimeout(() => { if (this.canSend(id)) this._fireReady(st); }, wait).unref?.();
    } else {
      this._fireReady(st);
    }
  }

  handleFrameAck(id: string, frameId: number): void {
    const st = this._state.get(id);
    if (!st) return;
    st.acksReceived++;
    // An ack covers the acked frame and everything older.
    let released = 0;
    while (st.inflight.length && ((frameId - st.inflight[0].frameId) | 0) >= 0) {
      const f = st.inflight.shift()!;
      const latency = Date.now() - f.sentAt;
      st.lastAckLatencyMs = latency;
      st.ackLatencySum += latency;
      released++;
    }
    if (released) this._fireReady(st);
  }

  public sendFrameChunked(id: string, data: FrameOut, frameId: number, maxBytes = 12_000): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0 || data.rects.length === 0) return;

    const packets = buildFramePackets(data.rects, data.encoding, frameId, data.isFullFrame, maxBytes);
    const bytes = packets.reduce((n, p) => n + p.length, 0);

    const st = this._ensureState(id);
    const now = Date.now();
    st.framesSent++;
    st.bytesSent += bytes;
    st.lastFrameId = frameId;
    st.lastSentAt = now;
    st.sentTimes.push(now);
    while (st.sentTimes.length && now - st.sentTimes[0] > FPS_WINDOW_MS) st.sentTimes.shift();
    if (this.isAckMode(id)) st.inflight.push({ frameId, sentAt: now, bytes });

    st.queue.push({ frameId, packets });
    this._drainAsync(id).catch(() => {});
  }

  public startSelfTestMeasurement(id: string): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return;

    const packet = buildFrameStatsPacket();
    const st = this._ensureState(id);
    st.queue.push({ frameId: 42, packets: [packet] });
    this._drainAsync(id).catch(() => {});
  }

  public getStats(id: string): DeviceStats | null {
    const st = this._state.get(id);
    if (!st) return null;
    const now = Date.now();
    let ackClients = 0;
    for (const ws of this._clients.get(id) ?? []) if (this._ackPeers.has(ws)) ackClients++;
    const fpsFrames = st.sentTimes.filter(t => now - t <= FPS_WINDOW_MS).length;
    return {
      clients: this.getClientCount(id),
      ackClients,
      ackMode: ackClients > 0,
      inflightFrameId: st.inflight[0]?.frameId ?? null,
      inflightCount: st.inflight.length,
      maxInflight: this._maxInflight,
      inflightAgeMs: st.inflight.length ? now - st.inflight[0].sentAt : null,
      framesSent: st.framesSent,
      bytesSent: st.bytesSent,
      ackTimeouts: st.ackTimeouts,
      acksReceived: st.acksReceived,
      lastAckLatencyMs: st.lastAckLatencyMs ?? null,
      avgAckLatencyMs: st.acksReceived ? Math.round(st.ackLatencySum / st.acksReceived) : null,
      fps: Math.round((fpsFrames / (FPS_WINDOW_MS / 1000)) * 10) / 10,
      lastFrameId: st.lastFrameId ?? null,
      lastSentAgeMs: st.lastSentAt ? now - st.lastSentAt : null,
    };
  }

  private _fireReady(st: BroadcasterState): void {
    if (!st.readyCallbacks.length) return;
    const cbs = st.readyCallbacks;
    st.readyCallbacks = [];
    for (const cb of cbs) { try { cb(); } catch {} }
  }

  private _ensureState(id: string): BroadcasterState {
    let st = this._state.get(id);
    if (!st) {
      st = {
        queue: [], sending: false, inflight: [], readyCallbacks: [],
        framesSent: 0, bytesSent: 0, ackTimeouts: 0, acksReceived: 0, ackLatencySum: 0, sentTimes: [],
      };
      this._state.set(id, st);
    }
    return st;
  }

  private async _drainAsync(id: string): Promise<void> {
    const st = this._ensureState(id);
    if (st.sending) return;
    st.sending = true;

    try {
      const peers = this._clients.get(id);
      if (!peers || peers.size === 0) { st.queue.length = 0; return; }
      const ackMode = this.isAckMode(id);

      while (st.queue.length) {
        // Legacy clients: keep only the latest frame. In ack mode the
        // producer is gated upstream (canSend), so the queue never piles up
        // and nothing is dropped here.
        if (!ackMode && st.queue.length > 1) {
          const latest = st.queue[st.queue.length - 1];
          st.queue.length = 0;
          st.queue.push(latest);
        }

        const f = st.queue.shift()!;
        let aborted = false;

        for (const pkt of f.packets) {
          if (!ackMode && st.queue.length > 0) { aborted = true; break; }

          for (const ws of new Set(peers)) {
            if (ws.readyState !== WebSocket.OPEN) {
              peers.delete(ws);
              continue;
            }
            try {
              ws.send(pkt, { binary: true });
            } catch {
              try { ws.close(); } catch {}
              peers.delete(ws);
            }
          }

          if (aborted) break;
          if (peers.size === 0) { st.queue.length = 0; return; }
          await Promise.resolve();
        }

        if (peers.size === 0) { st.queue.length = 0; return; }

        if (!ackMode && !aborted) {
          await this._paceBeforeNextFrame(peers, st);
        }
      }
    } finally {
      st.sending = false;
    }
  }

  private async _paceBeforeNextFrame(
    peers: Set<WebSocket>,
    st: BroadcasterState,
  ): Promise<void> {
    await new Promise(r => setTimeout(r, MIN_FRAME_GAP_MS));

    const deadline = Date.now() + DRAIN_MAX_MS;
    while (Date.now() < deadline) {
      if (st.queue.length > 0) return;
      let maxBuf = 0;
      for (const ws of peers) {
        if (ws.readyState === WebSocket.OPEN)
          maxBuf = Math.max(maxBuf, ws.bufferedAmount);
      }
      if (maxBuf <= BACKPRESSURE_LOW) return;
      await new Promise(r => setTimeout(r, DRAIN_POLL_MS));
    }
  }
}
