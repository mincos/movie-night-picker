import { firebaseConfig, TMDB_API_KEY } from './firebase-config.js';
import { celebrate } from './confetti.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  runTransaction, serverTimestamp, deleteField
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ---------- local identity ----------
const MEMBER_KEY = 'reelpick_member_id';
let memberId = localStorage.getItem(MEMBER_KEY);
if (!memberId) {
  memberId = 'm_' + Math.random().toString(36).slice(2, 10);
  localStorage.setItem(MEMBER_KEY, memberId);
}

let roomCode = null;
let memberName = null;
let unsubscribe = null;
let lastPhase = null;

// ---------- elements ----------
const views = {
  landing: document.getElementById('view-landing'),
  genres: document.getElementById('view-genres'),
  lobby: document.getElementById('view-lobby'),
  reveal: document.getElementById('view-reveal'),
  winner: document.getElementById('view-winner'),
};

function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  views[name].classList.remove('hidden');
}

const el = {
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
  return {
    id: movie.id,
    title: movie.title,
    overview: movie.overview || 'No description available.',
    poster_path: movie.poster_path,
    release_date: movie.release_date || '',
    vote_average: movie.vote_average || 0,
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
    phase: 'lobby',
    currentMovie: null,
    excludedMovieIds: [],
    genres: [...selectedGenres],
    members: {
      [memberId]: { name: memberName, allIn: false, vote: null, joinedAt: Date.now() }
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
    [`members.${memberId}`]: { name: memberName, allIn: false, vote: null, joinedAt: Date.now() }
  });

  enterRoom(code);
}

function showLandingError(msg) { el.landingError.textContent = msg; }

function enterRoom(code) {
  roomCode = code;
  el.landingError.textContent = '';
  el.lobbyCode.textContent = code;
  if (unsubscribe) unsubscribe();
  unsubscribe = onSnapshot(roomRef(code), (snap) => {
    if (!snap.exists()) return;
    renderRoom(snap.data());
  });
}

// ---------- rendering ----------
// circle takes currentColor, tick is punched out in the page background
const CHECK_ICON =
  '<svg class="check-icon" viewBox="0 0 20 20" aria-hidden="true">' +
  '<circle cx="10" cy="10" r="10" fill="currentColor"/>' +
  '<path d="M5.7 10.4l2.7 2.7 5.9-6.2" fill="none" stroke="#10131A" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderRoom(room) {
  const members = room.members || {};
  const memberEntries = Object.entries(members);

  if (room.phase === 'lobby' || room.phase === 'picking') {
    showView('lobby');
    const names = genreNames(room.genres || []);
    el.lobbyGenres.textContent = names.length ? names.join(' · ') : '';
    el.memberList.innerHTML = '';
    memberEntries.forEach(([id, m]) => {
      const li = document.createElement('li');
      const status = m.allIn
        ? `<span class="member-status is-in" role="img" aria-label="In">${CHECK_ICON}</span>`
        : '<span class="member-status">Waiting</span>';
      li.innerHTML = `<span>${escapeHtml(m.name)}${id === memberId ? ' (you)' : ''}</span>${status}`;
      el.memberList.appendChild(li);
    });

    const me = members[memberId];
    const allIn = me && me.allIn;
    el.btnAllIn.disabled = !!allIn || room.phase === 'picking';
    el.btnAllIn.textContent = room.phase === 'picking'
      ? 'Picking a movie…'
      : (allIn ? "You're in ✓" : "I am in");
    el.lobbyHint.textContent = room.phase === 'picking'
      ? 'Everyone is in — grabbing tonight\'s film…'
      : 'Waiting for everyone to be in…';

    // whoever notices everyone is in AND phase still lobby, tries to claim the pick
    const allReady = memberEntries.length > 0 && memberEntries.every(([, m]) => m.allIn);
    if (allReady && room.phase === 'lobby') {
      tryClaimPick();
    }
  }

  if (room.phase === 'reveal' && room.currentMovie) {
    showView('reveal');
    const movie = room.currentMovie;
    el.revealStatus.textContent = 'Tonight\'s contender';
    renderMovieInto(movie, {
      poster: el.moviePoster, title: el.movieTitle,
      meta: el.movieMeta, overview: el.movieOverview
    });

    const me = members[memberId];
    const voted = me && me.vote;
    el.btnSeen.disabled = !!voted;
    el.btnNotSeen.disabled = !!voted;
    const votedCount = memberEntries.filter(([, m]) => m.vote).length;
    el.revealHint.textContent = voted
      ? `Waiting on others… (${votedCount}/${memberEntries.length} voted)`
      : 'Have you seen this one?';
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

function renderMovieInto(movie, targets) {
  targets.poster.src = movie.poster_path
    ? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
    : '';
  targets.poster.alt = movie.title;
  targets.title.textContent = movie.title;
  const year = movie.release_date ? movie.release_date.slice(0, 4) : '—';
  targets.meta.textContent = `${year} · ★ ${movie.vote_average.toFixed(1)}`;
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
    [`members.${memberId}.allIn`]: true
  });
}

