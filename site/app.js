(() => {
  'use strict';

  const REGIONS = ['north', 'south', 'east', 'west', 'central'];
  const MAX_PTS = 100;
  const ZERO_OFF = 100; // µg/m³ off at which a guess scores nothing
  const SLIDER_MAX = 350;
  const GUESS_MAX = 600;
  const KEY = 'hazedle:v2'; // v1 scored out of 200 per region
  const URL_SELF = location.origin + location.pathname;
  // Shared scores (Supabase). The publishable key is meant to be public; the table is only
  // reachable through the hazedle_submit / hazedle_stats functions.
  const API = 'https://edvmiplelrueckisnumm.supabase.co/rest/v1/rpc/';
  const API_KEY = 'sb_publishable_DLUL_VqHLWgCOmo2ANGwJQ_r6yJXhMz';

  const $ = (id) => document.getElementById(id);
  const el = {};
  ['roundLabel', 'intro', 'startBtn', 'introCount', 'game', 'steps', 'play', 'done', 'error',
   'photo', 'photoBtn', 'offline', 'regionTag', 'place', 'credit',
   'guessPanel', 'slider', 'guessOut', 'guessBand', 'lockBtn',
   'revealPanel', 'yours', 'actual', 'actualBand', 'scoreCell', 'pts', 'markYou', 'markReal', 'verdict', 'nextBtn',
   'total', 'grid', 'curveBox', 'pct', 'curve', 'doneCount', 'rows', 'tweetBtn', 'shareBtn', 'toast', 'nextRound',
   'sPlayed', 'sAvg', 'sBest', 'sStreak', 'help', 'helpBtn', 'zoom', 'zoomImg'].forEach((id) => (el[id] = $(id)));

  // ---- storage (never fatal) ----
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
  let store = load();
  store.rounds ||= {};
  store.player ||= (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));
  save(store);

  // ---- helpers ----
  const unhide = (s) => JSON.parse(atob(s.split('').reverse().join('')));
  const band = (v) =>
    v <= 55 ? { name: 'Normal', c: 'var(--b0)' } :
    v <= 150 ? { name: 'Elevated', c: 'var(--b1)' } :
    v <= 250 ? { name: 'High', c: 'var(--b2)' } :
               { name: 'Very high', c: 'var(--b3)' };
  const setBand = (node, v) => { const b = band(v); node.textContent = b.name; node.style.setProperty('--c', b.c); };
  // Same for every reading (measured in µg/m³ off), but curved: points drop fast near the
  // answer, then taper so even a rough guess keeps a few, reaching 0 at 100 off.
  // 0 off 100 · 5 off 93 · 10 off 85 · 25 off 65 · 50 off 35 · 75 off 13 · 100 off 0
  const score = (guess, actual) => Math.round(MAX_PTS * Math.max(0, 1 - Math.abs(guess - actual) / ZERO_OFF) ** 1.5);
  // Five tiers by distance off: bullseye ≤5, green ≤12, yellow ≤30, orange ≤55, red beyond.
  const tier = (p) => (p >= 92 ? 5 : p >= 82 ? 4 : p >= 58 ? 3 : p >= 30 ? 2 : 1);
  const TIER_COLOR = { 5: 'var(--bull)', 4: 'var(--b0)', 3: 'var(--b1)', 2: 'var(--b2)', 1: 'var(--b3)' };
  const EMOJI = { 5: '🎯', 4: '🟩', 3: '🟨', 2: '🟧', 1: '🟥' };
  const pct = (v) => Math.min(100, (v / SLIDER_MAX) * 100) + '%';
  const sgt = (iso, opts) => new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', ...opts });
  const hourName = (iso) => sgt(iso, { hour: 'numeric', hour12: true }).replace(' ', '').toLowerCase();
  const dayName = (iso, weekday = true) => sgt(iso, { ...(weekday && { weekday: 'short' }), day: 'numeric', month: 'short' });
  const roundName = (r) => `${dayName(r.startsAt)}, ${hourName(r.startsAt)} round`;
  const hourRange = (r) => {
    const from = hourName(r.hourFrom), to = hourName(r.hourTo);
    return (from.slice(-2) === to.slice(-2) ? from.slice(0, -2) : from) + '–' + to;
  };
  const plural = (n, w) => `${n.toLocaleString('en-SG')} ${w}${n === 1 ? '' : 's'}`;

  const LINES = {
    perfect: ["You're a walking NEA haze meter.", 'Did you just lick the air?', 'Are you secretly an air purifier?', 'Bang on. NEA wants to know your location.'],
    great: ['Your lungs are very well calibrated.', 'Haze whisperer behaviour.', 'So close you can taste it. Literally.', 'Certified sniff test.'],
    over: ['Bit dramatic. The air’s not that bad.', 'Calm down, it’s not 2015.', 'You saw grey and panicked.', 'Your N95 is showing.'],
    under: ['Optimist! It’s hazier than it looks.', 'Your eyes are kinder than the air.', 'Main character energy, but your lungs disagree.', 'Rose-tinted glasses detected.'],
    wayOver: ['Did you rate the photo or your anxiety?', 'That’s apocalypse-level. Touch grass (with a mask).', 'Were you looking at Jakarta?'],
    wayUnder: ['Have you tried wiping your glasses?', 'That’s clean-air-in-Switzerland territory.', 'Bold of you to assume we can breathe.'],
  };
  const pick = (list, seed) => list[Math.abs(seed) % list.length];
  const verdictFor = (p, g, a, seed) => {
    if (p >= 92) return pick(LINES.perfect, seed);
    if (p >= 82) return pick(LINES.great, seed);
    if (p >= 30) return pick(g > a ? LINES.over : LINES.under, seed);
    return pick(g > a ? LINES.wayOver : LINES.wayUnder, seed);
  };

  async function rpc(fn, body) {
    const r = await fetch(API + fn, {
      method: 'POST',
      headers: { apikey: API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(fn + ' ' + r.status);
    return r.json();
  }

  // ---- state ----
  let round, answers, rs; // rs = this round's saved progress

  function renderSteps() {
    el.steps.innerHTML = REGIONS.map((r, i) => {
      const g = rs.guesses[r];
      const cls = g != null ? 's' + tier(score(g, answers[r])) : i === rs.step ? 'on' : '';
      return `<li class="${cls}">${r}</li>`;
    }).join('');
  }

  function showRegion() {
    const r = REGIONS[rs.step];
    const info = round.regions.find((x) => x.region === r) || { image: null, place: 'Camera offline' };
    el.regionTag.textContent = r;
    el.place.textContent = info.place;
    el.credit.textContent = info.credit
      ? `${info.credit} · ${sgt(info.takenAt, { hour: 'numeric', minute: '2-digit', hour12: true })}`
      : '';
    el.photo.classList.remove('ready');
    if (info.image) {
      el.offline.hidden = true;
      el.photo.hidden = false;
      el.photo.alt = `Live camera photo, ${info.place}, ${r} Singapore`;
      el.photo.onload = () => el.photo.classList.add('ready');
      el.photo.src = 'round/' + info.image;
      el.photoBtn.disabled = false;
    } else {
      el.photo.hidden = true;
      el.offline.hidden = false;
      el.photoBtn.disabled = true;
    }
    if (rs.guesses[r] != null) return reveal(false);
    el.guessPanel.hidden = false;
    el.revealPanel.hidden = true;
    setGuess(rs.draft ?? 80);
    renderSteps();
  }

  function setGuess(v) {
    v = Math.max(0, Math.min(GUESS_MAX, Math.round(v)));
    rs.draft = v;
    el.guessOut.value = el.guessOut.textContent = v;
    el.slider.value = Math.min(v, SLIDER_MAX);
    setBand(el.guessBand, v);
  }

  function lockIn() {
    rs.guesses[REGIONS[rs.step]] = rs.draft;
    save(store);
    reveal(true);
  }

  function reveal(animate) {
    const r = REGIONS[rs.step];
    const g = rs.guesses[r], a = answers[r], p = score(g, a);
    el.guessPanel.hidden = true;
    el.revealPanel.hidden = false;
    el.yours.textContent = g;
    setBand(el.actualBand, a);
    el.scoreCell.style.setProperty('--c', TIER_COLOR[tier(p)]);
    el.verdict.textContent = verdictFor(p, g, a, rs.step * 7 + g + a);
    el.nextBtn.textContent = rs.step === REGIONS.length - 1 ? 'See my score' : `Next: ${REGIONS[rs.step + 1]}`;
    renderSteps();
    if (animate) {
      el.markReal.style.left = el.markYou.style.left = pct(g);
      el.scoreCell.classList.remove('pop');
      const t0 = performance.now();
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / 700), e = 1 - Math.pow(1 - k, 3);
        el.actual.textContent = Math.round(g + (a - g) * e);
        el.pts.textContent = Math.round(p * e);
        if (k < 1) requestAnimationFrame(tick);
        else el.scoreCell.classList.add('pop');
      };
      requestAnimationFrame(() => { el.markReal.style.left = pct(a); requestAnimationFrame(tick); });
    } else {
      el.actual.textContent = a;
      el.pts.textContent = p;
      el.markYou.style.left = pct(g);
      el.markReal.style.left = pct(a);
    }
    el.nextBtn.focus({ preventScroll: true });
  }

  function next() {
    rs.draft = null;
    if (rs.step < REGIONS.length - 1) {
      rs.step++;
      save(store);
      showRegion();
      el.steps.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      finish();
    }
  }

  function finish() {
    const scores = REGIONS.map((r) => score(rs.guesses[r], answers[r]));
    // Always recomputed, so a round finished before a scoring change shows consistently.
    rs.total = scores.reduce((s, x) => s + x, 0);
    rs.finished = true;
    save(store);
    el.play.hidden = true;
    el.done.hidden = false;
    renderSteps();
    countUp(scores);
    el.rows.innerHTML = REGIONS.map((r, i) => {
      const g = rs.guesses[r], a = answers[r], p = scores[i];
      return `<li><span class="r">${r}</span><span class="d">you ${g} · actual ${a}</span><span class="p" style="--c:${TIER_COLOR[tier(p)]}">${p}</span></li>`;
    }).join('');
    renderStats();
    tickNext();
    loadCurve(scores);
    window.scrollTo({ top: 0 });
  }

  // Total ticks up from 0, fast then slowing, and each region's square lands as the
  // count passes its points.
  let countRaf;
  function countUp(scores) {
    cancelAnimationFrame(countRaf);
    const total = rs.total;
    const tiles = scores.map((p) => EMOJI[tier(p)]);
    let sum = 0;
    const lands = scores.map((p) => (sum += p));
    const paint = (v, shown) => {
      el.total.textContent = v;
      el.grid.innerHTML = tiles.map((t, i) => `<span class="tile${i < shown ? ' in' : ''}">${i < shown ? t : '⬛'}</span>`).join('');
    };
    const end = () => paint(total, tiles.length);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return end();
    const dur = Math.min(2400, 900 + total * 3);
    let t0 = null; // start timing at the first painted frame, not when the tab may be hidden
    const tick = (t) => {
      t0 ??= t;
      const k = Math.min(1, (t - t0) / dur);
      const v = Math.round(total * (1 - Math.pow(1 - k, 3)));
      paint(v, k >= 1 ? tiles.length : lands.filter((c) => c <= v).length);
      if (k < 1) countRaf = requestAnimationFrame(tick);
      else end();
    };
    paint(0, 0);
    countRaf = requestAnimationFrame(tick);
  }

  // ---- the curve: where this score sits among everyone's ----
  async function loadCurve(scores) {
    try {
      const s = rs.submitted
        ? await rpc('hazedle_stats', { p_round: round.id, p_total: rs.total })
        : await rpc('hazedle_submit', { p_round: round.id, p_player: store.player, p_scores: scores });
      if (!rs.submitted) { rs.submitted = true; save(store); }
      drawCurve(s);
    } catch {
      // Older round (no longer open) or offline: try read-only stats.
      try { drawCurve(await rpc('hazedle_stats', { p_round: round.id, p_total: rs.total })); } catch {}
    }
  }

  function drawCurve(s) {
    // A thin round looks silly as a curve, so fall back to the last 30 days.
    const useRound = s.round_players >= 20 || s.recent_players < 20;
    const n = useRound ? s.round_players : s.recent_players;
    const below = useRound ? s.round_below : s.recent_below;
    const hist = useRound ? s.round_hist : s.recent_hist;
    const others = Math.max(0, n - 1);
    if (others === 0) {
      el.pct.innerHTML = 'You’re the first to finish this round. Check back later to see how you stack up.';
    } else {
      const p = Math.round((below / others) * 100);
      el.pct.innerHTML = `You’re better than <b>${p}%</b> of players`;
    }
    el.doneCount.textContent = useRound
      ? `${plural(s.round_players, 'player')} this round · ${plural(s.today_players, 'player')} today`
      : `Curve from ${plural(s.recent_players, 'game')} in the last 30 days · ${plural(s.today_players, 'player')} today`;

    // Smooth the 10-point buckets into a curve (Gaussian kernel).
    const W = 320, H = 120, BASE = 104, TOP = 14, STEP = 5;
    const bw = n < 30 ? 45 : n < 200 ? 30 : 20;
    const xs = [];
    for (let v = 0; v <= 500; v += STEP) xs.push(v);
    const ys = xs.map((v) => hist.reduce((acc, c, b) => acc + (c ? c * Math.exp(-0.5 * ((v - (b * 10 + 5)) / bw) ** 2) : 0), 0));
    const max = Math.max(...ys, 1e-9);
    const X = (v) => (v / 500) * W;
    const Y = (y) => BASE - (y / max) * (BASE - TOP);
    const line = xs.map((v, i) => `${i ? 'L' : 'M'}${X(v).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join('');
    const area = `${line}L${W},${BASE}L0,${BASE}Z`;
    const me = rs.total;
    const myY = Y(ys[Math.round(me / STEP)]);
    const clipW = X(me).toFixed(1);
    el.curve.innerHTML = `
      <defs><clipPath id="below"><rect x="0" y="0" width="${clipW}" height="${H}"/></clipPath></defs>
      <path d="${area}" class="c-area"/>
      <path d="${area}" class="c-below" clip-path="url(#below)"/>
      <path d="${line}" class="c-line"/>
      <line x1="0" x2="${W}" y1="${BASE}" y2="${BASE}" class="c-base"/>
      <line x1="${clipW}" x2="${clipW}" y1="${myY.toFixed(1)}" y2="${BASE}" class="c-me"/>
      <circle cx="${clipW}" cy="${myY.toFixed(1)}" r="5" class="c-dot"/>
      <text x="${Math.min(W - 22, Math.max(22, X(me))).toFixed(1)}" y="${Math.max(11, myY - 10).toFixed(1)}" class="c-you">You</text>`;
    el.curveBox.hidden = false;
  }

  function renderStats() {
    const done = Object.entries(store.rounds).filter(([, v]) => v.finished);
    const totals = done.map(([, v]) => v.total);
    el.sPlayed.textContent = done.length;
    el.sAvg.textContent = totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0;
    el.sBest.textContent = totals.length ? Math.max(...totals) : 0;
    // Streak: consecutive 6-hour rounds played, ending with this one.
    const ids = new Set(done.map(([k]) => k));
    let streak = 0, t = Date.parse(round.startsAt);
    while (ids.has(idFor(t))) { streak++; t -= 6 * 3600e3; }
    el.sStreak.textContent = streak;
  }
  const idFor = (t) => {
    const d = new Date(t + 8 * 3600e3);
    return d.toISOString().slice(0, 10) + '-' + String(d.getUTCHours()).padStart(2, '0');
  };

  let nextTimer;
  function tickNext() {
    clearTimeout(nextTimer);
    const ms = Date.parse(round.endsAt) - Date.now();
    if (ms <= 0) {
      el.nextRound.innerHTML = '<span class="dot"></span>Next round is landing any minute…';
      nextTimer = setTimeout(checkForNewRound, 120e3);
      return;
    }
    const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3), s = Math.floor((ms % 60e3) / 1e3);
    const pad = (n) => String(n).padStart(2, '0');
    el.nextRound.innerHTML = `<span class="dot"></span>Next round in <b>${h}:${pad(m)}:${pad(s)}</b><span class="at">${hourName(round.endsAt)} SGT</span>`;
    nextTimer = setTimeout(tickNext, 1000);
  }
  async function checkForNewRound() {
    try {
      const r = await fetchRound();
      if (r.id !== round.id) return location.reload();
    } catch {}
    nextTimer = setTimeout(checkForNewRound, 120e3);
  }

  // ---- sharing ----
  // Colours only: no numbers and no too-high/too-low hints, so it doesn't spoil the round.
  const gridText = () => REGIONS.map((r) => EMOJI[tier(score(rs.guesses[r], answers[r]))]).join('');
  const shareText = () =>
    `🌫️ Hazedle · ${dayName(round.startsAt, false)} ${hourName(round.startsAt)} round\n` +
    `${rs.total}/500\n` +
    `${gridText()}\n` +
    `#Hazedle ${URL_SELF.replace(/^https?:\/\//, '')}`;

  function tweet() {
    window.open('https://x.com/intent/post?text=' + encodeURIComponent(shareText()), '_blank', 'noopener');
  }
  async function share() {
    const text = shareText();
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ text });
        return;
      }
      await navigator.clipboard.writeText(text);
      el.toast.textContent = 'Copied! Paste it anywhere.';
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      el.toast.textContent = 'Couldn’t copy. Here it is: ' + text.replace(/\n/g, ' ');
    }
    setTimeout(() => (el.toast.textContent = ''), 3000);
  }

  const fetchRound = () => fetch('round/round.json?t=' + Date.now(), { cache: 'no-store' }).then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });

  function beginGame() {
    el.intro.hidden = true;
    el.game.hidden = false;
    if (rs.finished) return finish();
    el.play.hidden = false;
    showRegion();
  }

  async function start() {
    try {
      round = await fetchRound();
      answers = unhide(round.a);
    } catch {
      el.roundLabel.textContent = '';
      el.error.hidden = false;
      el.error.textContent = 'Couldn’t load this round’s photos. Try refreshing in a minute.';
      return;
    }
    el.roundLabel.textContent = roundName(round);
    rs = store.rounds[round.id] ||= { step: 0, guesses: {} };
    // Keep storage small: last 200 rounds is ~50 days.
    const keys = Object.keys(store.rounds).sort();
    keys.slice(0, Math.max(0, keys.length - 200)).forEach((k) => delete store.rounds[k]);
    save(store);

    const started = rs.finished || Object.keys(rs.guesses).length > 0;
    if (started) return beginGame();
    el.intro.hidden = false;
    el.startBtn.focus({ preventScroll: true });
    rpc('hazedle_stats', { p_round: round.id })
      .then((s) => {
        if (s.today_players > 0) el.introCount.textContent = `${plural(s.today_players, 'player')} today`;
      })
      .catch(() => {});
  }

  // ---- events ----
  el.startBtn.addEventListener('click', beginGame);
  el.slider.addEventListener('input', () => setGuess(+el.slider.value));
  document.querySelectorAll('.nudge').forEach((b) => b.addEventListener('click', () => setGuess(rs.draft + +b.dataset.d)));
  el.lockBtn.addEventListener('click', lockIn);
  el.nextBtn.addEventListener('click', next);
  el.shareBtn.addEventListener('click', share);
  el.tweetBtn.addEventListener('click', tweet);
  el.helpBtn.addEventListener('click', () => el.help.showModal());
  el.photoBtn.addEventListener('click', () => {
    if (el.photo.hidden || !el.photo.src) return;
    el.zoomImg.src = el.photo.src;
    el.zoomImg.alt = el.photo.alt;
    el.zoom.showModal();
  });
  el.zoom.addEventListener('click', () => el.zoom.close());
  document.addEventListener('keydown', (e) => {
    if (el.play.hidden || document.querySelector('dialog[open]')) return;
    if (!el.guessPanel.hidden && e.target !== el.slider) {
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setGuess(rs.draft + step); e.preventDefault(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setGuess(rs.draft - step); e.preventDefault(); }
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { lockIn(); e.preventDefault(); }
    }
  });

  start();
})();
