import { NET_READY } from './fb.js';
import { fetchCategories, fetchQuestions } from './trivia-api.js';
import {
  createRoom, joinRoom, rejoinRoom, watchRoom, startGame, submitAnswer,
  revealAnswer, nextQuestion, playAgain, msLeft, scoreAnswer, isPaused,
  pauseGame, resumeGame, endRoom, CODE_RE,
} from './room.js';
import { VERSION, APP_NAME } from './version.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'xtrivia.session';

// ---------------------------------------------------------------- session persistence
function loadSession() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}
function saveSession(session) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}
function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
}

let session = null;   // { code, playerId, name, isHost, solo? }
let unwatch = null;   // current room subscription teardown
let room = null;      // last known room snapshot
let answeredThisQ = false;
let revealedByMe = false; // guards the host from calling revealAnswer twice for one question
let timerHandle = null;
let setupMode = 'host'; // 'host' | 'solo' — which flow screen-host-setup currently drives
let categoriesLoaded = false;

const SOLO_PLAYER_ID = 'solo';

// ---------------------------------------------------------------- toast
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------------------------------------------------------------- screens
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; });
}

document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => showScreen('screen-home')));

// ================================================================ HEADER / MENU / ABOUT

$('app-version').textContent = `v${VERSION}`;
$('about-name').textContent = APP_NAME;
$('about-version').textContent = `Version ${VERSION}`;

const menuDropdown = $('menu-dropdown');
const btnMenu = $('btn-menu');

function closeMenu() {
  menuDropdown.hidden = true;
  btnMenu.setAttribute('aria-expanded', 'false');
}

btnMenu.addEventListener('click', (e) => {
  e.stopPropagation();
  const willOpen = menuDropdown.hidden;
  menuDropdown.hidden = !willOpen;
  btnMenu.setAttribute('aria-expanded', String(willOpen));
});
menuDropdown.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', closeMenu);

$('menu-refresh').addEventListener('click', () => {
  closeMenu();
  location.reload();
});

$('menu-share').addEventListener('click', async () => {
  closeMenu();
  const shareData = { title: APP_NAME, text: 'Join me for a game of xTrivia!', url: location.href };
  if (navigator.share) {
    try { await navigator.share(shareData); } catch { /* user cancelled */ }
  } else if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(shareData.url);
      toast('Link copied to clipboard.');
    } catch {
      toast('Sharing is not supported on this browser.');
    }
  } else {
    toast('Sharing is not supported on this browser.');
  }
});

$('menu-pause').addEventListener('click', async () => {
  closeMenu();
  if (!room) return;
  try {
    if (session.solo) {
      if (isPaused(room)) resumeSoloGame(); else pauseSoloGame();
    } else if (isPaused(room)) {
      await resumeGame(room.code, room);
    } else {
      await pauseGame(room.code);
    }
  } catch (e) {
    toast(e.message);
  }
});

$('menu-end').addEventListener('click', async () => {
  closeMenu();
  if (!room) return;
  if (session.solo) {
    session = null;
    room = null;
    showScreen('screen-home');
    return;
  }
  const prompt = room.state === 'lobby' ? 'Cancel this game?' : 'End this game for everyone?';
  if (!confirm(prompt)) return;
  try {
    await endRoom(room.code);
  } catch (e) {
    toast(e.message);
  }
});

$('menu-about').addEventListener('click', () => {
  closeMenu();
  $('about-modal').hidden = false;
});
$('btn-about-close').addEventListener('click', () => { $('about-modal').hidden = true; });
$('about-modal').addEventListener('click', (e) => {
  if (e.target.id === 'about-modal') $('about-modal').hidden = true;
});

$('btn-update-refresh').addEventListener('click', () => location.reload());

(async function checkForUpdate() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== VERSION) $('update-banner').hidden = false;
  } catch {
    // offline or unreachable — skip the check
  }
})();

// ================================================================ HOME

if (!NET_READY) $('offline-note').hidden = false;

