// Pixel preparation for RGB565 panels.
//
// 1. Bin centres: the panel truncates 8-bit channels to 5/6 bits (verified on
//    both the ESP32-P4 hardware decoder and JPEGDEC). A JPEG at quality 100
//    is still +-1..2 off on a few percent of pixels, and when such a pixel sits
//    at a bin edge that error flips the displayed value, which flickers in dark
//    gradients every time a tile is re-sent. Encoding each channel at the
//    CENTRE of its bin (R,B: 8k+4, G: 4k+2) keeps the error inside the bin, so
//    the panel reproduces the intended RGB565 value exactly.
//
// 2. Hardware decoder range: the ESP32-P4 JPEG decoder applies a fixed BT.601
//    limited-range expansion (1.164*(Y-16), chroma *1.138) to what is really
//    full-range JFIF data, crushing dark tones. For tiles the client will
//    decode in hardware we apply the exact inverse (full -> limited range in
//    YCbCr) so the expansion lands back on the intended values.
export function prepareForPanel(rgba: Buffer, hwLimitedRange: boolean): void {
  const n = rgba.length;
  for (let i = 0; i < n; i += 4) {
    // bin centres
    let r = ((rgba[i] >> 3) << 3) + 4;
    let g = ((rgba[i + 1] >> 2) << 2) + 2;
    let b = ((rgba[i + 2] >> 3) << 3) + 4;
    if (hwLimitedRange) {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      const yl = 16 + y * (219 / 255);
      const cbl = 128 + (cb - 128) * (224 / 255);
      const crl = 128 + (cr - 128) * (224 / 255);
      r = yl + 1.402 * (crl - 128);
      g = yl - 0.344136 * (cbl - 128) - 0.714136 * (crl - 128);
      b = yl + 1.772 * (cbl - 128);
    }
    rgba[i] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r);
    rgba[i + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g);
    rgba[i + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
  }
}

/** What the ESP32-P4 hardware decoder makes of an 8-bit RGB value (for tests). */
export function emulateHwExpand(r: number, g: number, b: number): [number, number, number] {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const R = 1.164 * (y - 16) + 1.596 * (cr - 128);
  const G = 1.164 * (y - 16) - 0.392 * (cb - 128) - 0.813 * (cr - 128);
  const B = 1.164 * (y - 16) + 2.017 * (cb - 128);
  const c = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.floor(v));
  return [c(R), c(G), c(B)];
}
