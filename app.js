import { firebaseConfig, TMDB_API_KEY } from './firebase-config.js';
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

// ---------- elements ----------
const views = {
  landing: document.getElementById('view-landing'),
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

  lobbyCode: document.getElementById('lobby-code'),
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

  winnerPoster: document.getElementById('winner-poster'),
  winnerTitle: document.getElementById('winner-title'),
  winnerMeta: document.getElementById('winner-meta'),
  winnerOverview: document.getElementById('winner-overview'),
  btnPlayAgain: document.getElementById('btn-play-again'),
};

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ---------- TMDB ----------
async function fetchRandomMovie(excludeIds = []) {
  const page = Math.floor(Math.random() * 20) + 1; // popular movies, pages 1-20
  const res = await fetch(
    `https://api.themoviedb.org/3/movie/popular?api_key=${TMDB_API_KEY}&language=en-US&page=${page}`
  );
  if (!res.ok) throw new Error('TMDB request failed');
  const data = await res.json();
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
function renderRoom(room) {
  const members = room.members || {};
  const memberEntries = Object.entries(members);

  if (room.phase === 'lobby' || room.phase === 'picking') {
    showView('lobby');
    el.memberList.innerHTML = '';
    memberEntries.forEach(([id, m]) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(m.name)}${id === memberId ? ' (you)' : ''}</span>
        <span class="member-status ${m.allIn ? 'is-in' : ''}">${m.allIn ? 'All in' : 'Waiting'}</span>`;
      el.memberList.appendChild(li);
    });

    const me = members[memberId];
    const allIn = me && me.allIn;
    el.btnAllIn.disabled = !!allIn || room.phase === 'picking';
    el.btnAllIn.textContent = room.phase === 'picking'
      ? 'Picking a movie…'
      : (allIn ? "You're all in ✓" : "I'm all in");
    el.lobbyHint.textContent = room.phase === 'picking'
      ? 'Everyone is in — grabbing tonight\'s film…'
      : 'Waiting for everyone to be all in…';

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
  }
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
    const movie = await fetchRandomMovie(excluded);

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
el.btnCreate.addEventListener('click', () => createRoom().catch(e => showLandingError(e.message)));
el.btnJoin.addEventListener('click', () => joinRoom().catch(e => showLandingError(e.message)));
el.btnAllIn.addEventListener('click', () => markAllIn().catch(e => (el.lobbyError.textContent = e.message)));
el.btnSeen.addEventListener('click', () => castVote('seen'));
el.btnNotSeen.addEventListener('click', () => castVote('not_seen'));
el.btnPlayAgain.addEventListener('click', () => playAgain());

// allow Enter key to submit
[el.name, el.code].forEach(input => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.btnCreate.click();
  });
});
