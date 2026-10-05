'use strict';

/* ---------- Native plugins (no bundler: Capacitor exposes them on window) ---------- */
const P = (window.Capacitor && window.Capacitor.Plugins) || {};
// Native timer service (Android): owns timing + sounds so it works with the screen locked.
const Native = P.RepeatTimer || null;
const nativeOpts = () => ({
  durationMs: settings.duration * 1000,
  restMs: settings.rest * 1000,
  repeat: settings.repeat,
  sound: settings.sound,
  soundType: settings.soundType,
  vibrate: settings.vibrate,
});

const store = {
  async load() {
    try {
      if (P.Preferences) {
        const { value } = await P.Preferences.get({ key: 'settings' });
        return value ? JSON.parse(value) : null;
      }
      return JSON.parse(localStorage.getItem('settings'));
    } catch (e) { return null; }
  },
  async save(s) {
    const v = JSON.stringify(s);
    try {
      if (P.Preferences) await P.Preferences.set({ key: 'settings', value: v });
      else localStorage.setItem('settings', v);
    } catch (e) { /* best effort */ }
  },
};

function keepAwake(on) {
  try {
    if (P.KeepAwake) on ? P.KeepAwake.keepAwake() : P.KeepAwake.allowSleep();
  } catch (e) {}
}

function vibrate(ms) {
  if (!settings.vibrate) return;
  try {
    if (P.Haptics) P.Haptics.vibrate({ duration: ms });
    else if (navigator.vibrate) navigator.vibrate(ms);
  } catch (e) {}
}

/* ---------- Sound (synthesized, no audio files) ---------- */
let ctx = null;
function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
function tone(freq, at, dur, type = 'sine', gain = 0.5) {
  const c = audio();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(c.destination);
  o.start(at);
  o.stop(at + dur + 0.05);
}
const SOUNDS = {
  chime: {
    end(t)   { tone(880, t, 1.2); tone(1318.5, t + 0.25, 1.2); tone(1760, t + 0.5, 1.6); },
    start(t) { tone(1318.5, t, 0.6); },
    resume(t){ tone(1046.5, t, 0.35, 'triangle', 0.6); tone(1568, t + 0.18, 0.7, 'triangle', 0.6); },
  },
  bowl: {
    end(t)   { tone(220, t, 4, 'sine', 0.6); tone(444, t, 3, 'sine', 0.25); tone(673, t, 2.5, 'sine', 0.12); },
    start(t) { tone(440, t, 1.6, 'sine', 0.45); tone(888, t, 1.0, 'sine', 0.12); },
    resume(t){ tone(330, t, 0.5, 'sine', 0.6); tone(440, t + 0.25, 1.4, 'sine', 0.6); tone(880, t + 0.25, 1.0, 'sine', 0.15); },
  },
  beep: {
    end(t)   { for (let i = 0; i < 3; i++) tone(1000, t + i * 0.3, 0.18, 'square', 0.22); },
    start(t) { tone(1500, t, 0.25, 'square', 0.22); },
    resume(t){ tone(1500, t, 0.12, 'square', 0.22); tone(1500, t + 0.18, 0.12, 'square', 0.22); },
  },
};
function play(kind, force = false) {
  if (!settings.sound && !force) return;
  if (Native) { Native.playCue({ kind, soundType: settings.soundType }); return; }
  try {
    const c = audio();
    (SOUNDS[settings.soundType] || SOUNDS.bowl)[kind](c.currentTime + 0.02);
  } catch (e) {}
}

/* ---------- Trial + purchase ---------- */
const Billing = P.Billing || null;
const TRIAL_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
let ent = { trialStart: 0, purchased: false, price: null };
let devBuild = false;

const entStore = {
  async load() {
    try {
      const v = P.Preferences ? (await P.Preferences.get({ key: 'ent' })).value : localStorage.getItem('ent');
      return v ? JSON.parse(v) : null;
    } catch (e) { return null; }
  },
  async save() {
    const v = JSON.stringify(ent);
    try { P.Preferences ? await P.Preferences.set({ key: 'ent', value: v }) : localStorage.setItem('ent', v); } catch (e) {}
  },
};
const trialDaysLeft = () => Math.max(0, Math.ceil((ent.trialStart + TRIAL_DAYS * DAY - Date.now()) / DAY));
const unlocked = () => ent.purchased || trialDaysLeft() > 0;

