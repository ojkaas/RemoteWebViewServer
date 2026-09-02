import { describe, it, expect } from "vitest";
import {
  FLAG_OPENURL_FORCE,
  FLAG_LAST_OF_FRAME,
  FLAG_IS_FULL_FRAME,
  MsgType,
  OPENURL_HEADER_BYTES,
  PROTOCOL_VERSION,
  Encoding,
  parseOpenURLPacket,
  buildFramePackets,
  parseFrameHeader,
  buildFrameAckPacket,
  parseFrameAckPacket,
  FRAME_ACK_BYTES,
} from "./protocol.js";

function buildOpenURL(url: string, flags: number): Buffer {
  const u = Buffer.from(url, "utf8");
  const b = Buffer.alloc(OPENURL_HEADER_BYTES + u.length);
  b.writeUInt8(MsgType.OpenURL, 0);
  b.writeUInt8(PROTOCOL_VERSION, 1);
  b.writeUInt16LE(flags, 2);
  b.writeUInt32LE(u.length, 4);
  u.copy(b, OPENURL_HEADER_BYTES);
  return b;
}

describe("OpenURL packet", () => {
  it("parses url and plain flags", () => {
    const p = parseOpenURLPacket(buildOpenURL("http://x/a", 0));
    expect(p).toEqual({ flags: 0, url: "http://x/a" });
  });

  it("carries the force flag (client refresh)", () => {
    const p = parseOpenURLPacket(buildOpenURL("http://x/a", FLAG_OPENURL_FORCE));
    expect(p?.flags! & FLAG_OPENURL_FORCE).toBe(FLAG_OPENURL_FORCE);
  });

  it("rejects truncated packets", () => {
    const b = buildOpenURL("http://x/a", 0).subarray(0, 10);
    expect(parseOpenURLPacket(b)).toBeNull();
  });
});

describe("FrameAck packet", () => {
  it("round-trips the frame id", () => {
    const b = buildFrameAckPacket(0xfffffffe);
    expect(b.length).toBe(FRAME_ACK_BYTES);
    expect(b.readUInt8(0)).toBe(MsgType.FrameAck);
    expect(parseFrameAckPacket(b)).toBe(0xfffffffe);
  });
  it("rejects other packet types", () => {
    expect(parseFrameAckPacket(buildOpenURL("x", 0))).toBeNull();
  });
});

describe("Frame packets", () => {
  it("splits rects by maxBytes and flags the last chunk", () => {
    const rects = [0, 1, 2].map(i => ({ x: i * 32, y: 0, w: 32, h: 32, data: Buffer.alloc(100, i) }));
    const pkts = buildFramePackets(rects, Encoding.JPEG, 7, true, 11 + 12 + 100 + 5);
    expect(pkts.length).toBe(3);
    const heads = pkts.map(p => parseFrameHeader(p)!);
    expect(heads.every(h => h.frameId === 7)).toBe(true);
    expect(heads.every(h => h.flags & FLAG_IS_FULL_FRAME)).toBe(true);
    expect(heads.slice(0, -1).every(h => (h.flags & FLAG_LAST_OF_FRAME) === 0)).toBe(true);
    expect(heads[2].flags & FLAG_LAST_OF_FRAME).toBe(FLAG_LAST_OF_FRAME);
  });
});
