#!/usr/bin/env python3
"""Upload the praline analyzer to Azure Content Understanding and score it on test photos.

Usage:
  python3 azure/run.py                 # upload analyzer, run every image in test-keys.json
  python3 azure/run.py --no-upload     # reuse the analyzer already in Azure
  python3 azure/run.py images/IMG_0626.HEIC   # run specific images (scored if they have a key)
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AZ = ROOT / "azure"
API = "2025-11-01"
ANALYZER_ID = "pralineBox"


def load_env():
    env = {}
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env["AZURE_CU_ENDPOINT"].rstrip("/"), env["AZURE_CU_KEY"]


ENDPOINT, KEY = load_env()


def call(method, url, body=None, content_type="application/json"):
    if not url.startswith("http"):
        url = f"{ENDPOINT}/contentunderstanding{url}{'&' if '?' in url else '?'}api-version={API}"
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Ocp-Apim-Subscription-Key": KEY, "Content-Type": content_type})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return r.status, dict(r.headers), (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        return e.code, dict(e.headers), raw


def wait(headers):
    op = headers.get("Operation-Location") or headers.get("operation-location")
    while True:
        s, _, body = call("GET", op)
        status = body.get("status") if isinstance(body, dict) else None
        if status in ("Succeeded", "Failed", "Canceled"):
            return body
        time.sleep(2)


def upload():
    schema = (AZ / "praline-analyzer.json").read_bytes()
    s, h, body = call("PUT", f"/analyzers/{ANALYZER_ID}", schema)
    if s == 409:  # already exists: replace it
        call("DELETE", f"/analyzers/{ANALYZER_ID}")
        s, h, body = call("PUT", f"/analyzers/{ANALYZER_ID}", schema)
    if s >= 300:
        sys.exit(f"Upload failed ({s}):\n{body}")
    res = wait(h)
    if res.get("status") != "Succeeded":
        sys.exit(f"Analyzer build failed:\n{json.dumps(res, indent=2)[:3000]}")
    print(f"Analyzer '{ANALYZER_ID}' ready.")


def image_bytes(path):
    # Phone photos (HEIC, or large JPEGs) are converted and downscaled: fewer tokens, same accuracy.
    if path.suffix.lower() in (".heic", ".heif") or path.stat().st_size > 1_500_000:
        out = Path(tempfile.mkdtemp()) / (path.stem + ".jpg")
        subprocess.run(["sips", "-s", "format", "jpeg", "-Z", "2400", str(path), "--out", str(out)],
                       check=True, capture_output=True)
        return out.read_bytes(), "image/jpeg"
    return path.read_bytes(), "image/png" if path.suffix.lower() == ".png" else "image/jpeg"


def analyze(path):
    data, ctype = image_bytes(path)
    s, h, body = call("POST", f"/analyzers/{ANALYZER_ID}:analyzeBinary", data, ctype)
    if s >= 300:
        sys.exit(f"Analyze failed ({s}):\n{body}")
    res = wait(h)
    (AZ / "results").mkdir(exist_ok=True)
    (AZ / "results" / f"{path.stem}.json").write_text(json.dumps(res, indent=2))
    if res.get("status") != "Succeeded":
        sys.exit(f"Analyze failed:\n{json.dumps(res, indent=2)[:3000]}")
    fields = res["result"]["contents"][0]["fields"]
    pieces = []
    for item in fields["pieces"]["valueArray"]:
        o = item["valueObject"]
        g = lambda k: (o.get(k) or {}).get("valueString") or (o.get(k) or {}).get("valueNumber")
        pieces.append({k: g(k) for k in ("row", "column", "topping", "shape", "shell", "praline")})
    dims = (fields["boxRows"].get("valueNumber"), fields["boxColumns"].get("valueNumber"))
    return dims, pieces


def score(name, dims, pieces, key):
    got = {(int(p["row"]), int(p["column"])): p for p in pieces}
    rows, cols = len(key), len(key[0])
    ok, wrong, unknown = 0, [], 0
    for r in range(rows):
        for c in range(cols):
            want = key[r][c]
            p = got.get((r + 1, c + 1), {})
            have = p.get("praline")
            if want is None:
                total_skip = True
                ok += 1
            elif have == want:
                ok += 1
            else:
                unknown += have == "Unknown"
                wrong.append(f"  r{r+1}c{c+1}: got {have or 'MISSING'} ({p.get('shell')}/{p.get('shape')}/'{p.get('topping')}'), want {want}")
    total = rows * cols
    print(f"\n{name}: {ok}/{total} correct  ({unknown} Unknown, {total-ok-unknown} wrong)  grid {dims[0]}x{dims[1]} (want {rows}x{cols})")
    print("\n".join(wrong) if wrong else "  all correct")
    return ok, total


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    keys = json.loads((AZ / "test-keys.json").read_text())
    if "--no-upload" not in sys.argv:
        upload()
    targets = [Path(a) if Path(a).is_absolute() else ROOT / a for a in args] or [ROOT / "images" / k for k in keys]
    tot_ok = tot = 0
    for path in targets:
        dims, pieces = analyze(path)
        if path.name in keys:
            o, t = score(path.name, dims, pieces, keys[path.name])
            tot_ok, tot = tot_ok + o, tot + t
        else:
            counts = Counter(p["praline"] for p in pieces)
            print(f"\n{path.name}: grid {dims[0]}x{dims[1]}, {len(pieces)} pieces (no answer key)")
            for n, c in counts.most_common():
                print(f"  {c:3}  {n}")
    if tot:
        print(f"\nOVERALL {tot_ok}/{tot} = {100*tot_ok/tot:.0f}%")


if __name__ == "__main__":
    main()
