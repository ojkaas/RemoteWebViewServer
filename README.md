[![Stand With Ukraine](https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/banner-direct-single.svg)](https://stand-with-ukraine.pp.ua)

# Remote WebView Server

> Fork of [strange-v/RemoteWebViewServer](https://github.com/strange-v/RemoteWebViewServer) with fixes for high-framerate streaming to ESP32 devices over Ethernet.

Headless browser that renders target web pages (e.g., Home Assistant dashboards) and streams them as image tiles over WebSocket to lightweight [clients](https://github.com/ojkaas/RemoteWebViewClient) (ESP32 displays). The server supports multiple simultaneous clients, each with its own screen resolution, orientation, and per-device settings.

![Remote WebView](/images/tiled_preview.png)

## What Changed vs Upstream

> [!WARNING]
> These changes were heavily vibe-coded with AI assistance. They work on my local setup and my specific hardware, but have not been extensively tested beyond that. Use at your own risk.

This fork fixes display latency issues that occur when the server produces frames faster than the client can consume them (e.g., CSS animations at ~48 fps over WiFi/Ethernet):

- **Rate-limited broadcaster** — 100 ms minimum gap between frames, adaptive buffer-drain pacing, and stale frame dropping to prevent TCP buffer bloat that caused ~40 s display latency
- **Processing mutex** — prevents concurrent frame encoding so frames are processed in order
- **DOM MutationObserver capture** — injects a `MutationObserver` via CDP binding to detect DOM-only changes that Chrome's screencast misses, triggering an immediate `Page.captureScreenshot`
- **Fallback screenshot timer** — captures static pages where Chrome's screencast stops producing frames (800 ms idle delay, then 2 s periodic recheck)
- **Parallel tile encoding** — `Promise.all` for tile encoding instead of sequential loop
- **4:4:4 chroma subsampling** — eliminates visible JPEG block artifacts on gradients (was 4:2:0)
- **Navigation URL tracking fix** — `dev.url` is now updated after `Page.navigate`, preventing repeated navigations to the same URL
- **Tap event fix** — touch protocol parser now accepts Tap events (was rejecting `kind > Up`, should be `kind > Tap`)
- **Tuned defaults** — `fullFrameAreaThreshold` 0.5 → 0.25, `fullFrameEvery` 50 → 15 for more responsive updates

## Features

- Renders pages in a headless Chromium environment and streams diffs as tiles over WebSocket
- Tile merging with FNV-1a change detection to reduce packet count and CPU load
- Full-frame fallback on cadence/threshold or on demand
- Configurable tile size, JPEG quality, WS message size, and min frame interval
- Per-client settings: each connection can supply its own width, height, tileSize, jpegQuality, maxBytesPerMessage, etc.
- Hot reconfigure: reconnecting with new params reconfigures the device session and triggers a full-frame refresh
- No viewers = no work: frames are ACK'd to keep Chromium streaming, but tiles aren't encoded/queued when there are no listeners
- Touch event bridging (down/move/up/tap) — scrolling supported
- Client-driven navigation: the client can control which page to open
- Built-in self-test page to visualize and measure render time
- Health endpoint for container orchestration
- Optional DevTools access via TCP proxy
- Home Assistant add-on support

## ESPHome Configuration Example

```yaml
external_components:
  - source: github://ojkaas/RemoteWebViewClient@main
    refresh: 0s
    components: [remote_webview]

remote_webview:
  id: rwv
  server: !secret rwv_server
  url: !secret rwv_url
  big_endian: false
  jpeg_quality: 85
  max_bytes_per_msg: 14336
  tile_size: 32
  full_frame_tile_count: 4
  full_frame_area_threshold: 0.25
  full_frame_every: 15
  min_frame_interval: 80
```

See the [RemoteWebViewClient](https://github.com/ojkaas/RemoteWebViewClient) README for full setup and configuration options.

## Accessing the Server's Tab with Chrome DevTools

1. Make sure your server exposes the DevTools (CDP) port (e.g., 9222).
   - If you use a pure Docker container, make sure you have configured and started `debug-proxy`
   - If HA OS addon is used, enable `expose_debug_proxy`
1. In Chrome, go to `chrome://inspect/#devices` → **Configure…** → add your host: `hostname_or_ip:9222`.
1. You should see the page the server opened. Click **inspect** to open a full DevTools window for that tab.

## Image Tags & Versioning

Images are published to **GitHub Container Registry** (GHCR).

- `latest` — newest stable release
- `beta` — newest pre-release (rolling)
- Semantic versions: `X.Y.Z`, plus convenience tags `X.Y`, `X` on stable releases

```
docker pull ghcr.io/ojkaas/remote-webview-server:latest
```

## Docker Compose Example

```yaml
services:
  rwvserver:
    image: ghcr.io/ojkaas/remote-webview-server:latest  # use :beta for pre-release
    container_name: remote-webview-server
    restart: unless-stopped
    environment:
      TILE_SIZE: 32
      FULL_FRAME_TILE_COUNT: 4
      FULL_FRAME_AREA_THRESHOLD: 0.25
      FULL_FRAME_EVERY: 15
      EVERY_NTH_FRAME: 1
      MIN_FRAME_INTERVAL_MS: 80
      JPEG_QUALITY: 85
      MAX_BYTES_PER_MESSAGE: 14336
      WS_PORT: 8081
      DEBUG_PORT: 9221 # internal debug port
      HEALTH_PORT: 18080
      PREFERS_REDUCED_MOTION: false
      USER_DATA_DIR: /pw-data
      BROWSER_LOCALE: "en-US"
    ports:
      - "8081:8081"                   # WebSocket stream
      - "9222:9222"                   # external DevTools via socat
    expose:
      - "18080"                       # health endpoint (internal)
      - "9221"                        # internal DevTools port
    volumes:
      - /opt/volumes/esp32-rdp/pw-data:/pw-data
    shm_size: 1gb
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:18080 || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 5
      start_period: 10s

  debug-proxy:
    image: alpine/socat
    container_name: remote-webview-server-debug
    restart: unless-stopped
    network_mode: "service:rwvserver"
    depends_on:
      rwvserver:
        condition: service_healthy
    command:
      - "-d"
      - "-d"
      - "TCP-LISTEN:9222,fork,reuseaddr,keepalive" # external DevTools port
      - "TCP:127.0.0.1:9221"
```

## Related Projects

| Project | Description |
|---------|-------------|
| [ojkaas/RemoteWebViewClient](https://github.com/ojkaas/RemoteWebViewClient) | Fork of the ESPHome client component with ESP32-P4 HW JPEG fixes |
| [strange-v/RemoteWebViewServer](https://github.com/strange-v/RemoteWebViewServer) | Upstream server project |
| [strange-v/RemoteWebViewClient](https://github.com/strange-v/RemoteWebViewClient) | Upstream client project |