// Only one client should "win" the transition from lobby -> picking.
async function tryClaimPick() {
  let shouldPick = false;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef(roomCode));
      const room = snap.data();
      if (!room || room.phase !== 'lobby') return;
      const members = room.members || {};
      const allReady = Object.values(members).length > 0 &&
        Object.values(members).every(m => m.allIn);
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
  try {
    const snap = await getDoc(roomRef(roomCode));
    const room = snap.data();
    const excluded = room.excludedMovieIds || [];
    const movie = await fetchRandomMovie(excluded, room.genres || []);

    const members = room.members || {};
    const resetVotes = {};
    Object.keys(members).forEach(id => { resetVotes[`members.${id}.vote`] = null; });

    await updateDoc(roomRef(roomCode), {
      phase: 'reveal',
      currentMovie: movie,
      excludedMovieIds: [...excluded, movie.id],
      ...resetVotes
    });
  } catch (e) {
    console.error(e);
    el.revealStatus.textContent = 'Could not fetch a movie. Check your TMDB API key.';
  }
}

async function castVote(vote) {
  await updateDoc(roomRef(roomCode), {
    [`members.${memberId}.vote`]: vote
  });

  if (vote === 'seen') {
    // immediately try to move on to a new movie
    await tryClaimNextPick();
  } else {
    await tryClaimWinner();
  }
}

async function tryClaimNextPick() {
  let shouldPick = false;
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef(roomCode));
      const room = snap.data();
      if (!room || room.phase !== 'reveal') return;
      const members = room.members || {};
      const anySeen = Object.values(members).some(m => m.vote === 'seen');
      if (!anySeen) return;
      tx.update(roomRef(roomCode), { phase: 'picking' });
      shouldPick = true;
    });
  } catch (e) {
    console.error(e);
  }
  if (shouldPick) await pickAndRevealMovie();
}

async function tryClaimWinner() {
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef(roomCode));
      const room = snap.data();
      if (!room || room.phase !== 'reveal') return;
      const members = room.members || {};
      const values = Object.values(members);
      const allNotSeen = values.length > 0 && values.every(m => m.vote === 'not_seen');
      if (!allNotSeen) return;
      tx.update(roomRef(roomCode), { phase: 'winner' });
    });
  } catch (e) {
    console.error(e);
  }
}

async function playAgain() {
  const snap = await getDoc(roomRef(roomCode));
  const room = snap.data();
  const members = room.members || {};
  const resets = {};
  Object.keys(members).forEach(id => {
    resets[`members.${id}.allIn`] = false;
    resets[`members.${id}.vote`] = null;
  });
  await updateDoc(roomRef(roomCode), {
    phase: 'lobby',
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
