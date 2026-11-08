# Deploying the praline scanner (Node.js)

The app is one Node server (`server.js`, no dependencies) that serves the page and forwards photos to Azure. The Azure key only lives on the server.

## Files to upload

```
package.json
server.js
index.html
azure/praline-ids.json
demo/                  (the two Test images photos)
```

Do **not** upload `.env`, `images/`, `azure/results/` or the Python test scripts.

## Environment variables (set these in the host's panel, not in a file)

| Name | Value |
|---|---|
| `AZURE_CU_ENDPOINT` | `https://<your-resource>.services.ai.azure.com` (same as your local `.env`) |
| `AZURE_CU_KEY` | KEY 1 of your Content Understanding resource (Azure portal → resource → Keys and Endpoint) |
| `APP_PASSWORD` | a password you choose. Needed to scan after the free test scan; each phone stays logged in for 30 days |
| `FREE_SCANS_PER_DAY` | optional, default `20`. Cap on free test scans across all visitors per day; `0` turns them off |
| `AZURE_CU_ANALYZER_ID` | `pralineBox` (optional; that's the default) |
| `AZURE_CU_GRID_ANALYZER_ID` | `pralineGrid` (optional; that's the default). Places the labels on the photo |

`PORT` is set by the host automatically.

## Hostinger

Node.js hosting is in hPanel on plans that support Node.js apps. The panel's exact labels may differ from these steps:

1. **Add a Node.js app**, either from a GitHub repo or by uploading a zip of the files above.
2. **Node version:** 18 or newer (20 or 22 recommended).
3. **Entry file:** `server.js`. **Build command:** `npm run build` (only checks the files; nothing to install). **Start command:** `npm start`.
4. **Add the environment variables** above, or upload a `.env` file with the same lines next to `server.js`.
5. **Deploy**, then open the site on your phone. The first scan is free; after that the page asks for the password.

## Security notes

- The browser never sees the Azure key. It only calls `POST /analyze`, and the server adds the key.
- The page and the demo photos are public. Scans need the password (login cookie: HttpOnly, signed, 30 days), except one free test scan. Wrong guesses are limited to 10 per 15 minutes per IP. Changing `APP_PASSWORD` logs every device out; visiting `/logout` logs out one device.
- Free test scan: granted only if this browser hasn't had one (signed cookie), this IP hasn't had one in 24 hours, and fewer than `FREE_SCANS_PER_DAY` were given out today. These counters are kept in memory and reset when the app restarts. Set a budget alert in Azure as the backstop.
- Client IPs come from the last `X-Forwarded-For` entry, the one the host's proxy adds. That's right behind a single proxy (Hostinger). If the app is exposed directly with no proxy in front, clients can forge that header.
- Limits: 30 scans per hour per IP (each scan makes two Azure calls), 10 MB per photo, images only. Only the page itself is served; every other path returns 404.
- HTTPS: use the host's free SSL so the password isn't sent in clear text.
- If the key ever leaks, rotate it in Azure (Keys and Endpoint → Regenerate) and update the env var.

## Local run

```
cp .env.example .env   # fill in values
npm start              # http://localhost:8000
```

`python3 azure/run.py` is still the tuning tool. It uploads `azure/praline-analyzer.json` to Azure and scores the test photos. Run it locally only.
