#!/usr/bin/env node
// Count and locate pixels that differ between two PNGs (same size).
//   node tools/shot_diff.mjs a.png b.png [threshold=12]
import sharp from "sharp";
const [fa, fb, thr = "12"] = process.argv.slice(2);
const a = await sharp(fa).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const b = await sharp(fb).ensureAlpha().raw().toBuffer();
const t = Number(thr);
let diff = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
for (let i = 0; i < a.data.length; i += 4) {
  if (Math.abs(a.data[i] - b[i]) + Math.abs(a.data[i + 1] - b[i + 1]) + Math.abs(a.data[i + 2] - b[i + 2]) > t) {
    diff++;
    const p = i >> 2, x = p % a.info.width, y = (p / a.info.width) | 0;
    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
}
console.log(`changed pixels: ${diff}` + (diff ? ` bbox x${minx}-${maxx} y${miny}-${maxy}` : ""));
