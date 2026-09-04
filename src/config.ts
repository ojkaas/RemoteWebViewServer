import env from "env-var";
import { getRotatedDimensions, Rotation } from "./util.js";

export type DeviceConfig = {
  height: number;                   // px
  width: number;                    // px
  tileSize: number;                 // px
  fullFrameTileCount: number;       // tiles
  fullFrameAreaThreshold: number;   // 0..1
  fullFrameEvery: number;           // frames
  everyNthFrame: number;            // frames (>=1)
  minFrameInterval: number;         // ms (>=0)
  jpegQuality: number;              // 1..100
  maxBytesPerMessage: number;       // bytes (>0)
  rotation: Rotation;               // degrees
  chroma: '4:4:4' | '4:2:0';        // JPEG chroma subsampling for tiles
  screencastFormat: 'png' | 'jpeg';  // Chrome capture format
  screencastQuality: number;        // 1..100, jpeg only
  reducedMotion: boolean;           // emulate prefers-reduced-motion for this device
  screencastMode: 'stream' | 'ondemand'; // ondemand: one Chromium capture per frame we want
  rleMaxRatio: number;              // 0 = JPEG only; else lossless RLE for rects <= ratio * raw size
  hwMinPixels: number;              // client decodes rects >= this many pixels in hardware (0 = software only)
  panelPrep: boolean;               // encode at RGB565 bin centres
  maxInflight: number;              // 0 = server default (ACK_MAX_INFLIGHT); 1 on slow links
};

const DEFAULTS = {
  tileSize: 32,
  fullFrameTileCount: 4,
  fullFrameAreaThreshold: 0.25,
  fullFrameEvery: 15,
  everyNthFrame: 1,
  minFrameInterval: 80,
  jpegQuality: 85,
  maxBytesPerMessage: 14336,
  rotation: 0,
  chroma: '4:4:4',
  screencastFormat: 'png',
  screencastQuality: 90,
  reducedMotion: false,
  screencastMode: 'stream',
  rleMaxRatio: 0,
  hwMinPixels: 0,
  panelPrep: true,
  maxInflight: 0,
} as const;

const store = new Map<string, DeviceConfig>();

export function getConfigFor(id: string): DeviceConfig {
  const cfg = store.get(id);
  if (!cfg) throw new Error(`config for id="${id}" not found`);
  return cfg;
}
export function setConfigFor(id: string, cfg: DeviceConfig): void {
  store.set(id, cfg);
}

function num(input?: string | null): number | undefined {
  if (input == null) return undefined;
  const v = Number(input);
  if (!Number.isFinite(v)) throw new Error(`invalid number: "${input}"`);
  return v;
}
function intPos(input?: string | null): number | undefined {
  const v = num(input);
  if (v == null) return undefined;
  if (!Number.isInteger(v) || v <= 0) throw new Error(`invalid positive integer: "${input}"`);
  return v;
}
function intNonNeg(input?: string | null): number | undefined {
  const v = num(input);
  if (v == null) return undefined;
  if (!Number.isInteger(v) || v < 0) throw new Error(`invalid non-negative integer: "${input}"`);
  return v;
}
function float01(input?: string | null): number | undefined {
  const v = num(input);
  if (v == null) return undefined;
  if (v < 0 || v > 1) throw new Error(`invalid 0..1 number: "${input}"`);
  return v;
}
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function readEnvFallbacks(): Partial<DeviceConfig> {
  const val = (name: string) => env.get(name).asString() ?? undefined;

  const out: Partial<DeviceConfig> = {};
  const TS = val("TILE_SIZE");
  const FFTC = val("FULL_FRAME_TILE_COUNT");
  const FFAT = val("FULL_FRAME_AREA_THRESHOLD");
  const FFE = val("FULL_FRAME_EVERY");
  const ENF = val("EVERY_NTH_FRAME");
  const MFI = val("MIN_FRAME_INTERVAL_MS");
  const Q = val("JPEG_QUALITY");
  const MBPM = val("MAX_BYTES_PER_MESSAGE");

  if (TS) out.tileSize = intPos(TS)!;
  if (FFTC) out.fullFrameTileCount = intPos(FFTC)!;
  if (FFAT != null) out.fullFrameAreaThreshold = float01(FFAT)!;
  if (FFE) out.fullFrameEvery = intPos(FFE)!;
  if (ENF) out.everyNthFrame = intPos(ENF)!;
  if (MFI != null) out.minFrameInterval = intNonNeg(MFI)!;
  if (Q) out.jpegQuality = clamp(intPos(Q)!, 1, 100);
  if (MBPM) out.maxBytesPerMessage = intPos(MBPM)!;

  return out;
}

