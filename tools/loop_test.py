#!/usr/bin/env python3
"""Closed-loop test for a Remote WebView device.

Reads the server's GET /stats, kicks the device off by connecting with its
own device id (the server closes the older socket), then verifies through
/stats alone that the device reconnected, received the forced full frame and
acked it. Needs only the `websockets` package.

    python tools/loop_test.py --server 192.168.178.62:8081 --device esp32-80f1b2d0b18b
    python tools/loop_test.py --server 192.168.178.62:8081 --watch      # live stats
"""
import argparse
import asyncio
import json
import sys
import time
import urllib.request


def get_stats(server: str) -> dict:
    with urllib.request.urlopen(f"http://{server}/stats", timeout=5) as r:
        return json.load(r)


def find_device(stats: dict, device_id: str):
    for d in stats.get("devices", []):
        if d["id"] == device_id:
            return d
    return None


def fmt(d: dict) -> str:
    t = d.get("transport") or {}
    return (f"clients={t.get('clients')} ack={int(bool(t.get('ackMode')))} "
            f"fps={t.get('fps')} sent={t.get('framesSent')} acks={t.get('acksReceived')} "
            f"ackLat={t.get('lastAckLatencyMs')}ms avgAck={t.get('avgAckLatencyMs')}ms flush={t.get('avgFlushMs')}ms "
            f"timeouts={t.get('ackTimeouts')} inflight={t.get('inflightCount')}/{t.get('maxInflight')} fid={d.get('frameId')} "
            f"proc={d.get('lastProcessMs')}ms sc={d.get('screencastFrames')} "
            f"skip={d.get('skippedUnchanged')} url={d.get('url')}")


async def kick(server: str, device: dict) -> None:
    import websockets  # type: ignore
    uri = (f"ws://{server}/?id={device['id']}&w={device['width']}&h={device['height']}"
           f"&ts={device['tileSize']}&q={device['jpegQuality']}&mfi={device['minFrameInterval']}")
    async with websockets.connect(uri, max_size=None):
        await asyncio.sleep(0.2)


def wait_for(server: str, device_id: str, pred, timeout_s: float, label: str):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout_s:
        try:
            last = find_device(get_stats(server), device_id)
            if last and pred(last):
                return last, time.time() - t0
        except Exception as e:  # server restarting etc.
            print(f"  ({label}: stats unavailable: {e})")
        time.sleep(0.5)
    return last, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True, help="host:port of the WebSocket server")
    ap.add_argument("--device", help="device id, e.g. esp32-80f1b2d0b18b (default: the only device)")
    ap.add_argument("--watch", action="store_true", help="print stats every 2 s instead of testing")
    ap.add_argument("--no-kick", action="store_true", help="only report, do not kick the device")
    args = ap.parse_args()

    stats = get_stats(args.server)
    print(f"server {stats.get('version')} up {stats.get('uptimeMs', 0) // 1000}s, devices={len(stats.get('devices', []))}")
    if not stats.get("devices"):
        print("FAIL: no devices on server")
        return 1
    device_id = args.device or stats["devices"][0]["id"]

    if args.watch:
        while True:
            d = find_device(get_stats(args.server), device_id)
            print(time.strftime("%H:%M:%S"), fmt(d) if d else "device gone")
            time.sleep(2)

    d = find_device(stats, device_id)
    if not d:
        print(f"FAIL: device {device_id} not found; have {[x['id'] for x in stats['devices']]}")
        return 1
    print("before:", fmt(d))
    t = d["transport"] or {}
    ok = True
    if (t.get("clients") or 0) < 1:
        print("FAIL: device has no connected client")
        return 1
    if not t.get("ackMode"):
        print("WARN: client is not in ack mode (old firmware?)")
    if args.no_kick:
        return 0

    # dev.frameId is monotonic for the life of the device session, unlike the
    # transport counters which a server restart resets.
    fid_before = d["frameId"]

    print("kicking device by connecting with its id ...")
    asyncio.run(kick(args.server, d))

    d2, dt = wait_for(args.server, device_id,
                      lambda x: (x["transport"] or {}).get("clients", 0) >= 1
                      and x["frameId"] > fid_before,
                      timeout_s=25, label="reconnect")
    if dt is None:
        print("FAIL: device did not reconnect and receive a frame within 25 s")
        print("last:", fmt(d2) if d2 else "device gone")
        return 1
    print(f"PASS: reconnected and received forced frame after {dt:.1f}s")

    if t.get("ackMode"):
        acks_at_reconnect = (d2["transport"] or {}).get("acksReceived", 0)
        d3, dt2 = wait_for(args.server, device_id,
                           # two acks after the reconnect frame proves the ack path is live;
                           # inflight rarely reads 0 on an animating page with pipelining
                           lambda x: (x["transport"] or {}).get("acksReceived", 0) >= acks_at_reconnect + 2,
                           timeout_s=10, label="ack")
        if dt2 is None:
            print("FAIL: reconnect frame was not acked within 10 s")
            print("last:", fmt(d3) if d3 else "device gone")
            ok = False
        else:
            print(f"PASS: reconnect frame acked ({(d3['transport'] or {}).get('lastAckLatencyMs')} ms)")

    time.sleep(3)
    d4 = find_device(get_stats(args.server), device_id)
    print("after: ", fmt(d4) if d4 else "device gone")
    if d4 and (d4["transport"] or {}).get("ackTimeouts", 0) > t.get("ackTimeouts", 0):
        print("WARN: ack timeouts increased during the test")
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
