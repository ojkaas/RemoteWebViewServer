#!/usr/bin/env python3
"""Sample a device's throughput and timing from GET /stats over a window.

    python tools/measure.py --server 192.168.178.62:8081 --device esp32-... [--seconds 30]
        [--wait-tile 128] [--wait-version 1.1.11] [--settle 25] [--label E2]

Waits (optionally) until the server version / device tile size matches and the
device has acked a few frames, settles, then prints one line with fps,
bytes/frame, ack latency for the window, and the server's per-frame timing.
"""
import argparse
import json
import subprocess
import sys
import time
import urllib.request


def stats(server: str) -> dict:
    with urllib.request.urlopen(f"http://{server}/stats", timeout=5) as r:
        return json.load(r)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True)
    ap.add_argument("--device")
    ap.add_argument("--seconds", type=int, default=30)
    ap.add_argument("--settle", type=int, default=25)
    ap.add_argument("--wait-tile", type=int)
    ap.add_argument("--wait-version")
    ap.add_argument("--wait-timeout", type=int, default=150)
    ap.add_argument("--label", default="")
    ap.add_argument("--cpu-host", help="ssh host (or 'local') to sample chrome/node CPU with top during the window")
    args = ap.parse_args()

    def dev():
        s = stats(args.server)
        if args.wait_version and s.get("version") != args.wait_version:
            return None, s
        for d in s.get("devices", []):
            if args.device and d["id"] != args.device:
                continue
            return d, s
        return None, s

    t0 = time.time()
    while True:
        try:
            d, s = dev()
        except Exception:
            d, s = None, {}
        t = (d or {}).get("transport") or {}
        ok = d is not None and t.get("clients", 0) >= 1 and t.get("acksReceived", 0) > 10
        if ok and args.wait_tile and d["tileSize"] != args.wait_tile:
            ok = False
        if ok:
            break
        if time.time() - t0 > args.wait_timeout:
            print("FAIL: device not ready (version/tile/acks)", file=sys.stderr)
            return 1
        time.sleep(2)
    if args.settle:
        time.sleep(args.settle)

    a, _ = dev()
    cpu = None
    if args.cpu_host:
        # two top samples args.seconds apart; the second one reflects the window
        cmd = (f"top -bn2 -d {args.seconds} -w 200 | awk '/^top/{{n++}} n==2 && /(chrome|node|headless)/{{c[$12]+=$9}} END{{for(k in c) printf \"%s=%.0f \", k, c[k]}}'; "
               f"printf 'load=%s' \"$(cut -d' ' -f1 /proc/loadavg)\"")
        try:
            argv = ["bash", "-c", cmd] if args.cpu_host == "local" else ["ssh", "-o", "BatchMode=yes", args.cpu_host, cmd]
            cpu = subprocess.run(argv, capture_output=True, text=True, timeout=args.seconds + 30).stdout.strip()
        except Exception as e:
            cpu = f"cpu-sample-failed:{e}"
    else:
        time.sleep(args.seconds)
    b, s = dev()
    ta, tb = a["transport"], b["transport"]
    n = tb["acksReceived"] - ta["acksReceived"]
    nf = max(1, tb["framesSent"] - ta["framesSent"])
    avg_ack = (tb["avgAckLatencyMs"] * tb["acksReceived"] - ta["avgAckLatencyMs"] * ta["acksReceived"]) / n if n else float("nan")
    print(f"{args.label or 'sample'} [{s.get('version')} tile={b['tileSize']} q={b['jpegQuality']} chroma={b.get('chroma')} sc={b.get('screencastFormat')}] "
          f"{args.seconds}s: fps={nf / args.seconds:.1f} bytes/frame={(tb['bytesSent'] - ta['bytesSent']) // nf} "
          f"avgAck={avg_ack:.0f}ms decode={b.get('avgDecodeMs')}ms diffEncode={b.get('avgDiffEncodeMs')}ms (hash={b.get('avgHashMs')} enc={b.get('avgEncodeMs')} rects={b.get('avgRectsPerFrame')}) "
          f"captures={b['screencastFrames'] - a['screencastFrames']} timeouts={tb['ackTimeouts'] - ta['ackTimeouts']}"
          + (f" cpu%[{cpu}]" if cpu is not None else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
