(() => {
  'use strict';

  const REGIONS = ['north', 'south', 'east', 'west', 'central'];
  const MAX_PTS = 200;
  const ZERO_AT = Math.log(2.5); // off by 2.5x either way scores nothing
  const SLIDER_MAX = 350;
  const GUESS_MAX = 600;
  const KEY = 'hazedle:v1';
  const URL_SELF = location.origin + location.pathname;

  const $ = (id) => document.getElementById(id);
  const el = {
    roundLabel: $('roundLabel'), steps: $('steps'), play: $('play'), done: $('done'), error: $('error'),
    photo: $('photo'), photoBtn: $('photoBtn'), offline: $('offline'), regionTag: $('regionTag'), place: $('place'), credit: $('credit'),
    guessPanel: $('guessPanel'), slider: $('slider'), guessOut: $('guessOut'), guessBand: $('guessBand'), lockBtn: $('lockBtn'),
    revealPanel: $('revealPanel'), actual: $('actual'), actualBand: $('actualBand'), yours: $('yours'), pts: $('pts'),
    markYou: $('markYou'), markReal: $('markReal'), verdict: $('verdict'), nextBtn: $('nextBtn'),
    total: $('total'), grid: $('grid'), rows: $('rows'), shareBtn: $('shareBtn'), tweetBtn: $('tweetBtn'), actualLabel: $('actualLabel'), toast: $('toast'), nextRound: $('nextRound'),
    sPlayed: $('sPlayed'), sAvg: $('sAvg'), sBest: $('sBest'), sStreak: $('sStreak'),
    help: $('help'), helpBtn: $('helpBtn'), zoom: $('zoom'), zoomImg: $('zoomImg'),
  };

  // ---- storage (never fatal) ----
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };
  let store = load();
  store.rounds ||= {};

  // ---- helpers ----
  const unhide = (s) => JSON.parse(atob(s.split('').reverse().join('')));
  const band = (v) =>
    v <= 55 ? { name: 'Normal', c: 'var(--b0)', i: 0 } :
    v <= 150 ? { name: 'Elevated', c: 'var(--b1)', i: 1 } :
    v <= 250 ? { name: 'High', c: 'var(--b2)', i: 2 } :
               { name: 'Very high', c: 'var(--b3)', i: 3 };
  const setBand = (node, v) => { const b = band(v); node.textContent = b.name; node.style.setProperty('--c', b.c); };
  const score = (guess, actual) => {
    const err = Math.abs(Math.log((guess + 5) / (actual + 5)));
    return Math.round(MAX_PTS * Math.max(0, 1 - err / ZERO_AT));
  };
  const tier = (p) => (p >= 160 ? 4 : p >= 100 ? 3 : p >= 40 ? 2 : 1);
  const EMOJI = { 4: '🟩', 3: '🟨', 2: '🟧', 1: '🟥' };
  // 🎯 within 2 µg/m³, ⬆️ guessed too high, ⬇️ guessed too low
  const arrow = (g, a) => (Math.abs(g - a) <= 2 ? '🎯' : g > a ? '⬆️' : '⬇️');
  const mood = (t) => (t >= 900 ? '🏆' : t >= 750 ? '😎' : t >= 550 ? '🙂' : t >= 350 ? '😶‍🌫️' : '😷');
  const pct = (v) => Math.min(100, (v / SLIDER_MAX) * 100) + '%';
  const sgt = (iso, opts) => new Date(iso).toLocaleString('en-SG', { timeZone: 'Asia/Singapore', ...opts });
  const hourName = (iso) => sgt(iso, { hour: 'numeric', hour12: true }).replace(' ', '').toLowerCase();
  const dayName = (iso, weekday = true) => sgt(iso, { ...(weekday && { weekday: 'short' }), day: 'numeric', month: 'short' });
  const roundName = (r) => `${dayName(r.startsAt)}, ${hourName(r.startsAt)} round`;
  // The reading a round is scored on averages the hour before the round starts.
  const readingHour = (r) => {
    const to = r.hourTo || r.startsAt;
    const from = r.hourFrom || new Date(Date.parse(to) - 3600e3).toISOString();
    return { from, to, label: `${hourName(from).replace(/[ap]m$/, (m) => (hourName(from).slice(-2) === hourName(to).slice(-2) ? '' : m))}–${hourName(to)}` };
  };
  const verdictFor = (p, g, a) => {
    if (p === MAX_PTS) return 'Bang on. Are you an NEA sensor?';
    if (p >= 170) return 'So close. You can practically taste it.';
    if (p >= 120) return g > a ? 'A bit pessimistic, but not far off.' : 'A touch optimistic, but not far off.';
    if (p >= 60) return g > a ? 'Hazier in your head than in the air.' : 'Hazier out there than it looks.';
    return g > a ? 'Way too gloomy. The air was kinder than that.' : 'Way off. That haze is sneakier than it looks.';
  };

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
    const g = rs.guesses[r];
    if (g != null) return reveal(false);
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
    const r = REGIONS[rs.step];
    rs.guesses[r] = rs.draft;
    save(store);
    reveal(true);
  }

  function reveal(animate) {
    const r = REGIONS[rs.step];
    const g = rs.guesses[r], a = answers[r], p = score(g, a);
    el.guessPanel.hidden = true;
    el.revealPanel.hidden = false;
    el.yours.textContent = g;
    el.pts.textContent = `+${p} pts`;
    setBand(el.actualBand, a);
    el.verdict.textContent = verdictFor(p, g, a);
    el.nextBtn.textContent = rs.step === REGIONS.length - 1 ? 'See my score' : `Next: ${REGIONS[rs.step + 1]}`;
    renderSteps();
    if (animate) {
      el.markReal.style.left = el.markYou.style.left = pct(g);
      const t0 = performance.now();
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / 700), e = 1 - Math.pow(1 - k, 3);
        el.actual.textContent = Math.round(g + (a - g) * e);
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(() => { el.markReal.style.left = pct(a); requestAnimationFrame(tick); });
    } else {
      el.actual.textContent = a;
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
      el.photoBtn.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      finish();
    }
  }

  function finish() {
    if (!rs.finished) {
      rs.finished = true;
      rs.total = REGIONS.reduce((s, r) => s + score(rs.guesses[r], answers[r]), 0);
      save(store);
    }
    el.play.hidden = true;
    el.done.hidden = false;
    renderSteps();
    el.total.textContent = rs.total;
    el.grid.textContent = gridText();
    el.rows.innerHTML = REGIONS.map((r) => {
      const g = rs.guesses[r], a = answers[r];
      return `<li><span class="r">${r}</span><span class="d">guessed ${g}, actual ${a}</span><span class="p">${score(g, a)}</span></li>`;
    }).join('');
    renderStats();
    tickNext();
  }

  function renderStats() {
    const done = Object.entries(store.rounds).filter(([, v]) => v.finished).sort(([a], [b]) => (a < b ? -1 : 1));
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
      el.nextRound.textContent = 'New photos are on their way. Refresh in a few minutes.';
      nextTimer = setTimeout(checkForNewRound, 120e3);
      return;
    }
    const h = Math.floor(ms / 3600e3), m = Math.floor((ms % 3600e3) / 60e3), s = Math.floor((ms % 60e3) / 1e3);
    const at = sgt(round.endsAt, { hour: 'numeric', hour12: true }).replace(' ', '').toLowerCase();
    el.nextRound.textContent = `Next round at ${at} SGT, in ${h ? h + 'h ' : ''}${m}m ${String(s).padStart(2, '0')}s`;
    nextTimer = setTimeout(tickNext, 1000);
  }
  async function checkForNewRound() {
    try {
      const r = await fetchRound();
      if (r.id !== round.id) return location.reload();
    } catch {}
    nextTimer = setTimeout(checkForNewRound, 120e3);
  }

  const gridText = () =>
    REGIONS.map((r) => EMOJI[tier(score(rs.guesses[r], answers[r]))]).join('') + '\n' +
    REGIONS.map((r) => arrow(rs.guesses[r], answers[r])).join('');
  // Short enough for one post: no real numbers, so it doesn't spoil the round for anyone.
  const shareText = () =>
    `🌫️ Hazedle · ${dayName(round.startsAt, false)} ${hourName(round.startsAt)}\n` +
    `${rs.total}/1000 ${mood(rs.total)}\n` +
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
      el.toast.textContent = 'Copied to clipboard';
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

  async function start() {
    try {
      round = await fetchRound();
      answers = unhide(round.a);
    } catch (e) {
      el.roundLabel.textContent = '';
      el.error.hidden = false;
      el.error.textContent = 'Couldn’t load this round’s photos. Try refreshing in a minute.';
      return;
    }
    if (round.hourTo) {
      el.roundLabel.textContent = `${roundName(round)} · photos from ${readingHour(round).label}, scored on NEA's ${hourName(round.hourTo)} reading`;
      el.actualLabel.textContent = `NEA ${hourName(round.hourTo)} PM2.5 (${readingHour(round).label} avg)`;
    } else {
      // Rounds from before photos were tied to the reading hour.
      el.roundLabel.textContent = roundName(round);
      el.actualLabel.textContent = 'Actual 1-hr PM2.5';
    }
    rs = store.rounds[round.id] ||= { step: 0, guesses: {} };
    // Keep storage small: last 200 rounds is ~50 days.
    const keys = Object.keys(store.rounds).sort();
    keys.slice(0, Math.max(0, keys.length - 200)).forEach((k) => delete store.rounds[k]);
    save(store);
    if (!store.seenHelp) { store.seenHelp = true; save(store); el.help.showModal(); }
    if (rs.finished) return finish();
    el.play.hidden = false;
    showRegion();
  }

  // ---- events ----
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
    if (!el.guessPanel.hidden) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { if (e.target !== el.slider) { setGuess(rs.draft + (e.shiftKey ? 10 : 1)); e.preventDefault(); } }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { if (e.target !== el.slider) { setGuess(rs.draft - (e.shiftKey ? 10 : 1)); e.preventDefault(); } }
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { lockIn(); e.preventDefault(); }
    }
  });

  start();
})();
