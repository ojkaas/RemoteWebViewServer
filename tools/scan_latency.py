#!/usr/bin/env python3
"""End-to-end scan-to-screen latency for the barcode display.

POSTs a scan to the frontend, then polls the server's /stats (every 20 ms)
until the device has received AND acked a new frame. That is the moment the
product screen is on the glass. Then clears the product (idle screen) and
measures that transition too. Repeats N times and prints medians.

    python tools/scan_latency.py --server 192.168.178.62:8081 --frontend 192.168.178.62:3811 --device esp32-... [--runs 5]
"""
import argparse
import json
import statistics
import sys
import time
import urllib.request

BARCODES = ["5901234123457", "4006381333931", "8710398527943", "5000112628036"]


def get_dev(server, device_id):
    with urllib.request.urlopen(f"http://{server}/stats", timeout=5) as r:
        for d in json.load(r)["devices"]:
            if d["id"] == device_id:
                return d
    return None


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=5) as r:
        return r.status


def measure_transition(server, device_id, fire, timeout_s=5.0):
    """fire() triggers the page change; returns (ms until first new frame acked, frames, bytes) or None."""
    before = get_dev(server, device_id)
    tb = before["transport"]
    fid0, acks0, bytes0 = before["frameId"], tb["acksReceived"], tb["bytesSent"]
    t0 = time.perf_counter()
    fire()
    first_ack_ms = None
    last = before
    while time.perf_counter() - t0 < timeout_s:
        d = get_dev(server, device_id)
        if d:
            last = d
            t = d["transport"]
            # a real screen transition is a big frame; idle-animation frames are ~15-25 KB
            if first_ack_ms is None and d["frameId"] > fid0 and t["acksReceived"] > acks0 and t["bytesSent"] - bytes0 >= 15 * 1024:
                first_ack_ms = (time.perf_counter() - t0) * 1000
                # keep polling briefly to count the frames the transition produced
                t_end = time.perf_counter() + 0.6
                while time.perf_counter() < t_end:
                    d = get_dev(server, device_id) or d
                    time.sleep(0.05)
                last = d
                break
        time.sleep(0.02)
    if first_ack_ms is None:
        return None
    return first_ack_ms, last["frameId"] - fid0, last["transport"]["bytesSent"] - bytes0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True)
    ap.add_argument("--frontend", required=True)
    ap.add_argument("--device", required=True)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--label", default="")
    args = ap.parse_args()

    scan_ms, clear_ms = [], []
    for i in range(args.runs):
        bc = BARCODES[i % len(BARCODES)]
        r = measure_transition(args.server, args.device, lambda: post(f"http://{args.frontend}/api/scan", {"barcode": bc}))
        if r is None:
            print(f"run {i + 1}: scan -> NO FRAME within 5 s"); return 1
        scan_ms.append(r[0]); print(f"run {i + 1}: scan {bc}: product on screen after {r[0]:.0f} ms ({r[1]} frames, {r[2] // 1024} KB)")
        time.sleep(1.5)
        r = measure_transition(args.server, args.device, lambda: post(f"http://{args.frontend}/api/action", {"barcode": bc, "action": "dismiss"}))
        if r is None:
            print(f"run {i + 1}: clear -> NO FRAME within 5 s"); return 1
        clear_ms.append(r[0]); print(f"run {i + 1}: clear: idle screen after {r[0]:.0f} ms ({r[1]} frames, {r[2] // 1024} KB)")
        time.sleep(1.5)
    print(f"{args.label or 'scan-latency'}: scan->screen median {statistics.median(scan_ms):.0f} ms (min {min(scan_ms):.0f}, max {max(scan_ms):.0f}); "
          f"clear->idle median {statistics.median(clear_ms):.0f} ms (min {min(clear_ms):.0f}, max {max(clear_ms):.0f}); runs={args.runs}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
