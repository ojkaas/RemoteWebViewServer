import os from "node:os";
import sharp from "sharp";
import zlib from "node:zlib";
import { Encoding, FRAME_HEADER_BYTES, TILE_HEADER_BYTES, encodeRle565, encodeDeflate565 } from "./protocol.js";
import { prepareForPanel } from "./panel.js";
import { hash32 } from "./util.js";
import { Q5, Q6 } from "./deviceManager.js";

sharp.concurrency(Math.max(1, os.cpus().length - 1));

export type RGBA = { data: Buffer; width: number; height: number };

export type Rect = { x: number; y: number; w: number; h: number; data: Buffer; enc?: Encoding };

export type FrameOut = {
  rects: Rect[];
  isFullFrame: boolean;
  encoding: Encoding;
  hashMs?: number;     // tile hashing + merge
  encodeMs?: number;   // JPEG encoding of the rects
  rleRects?: number;   // rects sent losslessly (RLE)
  rleBytes?: number;
  lzRects?: number;    // rects sent losslessly (RGB565 + deflate)
  lzBytes?: number;
};

export type FrameProcessorCfg = {
  tileSize: number;
  fullframeTileCount: number;
  fullframeAreaThreshold: number;
  jpegQuality: number;
  fullFrameEvery: number;
  maxBytesPerMessage: number;
  chroma?: '4:4:4' | '4:2:0';
  quantize565?: boolean;   // hash on RGB565-quantised values so sub-step changes are ignored
  // Lossless RLE565 instead of JPEG for rects that compress to at most this
  // fraction of their raw RGB565 size (flat UI areas, backgrounds). 0 disables.
  rleMaxRatio?: number;
  rleMaxPixels?: number;   // client-side decode buffer limit (pixels)
  lzMaxRatio?: number;     // 0 = off; else RGB565+deflate for rects that compress to <= ratio * raw size
  lzLevel?: number;        // deflate level 1..9
  panelPrep?: boolean;     // encode at RGB565 bin centres (exact reproduction on the panel)
  hwMinPixels?: number;    // rects with at least this many pixels are decoded by the P4 hardware (0 = never)
};

export class FrameProcessor {
  private _cfg: FrameProcessorCfg;
  private _cols = 0;
  private _rows = 0;
  private _prev?: Uint32Array;
  private _iter = 0;
  private _fullFrameRequested = false;

  constructor(cfg: FrameProcessorCfg) {
    this._cfg = cfg;
  }

  public requestFullFrame(): void {
    this._iter = 0;
    this._fullFrameRequested = true;
  }

