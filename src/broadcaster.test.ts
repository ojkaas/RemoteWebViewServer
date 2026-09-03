import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { DeviceBroadcaster, ACK_TIMEOUT_MS } from "./broadcaster.js";
import { Encoding, parseFrameHeader } from "./protocol.js";
import type { FrameOut } from "./frameProcessor.js";

class FakeWs extends EventEmitter {
  static OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Buffer[] = [];
  send(buf: Buffer) { this.sent.push(buf); }
  close() { this.readyState = 3; this.emit("close"); }
  ping() {}
  terminate() { this.close(); }
}

const frame = (): FrameOut => ({
  rects: [{ x: 0, y: 0, w: 32, h: 32, data: Buffer.alloc(10, 1) }],
  isFullFrame: false,
  encoding: Encoding.JPEG,
});

async function tick() { await new Promise(r => setTimeout(r, 0)); }

describe("DeviceBroadcaster ack flow control", () => {
  it("is not in ack mode for legacy clients", () => {
    const b = new DeviceBroadcaster();
    const ws = new FakeWs();
    b.addClient("d", ws as any);
    expect(b.isAckMode("d")).toBe(false);
    expect(b.canSend("d")).toBe(true);
    b.sendFrameChunked("d", frame(), 1);
    expect(b.canSend("d")).toBe(true);
  });

  it("blocks after one frame until the ack arrives", async () => {
    const b = new DeviceBroadcaster({ maxInflight: 1 });
    const ws = new FakeWs();
    b.addClient("d", ws as any, { ack: true });
    expect(b.isAckMode("d")).toBe(true);

    b.sendFrameChunked("d", frame(), 1);
    await tick();
    expect(ws.sent.length).toBe(1);
    expect(parseFrameHeader(ws.sent[0])!.frameId).toBe(1);
    expect(b.canSend("d")).toBe(false);

    const ready = vi.fn();
    b.onReady("d", ready);
    expect(ready).not.toHaveBeenCalled();

    b.handleFrameAck("d", 1);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(b.canSend("d")).toBe(true);
    expect(b.getStats("d")!.acksReceived).toBe(1);
    expect(b.getStats("d")!.inflightFrameId).toBeNull();
  });

  it("ignores stale acks and accepts newer ones", async () => {
    const b = new DeviceBroadcaster({ maxInflight: 1 });
    const ws = new FakeWs();
    b.addClient("d", ws as any, { ack: true });
    b.sendFrameChunked("d", frame(), 5);
    b.handleFrameAck("d", 4);
    expect(b.canSend("d")).toBe(false);
    b.handleFrameAck("d", 6);
    expect(b.canSend("d")).toBe(true);
  });

  it("writes off a frame after the ack timeout", () => {
    vi.useFakeTimers();
    try {
      const b = new DeviceBroadcaster({ maxInflight: 1 });
      const ws = new FakeWs();
      b.addClient("d", ws as any, { ack: true });
      b.sendFrameChunked("d", frame(), 1);
      expect(b.canSend("d")).toBe(false);
      vi.advanceTimersByTime(ACK_TIMEOUT_MS + 1);
      expect(b.canSend("d")).toBe(true);
      expect(b.getStats("d")!.ackTimeouts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows N frames in flight and releases older ones on a newer ack", () => {
    const b = new DeviceBroadcaster({ maxInflight: 2 });
    const ws = new FakeWs();
    b.addClient("d", ws as any, { ack: true });
    b.sendFrameChunked("d", frame(), 1);
    expect(b.canSend("d")).toBe(true);
    b.sendFrameChunked("d", frame(), 2);
    expect(b.canSend("d")).toBe(false);
    expect(b.getStats("d")!.inflightCount).toBe(2);
    b.handleFrameAck("d", 2);
    expect(b.getStats("d")!.inflightCount).toBe(0);
    expect(b.canSend("d")).toBe(true);
  });

  it("keeps counters across a reconnect and drops them on forgetDevice", () => {
    const b = new DeviceBroadcaster({ maxInflight: 1 });
    const ws1 = new FakeWs();
    b.addClient("d", ws1 as any, { ack: true });
    b.sendFrameChunked("d", frame(), 1);
    ws1.close();
    expect(b.getClientCount("d")).toBe(0);
    expect(b.getStats("d")!.framesSent).toBe(1);
    const ws2 = new FakeWs();
    b.addClient("d", ws2 as any, { ack: true });
    expect(b.getStats("d")!.framesSent).toBe(1);
    b.forgetDevice("d");
    expect(b.getStats("d")).toBeNull();
  });

  it("is gated by the slowest of two ack peers sharing a device", async () => {
    const b = new DeviceBroadcaster({ maxInflight: 1 });
    const fast = new FakeWs(), slow = new FakeWs();
    // addClient kicks older sockets for the same id; register both via the internal path
    b.addClient("d", fast as any, { ack: true });
    (b as any)._clients.get("d").add(slow);
    (b as any)._ackPeers.add(slow);
    b.sendFrameChunked("d", frame(), 1);
    await tick();
    expect(fast.sent.length).toBe(1);
    expect(slow.sent.length).toBe(1);
    expect(b.canSend("d")).toBe(false);
    b.handleFrameAck("d", 1, fast as any);
    expect(b.canSend("d")).toBe(false);   // slow peer still has it in flight
    b.handleFrameAck("d", 1, slow as any);
    expect(b.canSend("d")).toBe(true);
    expect(b.getStats("d")!.inflightCount).toBe(0);
  });

  it("clears in-flight state when the client reconnects", () => {
    const b = new DeviceBroadcaster({ maxInflight: 1 });
    const ws1 = new FakeWs();
    b.addClient("d", ws1 as any, { ack: true });
    b.sendFrameChunked("d", frame(), 1);
    expect(b.canSend("d")).toBe(false);
    const ws2 = new FakeWs();
    b.addClient("d", ws2 as any, { ack: true });
    expect(b.canSend("d")).toBe(true);
    expect(b.getClientCount("d")).toBe(1);
  });
});
