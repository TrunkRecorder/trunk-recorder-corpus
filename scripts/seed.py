#!/usr/bin/env python3
"""Upload a manifest's captures through the service and check them, as the decode job would.

    DECODE_TOKEN=… scripts/seed.py <trunk-pro> <manifest> <folder of capture folders> <api>
"""
import concurrent.futures as cf
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.request

PART = 32 * 2**20
bin_path, manifest, root, api = sys.argv[1:5]
here = pathlib.Path(__file__).parent


def call(method, url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers={"User-Agent": "trunk-recorder-corpus", **(headers or {})})
    for attempt in range(6):
        try:
            return json.load(urllib.request.urlopen(req, timeout=300))
        except urllib.error.HTTPError as e:
            if e.code < 500:
                sys.exit(f"{url}: {e.code} {e.read().decode()}")
        except OSError as e:
            print(f"retrying {url}: {e}")
    sys.exit(f"{url}: gave up")


token = call("POST", f"{api}/installs")["token"]
auth = {"Authorization": f"Bearer {token}"}
for entry in json.load(open(manifest))["captures"]:
    folder = pathlib.Path(root) / entry["id"]
    body = {"purpose": "healthy", "tier": entry["tier"], "protocol": entry["protocol"], "note": f"Reference capture: {entry['id']}", "files": [{k: f[k] for k in ("name", "sha256", "bytes")} for f in entry["files"]]}
    made = call("POST", f"{api}/submissions", json.dumps(body).encode(), {**auth, "Content-Type": "application/json"})
    sid = made["id"]
    todo = [f for f in entry["files"] if f["sha256"] not in made["have"]]

    def send(job):
        f, n = job
        with open(folder / f["name"], "rb") as r:
            r.seek(n * PART)
            data = r.read(PART)
        call("PUT", f"{api}/submissions/{sid}/files/{f['name']}/parts/{n + 1}", data, auth)

    jobs = [(f, n) for f in todo for n in range(max(1, -(-f["bytes"] // PART)))]
    with cf.ThreadPoolExecutor(4) as pool:
        list(pool.map(send, jobs))
    call("POST", f"{api}/submissions/{sid}/complete", b"", auth)
    token_row = next(p for p in call("GET", f"{api}/pending", None, {"Authorization": f"Bearer {os.environ['DECODE_TOKEN']}"})["pending"] if p["id"] == sid)
    with tempfile.TemporaryDirectory() as out:
        checked = subprocess.run([bin_path, "tool", "submission", folder, "--out", out], capture_output=True, text=True)
        if checked.returncode != 0:
            sys.exit(f"{entry['id']} failed its check, not reported: {checked.stdout} {checked.stderr}")
        subprocess.run([sys.executable, here / "report.py", out, f"{api}/submissions/{sid}", token_row["results_token"]], check=True, stdout=subprocess.DEVNULL)
    print(f"{entry['id']}: {sid}, uploaded {len(jobs)} parts", flush=True)