export function makeConfigFromParams(params: URLSearchParams): DeviceConfig {
  const envFallbacks = readEnvFallbacks();

  // required
  let height = intPos(params.get("h")) ?? envFallbacks.height;
  let width = intPos(params.get("w")) ?? envFallbacks.width;
  if (!height || !width) throw new Error(`missing required params "h" and/or "w"`);

  // optional
  const tileSize = intPos(params.get("ts")) ?? envFallbacks.tileSize ?? DEFAULTS.tileSize;
  const fullFrameTileCount = intPos(params.get("fftc")) ?? envFallbacks.fullFrameTileCount ?? DEFAULTS.fullFrameTileCount;
  const fullFrameAreaThreshold = float01(params.get("ffat")) ?? envFallbacks.fullFrameAreaThreshold ?? DEFAULTS.fullFrameAreaThreshold;
  const fullFrameEvery = intPos(params.get("ffe")) ?? envFallbacks.fullFrameEvery ?? DEFAULTS.fullFrameEvery;
  const minFrameInterval = intNonNeg(params.get("mfi")) ?? envFallbacks.minFrameInterval ?? DEFAULTS.minFrameInterval;
  const everyNthFrame = intPos(params.get("enf")) ?? envFallbacks.everyNthFrame ?? DEFAULTS.everyNthFrame;
  const jpegQuality = clamp(intPos(params.get("q")) ?? envFallbacks.jpegQuality ?? DEFAULTS.jpegQuality, 1, 100);
  const maxBytesPerMessage = intPos(params.get("mbpm")) ?? envFallbacks.maxBytesPerMessage ?? DEFAULTS.maxBytesPerMessage;
  const rotation = intNonNeg(params.get("r")) as 0 | 90 | 180 | 270 | undefined
    ?? DEFAULTS.rotation;
  const chromaRaw = params.get("chroma") ?? env.get("JPEG_CHROMA").asString();
  const chroma: '4:4:4' | '4:2:0' = chromaRaw && /^4:?2:?0$/.test(chromaRaw) ? '4:2:0' : (chromaRaw && /^4:?4:?4$/.test(chromaRaw) ? '4:4:4' : DEFAULTS.chroma);
  const scfRaw = params.get("scf") ?? env.get("SCREENCAST_FORMAT").asString();
  const screencastFormat: 'png' | 'jpeg' = scfRaw && /^jpe?g$/i.test(scfRaw) ? 'jpeg' : DEFAULTS.screencastFormat;
  const prmRaw = params.get("prm");
  const reducedMotion = prmRaw != null ? /^(1|true|yes|on)$/i.test(prmRaw) : /^(1|true|yes|on)$/i.test(env.get("PREFERS_REDUCED_MOTION").asString() ?? '');
  const scmRaw = params.get("scm") ?? env.get("SCREENCAST_MODE").asString();
  const screencastMode: 'stream' | 'ondemand' = scmRaw && /^on-?demand$/i.test(scmRaw) ? 'ondemand' : DEFAULTS.screencastMode;
  const rleRaw = params.get("rle") ?? env.get("RLE_MAX_RATIO").asString();
  const rleMaxRatio = rleRaw != null && rleRaw !== '' && Number.isFinite(Number(rleRaw)) ? Math.min(1, Math.max(0, Number(rleRaw))) : DEFAULTS.rleMaxRatio;
  const hwMinPixels = intNonNeg(params.get("hwj")) ?? DEFAULTS.hwMinPixels;
  const ppRaw = params.get("pp") ?? env.get("PANEL_PREP").asString();
  const panelPrep = ppRaw != null && ppRaw !== '' ? /^(1|true|yes|on)$/i.test(ppRaw) : DEFAULTS.panelPrep;
  const maxInflight = intNonNeg(params.get("mif")) ?? DEFAULTS.maxInflight;
  const screencastQuality = clamp(intPos(params.get("scq")) ?? intPos(env.get("SCREENCAST_JPEG_QUALITY").asString()) ?? DEFAULTS.screencastQuality, 1, 100);

  const dimensions = getRotatedDimensions(width, height, rotation);

  return {
    height: dimensions.height,
    width: dimensions.width,
    tileSize,
    fullFrameTileCount,
    fullFrameAreaThreshold,
    fullFrameEvery,
    minFrameInterval,
    everyNthFrame,
    jpegQuality,
    maxBytesPerMessage,
    rotation,
    chroma,
    screencastFormat,
    screencastQuality,
    reducedMotion,
    screencastMode,
    rleMaxRatio,
    hwMinPixels,
    panelPrep,
    maxInflight,
  };
}

