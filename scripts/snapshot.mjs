// Takes this round's five camera snapshots and the PM2.5 readings they're scored against.
// Writes site/round/round.json and site/round/<region>.jpg. Node 20+, no dependencies.
//
// A round lasts 6 hours, starting 00:00, 06:00, 12:00 and 18:00 Singapore time.
// If the live site already has the current round (e.g. we're redeploying after a code
// change), its photos and answers are reused so nobody's round changes underneath them.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const OUT = new URL('../site/round/', import.meta.url);
const HISTORY = new URL('../data/history.json', import.meta.url);
const LIVE = process.env.LIVE_URL || 'https://alsttr.github.io/hazedle/';
const UA = { 'User-Agent': 'Mozilla/5.0 (Hazedle snapshot; +https://alsttr.github.io/hazedle/)' };
const ROUND_HOURS = 6;
const SGT = 8 * 3600e3;
const FORCE = process.argv.includes('--force');

// Ordered by preference; the first camera with a fresh image wins.
const CAMERAS = {
  north: [
    { kind: 'lta', id: '2701', place: 'Woodlands Causeway', credit: 'LTA traffic camera via data.gov.sg' },
    { kind: 'lta', id: '2702', place: 'Woodlands Checkpoint', credit: 'LTA traffic camera via data.gov.sg' },
    { kind: 'lta', id: '2704', place: 'Woodlands Ave 3', credit: 'LTA traffic camera via data.gov.sg' },
  ],
  south: [
    { kind: 'lta', id: '4799', place: 'Sentosa Gateway', credit: 'LTA traffic camera via data.gov.sg' },
    { kind: 'lta', id: '4798', place: 'Sentosa Gateway', credit: 'LTA traffic camera via data.gov.sg' },
  ],
  east: [
    { kind: 'rtspme', id: 'iBdQrE7r', place: 'Changi Sailing Club', credit: 'Changi Sailing Club weather camera' },
  ],
  west: [
    { kind: 'lta', id: '4703', place: 'Tuas Second Link', credit: 'LTA traffic camera via data.gov.sg' },
    { kind: 'lta', id: '4713', place: 'Tuas Checkpoint', credit: 'LTA traffic camera via data.gov.sg' },
    { kind: 'lta', id: '4712', place: 'AYE towards Tuas', credit: 'LTA traffic camera via data.gov.sg' },
  ],
  central: [
    { kind: 'windy', id: '1369190454', place: 'Sin Ming (Midview City)', credit: 'Midview City webcam via Windy.com' },
  ],
};
const REGIONS = ['north', 'south', 'east', 'west', 'central'];
const MAX_AGE_MIN = 90; // older than this and the camera counts as offline

const windowStart = (t = Date.now()) => {
  const sgt = t + SGT;
  return sgt - (sgt % (ROUND_HOURS * 3600e3)) - SGT;
};
const roundId = (start) => {
  const d = new Date(start + SGT);
  return d.toISOString().slice(0, 10) + '-' + String(d.getUTCHours()).padStart(2, '0');
};

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getImage(url, headers = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 5000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(`not a usable JPEG: ${url}`);
  return { buf, lastModified: r.headers.get('last-modified') };
}

let ltaCache;
async function lta(id) {
  ltaCache ||= getJSON('https://api.data.gov.sg/v1/transport/traffic-images');
  const cam = (await ltaCache).items[0].cameras.find((c) => c.camera_id === id);
  if (!cam) throw new Error(`LTA camera ${id} not in feed`);
  const { buf } = await getImage(cam.image);
  return { buf, takenAt: Date.parse(cam.timestamp) };
}
async function windy(id) {
  const { buf, lastModified } = await getImage(`https://images-webcams.windy.com/${id.slice(-2)}/${id}/current/full/${id}.jpg`);
  return { buf, takenAt: lastModified ? Date.parse(lastModified) : Date.now() };
}
async function rtspme(id) {
  const ref = { Referer: `https://rtsp.me/embed/${id}/` };
  const embed = await getJSON(`https://rtsp.me/api/embed/${id}/token/`, { headers: ref });
  const stream = await getJSON(`${embed.url}/token/${embed.token}`, { headers: ref });
  const { buf } = await getImage(stream.poster, ref);
  return { buf, takenAt: Date.now() };
}
const FETCHERS = { lta, windy, rtspme };

async function pm25() {
  const d = await getJSON('https://api-open.data.gov.sg/v2/real-time/api/pm25');
  const item = d.data.items[0];
  return { readings: item.readings.pm25_one_hourly, at: item.timestamp };
}

// Light obfuscation so the answers aren't sitting in plain sight in devtools.
const hide = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64').split('').reverse().join('');
const unhide = (s) => JSON.parse(Buffer.from(s.split('').reverse().join(''), 'base64').toString());

let liveRound = null;
async function reuseLive(id) {
  try {
    const live = (liveRound = await getJSON(new URL('round/round.json', LIVE)));
    if (live.id !== id) return false;
    for (const r of live.regions) {
      if (!r.image) continue;
      const { buf } = await getImage(new URL('round/' + r.image, LIVE));
      await writeFile(new URL(r.image.split('?')[0], OUT), buf);
    }
    await writeFile(new URL('round.json', OUT), JSON.stringify(live, null, 1));
    console.log(`Reused live round ${id}`);
    return true;
  } catch (e) {
    console.log(`No live round to reuse (${e.message})`);
    return false;
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const start = windowStart();
  const id = roundId(start);
  if (!FORCE && (await reuseLive(id))) return;

  const { readings, at } = await pm25();
  const regions = [];
  const answers = {};
  for (const region of REGIONS) {
    let shot = null;
    for (const cam of CAMERAS[region]) {
      try {
        const { buf, takenAt } = await FETCHERS[cam.kind](cam.id);
        const ageMin = (Date.now() - takenAt) / 60e3;
        if (ageMin > MAX_AGE_MIN) throw new Error(`stale (${Math.round(ageMin)} min old)`);
        const file = `${region}.jpg`;
        await writeFile(new URL(file, OUT), buf);
        shot = { image: `${file}?r=${id}`, place: cam.place, credit: cam.credit, takenAt: new Date(takenAt).toISOString() };
        console.log(`${region}: ${cam.place} (${cam.kind} ${cam.id}) ok`);
        break;
      } catch (e) {
        console.warn(`${region}: ${cam.place} (${cam.kind} ${cam.id}) failed: ${e.message}`);
      }
    }
    regions.push({ region, ...(shot || { image: null, place: 'Camera offline', credit: null }) });
    answers[region] = readings[region];
  }

  const round = {
    id,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + ROUND_HOURS * 3600e3).toISOString(),
    capturedAt: new Date().toISOString(),
    readingAt: at,
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
  console.log(`Round ${id} ready (readings from ${at})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