  public async processFrameAsync(rgba: RGBA): Promise<FrameOut> {
    if (!this._prev) this._initGrid(rgba.width, rgba.height);

    const tHash0 = Date.now();
    let forceFull = this._cfg.fullFrameEvery > 0 && (this._iter % this._cfg.fullFrameEvery) === 0;
    if (this._fullFrameRequested) {
      forceFull = true;
      this._fullFrameRequested = false;
    }
    const chosenEncoding: Encoding = Encoding.JPEG;

    type TileInfo = { x: number; y: number; w: number; h: number; idx: number; h32: number; changed: boolean };
    const tiles: TileInfo[] = [];
    let changedArea = 0;

    for (let ty = 0; ty < this._rows; ty++) {
      for (let tx = 0; tx < this._cols; tx++) {
        const x = tx * this._cfg.tileSize;
        const y = ty * this._cfg.tileSize;
        const w = Math.min(this._cfg.tileSize, rgba.width - x);
        const h = Math.min(this._cfg.tileSize, rgba.height - y);

        const h32 = this._hashTile(rgba, x, y, w, h);
        const idx = ty * this._cols + tx;
        const prev = this._prev![idx];
        const changed = forceFull || (prev !== h32);

        tiles.push({ x, y, w, h, idx, h32, changed });
        if (changed) changedArea += w * h;
      }
    }

    const totalArea = rgba.width * rgba.height;
    const changedPct = totalArea > 0 ? (changedArea / totalArea) : 0;
    const doFull = forceFull || (changedPct > this._cfg.fullframeAreaThreshold);

    const tEnc0 = Date.now();
    let out: FrameOut;
    if (doFull) {
      out = await this._processFullFrame(rgba, tiles, chosenEncoding);
    } else {
      out = await this._processPartialFrame(rgba, tiles, chosenEncoding);
    }
    out.hashMs = tEnc0 - tHash0;
    out.encodeMs = Date.now() - tEnc0;
    out.rleRects = out.rects.filter(r => r.enc === Encoding.RAW565_RLE).length;
    out.rleBytes = out.rects.filter(r => r.enc === Encoding.RAW565_RLE).reduce((n, r) => n + r.data.length, 0);
    out.lzRects = out.rects.filter(r => r.enc === Encoding.RAW565_DEFLATE).length;
    out.lzBytes = out.rects.filter(r => r.enc === Encoding.RAW565_DEFLATE).reduce((n, r) => n + r.data.length, 0);

    const maxBytesPerTile = this._cfg.maxBytesPerMessage - FRAME_HEADER_BYTES - TILE_HEADER_BYTES;
    for (let i = 0; i < out.rects.length; i++) {
      const r = out.rects[i];
      if (r.data.length > maxBytesPerTile) {
        const redData = await this._makeRedFrameAsync(r.w, r.h, chosenEncoding);
        out.rects[i] = { x: r.x, y: r.y, w: r.w, h: r.h, data: redData };
      }
    }

    this._iter++;
    return out;
  }

  private async _processFullFrame(
    rgba: RGBA,
    tilesInfo: { x: number; y: number; w: number; h: number; idx: number; h32: number; changed: boolean }[],
    encoding: Encoding
  ): Promise<FrameOut> {
    // Every tile is (re)sent; tiles are still classified per codec and merged
    // per class, so a photo in an otherwise flat page goes JPEG while the rest
    // stays lossless. The merge caps rect sizes (maxW/maxH).
    const all = tilesInfo.map((t) => ({ ...t, changed: true }));
    const cls = this._classifyTiles(rgba, all);
    const mergedRects = this._mergeChangedTiles(all, rgba.width, rgba.height, cls);

    const rects = await Promise.all(
      mergedRects.map(async (r) => {
        const raw = this._extractRaw(rgba, r.x, r.y, r.w, r.h);
        return this._encodeRect(raw, r.x, r.y, r.w, r.h, encoding, r.cls);
      })
    );

    for (const t of tilesInfo) this._prev![t.idx] = t.h32;

    return { rects, isFullFrame: true, encoding };
  }

  /** Codec class per tile: 0 = unchanged, 1 = lossless (RGB565+deflate), 2 = JPEG.
   *  A quick level-1 deflate of the tile's RGB565 bytes measures how "flat"
   *  it is; photo-like tiles (ratio above lzMaxRatio) go JPEG. Deciding per
   *  tile (not per merged rect) keeps a photo from dragging a whole flat page
   *  into JPEG, or a flat page from sending a photo losslessly (2 bytes/px). */
  private _classifyTiles(rgba: RGBA, tiles: { x: number; y: number; w: number; h: number; idx: number; changed: boolean }[]): number[] {
    const cls = new Array<number>(tiles.length).fill(0);
    const lzRatio = this._cfg.lzMaxRatio ?? 0;
    for (const t of tiles) {
      if (!t.changed) continue;
      if (lzRatio <= 0) { cls[t.idx] = 2; continue; }
      const n = t.w * t.h;
      const px = Buffer.allocUnsafe(n * 2);
      for (let yy = 0, o = 0; yy < t.h; yy++) {
        let j = ((t.y + yy) * rgba.width + t.x) * 4;
        for (let xx = 0; xx < t.w; xx++, j += 4, o += 2) {
          const v = ((rgba.data[j] & 0xF8) << 8) | ((rgba.data[j + 1] & 0xFC) << 3) | (rgba.data[j + 2] >> 3);
          px[o] = v & 0xFF; px[o + 1] = v >> 8;
        }
      }
      const z = zlib.deflateRawSync(px, { level: 1 }).length;
      cls[t.idx] = z <= Math.max(64, n * 2 * lzRatio) ? 1 : 2;
    }
    return cls;
  }

