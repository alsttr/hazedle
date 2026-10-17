// Takes a round's five camera photos and the PM2.5 readings they're scored against.
// Writes site/round/round.json and site/round/<region>.jpg. Node 20+, no dependencies.
//
// Matching photos to readings
//   NEA's 1-hour PM2.5 stamped e.g. 12:00 is the average over 11:00-12:00; it appears
//   a minute after 12:00 (and is re-issued at 12:45). So the job runs a little before a
//   round starts: it takes photos now, keeps only frames whose own capture time falls
//   inside the current clock hour, then waits for that hour's reading and scores
//   against it. Every photo in a round was taken inside the hour its answer averages.
//
// Rounds last 6 hours and start 00:00, 06:00, 12:00 and 18:00 SGT. Every round is
// scored on the reading stamped at its start, so the 6pm round (live 6pm-12am, the same
// photos for everyone) uses photos from 5-6pm and NEA's 6pm reading. The job is
// scheduled before the hour; if it runs late, LTA cameras come from LTA's history and
// the live-only cameras sit the round out. If the live site already has the round
// (e.g. a redeploy after a code change), its photos and answers are reused.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = new URL('../site/round/', import.meta.url);
const HISTORY = new URL('../data/history.json', import.meta.url);
const LIVE = process.env.LIVE_URL || 'https://alsttr.github.io/hazedle/';
const UA = { 'User-Agent': 'Mozilla/5.0 (Hazedle snapshot; +https://alsttr.github.io/hazedle/)' };
const HOUR = 3600e3;
const MIN = 60e3;
const ROUND_HOURS = 6;
const SGT = 8 * HOUR;
const FORCE = process.argv.includes('--force');
const REDEPLOY = process.argv.includes('--redeploy'); // keep whatever round is live
const RETRY_EVERY = 2 * MIN; // re-poll a camera whose frame isn't inside the hour yet
const PHOTO_CUTOFF = 1 * MIN; // stop trying for photos this long before the hour ends
const READING_DEADLINE = 70 * MIN; // after the hour ends, give up waiting for NEA

// Only cameras that look out to a horizon (not down at a road), so the haze is judgeable.
// Each round tries a region's cameras in a different order, so the view can change from
// round to round; the first with a frame inside the hour wins.
const LTA = 'LTA traffic camera via data.gov.sg';
const CAMERAS = {
  north: [
    { kind: 'lta', id: '2701', place: 'Woodlands Causeway', credit: LTA },
    { kind: 'lta', id: '2702', place: 'Woodlands Checkpoint', credit: LTA },
  ],
  south: [
    // 4799 (also Sentosa Gateway) points down at the road, so it's left out.
    { kind: 'lta', id: '4798', place: 'Sentosa Gateway, towards Mount Faber', credit: LTA },
  ],
  east: [
    { kind: 'rtspme', id: 'iBdQrE7r', place: 'Changi Sailing Club', credit: 'Changi Sailing Club weather camera' },
  ],
  west: [
    { kind: 'lta', id: '4703', place: 'Tuas Second Link', credit: LTA },
    { kind: 'lta', id: '4713', place: 'Tuas Checkpoint', credit: LTA },
  ],
  central: [
    { kind: 'windy', id: '1369190454', place: 'Sin Ming (Midview City)', credit: 'Midview City webcam via Windy.com' },
  ],
};
// Deterministic shuffle per round, so a retried run picks the same order.
function orderFor(list, seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return list
    .map((c, i) => ({ c, k: Math.imul(h ^ (i + 1) * 2654435761, 2246822519) >>> 0 }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.c);
}
const REGIONS = ['north', 'south', 'east', 'west', 'central'];

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const windowStart = (t) => {
  const sgt = t + SGT;
  return sgt - (sgt % (ROUND_HOURS * HOUR)) - SGT;
};
const roundId = (start) => {
  const d = new Date(start + SGT);
  return d.toISOString().slice(0, 10) + '-' + String(d.getUTCHours()).padStart(2, '0');
};
const sgtTime = (t) => new Date(t + SGT).toISOString().slice(11, 19);
// NEA timestamps look like 2026-10-17T12:00:00+08:00
const neaStamp = (t) => new Date(t + SGT).toISOString().slice(0, 19) + '+08:00';

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getImage(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers }, cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 5000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(`not a usable JPEG: ${url}`);
  const lm = r.headers.get('last-modified');
  return { buf, lastModified: lm ? Date.parse(lm) : null };
}

