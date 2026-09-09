import { firebaseConfig, TMDB_API_KEY } from './firebase-config.js';
import { celebrate } from './confetti.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  runTransaction, serverTimestamp, deleteField, arrayUnion, Timestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ---------- local identity ----------
const MEMBER_KEY = 'reelpick_member_id';
const ROOM_KEY = 'reelpick_room';
const NAME_KEY = 'reelpick_name';
let memberId = localStorage.getItem(MEMBER_KEY);
if (!memberId) {
  memberId = 'm_' + Math.random().toString(36).slice(2, 10);
  localStorage.setItem(MEMBER_KEY, memberId);
}

// Rooms self-destruct via a Firestore TTL policy on `expiresAt`.
// The stamp slides forward on activity so a long night is never cut short.
const ROOM_TTL_HOURS = 1;
const roomExpiry = () =>
  Timestamp.fromMillis(Date.now() + ROOM_TTL_HOURS * 60 * 60 * 1000);

// Presence by inference: each client writes lastSeen on a timer, and anyone
// silent past AWAY_MS stops counting toward "everyone's in" / "everyone voted".
// Tab-close events are too unreliable to use (and fire on nothing at all when a
// phone kills the app), so absence is measured rather than announced.
const HEARTBEAT_MS = 3000;
const AWAY_MS = 10000;
let heartbeatTimer = null;
let settleTimer = null;
let lastRoom = null;

// We always count ourselves: acting in the room *is* proof of presence, and our
// own lastSeen can lag (the page was hidden, or just reloaded), which would
// otherwise let a client filter away its own vote.
const isPresent = (id, m) =>
  id === memberId ||
  (!!m && typeof m.lastSeen === 'number' && (Date.now() - m.lastSeen) < AWAY_MS);
const presentEntries = room =>
  Object.entries(room.members || {}).filter(([id, m]) => isPresent(id, m));
const presentMembers = room => presentEntries(room).map(([, m]) => m);

let roomCode = null;
let memberName = null;
let unsubscribe = null;
let lastPhase = null;
let shownMovieId = null;

// ---------- elements ----------
const views = {
  landing: document.getElementById('view-landing'),
  genres: document.getElementById('view-genres'),
  lobby: document.getElementById('view-lobby'),
  picking: document.getElementById('view-picking'),
  reveal: document.getElementById('view-reveal'),
  winner: document.getElementById('view-winner'),
};

function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name].classList.remove('hidden');

  // the lobby already shows the code on its ticket; these screens didn't
  const showBar = (name === 'picking' || name === 'reveal' || name === 'winner') && !!roomCode;
  el.roomBar.hidden = !showBar;
  document.body.classList.toggle('with-room-bar', showBar);
  if (showBar) el.roomBarCode.textContent = roomCode;
}

const el = {
  roomBar: document.getElementById('room-bar'),
  roomBarCode: document.getElementById('room-bar-code'),

  name: document.getElementById('input-name'),
  code: document.getElementById('input-code'),
  btnCreate: document.getElementById('btn-create-room'),
  btnJoin: document.getElementById('btn-join-room'),
  landingError: document.getElementById('landing-error'),

  genreGrid: document.getElementById('genre-grid'),
  genreCount: document.getElementById('genre-count'),
  genreError: document.getElementById('genre-error'),
  btnStartRoom: document.getElementById('btn-start-room'),
  btnGenresBack: document.getElementById('btn-genres-back'),

  lobbyCode: document.getElementById('lobby-code'),
  lobbyGenres: document.getElementById('lobby-genres'),
  memberList: document.getElementById('member-list'),
  btnAllIn: document.getElementById('btn-all-in'),
  lobbyHint: document.getElementById('lobby-hint'),
  lobbyError: document.getElementById('lobby-error'),

  pickingText: document.getElementById('picking-text'),
  pickingError: document.getElementById('picking-error'),

  revealStatus: document.getElementById('reveal-status'),
  movieCard: document.getElementById('movie-card'),
  moviePoster: document.getElementById('movie-poster'),
  movieTitle: document.getElementById('movie-title'),
  movieMeta: document.getElementById('movie-meta'),
  movieOverview: document.getElementById('movie-overview'),
  voteRow: document.getElementById('vote-row'),
  btnSeen: document.getElementById('btn-seen-it'),
  btnNotSeen: document.getElementById('btn-not-seen-it'),
  revealHint: document.getElementById('reveal-hint'),

  winnerCard: document.getElementById('winner-card'),
  winnerPoster: document.getElementById('winner-poster'),
  winnerTitle: document.getElementById('winner-title'),
  winnerMeta: document.getElementById('winner-meta'),
  winnerOverview: document.getElementById('winner-overview'),
  btnPlayAgain: document.getElementById('btn-play-again'),
};

