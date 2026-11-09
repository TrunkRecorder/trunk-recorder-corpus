#!/usr/bin/env python3
"""Send a decode job's results: its waterfalls, then the verdict. No checks file means it failed."""
import json
import pathlib
import sys
import urllib.request

out, url, token = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]


def send(method, path, data, kind):
    req = urllib.request.Request(url + path, data=data, method=method, headers={"Authorization": f"Bearer {token}", "Content-Type": kind, "User-Agent": "trunk-recorder-corpus"})
    urllib.request.urlopen(req).read()


checks_path = out / "checks.json"
if not checks_path.exists():
    # (The check itself broke, not the capture: left waiting, for the next run.)
    sys.exit("No results to report.")
checks = json.loads(checks_path.read_text())
if checks.get("ok"):
    for f in sorted(out.glob("waterfall-*.bin")):
        send("PUT", f"/waterfall/{f.stem.split('-')[1]}", f.read_bytes(), "application/octet-stream")
    # (What a recording decoded to, in case it becomes a test. Hashes and counts.)
    expected = out / "expected.jsonl"
    if expected.exists():
        send("PUT", "/expected", expected.read_bytes(), "text/plain")
send("POST", "/results", json.dumps({"ok": bool(checks.get("ok")), "checks": checks}).encode(), "application/json")
print(json.dumps(checks))
