import { WebSocket } from "ws";
import { buildFrameStatsPacket, buildFramePackets } from "./protocol.js";
import type { FrameOut } from "./frameProcessor.js";

type OutFrame = { frameId: number; packets: Buffer[] };
type BroadcasterState = { queue: OutFrame[]; sending: boolean };

// Rate limiting: minimum gap between frames sent to each client.
// Prevents TCP buffer bloat when the server produces frames faster
// than ESP32 WiFi can absorb them (animation at 48fps → ~40s latency).
const MIN_FRAME_GAP_MS = 100;    // ~10fps max output rate
const DRAIN_POLL_MS = 5;         // poll interval while waiting for drain
const DRAIN_MAX_MS = 2000;       // max wait for buffer drain
const BACKPRESSURE_LOW = 16 * 1024;

export class DeviceBroadcaster {
  private _clients = new Map<string, Set<WebSocket>>();
  private _state = new Map<string, BroadcasterState>();

  addClient(id: string, ws: WebSocket): void {
    const old = this._clients.get(id);
    if (old && old.size) {
      for (const sock of old) {
        try { sock.close(); } catch {}
      }
      old.clear();
    }

    if (!this._clients.has(id)) this._clients.set(id, new Set());
    this._clients.get(id)!.add(ws);

    if (!this._state.has(id)) this._state.set(id, { queue: [], sending: false });

    console.log(`[broadcaster] Client connected to device ${id}, total clients: ${this._clients.get(id)?.size}`);
    ws.once("close", () => this.removeClient(id, ws));
    ws.once("error", () => this.removeClient(id, ws));
  }

  removeClient(id: string, ws: WebSocket): void {
    this._clients.get(id)?.delete(ws);
    if ((this._clients.get(id)?.size ?? 0) === 0) {
      this._clients.delete(id);
      this._state.delete(id);
    }
    console.log(`[broadcaster] Client disconnected from device ${id}, total clients: ${this._clients.get(id)?.size ?? 0}`);
  }

  getClientCount(id: string): number {
    return this._clients.get(id)?.size ?? 0;
  }

  public sendFrameChunked(id: string, data: FrameOut, frameId: number, maxBytes = 12_000): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0 || data.rects.length === 0) return;

    const packets = buildFramePackets(data.rects, data.encoding, frameId, data.isFullFrame, maxBytes);

    const st = this._ensureState(id);
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

  private _ensureState(id: string): BroadcasterState {
    let st = this._state.get(id);
    if (!st) {
      st = { queue: [], sending: false };
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

      while (st.queue.length) {
        // Always keep only the latest frame — drop stale ones
        if (st.queue.length > 1) {
          const latest = st.queue[st.queue.length - 1];
          st.queue.length = 0;
          st.queue.push(latest);
        }

        const f = st.queue.shift()!;
        let aborted = false;

        for (const pkt of f.packets) {
          // If a newer frame arrived while we're sending, abandon this frame
          if (st.queue.length > 0) { aborted = true; break; }

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

        // --- Rate limiting: prevent TCP buffer bloat ---
        // The server produces frames at ~48fps during animation, but ESP32
        // WiFi can only consume ~1-2MB/s. Without pacing, hundreds of frames
        // pile up in the kernel TCP buffer. Content changes (product scan)
        // get buried behind the backlog, causing ~40s display latency.
        //
        // Fix: wait MIN_FRAME_GAP_MS + buffer drain between frames.
        // During the wait, new frames accumulate in the queue and get
        // pruned to keep only the latest. The first frame after a quiet
        // period (content change) is sent immediately (no pacing).
        if (!aborted) {
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
    // Minimum inter-frame gap
    await new Promise(r => setTimeout(r, MIN_FRAME_GAP_MS));

    // Then wait for client buffers to drain (adapts to network speed)
    const deadline = Date.now() + DRAIN_MAX_MS;
    while (Date.now() < deadline) {
      if (st.queue.length > 0) return; // newer frame waiting, go send it
      let maxBuf = 0;
      for (const ws of peers) {
        if (ws.readyState === WebSocket.OPEN)
          maxBuf = Math.max(maxBuf, ws.bufferedAmount);
      }
      if (maxBuf <= BACKPRESSURE_LOW) return; // buffers drained
      await new Promise(r => setTimeout(r, DRAIN_POLL_MS));
    }
  }
}
