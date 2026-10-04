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

/* ---------- Settings ---------- */
const DEFAULTS = { duration: 180, repeat: false, rest: 5, sound: true, soundType: 'bowl', vibrate: true };
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
  round = 1;
  state = 'work';
  phaseEnd = now() + settings.duration * 1000;
  if (Native) {
    Native.start({ ...nativeOpts(), phaseEnd });
  } else {
    play('start');
    vibrate(150);
  }
  keepAwake(true);
  clearInterval(ticker);
  ticker = setInterval(tick, 100);
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
  $('phase').textContent = { idle: 'READY', work: '\u00a0', rest: 'RESTING', done: 'DONE' }[state];
  $('round').textContent = running && settings.repeat ? `ROUND ${round}` : (state === 'done' && round > 1 ? `${round} ROUNDS` : '');
  $('startBtn').textContent = running ? 'STOP' : 'START';
  $('repeatBtn').setAttribute('aria-pressed', String(settings.repeat));
  $('repeatLabel').textContent = settings.repeat ? 'REPEAT ON' : 'REPEAT OFF';
}

function renderPicker() {
  $('pickerValue').textContent = fmt(settings.duration);
}

function renderSettings() {
  $('restValue').textContent = `${settings.rest} s`;
  $('soundToggle').setAttribute('aria-pressed', String(settings.sound));
  $('soundToggle').textContent = settings.sound ? 'ON' : 'OFF';
  $('vibrateToggle').setAttribute('aria-pressed', String(settings.vibrate));
  $('vibrateToggle').textContent = settings.vibrate ? 'ON' : 'OFF';
  document.querySelectorAll('#soundType button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.sound === settings.soundType)));
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

/* ---------- Events ---------- */
$('startBtn').addEventListener('click', () => {
  (state === 'work' || state === 'rest') ? stop() : start();
});

$('repeatBtn').addEventListener('click', () => {
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
});

/* ---------- Boot ---------- */
(async () => {
  const saved = await store.load();
  if (saved) settings = { ...DEFAULTS, ...saved };
  render();
  if (Native) adopt(await Native.getState()); // timer may still be running from before

})();