// ---------- genres ----------
// TMDB's genre ids are stable, so there's no need to fetch the list.
const GENRES = [
  { id: 28, name: 'Action' },
  { id: 12, name: 'Adventure' },
  { id: 16, name: 'Animation' },
  { id: 35, name: 'Comedy' },
  { id: 80, name: 'Crime' },
  { id: 99, name: 'Documentary' },
  { id: 18, name: 'Drama' },
  { id: 10751, name: 'Family' },
  { id: 14, name: 'Fantasy' },
  { id: 27, name: 'Horror' },
  { id: 9648, name: 'Mystery' },
  { id: 10749, name: 'Romance' },
  { id: 878, name: 'Sci-Fi' },
  { id: 53, name: 'Thriller' },
];

const MIN_GENRES = 2;
const MAX_GENRES = 3;
const selectedGenres = new Set();

function genreNames(ids = []) {
  return ids
    .map(id => (GENRES.find(g => g.id === id) || {}).name)
    .filter(Boolean);
}

function buildGenreGrid() {
  el.genreGrid.innerHTML = '';
  GENRES.forEach(g => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = g.name;
    chip.dataset.id = String(g.id);
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => toggleGenre(g.id));
    el.genreGrid.appendChild(chip);
  });
  renderGenreState();
}

function toggleGenre(id) {
  if (selectedGenres.has(id)) selectedGenres.delete(id);
  else if (selectedGenres.size < MAX_GENRES) selectedGenres.add(id);
  renderGenreState();
}