async function ensureCategoriesLoaded() {
  if (categoriesLoaded) return;
  try {
    const cats = await fetchCategories();
    const sel = $('host-category');
    for (const c of cats) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      sel.appendChild(opt);
    }
    categoriesLoaded = true;
  } catch {
    toast('Could not load categories — "Any category" still works.');
  }
}

function enterSetupScreen(mode) {
  setupMode = mode;
  $('setup-heading').textContent = mode === 'solo' ? 'Play solo' : 'Host a game';
  $('btn-create-room').textContent = mode === 'solo' ? 'Start game' : 'Create room';
  showScreen('screen-host-setup');
  ensureCategoriesLoaded();
}

$('btn-go-host').addEventListener('click', () => enterSetupScreen('host'));
$('btn-go-solo').addEventListener('click', () => enterSetupScreen('solo'));

$('host-amount').addEventListener('input', (e) => { $('host-amount-val').textContent = e.target.value; });
$('host-seconds').addEventListener('input', (e) => { $('host-seconds-val').textContent = e.target.value; });

$('btn-create-room').addEventListener('click', async () => {
  const name = $('host-name').value.trim() || (setupMode === 'solo' ? 'You' : 'Host');
  const settings = {
    category: $('host-category').value,
    difficulty: $('host-difficulty').value,
    amount: Number($('host-amount').value),
    seconds: Number($('host-seconds').value),
  };
  const btn = $('btn-create-room');
  btn.disabled = true;
  try {
    if (setupMode === 'solo') {
      const qs = await fetchQuestions(settings);
      startSoloGame(name, settings, qs);
    } else {
      const { code, playerId } = await createRoom(name, settings);
      session = { code, playerId, name, isHost: true };
      saveSession(session);
      enterRoom();
    }
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
});

$('btn-join').addEventListener('click', async () => {
  const name = $('join-name').value.trim();
  const code = $('join-code').value.trim().toUpperCase();
  if (!name) return toast('Enter a name first.');
  if (!CODE_RE.test(code)) return toast('Room codes are 5 letters/numbers.');
  const btn = $('btn-join');
  btn.disabled = true;
  try {
    const { playerId } = await joinRoom(code, name);
    session = { code, playerId, name, isHost: false };
    saveSession(session);
    enterRoom();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
});

$('btn-back-home').addEventListener('click', () => {
  if (unwatch) unwatch();
  unwatch = null;
  clearSession();
  session = null;
  room = null;
  showScreen('screen-home');
  updateHostMenu();
});

// ================================================================ ROOM WATCH

function enterRoom() {
  if (unwatch) unwatch();
  unwatch = watchRoom(session.code, onRoomUpdate);
}

function onRoomUpdate(r) {
  if (!r) {
    toast('The host ended the game.');
    if (unwatch) unwatch();
    unwatch = null;
    clearSession();
    session = null;
    room = null;
    showScreen('screen-home');
    updateHostMenu();
    return;
  }
  const qChanged = !room || room.currentIndex !== r.currentIndex || room.state !== r.state;
  room = r;
  if (qChanged) { answeredThisQ = false; revealedByMe = false; }
  render();
  maybeAutoReveal();
}

function render() {
  updateHostMenu();
  if (!room) return;
  if (room.state === 'lobby') renderLobby();
  else if (room.state === 'question') renderQuestion();
  else if (room.state === 'reveal') renderReveal();
  else if (room.state === 'end') renderEnd();
}

function updateHostMenu() {
  const pauseItem = $('menu-pause');
  const endItem = $('menu-end');
  const isActiveHost = !!(session && session.isHost && room);
  if (!isActiveHost) {
    pauseItem.hidden = true;
    endItem.hidden = true;
    return;
  }
  pauseItem.hidden = room.state !== 'question';
  pauseItem.textContent = isPaused(room) ? 'Resume game' : 'Pause game';
  endItem.hidden = false;
  endItem.textContent = room.state === 'lobby' ? 'Cancel game' : 'Quit game';
}

// ================================================================ SOLO MODE
//
// Solo plays out entirely in memory, in the same room-shaped object the multiplayer
// screens already render — no Firebase room exists, so these mirror room.js's functions
// but mutate `room` directly and call render() themselves instead of relying on a
// Firebase onValue callback.

function startSoloGame(name, settings, questions) {
  room = {
    code: 'SOLO',
    state: 'question',
    settings,
    questions,
    currentIndex: 0,
    questionStartedAt: Date.now(),
    answers: {},
    players: { [SOLO_PLAYER_ID]: { name: name || 'You', score: 0, isHost: true } },
    pause: null,
    pausedMs: 0,
  };
  session = { code: 'SOLO', playerId: SOLO_PLAYER_ID, name: name || 'You', isHost: true, solo: true };
  answeredThisQ = false;
  revealedByMe = false;
  render();
}

function submitSoloAnswer(qIndex, optionIndex) {
  if (isPaused(room)) return;
  if (!room.answers[qIndex]) room.answers[qIndex] = {};
  if (room.answers[qIndex][SOLO_PLAYER_ID]) return;
  room.answers[qIndex][SOLO_PLAYER_ID] = { optionIndex, answeredAt: Date.now(), pausedMsAtAnswer: room.pausedMs || 0 };
  revealSoloAnswer(); // solo has exactly one player, so answering always means "everyone's answered"
}

function revealSoloAnswer() {
  const qIndex = room.currentIndex;
  const question = room.questions[qIndex];
  const seconds = room.settings.seconds;
  const ans = room.answers[qIndex] && room.answers[qIndex][SOLO_PLAYER_ID];
  if (ans) {
    const correct = ans.optionIndex === question.correctIndex;
    const msRemaining = (room.questionStartedAt + seconds * 1000) - ans.answeredAt + (ans.pausedMsAtAnswer || 0);
    const points = scoreAnswer(correct, msRemaining, seconds * 1000);
    ans.correct = correct;
    ans.points = points;
    room.players[SOLO_PLAYER_ID].score += points;
  }
  room.state = 'reveal';
  render();
}

function nextSoloQuestion() {
  const next = room.currentIndex + 1;
  if (next >= room.questions.length) {
    room.state = 'end';
  } else {
    room.currentIndex = next;
    room.state = 'question';
    room.questionStartedAt = Date.now();
    room.pause = null;
    room.pausedMs = 0;
  }
  answeredThisQ = false;
  revealedByMe = false;
  render();
}

function playSoloAgain(questions) {
  room.questions = questions;
  room.answers = {};
  room.currentIndex = 0;
  room.state = 'question';
  room.questionStartedAt = Date.now();
  room.pause = null;
  room.pausedMs = 0;
  room.players[SOLO_PLAYER_ID].score = 0;
  answeredThisQ = false;
  revealedByMe = false;
  render();
}

function pauseSoloGame() {
  if (isPaused(room)) return;
  room.pause = { status: 'active', startedAt: Date.now() };
  render();
}

function resumeSoloGame() {
  if (!isPaused(room)) return;
  room.pausedMs = (room.pausedMs || 0) + Math.max(0, Date.now() - room.pause.startedAt);
  room.pause = null;
  render();
}

// ================================================================ LOBBY

function renderLobby() {
  showScreen('screen-lobby');
  $('lobby-code').textContent = room.code;
  const players = Object.entries(room.players || {});
  $('lobby-count').textContent = players.length;
  const list = $('lobby-players');
  list.innerHTML = '';
  for (const [pid, p] of players) {
    const li = document.createElement('li');
    if (p.connected === false) li.classList.add('disconnected');
    li.innerHTML = `<span>${escapeHtml(p.name)}${p.isHost ? '<span class="host-badge">HOST</span>' : ''}</span>`;
    list.appendChild(li);
  }

  const startBtn = $('btn-start-game');
  const waiting = $('lobby-waiting');
  if (session.isHost) {
    startBtn.hidden = false;
    waiting.hidden = true;
    startBtn.onclick = async () => {
      startBtn.disabled = true;
      try {
        const qs = await fetchQuestions(room.settings);
        await startGame(room.code, qs);
      } catch (e) {
        toast(e.message);
      } finally {
        startBtn.disabled = false;
      }
    };
  } else {
    startBtn.hidden = true;
    waiting.hidden = false;
  }
}

// ================================================================ QUESTION

function renderQuestion() {
  showScreen('screen-question');
  const q = room.questions[room.currentIndex];
  $('q-progress').textContent = `Q ${room.currentIndex + 1}/${room.questions.length}`;
  $('q-meta').textContent = [q.category, q.difficulty].filter(Boolean).join(' · ');
  $('q-text').textContent = q.question;

  const answeredCount = Object.keys((room.answers && room.answers[room.currentIndex]) || {}).length;
  const total = Object.keys(room.players || {}).length;
  const answeredPill = $('q-answered');
  if (!session.solo) {
    answeredPill.hidden = false;
    answeredPill.textContent = `${answeredCount}/${total} answered`;
  } else {
    answeredPill.hidden = true;
  }

  const myAnswer = (room.answers && room.answers[room.currentIndex] && room.answers[room.currentIndex][session.playerId]) || null;
  answeredThisQ = !!myAnswer;

  const paused = isPaused(room);
  const pauseBanner = $('pause-banner');
  pauseBanner.hidden = !paused;
  $('pause-banner-text').textContent = session.isHost
    ? 'Game paused — resume from the menu when ready.'
    : 'Game paused — waiting for the host to resume.';

  const grid = $('q-options');
  grid.innerHTML = '';
  q.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'opt-btn';
    btn.textContent = opt;
    if (myAnswer) {
      btn.disabled = true;
      if (myAnswer.optionIndex === i) btn.classList.add('chosen');
      else btn.classList.add('faded');
    } else if (paused) {
      btn.disabled = true;
    }
    btn.addEventListener('click', async () => {
      if (answeredThisQ || isPaused(room)) return;
      answeredThisQ = true;
      grid.querySelectorAll('.opt-btn').forEach((b, j) => {
        b.disabled = true;
        if (j === i) b.classList.add('chosen'); else b.classList.add('faded');
      });
      try {
        if (session.solo) submitSoloAnswer(room.currentIndex, i);
        else await submitAnswer(room.code, room.currentIndex, session.playerId, i);
      } catch (e) {
        toast(e.message);
      }
    });
    grid.appendChild(btn);
  });

  runTimer();
}

