// scripts/build-pl-squad.js
//
// Fetches the FULL current Premier League squads directly from
// API-Football — every registered player across all 20 clubs, not just
// those with recorded match stats this season.
//
// IMPORTANT: this replaced an earlier version that used the /players
// endpoint (stats-based) — that silently excluded new signings who
// hadn't debuted yet, long-term injuries, and fringe squad players with
// zero appearances, undercounting the true squad size (came out at ~324
// instead of the real ~500+). This version fetches the 20 PL teams, then
// each team's actual registered squad list, which has no such gap.
//
// REAL MAINTENANCE IMPLICATION: unlike a historical pool, this one goes
// stale every transfer window. Re-run this at the start of each window
// (roughly January and July/August) to keep the pool current.
//
// Usage: API_FOOTBALL_KEY=xxx node scripts/build-pl-squad.js [season]

const fs = require("fs");
const path = require("path");

const { getTeamsForLeague, getSquad, sleep } = require("../lib/api-football");

const OUTPUT_PATH = path.join(__dirname, "../data/pl-squad.json");
const PL_LEAGUE_ID = 39;
const REQUEST_PAUSE_MS = 300;

function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function run(seasonArg) {
  const season = parseInt(seasonArg, 10) || new Date().getFullYear();
  console.log(`[build-pl-squad] fetching PL teams for season ${season}...`);

  const teams = await getTeamsForLeague(PL_LEAGUE_ID, season);
  await sleep(REQUEST_PAUSE_MS);
  console.log(`[build-pl-squad] found ${teams.length} teams. Fetching full squads...`);

  const playersById = new Map();

  for (const team of teams) {
    try {
      const squad = await getSquad(team.id);
      for (const player of squad) {
        playersById.set(player.id, player.name);
      }
      console.log(`[build-pl-squad] ${team.name}: ${squad.length} players (${playersById.size} unique so far)`);
    } catch (err) {
      console.warn(`[build-pl-squad] failed to fetch squad for ${team.name}: ${err.message}`);
    }
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