// Each fetcher returns the frame, the time its source reports for it, and how much
// earlier than that the photo may really have been taken (checked against the clocks
// burned into the Changi and Midview frames).
async function lta(id, from, to) {
  // LTA keeps history, so a late run can still fetch frames from the right hour.
  const late = Date.now() >= to - PHOTO_CUTOFF;
  const q = late ? `?date_time=${new Date(to - 30 * MIN + SGT).toISOString().slice(0, 19)}` : '';
  const feed = await getJSON('https://api.data.gov.sg/v1/transport/traffic-images' + q);
  const cam = feed.items[0].cameras.find((c) => c.camera_id === id);
  if (!cam) throw new Error('not in feed');
  const { buf } = await getImage(cam.image);
  return { buf, reportedAt: Date.parse(cam.timestamp), lag: 2 * MIN, source: late ? 'LTA history' : 'feed timestamp' };
}
async function windy(id) {
  const { buf, lastModified } = await getImage(`https://images-webcams.windy.com/${id.slice(-2)}/${id}/current/full/${id}.jpg`);
  if (!lastModified) throw new Error('no Last-Modified, capture time unknown');
  // Last-Modified is the upload time; the time burned into the frame has run 3-9 min
  // earlier (15:57 vs 16:01, 17:27 vs 17:36 on 17 Oct 2026), so allow 15.
  return { buf, reportedAt: lastModified, lag: 15 * MIN, source: 'Last-Modified' };
}
async function rtspme(id) {
  const ref = { Referer: `https://rtsp.me/embed/${id}/` };
  const embed = await getJSON(`https://rtsp.me/api/embed/${id}/token/`, { headers: ref });
  const stream = await getJSON(`${embed.url}/token/${embed.token}`, { headers: ref });
  const { buf, lastModified } = await getImage(stream.poster, ref);
  if (!lastModified) throw new Error('no Last-Modified, capture time unknown');
  // The poster refreshes every ~30 s; its burned-in clock is within seconds of Last-Modified.
  return { buf, reportedAt: lastModified, lag: 1 * MIN, source: 'Last-Modified' };
}
const FETCHERS = { lta, windy, rtspme };

// Photos for every region, each taken inside [from, to). Retries until the cutoff.
async function takePhotos(from, to, seed) {
  const shots = {};
  const cutoff = to - PHOTO_CUTOFF;
  // Too early for this hour (manual run): wait until frames from it can exist.
  const earliest = from + 6 * MIN;
  if (Date.now() < earliest) {
    console.log(`Waiting ${Math.round((earliest - Date.now()) / MIN)} min for the photo hour to begin`);
    await sleep(earliest - Date.now());
  }
  while (true) {
    for (const region of REGIONS) {
      if (shots[region]) continue;
      for (const cam of orderFor(CAMERAS[region], seed + region)) {
        try {
          const { buf, reportedAt, lag, source } = await FETCHERS[cam.kind](cam.id, from, to);
          const takenAt = reportedAt - lag; // earliest it could have been taken
          if (takenAt < from || reportedAt >= to) {
            throw new Error(`frame from ${sgtTime(takenAt)}-${sgtTime(reportedAt)}, not inside ${sgtTime(from)}-${sgtTime(to)}`);
          }
          await writeFile(new URL(`${region}.jpg`, OUT), buf);
          shots[region] = { cam, takenAt, reportedAt, source };
          console.log(`${region}: ${cam.place} frame taken ${sgtTime(takenAt)}-${sgtTime(reportedAt)} SGT (${source})`);
          break;
        } catch (e) {
          console.warn(`${region}: ${cam.place} (${cam.kind} ${cam.id}) not used: ${e.message}`);
        }
      }
    }
    const missing = REGIONS.filter((r) => !shots[r]);
    if (!missing.length || Date.now() + RETRY_EVERY > cutoff) {
      if (missing.length) console.warn(`No photo inside the hour for: ${missing.join(', ')}`);
      return shots;
    }
    console.log(`Retrying ${missing.join(', ')} in ${RETRY_EVERY / MIN} min`);
    await sleep(RETRY_EVERY);
  }
}