function runTimer() {
  clearInterval(timerHandle);
  const bar = $('q-timer-bar');
  const total = room.settings.seconds * 1000;
  const tick = () => {
    if (!room || room.state !== 'question') { clearInterval(timerHandle); return; }
    const left = msLeft(room);
    bar.style.width = `${Math.max(0, (left / total) * 100)}%`;
    if (left <= 0) {
      clearInterval(timerHandle);
      closeQuestionIfNeeded();
    }
  };
  tick();
  timerHandle = setInterval(tick, 200);
}

// A question only ever closes for one of two reasons — the timer ran out, or every
// connected player has answered — never on a manual host shortcut, so nobody can be
// cut off before they've had their chance.
async function closeQuestionIfNeeded() {
  if (!session.isHost || revealedByMe || !room || room.state !== 'question' || isPaused(room)) return;
  revealedByMe = true;
  try {
    if (session.solo) revealSoloAnswer();
    else await revealAnswer(room.code, room);
  } catch (e) {
    revealedByMe = false;
    toast(e.message);
  }
}

function maybeAutoReveal() {
  if (!session.isHost || session.solo || !room || room.state !== 'question') return;
  const connected = Object.values(room.players || {}).filter((p) => p.connected !== false);
  const answeredCount = Object.keys((room.answers && room.answers[room.currentIndex]) || {}).length;
  if (connected.length > 0 && answeredCount >= connected.length) closeQuestionIfNeeded();
}

