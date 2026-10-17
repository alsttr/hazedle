# Hazedle

Guess Singapore's PM2.5 from five live cameras: north, south, east, west and central. A new round starts every 6 hours (12am, 6am, 12pm and 6pm SGT).

Live: https://alsttr.github.io/hazedle/

## How it works

- Everyone plays the same round for 6 hours. Each round is scored on NEA's 1-hour PM2.5 reading stamped at its start, which is the average over the hour before. For example, the 6pm round uses photos taken between 5pm and 6pm and the 6pm reading. It goes live just after 6pm and runs until midnight.
- `scripts/snapshot.mjs` runs before each round. It only keeps a frame if that camera's own capture time is inside the reading's hour, with a margin per source: LTA 2 min, Changi 1 min, Windy 5 min, checked against the clocks burned into the images. Then it waits for that exact reading and writes `site/round/`. If the job starts late, LTA frames come from LTA's history and the other cameras sit that round out. Cameras are listed in `CAMERAS` in preference order. If none is working, that region becomes a "camera offline" blind guess.
  - North: LTA traffic camera at Woodlands (data.gov.sg)
  - South: LTA traffic camera at Sentosa Gateway (data.gov.sg)
  - East: Changi Sailing Club weather camera (rtsp.me poster frame)
  - West: LTA traffic camera at Tuas (data.gov.sg)
  - Central: Midview City webcam, Sin Ming (Windy.com)
- `.github/workflows/snapshot.yml` runs it on a schedule and deploys `site/` to GitHub Pages. Round photos aren't committed. Only the small answer log in `data/history.json` is.
- The workflow is scheduled 50, 35 and 20 minutes before each round, in case GitHub runs it late. A push redeploys the code without changing the current round. To retake photos, run the workflow by hand with **force**.
- The game itself is static: `site/index.html`, `site/app.js` and `site/style.css`. Scores and stats live in each player's browser.

Local: `node scripts/snapshot.mjs --force`, then `python3 -m http.server -d site`.
