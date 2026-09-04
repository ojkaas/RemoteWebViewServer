import { describe, it, expect } from "vitest";
import { prepareForPanel, emulateHwExpand } from "./panel.js";

const to565 = (r: number, g: number, b: number) => [(r >> 3), (g >> 2), (b >> 3)];

describe("panel preparation", () => {
  it("software path: bin centres absorb JPEG error under truncation (R/B: -4..+3, G: -2..+1)", () => {
    for (const v of [0, 5, 6, 7, 13, 16, 55, 59, 64, 128, 200, 247, 255]) {
      const buf = Buffer.from([v, v, v, 255]);
      prepareForPanel(buf, false);
      for (const err of [-4, -3, -2, -1, 0, 1, 2, 3]) {
        const r = Math.max(0, Math.min(255, buf[0] + err));
        expect(r >> 3).toBe(v >> 3);
      }
      for (const err of [-2, -1, 0, 1]) {
        const g = Math.max(0, Math.min(255, buf[1] + err));
        expect(g >> 2).toBe(v >> 2);
      }
    }
  });

  it("hardware path: limited-range pre-compression is undone by the P4 expansion", () => {
    let mismatches = 0, total = 0;
    for (let r = 0; r < 256; r += 7) for (let g = 0; g < 256; g += 11) for (let b = 0; b < 256; b += 13) {
      const buf = Buffer.from([r, g, b, 255]);
      prepareForPanel(buf, true);
      const [R, G, B] = emulateHwExpand(buf[0], buf[1], buf[2]);
      total++;
      const ok = (R >> 3) === (r >> 3) && (G >> 2) === (g >> 2) && (B >> 3) === (b >> 3);
      if (!ok) mismatches++;
    }
    // rounding through 8-bit YCbCr can still miss a bin edge for a few
    // saturated colours; must be rare and never for greys (checked below)
    expect(mismatches / total).toBeLessThan(0.02);
    for (const v of [5, 6, 13, 16, 55, 64, 128, 235, 250]) {
      const buf = Buffer.from([v, v, v, 255]);
      prepareForPanel(buf, true);
      const [R, G, B] = emulateHwExpand(buf[0], buf[1], buf[2]);
      expect([R >> 3, G >> 2, B >> 3]).toEqual(to565(v, v, v));
    }
  });

  it("dark background is no longer crushed to black on the hardware path", () => {
    const buf = Buffer.from([5, 7, 13, 255]);   // the barcode idle background
    prepareForPanel(buf, true);
    const [R, G, B] = emulateHwExpand(buf[0], buf[1], buf[2]);
    expect([R >> 3, G >> 2, B >> 3]).toEqual(to565(5, 7, 13));
  });
});
