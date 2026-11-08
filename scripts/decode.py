#!/usr/bin/env python3
"""Check every submission that's waiting: fetch it, run trunk-pro on it, report."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import urllib.request

bin_path, api = sys.argv[1:3]
here = pathlib.Path(__file__).parent


def get(url, token):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "User-Agent": "trunk-recorder-corpus"})))


# (A release older than the tool can't judge anything: wait for one that can.)
probe = subprocess.run([bin_path, "tool", "submission"], capture_output=True, text=True)
if "no such tool" in probe.stdout + probe.stderr:
    sys.exit(print("This release has no `tool submission` yet."))

waiting = get(f"{api}/pending", os.environ["DECODE_TOKEN"])["pending"]
print(f"{len(waiting)} waiting")
for w in waiting:
    print(f"::add-mask::{w['results_token']}")
for w in waiting:
    work = pathlib.Path("/tmp/job") / w["id"]
    (work / "capture").mkdir(parents=True)
    (work / "submission.json").write_text(json.dumps(get(f"{api}/submissions/{w['id']}", w["results_token"])))
    fetched = subprocess.run([sys.executable, here / "fetch.py", work / "submission.json", work / "capture"])
    if fetched.returncode != 0:
        print(f"{w['id']}: couldn't fetch it")
        continue
    subprocess.run([bin_path, "tool", "submission", work / "capture", "--out", work / "out"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([sys.executable, here / "report.py", work / "out", f"{api}/submissions/{w['id']}", w["results_token"]])
    shutil.rmtree(work, ignore_errors=True)