// Ask Play what this Google account owns. Offline / not-installed-from-Play keeps the cached answer.
async function refreshLicense() {
  if (!Billing) return;
  try {
    const st = await Billing.getStatus();
    devBuild = !!st.debug;
    if (st.price) ent.price = st.price;
    if (st.known) ent.purchased = !!st.purchased;
    await entStore.save();
  } catch (e) {}
  enforceLicense();
}

// Trial over and not purchased: Repeat switches off (only when the timer isn't running).
function enforceLicense() {
  if (!unlocked() && settings.repeat && !(state === 'work' || state === 'rest')) {
    settings.repeat = false;
    save();
  }
  render();
}

/* ---------- Settings ---------- */
const DEFAULTS = { duration: 180, repeat: false, rest: 5, sound: true, soundType: 'bowl', vibrate: true, leadIn: false };
let settings = { ...DEFAULTS };
const save = () => store.save(settings);

/* ---------- Timer state machine ---------- */
// state: idle | work | rest | done
let state = 'idle';
let phaseEnd = 0;   // wall-clock ms when the current phase ends
let round = 0;
let ticker = null;

const now = () => Date.now();

function start() {
  audio(); // unlock audio on user gesture
  const lead = settings.leadIn && settings.rest > 0;
  // Lead-in: count down the rest gap first (round 0), then round 1 starts with the resume cue.
  round = lead ? 0 : 1;
  state = lead ? 'rest' : 'work';
  phaseEnd = now() + (lead ? settings.rest : settings.duration) * 1000;
  if (Native) {
    Native.start({ ...nativeOpts(), phaseEnd, leadIn: lead });
  } else {
    if (!lead) play('start');
    vibrate(150);
  }
  keepAwake(true);
  clearInterval(ticker);
  ticker = setInterval(tick, 100);
  render();
}

// Start the current round again from full time (round number unchanged). No-op outside a round.
function restartRound() {
  if (state !== 'work') return;
  if (!unlocked()) { showUnlock(); return; }   // full-version feature, like Repeat
  phaseEnd = now() + settings.duration * 1000;
  if (Native) {
    Native.restartRound({ phaseEnd });
  } else {
    play('start');
    vibrate(150);
  }
  render();
}

function stop() {
  if (Native) Native.stop();
  clearInterval(ticker);
  state = 'idle';
  round = 0;
  keepAwake(false);
  render();
}

function finish() {
  clearInterval(ticker);
  state = 'done';
  keepAwake(false);
}

// Advance one phase. Next phase is scheduled from the previous end time, so no drift.
function advance() {
  if (state === 'work') {
    if (!settings.repeat) { finish(); return 'end'; }
    if (settings.rest > 0) {
      state = 'rest';
      phaseEnd += settings.rest * 1000;
    } else {
      round++;
      phaseEnd += settings.duration * 1000;
    }
    return 'end';
  }
  if (state === 'rest') {
    state = 'work';
    round++;
    phaseEnd += settings.duration * 1000;
    return 'resume';
  }
  return null;
}

function tick() {
  let cue = null;
  // Loop handles catch-up if the app was backgrounded across several phases.
  while ((state === 'work' || state === 'rest') && now() >= phaseEnd) cue = advance();
  if (cue && !Native) {
    play(cue);
    vibrate(cue === 'end' ? 600 : 300);
  }
  render();
}

/* ---------- Rendering ---------- */
const $ = (id) => document.getElementById(id);
const fmt = (s) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
};