export function deviceConfigsEqual(
  a: DeviceConfig,
  b: DeviceConfig,
  eps = 1e-6
): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.tileSize === b.tileSize &&
    a.fullFrameTileCount === b.fullFrameTileCount &&
    Math.abs(a.fullFrameAreaThreshold - b.fullFrameAreaThreshold) <= eps &&
    a.fullFrameEvery === b.fullFrameEvery &&
    a.everyNthFrame === b.everyNthFrame &&
    a.minFrameInterval === b.minFrameInterval &&
    a.jpegQuality === b.jpegQuality &&
    a.maxBytesPerMessage === b.maxBytesPerMessage &&
    a.rotation === b.rotation &&
    a.chroma === b.chroma &&
    a.screencastFormat === b.screencastFormat &&
    a.screencastQuality === b.screencastQuality &&
    a.reducedMotion === b.reducedMotion &&
    a.screencastMode === b.screencastMode &&
    a.rleMaxRatio === b.rleMaxRatio &&
    a.hwMinPixels === b.hwMinPixels &&
    a.panelPrep === b.panelPrep &&
    a.maxInflight === b.maxInflight
  );
}

export function logDeviceConfig(id: string, cfg: DeviceConfig): void {
  const entries: [string, string | number][] = [
    ["width", cfg.width],
    ["height", cfg.height],
    ["tileSize", cfg.tileSize],
    ["fullFrameTileCount", cfg.fullFrameTileCount],
    ["fullFrameAreaThreshold", cfg.fullFrameAreaThreshold.toFixed(3)],
    ["fullFrameEvery", cfg.fullFrameEvery],
    ["everyNthFrame", cfg.everyNthFrame],
    ["minFrameInterval", cfg.minFrameInterval],
    ["jpegQuality", cfg.jpegQuality],
    ["maxBytesPerMessage", cfg.maxBytesPerMessage],
    ["rotation", cfg.rotation],
    ["chroma", cfg.chroma],
    ["screencastFormat", cfg.screencastFormat],
    ["screencastQuality", cfg.screencastQuality],
    ["reducedMotion", String(cfg.reducedMotion)],
    ["screencastMode", cfg.screencastMode],
    ["rleMaxRatio", cfg.rleMaxRatio],
    ["hwMinPixels", cfg.hwMinPixels],
    ["panelPrep", String(cfg.panelPrep)],
    ["maxInflight", cfg.maxInflight],
  ];

  const head = `[client_connect] id=${id}`;
  const body = entries.map(([k, v]) => `  ${k}=${v}`).join('\n');

  console.info(`${head}\n${body}`);
}