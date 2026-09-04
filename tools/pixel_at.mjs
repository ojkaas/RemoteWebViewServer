#!/usr/bin/env node
// Print RGB and the RGB565 value (truncated and rounded) of pixels in a PNG.
//   node tools/pixel_at.mjs shot.png 0,0 384,64 448,256
import sharp from "sharp";
const [file, ...coords] = process.argv.slice(2);
const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const hex = v => "0x" + v.toString(16).padStart(4, "0");
for (const c of coords) {
  const [x, y] = c.split(",").map(Number);
  const i = (y * info.width + x) * 4;
  const r = data[i], g = data[i + 1], b = data[i + 2];
  const trunc = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
  const round = (Math.min(31, Math.round(r * 31 / 255)) << 11) | (Math.min(63, Math.round(g * 63 / 255)) << 5) | Math.min(31, Math.round(b * 31 / 255));
  console.log(`(${x},${y}) rgb=(${r},${g},${b}) trunc=${hex(trunc)} round=${hex(round)}`);
}
