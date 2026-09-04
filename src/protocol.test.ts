import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
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
  encodeRle565,
  decodeRle565,
  encodeDeflate565,
  decodeDeflate565,
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

describe("RLE565", () => {
  it("round-trips a flat tile into a handful of bytes", () => {
    const w = 64, h = 64;
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { rgba[i * 4] = 16; rgba[i * 4 + 1] = 24; rgba[i * 4 + 2] = 32; rgba[i * 4 + 3] = 255; }
    const rle = encodeRle565(rgba, w, h);
    expect(rle.length).toBeLessThan(64);
    const px = decodeRle565(rle, w, h)!;
    expect(px.length).toBe(w * h);
    expect(px[0]).toBe(((16 & 0xF8) << 8) | ((24 & 0xFC) << 3) | (32 >> 3));
    expect(px[w * h - 1]).toBe(px[0]);
  });
  it("round-trips noise exactly and rejects truncated data", () => {
    const w = 16, h = 8;
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37) & 0xFF;
    const rle = encodeRle565(rgba, w, h);
    const px = decodeRle565(rle, w, h)!;
    for (let i = 0; i < w * h; i++) {
      const j = i * 4;
      expect(px[i]).toBe(((rgba[j] & 0xF8) << 8) | ((rgba[j + 1] & 0xFC) << 3) | (rgba[j + 2] >> 3));
    }
    expect(decodeRle565(rle.subarray(0, rle.length - 3), w, h)).toBeNull();
  });
  it("groups mixed encodings into separate packets, last flag on the final one", () => {
    const rects = [
      { x: 0, y: 0, w: 32, h: 32, data: Buffer.alloc(50, 1) },
      { x: 32, y: 0, w: 32, h: 32, data: Buffer.alloc(9, 2), enc: Encoding.RAW565_RLE },
      { x: 64, y: 0, w: 32, h: 32, data: Buffer.alloc(50, 3) },
    ];
    const pkts = buildFramePackets(rects, Encoding.JPEG, 9, false, 100000);
    expect(pkts.length).toBe(2);
    const heads = pkts.map(p => parseFrameHeader(p)!);
    expect(heads[0].enc).toBe(Encoding.JPEG);
    expect(heads[0].tileCount).toBe(2);
    expect(heads[1].enc).toBe(Encoding.RAW565_RLE);
    expect(heads[0].flags & FLAG_LAST_OF_FRAME).toBe(0);
    expect(heads[1].flags & FLAG_LAST_OF_FRAME).toBe(FLAG_LAST_OF_FRAME);
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

describe("deflate565", () => {
  it("round-trips RGB565 exactly and beats raw size on flat content", () => {
    const w = 64, h = 64;
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const y = (i / w) | 0;
      rgba[i * 4] = y < 32 ? 5 : 200; rgba[i * 4 + 1] = 7; rgba[i * 4 + 2] = (i % 7 === 0) ? 250 : 13; rgba[i * 4 + 3] = 255;
    }
    const lz = encodeDeflate565(rgba, w, h, 6);
    expect(lz.length).toBeLessThan(w * h * 2 * 0.1);
    const px = decodeDeflate565(lz, w, h)!;
    expect(px).not.toBeNull();
    for (let i = 0; i < w * h; i++) {
      const exp = ((rgba[i * 4] & 0xF8) << 8) | ((rgba[i * 4 + 1] & 0xFC) << 3) | (rgba[i * 4 + 2] >> 3);
      expect(px[i]).toBe(exp);
    }
  });

  it("noise compresses poorly (so it would fall back to JPEG)", () => {
    const w = 64, h = 64;
    const rgba = Buffer.alloc(w * h * 4);
    randomBytes(rgba.length).copy(rgba);
    const lz = encodeDeflate565(rgba, w, h, 6);
    expect(lz.length).toBeGreaterThan(w * h * 2 * 0.5);
  });
});