function renderGenreState() {
  const full = selectedGenres.size >= MAX_GENRES;
  el.genreGrid.querySelectorAll('.chip').forEach(chip => {
    const on = selectedGenres.has(Number(chip.dataset.id));
    chip.classList.toggle('is-on', on);
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    // once three are picked, the rest are out of reach until one is dropped
    chip.disabled = !on && full;
  });
  el.genreCount.textContent = `${selectedGenres.size} of ${MIN_GENRES}–${MAX_GENRES} picked`;
  el.btnStartRoom.disabled = selectedGenres.size < MIN_GENRES;
  el.genreError.textContent = '';
}

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ---------- TMDB ----------
async function fetchRandomMovie(excludeIds = [], genreIds = []) {
  // discover lets us filter by genre; an empty genre list keeps it wide open
  const base = `https://api.themoviedb.org/3/discover/movie?api_key=${TMDB_API_KEY}`
    + '&language=en-US&sort_by=popularity.desc&include_adult=false&vote_count.gte=150'
    + (genreIds.length ? `&with_genres=${genreIds.join('|')}` : '');

  // page 1 tells us how deep the result set actually goes
  const first = await fetch(`${base}&page=1`);
  if (!first.ok) throw new Error('TMDB request failed');
  const firstData = await first.json();
  if (!firstData.results || !firstData.results.length) {
    throw new Error('No movies matched those genres.');
  }

  const maxPage = Math.min(firstData.total_pages || 1, 20);
  const page = Math.floor(Math.random() * maxPage) + 1;

  let data = firstData;
  if (page !== 1) {
    const res = await fetch(`${base}&page=${page}`);
    if (!res.ok) throw new Error('TMDB request failed');
    data = await res.json();
    if (!data.results || !data.results.length) data = firstData;
  }

  const pool = data.results.filter(m => !excludeIds.includes(m.id));
  const list = pool.length ? pool : data.results;
  const movie = list[Math.floor(Math.random() * list.length)];

  // runtime only exists on the detail endpoint; a failure here shouldn't
  // cost us the pick, so the movie just goes out without a duration
  let runtime = null;
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/movie/${movie.id}?api_key=${TMDB_API_KEY}&language=en-US`
    );
    if (res.ok) runtime = (await res.json()).runtime || null;
  } catch (e) {
    console.error(e);
  }

  return {
    id: movie.id,
    title: movie.title,
    overview: movie.overview || 'No description available.',
    poster_path: movie.poster_path,
    release_date: movie.release_date || '',
    vote_average: movie.vote_average || 0,
    runtime,
  };
}

// ---------- room helpers ----------
function roomRef(code) {
  return doc(db, 'rooms', code);
}

async function createRoom() {
  memberName = el.name.value.trim();
  if (!memberName) return showLandingError('Enter your name first.');

  let code = genRoomCode();
  // avoid unlikely collision
  for (let i = 0; i < 5; i++) {
    const snap = await getDoc(roomRef(code));
    if (!snap.exists()) break;
    code = genRoomCode();
  }

  await setDoc(roomRef(code), {
    createdAt: serverTimestamp(),
    expiresAt: roomExpiry(),
    phase: 'lobby',
    currentMovie: null,
    excludedMovieIds: [],
    genres: [...selectedGenres],
    members: {
      [memberId]: { name: memberName, allIn: false, vote: null, voteFor: null,
        joinedAt: Date.now(), lastSeen: Date.now() }
    }
  });

  enterRoom(code);
}

async function joinRoom() {
  memberName = el.name.value.trim();
  const code = el.code.value.trim().toUpperCase();
  if (!memberName) return showLandingError('Enter your name first.');
  if (!code) return showLandingError('Enter a room code.');

  const snap = await getDoc(roomRef(code));
  if (!snap.exists()) return showLandingError('No room with that code.');

  await updateDoc(roomRef(code), {
    [`members.${memberId}`]: { name: memberName, allIn: false, vote: null, voteFor: null,
      joinedAt: Date.now(), lastSeen: Date.now() }
  });

  enterRoom(code);
}

function showLandingError(msg) { el.landingError.textContent = msg; }

async function sendHeartbeat() {
  // a hidden tab isn't watching anything — don't spend quota (or hold the room
  // alive via expiresAt) for a phone that's been locked or a forgotten tab
  if (!roomCode || document.hidden) return;
  try {
    await updateDoc(roomRef(roomCode), {
      [`members.${memberId}.lastSeen`]: Date.now(),
      // a room with a live heartbeat isn't abandoned, so keep it off the TTL
      // sweep even if nobody has picked a new movie for an hour
      expiresAt: roomExpiry(),
    });
  } catch (e) {
    console.error(e);
  }
}

function startPresence() {
  sendHeartbeat();
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  // note: browsers throttle (or suspend) timers in hidden tabs anyway, but the
  // guard in sendHeartbeat is what actually stops the writes

  // Going quiet produces no snapshot, so a room already waiting only on absent
  // players would sit there forever. Poll for that, but only when it can apply.
  clearInterval(settleTimer);
  settleTimer = setInterval(() => {
    if (!roomCode || !lastRoom || document.hidden) return;
    renderRoom(lastRoom); // refresh Away labels without waiting for a write

    if (lastRoom.phase !== 'reveal' || !lastRoom.currentMovie) return;
    const all = Object.values(lastRoom.members || {});
    const here = Object.entries(lastRoom.members || {})
      .filter(([id, m]) => isPresent(id, m)).map(([, m]) => m);
    // nobody absent -> the voter's own transaction settles it; don't poll
    if (!here.length || here.length === all.length) return;

    const movieId = lastRoom.currentMovie.id;
    const votedOnThis = m => m.vote && m.voteFor === movieId;
    if (here.some(m => votedOnThis(m) && m.vote === 'seen') || here.every(votedOnThis)) {
      settleReveal();
    }
  }, 2000);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) sendHeartbeat(); // back on screen: re-announce at once
});

function rememberSession(code, name) {
  try {
    localStorage.setItem(ROOM_KEY, code);
    if (name) localStorage.setItem(NAME_KEY, name);
  } catch (e) { /* private mode — resume just won't work */ }
}

function forgetSession() {
  try { localStorage.removeItem(ROOM_KEY); } catch (e) { /* ignore */ }
}

// iOS discards backgrounded pages, and reopening the tab would otherwise dump
// you on the start screen instead of the room you were in.
async function resumeSession() {
  let code = null;
  let savedName = null;
  try {
    code = localStorage.getItem(ROOM_KEY);
    savedName = localStorage.getItem(NAME_KEY);
  } catch (e) {
    return;
  }
  if (savedName) el.name.value = savedName;
  if (!code) return;

  try {
    const snap = await getDoc(roomRef(code));
    if (!snap.exists()) return forgetSession(); // expired or swept by the TTL
    const room = snap.data();
    memberName = savedName || 'Guest';

    // gone long enough to have fallen out of the members map — rejoin rather
    // than render a room we aren't in
    if (!(room.members || {})[memberId]) {
      await updateDoc(roomRef(code), {
        [`members.${memberId}`]: { name: memberName, allIn: false, vote: null, voteFor: null,
          joinedAt: Date.now(), lastSeen: Date.now() }
      });
    }
    enterRoom(code);
  } catch (e) {
    console.error(e);
    forgetSession();
  }
}

function enterRoom(code) {
  roomCode = code;
  rememberSession(code, memberName);
  el.landingError.textContent = '';
  el.lobbyCode.textContent = code;
  if (unsubscribe) unsubscribe();
  unsubscribe = onSnapshot(roomRef(code), (snap) => {
    if (!snap.exists()) {
      // the room expired while we had it open
      forgetSession();
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      roomCode = null;
      showView('landing');
      showLandingError('That room has expired.');
      return;
    }
    renderRoom(snap.data());
  });
  startPresence();
}

// ---------- rendering ----------
// circle takes currentColor, tick is punched out in the page background
const CHECK_ICON =
  '<svg class="check-icon" viewBox="0 0 20 20" aria-hidden="true">' +
  '<circle cx="10" cy="10" r="10" fill="currentColor"/>' +
  '<path d="M5.7 10.4l2.7 2.7 5.9-6.2" fill="none" stroke="#10131A" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderRoom(room) {
  lastRoom = room;
  const members = room.members || {};
  const memberEntries = Object.entries(members);

  if (room.phase === 'picking') {
    showView('picking');
    // a re-pick already has a movie on the room; the first pick doesn't
    el.pickingText.textContent = room.currentMovie
      ? "Here's another one…"
      : 'Picking tonight\'s film…';
    el.pickingError.textContent = '';
  }

  if (room.phase === 'lobby') {
    showView('lobby');
    const names = genreNames(room.genres || []);
    el.lobbyGenres.textContent = names.length ? names.join(' · ') : '';
    el.memberList.innerHTML = '';
    memberEntries.forEach(([id, m]) => {
      const li = document.createElement('li');
      const status = !isPresent(id, m)
        ? '<span class="member-status is-away">Away</span>'
        : (m.allIn
            ? `<span class="member-status is-in" role="img" aria-label="In">${CHECK_ICON}</span>`
            : '<span class="member-status">Waiting</span>');
      li.innerHTML = `<span>${escapeHtml(m.name)}${id === memberId ? ' (you)' : ''}</span>${status}`;
      el.memberList.appendChild(li);
    });

    const me = members[memberId];
    const allIn = me && me.allIn;
    el.btnAllIn.disabled = !!allIn;
    el.btnAllIn.textContent = allIn ? "You're in ✓" : "I am in";
    el.lobbyHint.textContent = 'Waiting for everyone to be in…';

    // whoever notices everyone is in tries to claim the pick
    // someone who closed the app must not hold the room hostage
    const here = memberEntries.filter(([id, m]) => isPresent(id, m));
    const allReady = here.length > 0 && here.every(([, m]) => m.allIn);
    if (allReady) tryClaimPick();
  }

  if (room.phase === 'reveal' && room.currentMovie) {
    showView('reveal');
    const movie = room.currentMovie;
    el.revealStatus.textContent = 'Tonight\'s contender';
    renderMovieInto(movie, {
      poster: el.moviePoster, title: el.movieTitle,
      meta: el.movieMeta, overview: el.movieOverview
    });

    shownMovieId = movie.id;
    const me = members[memberId];
    const votedOnThis = m => m.vote && m.voteFor === movie.id;
    const voted = me && votedOnThis(me);
    el.btnSeen.disabled = !!voted;
    el.btnNotSeen.disabled = !!voted;
    const here = memberEntries.filter(([id, m]) => isPresent(id, m));
    const votedCount = here.filter(([, m]) => votedOnThis(m)).length;
    el.revealHint.textContent = voted
      ? `Waiting on others… (${votedCount}/${here.length} voted)`
      : 'Wanna watch this one?';
  }

  if (room.phase === 'winner' && room.currentMovie) {
    showView('winner');
    renderMovieInto(room.currentMovie, {
      poster: el.winnerPoster, title: el.winnerTitle,
      meta: el.winnerMeta, overview: el.winnerOverview
    });
    // only on the transition in — renderRoom runs on every snapshot
    if (lastPhase !== 'winner') {
      el.winnerCard.classList.remove('is-revealed');
      void el.winnerCard.offsetWidth; // restart the entrance animation
      el.winnerCard.classList.add('is-revealed');
      celebrate();
    }
  }

  lastPhase = room.phase;
}

function formatRuntime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function renderMovieInto(movie, targets) {
  targets.poster.src = movie.poster_path
    ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
    : '';
  targets.poster.alt = movie.title;
  targets.title.textContent = movie.title;

  const year = movie.release_date ? movie.release_date.slice(0, 4) : '—';
  const parts = [year, `★ ${movie.vote_average.toFixed(1)}`];
  // rooms picked before runtime was stored simply have no duration
  if (movie.runtime) parts.push(formatRuntime(movie.runtime));
  targets.meta.textContent = parts.join(' · ');

  targets.overview.textContent = movie.overview;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- actions ----------
async function markAllIn() {
  await updateDoc(roomRef(roomCode), {
    [`members.${memberId}.allIn`]: true,
    [`members.${memberId}.lastSeen`]: Date.now(),
  });
}

// Only one client should "win" the transition from lobby -> picking.
async function tryClaimPick() {
  let shouldPick = false;
  try {
    await runTransaction(db, async (tx) => {
      // Firestore re-runs this callback on contention. Without resetting here,
      // a losing attempt keeps the flag from an earlier one and picks anyway.
      shouldPick = false;
      const snap = await tx.get(roomRef(roomCode));
      const room = snap.data();
      if (!room || room.phase !== 'lobby') return;
      const members = room.members || {};
      const here = presentMembers(room);
      const allReady = here.length > 0 && here.every(m => m.allIn);
      if (!allReady) return;
      tx.update(roomRef(roomCode), { phase: 'picking' });
      shouldPick = true;
    });
  } catch (e) {
    console.error(e);
  }
  if (shouldPick) await pickAndRevealMovie();
}

async function pickAndRevealMovie() {
  let members = {};
  try {
    const snap = await getDoc(roomRef(roomCode));
    const room = snap.data();
    members = room.members || {};
    const excluded = room.excludedMovieIds || [];
    const movie = await fetchRandomMovie(excluded, room.genres || []);

    const resetVotes = {};
    Object.keys(members).forEach(id => {
      resetVotes[`members.${id}.vote`] = null;
      resetVotes[`members.${id}.voteFor`] = null;
    });

    await updateDoc(roomRef(roomCode), {
      phase: 'reveal',
      expiresAt: roomExpiry(),
      currentMovie: movie,
      excludedMovieIds: arrayUnion(movie.id),
      ...resetVotes
    });
  } catch (e) {
    console.error(e);
    el.pickingError.textContent = e.message;
    // don't leave the room stranded on the loader — hand it back to the lobby
    const reset = {};
    Object.keys(members).forEach(id => {
      reset[`members.${id}.allIn`] = false;
      reset[`members.${id}.vote`] = null;
      reset[`members.${id}.voteFor`] = null;
    });
    try {
      await updateDoc(roomRef(roomCode), { phase: 'lobby', ...reset });
      el.lobbyError.textContent = 'Could not fetch a movie — try again.';
    } catch (_) { /* nothing more we can do from here */ }
  }
}

// One transaction records the vote AND decides what happens next.
// Doing it in two steps let a second "Neah" land after the re-pick had already
// cleared the votes, which made it count against the *new* movie and skip it.
async function castVote(vote) {
  const votedOn = shownMovieId;
  if (votedOn == null) return;

  let shouldPick = false;
  try {
    await runTransaction(db, async (tx) => {
      shouldPick = false; // reset per attempt — see tryClaimPick
      const ref = roomRef(roomCode);
      const snap = await tx.get(ref);
      const room = snap.data();
      if (!room || room.phase !== 'reveal' || !room.currentMovie) return;

      // the movie moved on between the click and this write — drop the vote
      // rather than applying it to something the voter never saw
      if (room.currentMovie.id !== votedOn) return;

      const members = { ...(room.members || {}) };
      const me = members[memberId];
      if (!me) return;
      if (me.vote && me.voteFor === votedOn) return; // already voted on this one

      members[memberId] = { ...me, vote, voteFor: votedOn };
      const values = Object.entries(members)
        .filter(([id, m]) => isPresent(id, m)).map(([, m]) => m);
      const votedOnThis = m => m.vote && m.voteFor === votedOn;

      const update = {
        [`members.${memberId}.vote`]: vote,
        [`members.${memberId}.voteFor`]: votedOn,
        [`members.${memberId}.lastSeen`]: Date.now(),
      };

      if (values.some(m => votedOnThis(m) && m.vote === 'seen')) {
        update.phase = 'picking';
        shouldPick = true;
      } else if (values.length && values.every(m => votedOnThis(m) && m.vote === 'not_seen')) {
        update.phase = 'winner';
      }

      tx.update(ref, update);
    });
  } catch (e) {
    console.error(e);
  }

  if (shouldPick) await pickAndRevealMovie();
}

// Finishes a reveal that the remaining players have already settled — needed
// because a player going quiet generates no snapshot to react to.
async function settleReveal() {
  let shouldPick = false;
  try {
    await runTransaction(db, async (tx) => {
      shouldPick = false;
      const ref = roomRef(roomCode);
      const snap = await tx.get(ref);
      const room = snap.data();
      if (!room || room.phase !== 'reveal' || !room.currentMovie) return;

      const movieId = room.currentMovie.id;
      const here = presentMembers(room);
      if (!here.length) return;
      const votedOnThis = m => m.vote && m.voteFor === movieId;

      if (here.some(m => votedOnThis(m) && m.vote === 'seen')) {
        tx.update(ref, { phase: 'picking' });
        shouldPick = true;
      } else if (here.every(votedOnThis)) {
        tx.update(ref, { phase: 'winner' });
      }
    });
  } catch (e) {
    console.error(e);
  }
  if (shouldPick) await pickAndRevealMovie();
}

async function playAgain() {
  const snap = await getDoc(roomRef(roomCode));
  const room = snap.data();
  const members = room.members || {};
  const resets = {};
  Object.keys(members).forEach(id => {
    resets[`members.${id}.allIn`] = false;
    resets[`members.${id}.vote`] = null;
    resets[`members.${id}.voteFor`] = null;
  });
  await updateDoc(roomRef(roomCode), {
    phase: 'lobby',
    expiresAt: roomExpiry(),
    currentMovie: null,
    ...resets
  });
}

// ---------- wire up events ----------
// "Start a room" now goes through the genre picker first
el.btnCreate.addEventListener('click', () => {
  memberName = el.name.value.trim();
  if (!memberName) return showLandingError('Enter your name first.');
  showLandingError('');
  showView('genres');
});

el.btnGenresBack.addEventListener('click', () => showView('landing'));

el.btnStartRoom.addEventListener('click', () => {
  if (selectedGenres.size < MIN_GENRES) {
    el.genreError.textContent = `Pick at least ${MIN_GENRES} genres.`;
    return;
  }
  el.btnStartRoom.disabled = true;
  el.btnStartRoom.textContent = 'Starting…';
  createRoom().catch(e => {
    el.genreError.textContent = e.message;
    el.btnStartRoom.disabled = false;
    el.btnStartRoom.textContent = 'Start the room';
  });
});
el.btnJoin.addEventListener('click', () => joinRoom().catch(e => showLandingError(e.message)));
el.btnAllIn.addEventListener('click', () => markAllIn().catch(e => (el.lobbyError.textContent = e.message)));
el.btnSeen.addEventListener('click', () => castVote('seen'));
el.btnNotSeen.addEventListener('click', () => castVote('not_seen'));
el.btnPlayAgain.addEventListener('click', () => playAgain());

// allow Enter key to submit
el.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnCreate.click();
});

el.code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.btnJoin.click();
});

buildGenreGrid();
resumeSession();
