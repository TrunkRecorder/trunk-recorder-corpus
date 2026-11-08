#!/usr/bin/env python3
"""Download a submission's files, checking each one's hash and that its name is safe."""
import hashlib
import json
import pathlib
import re
import shutil
import sys
import urllib.request

submission, out = sys.argv[1:3]
for f in json.load(open(submission))["files"]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", f["name"]) or not re.fullmatch(r"[0-9a-f]{64}", f["sha256"]):
        sys.exit(f"Bad file entry: {f['name']!r}")
    path = pathlib.Path(out) / f["name"]
    # (Cloudflare refuses Python's own user agent.)
    with urllib.request.urlopen(urllib.request.Request(f["url"], headers={"User-Agent": "trunk-recorder-corpus"})) as r, open(path, "wb") as w:
        shutil.copyfileobj(r, w)
    h = hashlib.sha256()
    with open(path, "rb") as r:
        while chunk := r.read(1 << 20):
            h.update(chunk)
    if h.hexdigest() != f["sha256"]:
        sys.exit(f"{f['name']} doesn't match its hash")