  private async _processPartialFrame(
    rgba: RGBA,
    tiles: { x: number; y: number; w: number; h: number; idx: number; h32: number; changed: boolean }[],
    encoding: Encoding
  ): Promise<FrameOut> {
    const cls = this._classifyTiles(rgba, tiles);
    const mergedRects = this._mergeChangedTiles(tiles, rgba.width, rgba.height, cls);

    // Encode all merged rects in parallel
    const out = await Promise.all(
      mergedRects.map(async (r) => {
        const raw = this._extractRaw(rgba, r.x, r.y, r.w, r.h);
        return this._encodeRect(raw, r.x, r.y, r.w, r.h, encoding, r.cls);
      })
    );

    for (const t of tiles) if (t.changed) this._prev![t.idx] = t.h32;

    return { rects: out, isFullFrame: false, encoding };
  }

  private _splitWholeFrame(w: number, h: number, n: number): { x: number; y: number; w: number; h: number }[] {
    if (n <= 1) return [{ x: 0, y: 0, w, h }];

    if (n === 2) {
      const h1 = Math.floor(h / 2);
      const h2 = h - h1;
      return [
        { x: 0, y: 0, w, h: h1 },
        { x: 0, y: h1, w, h: h2 },
      ];
    }

    let rows = Math.floor(Math.sqrt(n));
    while (rows > 1 && (n % rows !== 0)) rows--;
    const cols = Math.floor(n / rows);

    const split = (size: number, parts: number): number[] => {
      const out: number[] = [];
      let prev = 0;
      for (let i = 1; i <= parts; i++) {
        const cur = Math.floor((i * size) / parts);
        out.push(cur - prev);
        prev = cur;
      }
      return out;
    };

    const widths = split(w, cols);
    const heights = split(h, rows);

    const rects: { x: number; y: number; w: number; h: number }[] = [];
    let yAcc = 0;
    for (let r = 0; r < rows; r++) {
      let xAcc = 0;
      for (let c = 0; c < cols; c++) {
        rects.push({ x: xAcc, y: yAcc, w: widths[c], h: heights[r] });
        xAcc += widths[c];
      }
      yAcc += heights[r];
    }
    return rects;
  }

  private _getMaxFullTileSize(frameW: number, frameH: number): { maxW: number; maxH: number } {
    const fullRects = this._splitWholeFrame(frameW, frameH, this._cfg.fullframeTileCount);
    let maxW = 0, maxH = 0;
    for (const r of fullRects) {
      if (r.w > maxW) maxW = r.w;
      if (r.h > maxH) maxH = r.h;
    }
    return { maxW, maxH };
  }

  private _calcGridSplits(frameW: number, frameH: number) {
    const cols = this._cols, rows = this._rows, ts = this._cfg.tileSize;
    const widths: number[] = new Array(cols);
    const heights: number[] = new Array(rows);
    const xOffsets: number[] = new Array(cols);
    const yOffsets: number[] = new Array(rows);

    let x = 0;
    for (let c = 0; c < cols; c++) {
      const w = Math.min(ts, frameW - x);
      widths[c] = w;
      xOffsets[c] = x;
      x += w;
    }
    let y = 0;
    for (let r = 0; r < rows; r++) {
      const h = Math.min(ts, frameH - y);
      heights[r] = h;
      yOffsets[r] = y;
      y += h;
    }
    return { widths, heights, xOffsets, yOffsets };
  }

