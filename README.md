# Hazedle

Guess Singapore's PM2.5 from five live cameras: north, south, east, west and central. A new round starts every 6 hours (12am, 6am, 12pm and 6pm SGT).

Live: https://alsttr.github.io/hazedle/

## How it works

- `scripts/snapshot.mjs` grabs one photo per region and NEA's latest 1-hour PM2.5 readings, and writes `site/round/`. Cameras are listed in `CAMERAS` in preference order. If none is working, that region becomes a "camera offline" blind guess.
  - North: LTA traffic camera at Woodlands (data.gov.sg)
  - South: LTA traffic camera at Sentosa Gateway (data.gov.sg)
  - East: Changi Sailing Club weather camera (rtsp.me poster frame)
  - West: LTA traffic camera at Tuas (data.gov.sg)
  - Central: Midview City webcam, Sin Ming (Windy.com)
- `.github/workflows/snapshot.yml` runs it on a schedule and deploys `site/` to GitHub Pages. Round photos aren't committed. Only the small answer log in `data/history.json` is.
- A push redeploys the code without changing the current round. To retake photos, run the workflow by hand with **force**.
- The game itself is static: `site/index.html`, `site/app.js` and `site/style.css`. Scores and stats live in each player's browser.

Local: `node scripts/snapshot.mjs --force`, then `python3 -m http.server -d site`.