function render() {
  document.body.className = state;
  const running = state === 'work' || state === 'rest';
  const secs = running ? Math.max(0, Math.ceil((phaseEnd - now()) / 1000)) : settings.duration;
  $('time').textContent = fmt(secs);
  $('time').classList.toggle('long', secs >= 600);
  $('phase').textContent =
      state === 'idle' ? 'READY'
    : state === 'rest' ? (round === 0 ? 'GET READY' : 'RESTING')
    : state === 'work' ? (settings.repeat ? `ROUND ${round}` : '\u00a0')
    : (round > 1 ? `DONE · ${round} ROUNDS` : 'DONE');
  $('startBtn').textContent = running ? 'STOP' : 'START';
  $('repeatBtn').setAttribute('aria-pressed', String(settings.repeat));
  $('repeatLabel').textContent = settings.repeat ? 'REPEAT ON' : 'REPEAT OFF';
  // Restart: shown whenever Repeat is on (so the row never shifts mid-session), usable only during a round.
  $('restartBtn').hidden = !settings.repeat;
  $('restartBtn').disabled = state !== 'work';
}

function renderPicker() {
  $('pickerValue').textContent = fmt(settings.duration);
}

function renderSettings() {
  $('restValue').textContent = `${settings.rest} s`;
  $('leadInToggle').setAttribute('aria-pressed', String(settings.leadIn));
  $('leadInToggle').textContent = settings.leadIn ? 'ON' : 'OFF';
  $('soundToggle').setAttribute('aria-pressed', String(settings.sound));
  $('soundToggle').textContent = settings.sound ? 'ON' : 'OFF';
  $('vibrateToggle').setAttribute('aria-pressed', String(settings.vibrate));
  $('vibrateToggle').textContent = settings.vibrate ? 'ON' : 'OFF';
  document.querySelectorAll('#soundType button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.sound === settings.soundType)));
  const left = trialDaysLeft();
  $('licenseText').textContent = ent.purchased ? 'Unlocked — thank you!'
    : left > 0 ? `Free trial · ${left} day${left === 1 ? '' : 's'} left`
    : 'Trial ended — Repeat is locked';
  $('licenseBtn').hidden = ent.purchased;
  $('debugRow').hidden = !devBuild;
}

/* ---------- Sheets (Android back button closes them via history) ---------- */
let openSheet = null;
function showSheet(id) {
  openSheet = $(id);
  openSheet.hidden = false;
  history.pushState({ sheet: id }, '');
}
function hideSheet(fromPop = false) {
  if (!openSheet) return;
  openSheet.hidden = true;
  openSheet = null;
  save();
  pushUpdate();
  render();
  if (!fromPop) history.back();
}
window.addEventListener('popstate', () => hideSheet(true));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => hideSheet()));

// Switch from one open sheet to another without touching history (back still closes it).
function swapSheet(id) {
  if (openSheet) openSheet.hidden = true;
  openSheet = $(id);
  openSheet.hidden = false;
}

function renderUnlock(msg = '') {
  $('unlockLead').textContent = trialDaysLeft() > 0
    ? `Free trial: ${trialDaysLeft()} day${trialDaysLeft() === 1 ? '' : 's'} left.`
    : 'Your 7-day free trial has ended.';
  $('buyBtn').textContent = ent.price ? `UNLOCK — ${ent.price}` : 'UNLOCK';
  $('buyBtn').disabled = false;
  $('unlockMsg').textContent = msg;
}
function showUnlock() {
  renderUnlock();
  if (openSheet) swapSheet('unlock'); else showSheet('unlock');
}

$('buyBtn').addEventListener('click', async () => {
  if (!Billing) { renderUnlock('Purchases work in the Android app installed from Google Play.'); return; }
  $('buyBtn').disabled = true;
  $('unlockMsg').textContent = '';
  try {
    const r = await Billing.purchase();
    if (r.purchased) {
      ent.purchased = true;
      await entStore.save();
      renderUnlock('Unlocked — thank you!');
      $('buyBtn').disabled = true;
      setTimeout(() => { if (openSheet && openSheet.id === 'unlock') hideSheet(); }, 1200);
    } else if (r.pending) {
      renderUnlock('Payment pending — Repeat unlocks as soon as it completes.');
    } else if (r.cancelled) {
      renderUnlock();
    } else {
      renderUnlock(r.error || 'Purchase did not complete.');
    }
  } catch (e) {
    renderUnlock('Purchase did not complete.');
  }
});