// Waits for NEA's reading stamped exactly `stamp`.
async function readingFor(stamp) {
  const want = neaStamp(stamp);
  const day = want.slice(0, 10);
  const deadline = stamp + READING_DEADLINE;
  if (Date.now() < stamp) {
    console.log(`Waiting ${Math.round((stamp - Date.now()) / MIN)} min for the ${want.slice(11, 16)} reading`);
    await sleep(stamp - Date.now() + 30e3);
  }
  while (true) {
    try {
      const d = await getJSON(`https://api-open.data.gov.sg/v2/real-time/api/pm25?date=${day}`);
      const item = d.data.items.find((i) => i.timestamp === want);
      if (item) return { readings: item.readings.pm25_one_hourly, at: item.timestamp, issuedAt: item.updatedTimestamp };
    } catch (e) {
      console.warn(`PM2.5 fetch failed: ${e.message}`);
    }
    if (Date.now() > deadline) throw new Error(`NEA reading for ${want} never appeared`);
    await sleep(MIN);
  }
}

// Light obfuscation so the answers aren't sitting in plain sight in devtools.
const hide = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').split('').reverse().join('');
const unhide = (s) => JSON.parse(Buffer.from(s.split('').reverse().join(''), 'base64').toString());

let liveRound = null;
async function reuseLive(id) {
  try {
    const live = (liveRound = await getJSON(new URL(`round/round.json?t=${Date.now()}`, LIVE)));
    if (id !== null && live.id !== id) return false;
    id = live.id;
    for (const r of live.regions) {
      if (!r.image) continue;
      const { buf } = await getImage(new URL('round/' + r.image, LIVE));
      await writeFile(new URL(r.image.split('?')[0], OUT), buf);
    }
    await writeFile(new URL('round.json', OUT), JSON.stringify(live, null, 1));
    console.log(`Round ${id} is already live, reusing it`);
    return true;
  } catch (e) {
    console.log(`No live round to reuse (${e.message})`);
    return false;
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  // The round to build: the nearest round start (00/06/12/18 SGT), normally ~30 min away.
  const start = windowStart(Date.now() + (ROUND_HOURS / 2) * HOUR);
  const stamp = start; // scored on the reading stamped at the round's start...
  const hourFrom = stamp - HOUR; // ...which averages the hour before it
  const id = roundId(start);
  if (REDEPLOY && !FORCE) {
    const live = await reuseLive(null);
    if (live) return;
  }
  console.log(`Round ${id}: photos must be from ${sgtTime(hourFrom)}-${sgtTime(stamp)} SGT, scored on NEA's ${neaStamp(stamp)} reading`);
  if (!FORCE && (await reuseLive(id))) return;

  const shots = await takePhotos(hourFrom, stamp, id);
  const { readings, at, issuedAt } = await readingFor(stamp);

  const regions = REGIONS.map((region) => {
    const s = shots[region];
    if (!s) return { region, image: null, place: 'Camera offline', credit: null };
    return { region, image: `${region}.jpg?r=${id}`, place: s.cam.place, credit: s.cam.credit, takenAt: new Date(s.reportedAt).toISOString() };
  });
  const answers = Object.fromEntries(REGIONS.map((r) => [r, readings[r]]));
  if (REGIONS.some((r) => typeof answers[r] !== 'number')) throw new Error('NEA reading is missing a region');

  const round = {
    id,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + ROUND_HOURS * HOUR).toISOString(),
    hourFrom: new Date(hourFrom).toISOString(),
    hourTo: new Date(stamp).toISOString(),
    readingAt: at,
    readingIssuedAt: issuedAt,
    regions,
    a: hide(answers),
  };
  await writeFile(new URL('round.json', OUT), JSON.stringify(round, null, 1));

  // Small, committed log of past rounds' answers (no images). The repo is public, so a
  // round's answers are only logged once it has ended, i.e. when the next one replaces it.
  const prev = liveRound;
  if (prev && prev.id !== id && prev.a) {
    let history = [];
    if (existsSync(HISTORY)) history = JSON.parse(await readFile(HISTORY, 'utf8'));
    history = history.filter((h) => h.id !== prev.id);
    history.push({ id: prev.id, readingAt: prev.readingAt, pm25: unhide(prev.a), places: Object.fromEntries(prev.regions.map((r) => [r.region, r.place])) });
    await writeFile(HISTORY, JSON.stringify(history, null, 1) + '\n');
  }

  console.log(`\nRound ${id} ready. Every photo vs the ${at.slice(11, 16)} reading (average ${sgtTime(hourFrom)}-${sgtTime(stamp)}):`);
  for (const r of regions) {
    const s = shots[r.region];
    console.log(`  ${r.region.padEnd(8)} ${s ? `${sgtTime(s.takenAt)}-${sgtTime(s.reportedAt)}  inside the hour` : 'no photo inside the hour (camera offline this round)'}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
