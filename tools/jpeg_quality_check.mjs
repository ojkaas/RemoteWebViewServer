#!/usr/bin/env node
// Objective JPEG quality check for RGB565 panels.
//
//   node tools/jpeg_quality_check.mjs <screenshot.png> [tile=64]
//
// Splits the screenshot into tiles, encodes each tile with several
// quality/chroma settings the way frameProcessor does, decodes it again and
// compares against the original AFTER RGB565 quantisation (what the panel can
// actually show). Reports bytes and error statistics, with dark pixels
// (luma < 48) scored separately because block artifacts show there first.
import sharp from "sharp";
import { readFileSync } from "node:fs";

const file = process.argv[2];
const tile = Number(process.argv[3] ?? 64);
if (!file) { console.error("usage: node tools/jpeg_quality_check.mjs <png> [tile]"); process.exit(1); }

const { data, info } = await sharp(readFileSync(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;

const to565 = (r, g, b) => [(r >> 3) << 3, (g >> 2) << 2, (b >> 3) << 3]; // quantise to what 565 keeps
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function extract(x, y, w, h) {
  const out = Buffer.allocUnsafe(w * h * 4);
  for (let yy = 0; yy < h; yy++) data.copy(out, yy * w * 4, ((y + yy) * W + x) * 4, ((y + yy) * W + x + w) * 4);
  return out;
}

const settings = [];
for (const q of [100, 97, 95, 92, 90, 85]) for (const chroma of ["4:4:4", "4:2:0"]) settings.push({ q, chroma });

const rows = [];
for (const { q, chroma } of settings) {
  let bytes = 0, n = 0, nDark = 0, err1 = 0, err2 = 0, dark1 = 0, dark2 = 0, maxErr = 0, sumSq = 0;
  for (let y = 0; y < H; y += tile) for (let x = 0; x < W; x += tile) {
    const w = Math.min(tile, W - x), h = Math.min(tile, H - y);
    const raw = extract(x, y, w, h);
    const jpg = await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).removeAlpha()
      .jpeg({ quality: q, mozjpeg: false, chromaSubsampling: chroma }).toBuffer();
    bytes += jpg.length;
    const dec = await sharp(jpg).raw().toBuffer();
    for (let i = 0, j = 0; i < raw.length; i += 4, j += 3) {
      const [r0, g0, b0] = to565(raw[i], raw[i + 1], raw[i + 2]);
      const [r1, g1, b1] = to565(dec[j], dec[j + 1], dec[j + 2]);
      // error in 565 steps (1 step = 8 for R/B, 4 for G)
      const e = Math.max(Math.abs(r0 - r1) / 8, Math.abs(g0 - g1) / 4, Math.abs(b0 - b1) / 8);
      const dark = luma(raw[i], raw[i + 1], raw[i + 2]) < 48;
      n++; if (dark) nDark++;
      if (e >= 1) { err1++; if (dark) dark1++; }
      if (e >= 2) { err2++; if (dark) dark2++; }
      if (e > maxErr) maxErr = e;
      sumSq += e * e;
    }
  }
  rows.push({ q, chroma, KB: (bytes / 1024).toFixed(1), "px>=1step%": (100 * err1 / n).toFixed(2), "px>=2steps%": (100 * err2 / n).toFixed(3),
    "dark>=1step%": (100 * dark1 / Math.max(1, nDark)).toFixed(2), "dark>=2steps%": (100 * dark2 / Math.max(1, nDark)).toFixed(3),
    maxErr: maxErr.toFixed(0), rms: Math.sqrt(sumSq / n).toFixed(3) });
}
console.log(`${file}: ${W}x${H}, tile ${tile}, dark pixels ${(100 * rows.length && 0) || ""}`);
console.table(rows);
