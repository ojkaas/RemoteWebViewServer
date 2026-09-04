import env from "env-var";
import { mkdir } from 'fs/promises';
import { chromium } from 'playwright-core';
import { initCdpRootAsync, waitForCdpReadyAsync } from './cdpRoot.js';

const DEBUG_PORT = +(process.env.DEBUG_PORT || 9221);
const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');
const USER_DATA_DIR = process.env.USER_DATA_DIR || (process.platform === 'win32'
  ? 'C:\\Temp\\remotewebview-profile'
  : '/var/temp/remotewebview-profile');
const BROWSER_LOCALE = env.get("BROWSER_LOCALE").default("en-US").asString();
// Extra Chromium switches, space separated, e.g. "--disable-gpu-compositing".
// CHROME_ARGS_PRESET selects a built-in set so a variant can be shipped as an
// image without touching the compose file: default | swcompositing | nogpu
const CHROME_EXTRA_ARGS = (env.get("CHROME_EXTRA_ARGS").default("").asString()).split(/\s+/).filter(Boolean);
const CHROME_ARGS_PRESET = env.get("CHROME_ARGS_PRESET").default(process.env.CHROME_ARGS_PRESET_BUILD ?? "default").asString();
const PRESETS: Record<string, string[]> = {
  default: [],
  swcompositing: ['--disable-gpu-compositing'],
  nogpu: ['--disable-gpu', '--disable-gpu-compositing'],
  // Intel iGPU via the DRM render node (no X/Wayland): ANGLE on EGL/GBM.
  gpu: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-zero-copy', '--use-gl=angle', '--use-angle=gl-egl', '--enable-features=VaapiVideoDecodeLinuxGL'],
};

async function fetchJsonVersionAsync(): Promise<{ webSocketDebuggerUrl: string } | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function startHeadlessIfNeededAsync(): Promise<void> {
  const info = await fetchJsonVersionAsync();
  if (info?.webSocketDebuggerUrl) return;

  await mkdir(USER_DATA_DIR, { recursive: true });
  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--no-sandbox',
    '--force-device-scale-factor=1',
    '--headless=new',
    ...(PREFERS_REDUCED_MOTION ? ['--force-prefers-reduced-motion'] : []),
    ...(PRESETS[CHROME_ARGS_PRESET] ?? []),
    ...CHROME_EXTRA_ARGS,
  ];
  console.log(`[browser] chromium args preset=${CHROME_ARGS_PRESET} extra=${JSON.stringify(CHROME_EXTRA_ARGS)}`);

  if (PREFERS_REDUCED_MOTION)
    console.log('[browser] Launching with prefers-reduced-motion');

  await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    locale: BROWSER_LOCALE,
    args,
  });

  const t0 = Date.now();
  for (;;) {
    const j = await fetchJsonVersionAsync();
    if (j?.webSocketDebuggerUrl) return;
    if (Date.now() - t0 > 10000) throw new Error('Timed out waiting for CDP /json/version');
    await new Promise(r => setTimeout(r, 200));
  }
}

export async function bootstrapAsync(): Promise<void> {
  await startHeadlessIfNeededAsync();

  const info = await fetchJsonVersionAsync();
  if (!info?.webSocketDebuggerUrl) throw new Error('CDP not available');

  await initCdpRootAsync(info.webSocketDebuggerUrl);
  await waitForCdpReadyAsync();
  console.log('[cdp] ready:', info.webSocketDebuggerUrl);
}