$('restoreBtn').addEventListener('click', async () => {
  if (!Billing) { renderUnlock('Purchases work in the Android app installed from Google Play.'); return; }
  $('unlockMsg').textContent = 'Checking…';
  await refreshLicense();
  renderUnlock(ent.purchased ? 'Purchase restored — thank you!' : 'No purchase found for this Google account.');
  if (ent.purchased) setTimeout(() => { if (openSheet && openSheet.id === 'unlock') hideSheet(); }, 1200);
});

$('licenseBtn').addEventListener('click', () => showUnlock());

$('dbgExpire').addEventListener('click', async () => {
  ent.trialStart = Date.now() - (TRIAL_DAYS + 1) * DAY; ent.purchased = false;
  await entStore.save(); enforceLicense(); renderSettings();
});
$('dbgReset').addEventListener('click', async () => {
  ent.trialStart = Date.now();
  await entStore.save(); renderSettings();
});

/* ---------- Events ---------- */
$('startBtn').addEventListener('click', () => {
  (state === 'work' || state === 'rest') ? stop() : start();
});

$('restartBtn').addEventListener('click', restartRound);

$('repeatBtn').addEventListener('click', () => {
  if (!settings.repeat && !unlocked()) { showUnlock(); return; }
  // Allowed mid-run: turning it off lets the current round finish and stop.
  settings.repeat = !settings.repeat;
  save();
  pushUpdate();
  render();
});

$('time').addEventListener('click', () => {
  if (state === 'work' || state === 'rest') return;
  if (state === 'done') { state = 'idle'; render(); }
  renderPicker();
  showSheet('picker');
});

$('settingsBtn').addEventListener('click', () => { renderSettings(); showSheet('settings'); });

document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
  settings.duration = Math.min(99 * 60 + 55, Math.max(5, settings.duration + Number(b.dataset.step)));
  renderPicker();
}));
document.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => {
  settings.duration = Number(b.dataset.set);
  renderPicker();
}));

document.querySelectorAll('[data-rest]').forEach((b) => b.addEventListener('click', () => {
  settings.rest = Math.min(60, Math.max(0, settings.rest + Number(b.dataset.rest)));
  renderSettings();
}));
$('leadInToggle').addEventListener('click', () => { settings.leadIn = !settings.leadIn; renderSettings(); });
$('soundToggle').addEventListener('click', () => { settings.sound = !settings.sound; renderSettings(); });
$('vibrateToggle').addEventListener('click', () => { settings.vibrate = !settings.vibrate; renderSettings(); });
document.querySelectorAll('#soundType button').forEach((b) => b.addEventListener('click', () => {
  settings.soundType = b.dataset.sound;
  renderSettings();
  play('end', true); // preview
}));

// Mid-run setting changes (repeat toggle, rest gap, sound) go to the native service.
function pushUpdate() {
  if (Native && (state === 'work' || state === 'rest')) Native.update(nativeOpts());
}

// Adopt the native service's state (it is the source of truth on Android).
function adopt(s) {
  if (!s || !s.state) return;
  const wasRunning = state === 'work' || state === 'rest';
  const running = s.state === 'work' || s.state === 'rest';
  if (!running && !wasRunning && s.state === 'idle') return;
  state = s.state;
  phaseEnd = s.phaseEnd;
  round = s.round;
  if (running) {
    if (!wasRunning) { keepAwake(true); clearInterval(ticker); ticker = setInterval(tick, 100); }
  } else {
    clearInterval(ticker);
    keepAwake(false);
  }
  render();
}
if (Native) Native.addListener('state', adopt);

// Re-sync display immediately when returning to the app.
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  if (Native) adopt(await Native.getState());
  tick();
  refreshLicense();
});

/* ---------- Boot ---------- */
(async () => {
  const saved = await store.load();
  if (saved) settings = { ...DEFAULTS, ...saved };
  const savedEnt = await entStore.load();
  if (savedEnt) ent = { ...ent, ...savedEnt };
  if (!ent.trialStart) { ent.trialStart = Date.now(); await entStore.save(); }
  enforceLicense();
  if (Native) adopt(await Native.getState()); // timer may still be running from before
  refreshLicense();

})();
