// scripts/build-pl-squad.js
//
// Fetches the CURRENT Premier League squad directly from API-Football —
// roughly 500 players, one season, not the full multi-decade sweep
// Scouting Report's build-player-pool.js does. This is FootballGTP's new
// source list, replacing the old "top N by career PL apps from Scouting
// Report's historical pool" approach — every player here is someone
// actually playing in the league right now, which is the whole point of
// this version of the game.
//
// REAL MAINTENANCE IMPLICATION: unlike the old historical pool, this one
// goes stale every transfer window. Re-run this at the start of each
// window (roughly January and July/August) to keep the pool current.
//
// Usage: API_FOOTBALL_KEY=xxx node scripts/build-pl-squad.js [season]

const fs = require("fs");
const path = require("path");

const { getPlayersForSeason, sleep } = require("../lib/api-football");

const OUTPUT_PATH = path.join(__dirname, "../data/pl-squad.json");
const PL_LEAGUE_ID = 39;
const REQUEST_PAUSE_MS = 300; // tuned for API-Football Pro (300 req/min)

function loadJSON(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function run(seasonArg) {
  const season = parseInt(seasonArg, 10) || new Date().getFullYear();
  console.log(`[build-pl-squad] fetching PL squad for season ${season}...`);

  const playersById = new Map();
  let page = 1;
  let more = true;

  while (more) {
    const resp = await getPlayersForSeason(PL_LEAGUE_ID, season, page);
    for (const entry of resp) {
      playersById.set(entry.player.id, entry.player.name);
    }
    console.log(`[build-pl-squad] page ${page}: ${resp.length} players (${playersById.size} unique so far)`);
    more = resp.length === 20; // API-Football pages at 20/page
    page++;
    await sleep(REQUEST_PAUSE_MS);
  }

  const squad = [...playersById.entries()].map(([id, name]) => ({ id, name }));
  saveJSON(OUTPUT_PATH, squad);
  console.log(`[build-pl-squad] wrote ${squad.length} players to ${OUTPUT_PATH}`);
}

const seasonArg = process.argv[2];
run(seasonArg).catch((err) => {
  console.error("[build-pl-squad] fatal error:", err);
  process.exit(1);
});