#!/usr/bin/env python3
"""Send a decode job's results: its waterfalls, then the verdict. No checks file means it failed."""
import json
import pathlib
import sys
import urllib.request

out, url, token = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]


def send(method, path, data, kind):
    req = urllib.request.Request(url + path, data=data, method=method, headers={"Authorization": f"Bearer {token}", "Content-Type": kind})
    urllib.request.urlopen(req).read()


checks_path = out / "checks.json"
checks = json.loads(checks_path.read_text()) if checks_path.exists() else {"ok": False, "why": "The check didn't finish."}
if checks.get("ok"):
    for f in sorted(out.glob("waterfall-*.bin")):
        send("PUT", f"/waterfall/{f.stem.split('-')[1]}", f.read_bytes(), "application/octet-stream")
send("POST", "/results", json.dumps({"ok": bool(checks.get("ok")), "checks": checks}).encode(), "application/json")
print(json.dumps(checks))
