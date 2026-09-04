#!/usr/bin/env node
// Compare wire sizes of a full-screen PNG under the codecs the panel could use.
//   node tools/codec_size_check.mjs shot.png [tile=64]
// Prints: JPEG q100 4:4:4 (current), PNG as delivered, RGB565 raw + deflate,
// RGB565 + deflate per tile (what a tiled lossless scheme would cost), and
// RGB565 with PNG-style "up" prediction + deflate.
import sharp from "sharp";
import zlib from "node:zlib";

const [file, tileArg = "64"] = process.argv.slice(2);
const tile = Number(tileArg);
const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const kb = (n) => (n / 1024).toFixed(1) + " KB";

// current: JPEG q100 4:4:4 of the whole frame (bin-centre prep ignored; ~same size)
const jpeg = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
  .jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
const png9 = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
  .png({ compressionLevel: 9, effort: 10 }).toBuffer();
const pngPal = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
  .png({ compressionLevel: 9, palette: true, effort: 10 }).toBuffer();

// RGB565 (truncating, as the panel does)
const rgb565 = Buffer.alloc(W * H * 2);
for (let i = 0, p = 0; i < data.length; i += 4, p += 2) {
  const v = ((data[i] >> 3) << 11) | ((data[i + 1] >> 2) << 5) | (data[i + 2] >> 3);
  rgb565.writeUInt16LE(v, p);
}
const defl = (b, level = 9) => zlib.deflateRawSync(b, { level }).length;

// "up" predictor per row on the 565 bytes (cheap on the decoder: one add per byte)
const up = Buffer.alloc(rgb565.length);
const rowBytes = W * 2;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < rowBytes; x++) {
    const i = y * rowBytes + x;
    up[i] = (rgb565[i] - (y ? rgb565[i - rowBytes] : 0)) & 0xff;
  }
}

// per-tile deflate (each tile independently, as it would be sent)
let tileTotal = 0, tileTotalUp = 0, tiles = 0;
for (let ty = 0; ty < H; ty += tile) {
  for (let tx = 0; tx < W; tx += tile) {
    const w = Math.min(tile, W - tx), h = Math.min(tile, H - ty);
    const t = Buffer.alloc(w * h * 2), tu = Buffer.alloc(w * h * 2);
    for (let y = 0; y < h; y++) {
      rgb565.copy(t, y * w * 2, ((ty + y) * W + tx) * 2, ((ty + y) * W + tx + w) * 2);
      for (let x = 0; x < w * 2; x++) {
        const i = ((ty + y) * W + tx) * 2 + x;
        tu[y * w * 2 + x] = (rgb565[i] - (y ? rgb565[i - rowBytes] : 0)) & 0xff;
      }
    }
    tileTotal += defl(t); tileTotalUp += defl(tu); tiles++;
  }
}

console.log(`${W}x${H}, ${tiles} tiles of ${tile}px`);
console.log(`JPEG q100 4:4:4 full frame (today): ${kb(jpeg.length)}`);
console.log(`PNG as delivered by Chromium:        ${kb((await import("node:fs")).statSync(file).size)}`);
console.log(`PNG level 9 (sharp):                 ${kb(png9.length)}`);
console.log(`PNG palette (sharp):                 ${kb(pngPal.length)}`);
console.log(`RGB565 raw:                          ${kb(rgb565.length)}`);
console.log(`RGB565 + deflate (whole frame):      ${kb(defl(rgb565))}`);
console.log(`RGB565 up-pred + deflate (frame):    ${kb(defl(up))}`);
console.log(`RGB565 + deflate per tile:           ${kb(tileTotal)}`);
console.log(`RGB565 up-pred + deflate per tile:   ${kb(tileTotalUp)}`);