// ================================================================ REVEAL

function sortedPlayers() {
  return Object.entries(room.players || {})
    .map(([pid, p]) => ({ pid, ...p }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

function renderReveal() {
  showScreen('screen-reveal');
  const q = room.questions[room.currentIndex];
  const myAnswer = (room.answers && room.answers[room.currentIndex] && room.answers[room.currentIndex][session.playerId]) || null;

  $('reveal-heading').textContent = myAnswer && myAnswer.correct ? 'Correct!'
    : myAnswer ? 'Not quite' : 'Time’s up';
  $('reveal-correct').textContent = `Correct answer: ${q.options[q.correctIndex]}`;

  const pointsEl = $('reveal-points');
  if (myAnswer && typeof myAnswer.points === 'number') {
    pointsEl.textContent = myAnswer.points > 0 ? `+${myAnswer.points}` : '+0';
    pointsEl.className = `reveal-points ${myAnswer.points > 0 ? 'good' : 'bad'}`;
  } else {
    pointsEl.textContent = '+0';
    pointsEl.className = 'reveal-points bad';
  }

  const board = $('reveal-board');
  board.innerHTML = '';
  sortedPlayers().forEach((p, i) => {
    const li = document.createElement('li');
    if (p.pid === session.playerId) li.classList.add('me');
    li.innerHTML = `<span><span class="rank">${i + 1}.</span>${escapeHtml(p.name)}</span><span class="score">${p.score || 0}</span>`;
    board.appendChild(li);
  });

  const nextBtn = $('btn-next-question');
  const wait = $('reveal-wait');
  if (session.isHost) {
    nextBtn.hidden = false;
    wait.hidden = true;
    const isLast = room.currentIndex + 1 >= room.questions.length;
    nextBtn.textContent = isLast ? 'See final scores' : 'Next question';
    nextBtn.onclick = async () => {
      nextBtn.disabled = true;
      try {
        if (session.solo) nextSoloQuestion();
        else await nextQuestion(room.code, room);
      } catch (e) { toast(e.message); }
      finally { nextBtn.disabled = false; }
    };
  } else {
    nextBtn.hidden = true;
    wait.hidden = false;
  }
}

// ================================================================ END

function renderEnd() {
  showScreen('screen-end');
  const ranked = sortedPlayers();
  const podium = $('end-podium');
  podium.innerHTML = '';
  const order = [1, 0, 2].filter((i) => ranked[i]); // 2nd, 1st, 3rd, left-to-right
  for (const i of order) {
    const p = ranked[i];
    const div = document.createElement('div');
    div.className = `step p${i + 1}`;
    div.innerHTML = `<div class="bar">${p.score || 0}</div><div class="name">${escapeHtml(p.name)}</div>`;
    podium.appendChild(div);
  }

  const board = $('end-board');
  board.innerHTML = '';
  ranked.forEach((p, i) => {
    const li = document.createElement('li');
    if (p.pid === session.playerId) li.classList.add('me');
    li.innerHTML = `<span><span class="rank">${i + 1}.</span>${escapeHtml(p.name)}</span><span class="score">${p.score || 0}</span>`;
    board.appendChild(li);
  });

  const again = $('btn-play-again');
  again.hidden = !session.isHost;
  again.onclick = async () => {
    again.disabled = true;
    try {
      const qs = await fetchQuestions(room.settings);
      if (session.solo) playSoloAgain(qs);
      else await playAgain(room.code, qs);
    } catch (e) {
      toast(e.message);
    } finally {
      again.disabled = false;
    }
  };
}

// ---------------------------------------------------------------- utils

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------- boot / reconnect

(async function boot() {
  const saved = loadSession();
  if (!saved) return;
  session = saved;
  const ok = await rejoinRoom(saved.code, saved.playerId).catch(() => false);
  if (ok) {
    enterRoom();
  } else {
    clearSession();
    session = null;
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
