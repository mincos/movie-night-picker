# Reel Pick

A tiny room-based web app for picking tonight's movie with friends. No build step — plain HTML/CSS/JS. Hosts fine on GitHub Pages or Cloudflare Pages.

## How it works

1. One person **starts a room** and gets a 4-letter code. Others **join** with that code.
2. Everyone presses **"I am in"** once ready.
3. When everyone's in, the app picks a random popular movie (via TMDB) and shows it to everyone at once.
4. Each person presses **Neah** or **Wanna see it**.
   - If anyone presses Neah, a new movie is picked automatically (previous picks are excluded).
   - Once everyone says "Wanna see it" on the same movie, that's the winner — shown to the whole room.

Room state syncs live via Firestore, so everyone in the room sees the same thing in real time.

## One-time setup (you only do this once)

### 1. Firebase (free) — for real-time room sync

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (free, no card needed).
2. In your project: **Build > Firestore Database > Create database**. Start in **test mode** for now (see security rules below to tighten later).
3. Go to **Project settings > General > Your apps > Add app > Web (</> icon)**. Register the app (no need for Hosting).
4. Copy the `firebaseConfig` object it gives you.
5. Paste those values into `firebase-config.js` in this repo, replacing the placeholders.

**Auto-cleanup (TTL)** — rooms carry an `expiresAt` timestamp set 1 hour ahead, refreshed
whenever a movie is revealed or a new round starts. Firestore deletes expired rooms for you
once you enable a TTL policy on that field (one-time, and nothing is deleted until you do):

Firebase Console > **Firestore Database** > **Time-to-live (TTL)** tab > **Create policy**,
with collection group `rooms` and timestamp field `expiresAt`. Or via the CLI:

```
gcloud firestore fields ttls update expiresAt \
  --collection-group=rooms --enable-ttl --project=<your-project-id>
```

Firestore deletes expired documents within roughly 24 hours of their expiry, so rooms linger a
while after the hour is up rather than vanishing exactly on time. Rooms created before you turn
this on have no `expiresAt` and will never be swept — delete those by hand.

**Firestore rules** — since there's no login, use rules that just scope access to the `rooms` collection:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomCode} {
      allow read, write: if true;
    }
  }
}
```

This is fine for a casual app among friends (room codes act like a shared secret), but anyone with a room code can read/write that room. Don't put anything sensitive in it.

### 2. TMDB (free) — for movie data

1. Sign up at [themoviedb.org](https://www.themoviedb.org/signup).
2. Go to **Settings > API** and request a free API key (v3 auth).
3. Paste it into `firebase-config.js` as `TMDB_API_KEY`.

## Deploying

**GitHub Pages:**
```
git remote add origin <your-repo-url>
git push -u origin main
```
Then in the repo settings, enable **Pages** for the `main` branch (root).

**Cloudflare Pages:**
Connect the repo in the Cloudflare dashboard, no build command needed, output directory `/`.

## Local testing

Any static file server works, e.g.:
```
python3 -m http.server 8000
```
Then open `http://localhost:8000` in a couple of browser tabs/windows to simulate multiple friends.

## Notes / limits

- No authentication — anyone with the room code can join and vote.
- Movies are drawn from TMDB's "popular" list; swap the endpoint in `app.js` (`fetchRandomMovie`) if you'd rather pull from a different list (e.g. top rated, now playing, or a genre-filtered discover query).
- Firebase's free Spark plan covers this comfortably (well under its daily read/write limits for a small friend group).
