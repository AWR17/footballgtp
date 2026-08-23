# FootballGTP — Guess The Player

Daily footballer guessing game. Type a name, get instant 🟩🟨⬜ feedback
across 6 attributes, triangulate toward the answer in 6 tries.

## How it's different from Scouting Report

Same underlying philosophy (static frontend, no login, GitHub Actions
instead of a server) but a genuinely different mechanic: guess → feedback,
rather than clue → guess. See the two backend scripts below — this
project needs data on the *whole* guessable pool upfront, not just one
mystery player a day.

## Pipeline — run in this order

**1. One-time setup: bring in the source player list**

Copy your Scouting Report project's `data/player-pool.json` into this
repo's `data/player-pool.json`. That's the only file this project needs
from Scouting Report — everything else (`lib/api-football.js`,
`lib/league-tiers.js`) is already a self-contained local copy, so there's
no need to have both projects checked out together, no relative-path
juggling between repos.

**2. One-time (or occasional): build the attribute pool**

```bash
API_FOOTBALL_KEY=xxx node scripts/build-attributes.js [poolSize]
```

Takes the top N most-capped players from `data/player-pool.json` (750 by
default) and writes `public/footygtp-attributes.json` — one entry per
player with position, debut decade, club count, highest tier reached,
whether they played abroad, and a banded PL-appearances figure.

Caches career data to its own local `data/career-cache/` as it goes, so
re-running this script later (e.g. to expand the pool) doesn't re-fetch
players it's already processed.

**3. Daily: pick today's answer**

```bash
node scripts/pick-daily-answer.js
```

No API key needed — this only reads the attributes file built in step 1.
Picks the next unused player (deterministic by date), writes
`public/daily-answer.json` (what the frontend actually reads) plus a
dated archive in `public/answers/`, and records the player as used in
`data/used-answers.json` so it's never picked again.

This is a genuinely separate step from attribute-building because the
answer needs to be a **permanent, committed fact** — not something
computed client-side by hashing the date against the attributes file,
which breaks the moment that file is ever regenerated (the hash-to-player
mapping shifts, so different visitors could see different answers, and
nothing would prevent a repeat).

`.github/workflows/daily-answer.yml` runs this automatically, once a day.

## Hosting

Same shape as Scouting Report: GitHub repo → GitHub Actions runs the
daily script and commits the result → Netlify (or Vercel) redeploys
automatically whenever the repo changes. Publish directory: `public`.

**Important**: this needs its own separate GitHub repo and its own
separate Netlify site — it is not a mode inside Scouting Report, it's a
distinct product that happens to reuse some backend patterns and cached
data.

**Workflow permissions**: same gotcha we hit with Scouting Report — this
repo's Settings → Actions → General → Workflow permissions needs "Read
and write permissions" enabled, or the daily commit step will fail with
exit code 128.

## Local preview

```bash
npx serve public
```

Without `footygtp-attributes.json` or `daily-answer.json` present, the
frontend falls back to a small bundled 5-player demo set automatically,
so the page is inspectable immediately.