  private _mergeChangedTiles(
    tiles: { x: number; y: number; w: number; h: number; idx: number; h32: number; changed: boolean }[],
    frameW: number,
    frameH: number,
    cls?: number[]
  ): { x: number; y: number; w: number; h: number; cls?: number }[] {
    const cols = this._cols, rows = this._rows;
    const changed: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
    const visited: boolean[][] = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false));
    const klass: number[][] = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

    for (let i = 0; i < tiles.length; i++) {
      const ty = Math.floor(i / cols);
      const tx = i % cols;
      changed[ty][tx] = tiles[i].changed;
      klass[ty][tx] = cls ? cls[tiles[i].idx] : 0;
    }

    const { widths, heights, xOffsets, yOffsets } = this._calcGridSplits(frameW, frameH);
    const { maxW, maxH } = this._getMaxFullTileSize(frameW, frameH);

    const rects: { x: number; y: number; w: number; h: number; cls?: number }[] = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!changed[r][c] || visited[r][c]) continue;
        const k = klass[r][c];

        // grow horizontally (only over tiles of the same codec class)
        let wTiles = 0, pxW = 0;
        while (c + wTiles < cols && changed[r][c + wTiles] && !visited[r][c + wTiles] && klass[r][c + wTiles] === k) {
          const nextW = pxW + widths[c + wTiles];
          if (nextW > maxW) break;
          pxW = nextW;
          wTiles++;
        }

        // grow vertically
        let hTiles = 1, pxH = heights[r];
        let canGrow = true;
        while (canGrow && (r + hTiles) < rows) {
          const nextH = pxH + heights[r + hTiles];
          if (nextH > maxH) break;
          for (let cc = c; cc < c + wTiles; cc++) {
            if (!changed[r + hTiles][cc] || visited[r + hTiles][cc] || klass[r + hTiles][cc] !== k) { canGrow = false; break; }
          }
          if (!canGrow) break;
          pxH = nextH;
          hTiles++;
        }

        rects.push({ x: xOffsets[c], y: yOffsets[r], w: pxW, h: pxH, cls: cls ? k : undefined });

        for (let rr = r; rr < r + hTiles; rr++) {
          for (let cc = c; cc < c + wTiles; cc++) {
            visited[rr][cc] = true;
          }
        }
      }
    }

    return rects;
  }

  private _initGrid(w: number, h: number) {
    this._cols = Math.ceil(w / this._cfg.tileSize);
    this._rows = Math.ceil(h / this._cfg.tileSize);
    this._prev = new Uint32Array(this._cols * this._rows);
  }

  // FNV-1a over the tile sampled every 4th pixel of every row, straight from
  // the frame buffer (no copy). Same sensitivity as hash32() on the extracted
  // tile, which sampled every 16th byte.
  private _hashTile(rgba: RGBA, x: number, y: number, w: number, h: number): number {
    const d = rgba.data;
    const stride = rgba.width * 4;
    let hsh = 0x811C9DC5 >>> 0;
    const rowBytes = w * 4;
    if (this._cfg.quantize565) {
      // Every 4th pixel, all three channels, quantised to what the panel shows.
      for (let yy = 0; yy < h; yy++) {
        const base = (y + yy) * stride + x * 4;
        const end = base + rowBytes;
        for (let i = base; i < end; i += 16) {
          hsh ^= Q5[d[i]]; hsh = (hsh * 0x01000193) >>> 0;
          hsh ^= Q6[d[i + 1]]; hsh = (hsh * 0x01000193) >>> 0;
          hsh ^= Q5[d[i + 2]]; hsh = (hsh * 0x01000193) >>> 0;
        }
      }
      return hsh >>> 0;
    }
    for (let yy = 0; yy < h; yy++) {
      const base = (y + yy) * stride + x * 4;
      const end = base + rowBytes;
      for (let i = base; i < end; i += 16) {
        hsh ^= d[i]; hsh = (hsh * 0x01000193) >>> 0;
        hsh ^= d[i + 4] ?? 0; hsh = (hsh * 0x01000193) >>> 0;
        hsh ^= d[i + 8] ?? 0; hsh = (hsh * 0x01000193) >>> 0;
        hsh ^= d[i + 12] ?? 0; hsh = (hsh * 0x01000193) >>> 0;
      }
    }
    return hsh >>> 0;
  }

  private _extractRaw(rgba: RGBA, x: number, y: number, w: number, h: number): Buffer {
    const out = Buffer.allocUnsafe(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      const src = ((y + yy) * rgba.width + x) * 4;
      rgba.data.copy(out, yy * w * 4, src, src + w * 4);
    }
    return out;
  }

  /** Lossless RLE when the rect is flat enough, else the frame's encoding. */
  private async _encodeRect(raw: Buffer, x: number, y: number, w: number, h: number, enc: Encoding, cls?: number): Promise<Rect> {
    // Lossless (RGB565+deflate) for flat UI rects: 3-4x smaller than JPEG q100
    // and pixel-exact. The class comes from _classifyTiles; without one
    // (legacy callers) the rect's own deflate ratio decides.
    const lzRatio = this._cfg.lzMaxRatio ?? 0;
    if (lzRatio > 0 && cls !== 2) {
      const lz = encodeDeflate565(raw, w, h, this._cfg.lzLevel ?? 6);
      if (cls === 1 || lz.length <= Math.max(64, w * h * 2 * lzRatio)) {
        return { x, y, w, h, data: lz, enc: Encoding.RAW565_DEFLATE };
      }
    }
    const ratio = this._cfg.rleMaxRatio ?? 0;
    const maxPx = this._cfg.rleMaxPixels ?? 32768;
    if (ratio > 0 && w * h <= maxPx) {
      const rle = encodeRle565(raw, w, h);
      if (rle.length <= Math.max(64, w * h * 2 * ratio)) {
        return { x, y, w, h, data: rle, enc: Encoding.RAW565_RLE };
      }
    }
    if (this._cfg.panelPrep && enc === Encoding.JPEG) {
      const hw = (this._cfg.hwMinPixels ?? 0) > 0 && w * h >= (this._cfg.hwMinPixels ?? 0);
      prepareForPanel(raw, hw);
    }
    const data = await this._encode(raw, w, h, enc);
    return { x, y, w, h, data };
  }

  private async _encode(rawRgba: Buffer, w: number, h: number, enc: Encoding): Promise<Buffer> {
    switch (enc) {
      case Encoding.JPEG:
        return this._encodeJPEG(rawRgba, w, h);
      case Encoding.RAW565:
        return this._encodeRAW565(rawRgba);
      default:
        return this._encodeJPEG(rawRgba, w, h);
    }
  }

  private async _encodeJPEG(rawRgba: Buffer, w: number, h: number): Promise<Buffer> {
    return sharp(rawRgba, { raw: { width: w, height: h, channels: 4 } })
      .jpeg({ quality: this._cfg.jpegQuality, mozjpeg: false, chromaSubsampling: this._cfg.chroma ?? "4:4:4" })
      .toBuffer();
  }

  private _encodeRAW565(rawRgba: Buffer): Buffer {
    const pxCount = rawRgba.length >> 2;
    const out = Buffer.allocUnsafe(pxCount * 2);
    for (let i = 0, j = 0; i < pxCount; i++, j += 4) {
      const r = rawRgba[j];
      const g = rawRgba[j + 1];
      const b = rawRgba[j + 2];
      const v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);
      out[i * 2] = v & 0xFF;
      out[i * 2 + 1] = (v >> 8) & 0xFF;
    }
    return out;
  }

  private async _makeRedFrameAsync(w: number, h: number, enc: Encoding): Promise<Buffer> {
    const raw = Buffer.allocUnsafe(w * h * 4);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const RGBA_RED = 0xFF0000FF; // bytes: FF 00 00 FF
    for (let o = 0; o < raw.length; o += 4) view.setUint32(o, RGBA_RED, true);
    return this._encode(raw, w, h, enc);
  }
}
