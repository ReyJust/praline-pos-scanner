# Praline Scanner

Take a photo of a filled praline gift box and get the count of each praline, shown on a replica of the shop's POS button grid. At the till, staff tap the highlighted buttons instead of identifying and counting every piece by eye.

```
 phone photo ──► server.js ──► Azure AI Content Understanding
                    │              ├─ pralineBox   identifies every piece, slot by slot
                    │              └─ pralineGrid  finds where the slot grid sits in the photo
                    ▼
       POS grid replica: buttons highlighted with counts,
       each piece labelled on the photo
```

## Features

- **Camera or gallery.** iPhone HEIC photos are handled. Photos are downscaled on the phone before upload, so uploads are smaller and cost fewer Azure tokens.
- **Counts on the POS grid.** It's a 7×6 column-major layout with page arrows, matching the terminal. Each button shows a badge with its count, and an arrow lights up when the remaining picks are on another page.
- **Labels on the photo.** Each piece gets a short name in a side column, joined to it by a leader line. Tap a label or a POS button to highlight its pair.
- **Unclear pieces are flagged** with their row, column and appearance, so staff can check them by eye.
- **Test images.** Two demo box photos, for trying the app on a computer without a camera.
- **41 pralines** in the catalogue, with box sizes from 1×2 up to 8×8.

## Quick start

You need Node 18 or newer and an Azure AI Content Understanding resource. The server has no npm dependencies.

```bash
cp .env.example .env    # fill in endpoint, key and password
npm start               # http://localhost:8000
```

| Variable | Purpose |
|---|---|
| `AZURE_CU_ENDPOINT` | `https://<your-resource>.services.ai.azure.com` |
| `AZURE_CU_KEY` | Resource key. It stays on the server and never reaches the browser |
| `APP_PASSWORD` | Required to scan after the free test scan |
| `FREE_SCANS_PER_DAY` | Cap on free test scans across all visitors (default `20`, `0` = off) |
| `AZURE_CU_ANALYZER_ID` / `AZURE_CU_GRID_ANALYZER_ID` | Default to `pralineBox` / `pralineGrid` |

The analyzers have to exist on your resource first. `azure/run.py` creates them (see [Tuning](#tuning-the-analyzer)).

## Access policy

Anyone can open the page and the demo photos, but scans cost money, so they're gated:

1. **Logged in:** scan freely. The session is a signed HttpOnly cookie that lasts 30 days.
2. **Not logged in:** one free test scan, only if all three of these hold:
   - this browser hasn't had one (signed cookie)
   - this IP hasn't had one in the last 24 hours
   - the day's free-scan cap isn't used up
3. **Otherwise** the page asks for the password in a dialog, then carries on with the scan.

A free scan comes with a single-use ticket, good for one recognition call plus one grid call within 3 minutes.

Other limits:
- 10 password attempts per 15 minutes per IP
- 60 Azure calls per hour per IP
- 10 MB per photo, images only

The counters are kept in memory and reset when the server restarts, so **set a budget alert in Azure** as the backstop.

## Deploying

The app is one Node process and works on any Node host. [DEPLOY.md](DEPLOY.md) has step-by-step instructions for Hostinger, plus security notes. In short: upload `package.json`, `server.js`, `index.html`, `azure/praline-ids.json` and `demo/`, set the environment variables in the host's panel, and turn on HTTPS.

## Tuning the analyzer

Recognition is driven by the field schemas in `azure/`, not by code:

| File | What it is |
|---|---|
| `praline-analyzer.json` | `pralineBox` schema: box size, then one entry per slot (shell, shape, topping, praline ID) |
| `grid-analyzer.json` | `pralineGrid` schema: reads the grid's position off a 0–100 ruler the page draws around the upload copy |
| `praline-ids.json` | Praline IDs mapped to display names |
| `praline-visual-catalog.md` | Notes on how each praline looks, and the look-alike pairs to watch |
| `test-keys.json` | Answer keys (the correct praline in each slot) for the test photos |
| `run.py` | Uploads the analyzers and scores them against the answer keys |

```bash
python3 azure/run.py                  # upload both analyzers, score every photo in test-keys.json
python3 azure/run.py --no-upload      # re-score with the analyzers already in Azure
python3 azure/run.py images/IMG.HEIC  # run specific photos
```

`run.py` reports exact-slot accuracy and per-praline count accuracy. The test photos go in `images/`, which is git-ignored. Run it locally only, because it uses the key from `.env`.

## Project layout

```
server.js        HTTP server: page, demo photos, access control, Azure proxy
index.html       POS replica, scanning, photo labels (single file, no build)
azure/           analyzer schemas, praline catalogue, tuning script
demo/            two test box photos
DEPLOY.md        hosting guide and security notes
```

## Notes

- The page has a developer panel: press <kbd>D</kbd> to open it.
- Accuracy depends on the photo. A straight top-down shot of the whole box in even light works best.
