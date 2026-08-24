// scripts/build-attributes.js
//
// FOOTBALLGTP ATTRIBUTE PIPELINE — precomputes 6 comparable attributes
// per player for instant client-side guess feedback. Fully self-contained
// within this repo (no dependency on having Scouting Report checked out
// alongside it) — lib/api-football.js and lib/league-tiers.js are local
// copies of that project's files, kept independent so this pipeline
// doesn't silently break if that project's code changes shape later.
//
// Usage: API_FOOTBALL_KEY=xxx node scripts/build-attributes.js [poolSize]
//
// ONE-TIME SETUP before running this for the first time: copy your
// Scouting Report project's data/player-pool.json into this repo's
// data/player-pool.json (it's the source list of eligible players this
// script draws its curated pool from). After that one copy, this script
// is fully independent — no further cross-project file sharing needed.

const fs = require("fs");
const path = require("path");

const { getPlayerTeams, getPlayerSeasonStats, getPlayerSeasonAnyTeamLeague, getPlayerProfile, getPlayerTransfers, sleep } =
  require("../lib/api-football");
const { tierFor } = require("../lib/league-tiers");

const SOURCE_POOL_PATH = path.join(__dirname, "../data/player-pool.json");
const CACHE_DIR = path.join(__dirname, "../data/career-cache");
const OUTPUT_PATH = path.join(__dirname, "../public/footygtp-attributes.json");

const REQUEST_PAUSE_MS = 300; // tuned for API-Football Pro (300 req/min) — see Scouting Report's build-player-pool.js for the per-tier reasoning
const DEFAULT_POOL_SIZE = 750; // FootyGTP needs every name to be recognisable/guessable — deliberately smaller and more curated than Scouting Report's full eligible pool

// ---------- helpers (small, local copies — kept independent of Scouting
// Report's internals so this pipeline doesn't silently break if that
// game's code changes shape later) ----------

function tierRank(tierLabel) {
  const match = tierLabel?.match(/(\d+)(?:st|nd|rd|th) tier/i);
  return match ? parseInt(match[1], 10) : null;
}

function isYouthOrReserveTeam(teamName) {
  if (!teamName) return false;
  if (/\b(u1[4-9]|u2[0-3]|youth|reserves?|academy|juniors?)\b/i.test(teamName)) return true;
  const trimmed = teamName.trim();
  return /\sII$/.test(trimmed) || /\sB$/.test(trimmed);
}

// Same conservative name-matching used in Scouting Report's daily-puzzle.js
// — strips accents/punctuation and a small set of interchangeable
// prefix/suffix tokens (e.g. "AFC Bournemouth" vs "Bournemouth") so the
// same real club merges correctly rather than being counted twice.
function normalizeClubKey(name) {
  if (!name) return "";
  const key = name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.]/g, "")
    .trim();
  const genericTokens = ["afc", "fc", "cf"];
  const words = key.split(/\s+/).filter(Boolean);
  while (words.length > 1 && genericTokens.includes(words[0])) words.shift();
  while (words.length > 1 && genericTokens.includes(words[words.length - 1])) words.pop();
  return words.join(" ");
}

function loadJSON(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ---------- lightweight career fetch — attributes only, no clue text,
// no trophies/transfers (FootyGTP doesn't need any of that) ----------

async function getStintsForAttributes(playerId) {
  const cachePath = path.join(CACHE_DIR, `${playerId}.json`);
  const cached = loadJSON(cachePath, null);
  if (cached) return cached; // reuse Scouting Report's existing cache — zero new API calls if already fetched

  const teams = await getPlayerTeams(playerId);
  await sleep(REQUEST_PAUSE_MS);

  const stints = [];

  for (const t of teams) {
    const seasons = t.seasons || [];
    if (seasons.length === 0) continue;
    if (isYouthOrReserveTeam(t.team.name)) continue;

    const isNationalTeam = t.team.name === t.team.country;
    const seasonLeagues = [];
    let seasonCountry = null; // captured from season-stat lookups — often more reliable than the team-level country field
    let totalApps = 0;

    for (const season of seasons) {
      const stat = await getPlayerSeasonStats(playerId, season, t.team.id);
      totalApps += stat.appearances;
      if (stat.leagueId) seasonLeagues.push({ season, leagueId: stat.leagueId });
      if (!seasonCountry && stat.country) seasonCountry = stat.country;
      await sleep(REQUEST_PAUSE_MS);
    }

    let fallbackCountry = null;
    if (!isNationalTeam && seasonLeagues.length === 0) {
      try {
        const fallback = await getPlayerSeasonAnyTeamLeague(playerId, Math.min(...seasons), t.team.id);
        await sleep(REQUEST_PAUSE_MS);
        if (fallback.leagueId) seasonLeagues.push({ season: Math.min(...seasons), leagueId: fallback.leagueId });
        fallbackCountry = fallback.country;
      } catch (err) {
        console.warn(`[build-attributes] fallback league lookup failed for ${t.team.name}: ${err.message}`);
      }
    }

    seasonLeagues.sort((a, b) => a.season - b.season);
    // Prefer the team-level country field, but fall back to the
    // season-stat country (often populated even when the team record's
    // own country field is empty — this was the actual cause of the
    // Salah "played abroad: No" bug, where his Basel/Fiorentina/Roma
    // stints had a missing team.country despite valid league data).
    const effectiveCountry = t.team.country || seasonCountry || fallbackCountry;
    const tier = isNationalTeam
      ? { label: "national team" }
      : tierFor(seasonLeagues[0]?.leagueId ?? null, effectiveCountry);

    stints.push({
      clubName: t.team.name,
      country: effectiveCountry,
      isNationalTeam,
      tierLabel: tier.label,
      yearStart: Math.min(...seasons),
      appearances: totalApps,
    });
  }

  // API-Football sometimes returns the same real-world club as multiple
  // separate team entries (e.g. one per competition registration, or
  // under slightly different name variants). Left unmerged, this directly
  // corrupts the clubCount attribute — the exact bug caught and fixed in
  // Scouting Report's daily-puzzle.js, ported here since this pipeline
  // was written before that fix existed.
  const mergedByClub = new Map();
  for (const s of stints) {
    if (s.isNationalTeam) {
      mergedByClub.set(Symbol(s.clubName), s);
      continue;
    }
    const key = normalizeClubKey(s.clubName);
    const existing = mergedByClub.get(key);
    if (!existing) {
      mergedByClub.set(key, { ...s });
      continue;
    }
    const moreRepresentative = s.appearances > existing.appearances ? s : existing;
    mergedByClub.set(key, {
      ...existing,
      clubName: moreRepresentative.clubName,
      country: existing.country || s.country,
      tierLabel: moreRepresentative.tierLabel,
      yearStart: Math.min(existing.yearStart, s.yearStart),
      appearances: existing.appearances + s.appearances,
    });
  }
  const mergedStints = [...mergedByClub.values()];

  saveJSON(cachePath, mergedStints); // this project's own local cache — no longer shared with Scouting Report's, since this repo is self-contained
  return mergedStints;
}

// ---------- attribute derivation — pure logic, no API calls ----------

function deriveAttributes(stints) {
  const clubStints = stints.filter((s) => !s.isNationalTeam);

  const debutYear = Math.min(...clubStints.map((s) => s.yearStart));
  const debutDecade = Math.floor(debutYear / 10) * 10;

  const clubCount = clubStints.length;

  const tierRanks = clubStints.map((s) => tierRank(s.tierLabel)).filter((r) => r !== null);
  const highestTier = tierRanks.length > 0 ? Math.min(...tierRanks) : null;

  const playedAbroad = clubStints.some((s) => s.country && s.country !== "England");

  return { debutDecade, clubCount, highestTier, playedAbroad };
}

function bandPlApps(totalPlApps) {
  if (totalPlApps >= 300) return "300+";
  if (totalPlApps >= 150) return "150-300";
  if (totalPlApps >= 50) return "50-150";
  return "<50";
}

// Transfer fees arrive as free-text (e.g. "€45M", "£30M", "Free", "Loan",
// "N/A") in whatever currency the deal was actually done in. This
// deliberately does NOT convert between currencies — for a rough banding
// comparison, the raw number is close enough (€/£/$ are usually within
// ~15-20% of each other), but it's an approximation worth knowing about,
// not a precise cross-currency ranking.
function parseFeeAmount(feeStr) {
  if (!feeStr) return null;
  const cleaned = feeStr.trim();
  if (/free/i.test(cleaned)) return 0;
  if (/loan/i.test(cleaned) || /n\/a/i.test(cleaned) || /^transfer$/i.test(cleaned)) return null;
  const match = cleaned.match(/([\d.]+)\s*([MK])?/i);
  if (!match) return null;
  let value = parseFloat(match[1]);
  if (Number.isNaN(value)) return null;
  const suffix = match[2]?.toUpperCase();
  if (suffix === "M") value *= 1_000_000;
  else if (suffix === "K") value *= 1_000;
  return value;
}

// Finds the single biggest transfer fee across a player's whole career —
// one new API call per player, on top of everything else this pipeline
// already fetches.
async function getRecordTransferFee(playerId) {
  const transfers = await getPlayerTransfers(playerId);
  let maxFee = null;
  for (const t of transfers) {
    const amount = parseFeeAmount(t.fee);
    if (amount !== null && (maxFee === null || amount > maxFee)) maxFee = amount;
  }
  return maxFee; // null if every transfer was a loan/free/unknown — no real fee figure exists
}

function bandTransferFee(amount) {
  if (amount === null) return "Unknown";
  if (amount === 0) return "Free";
  if (amount < 5_000_000) return "<5M";
  if (amount < 20_000_000) return "5-20M";
  if (amount < 50_000_000) return "20-50M";
  return "50M+";
}

// ---------- main ----------

function normalizeNameForDedup(name) {
  return name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toLowerCase().replace(/[^a-z\s]/g, "");
}

async function run(poolSizeArg) {
  const poolSize = parseInt(poolSizeArg, 10) || DEFAULT_POOL_SIZE;
  const sourcePool = loadJSON(SOURCE_POOL_PATH, []);
  if (sourcePool.length === 0) {
    throw new Error(`No source pool found at ${SOURCE_POOL_PATH}. Run Scouting Report's build-player-pool.js first.`);
  }

  // Deliberately curated, not the full eligible pool — every name here
  // needs to be something a player might actually type and recognise,
  // so take the most-capped players rather than the full long tail.
  const candidates = [...sourcePool]
    .sort((a, b) => b.totalPlApps - a.totalPlApps)
    .slice(0, poolSize);

  console.log(`[build-attributes] processing ${candidates.length} players...`);

  const attributesById = {};
  const usedNames = new Set(); // guess-matching works by name string — a collision would make guessing that name resolve to the wrong player
  let processed = 0;
  let skipped = 0;
  let nameCollisions = 0;

  for (const candidate of candidates) {
    try {
      const stints = await getStintsForAttributes(candidate.id);
      if (stints.filter((s) => !s.isNationalTeam).length === 0) {
        skipped++;
        continue; // nothing usable — skip rather than publish a broken entry
      }

      const attrs = deriveAttributes(stints);

      let position = null;
      let nationality = null;
      let displayName = candidate.name;
      try {
        const lastKnownSeason = stints[stints.length - 1]?.yearStart ?? new Date().getFullYear();
        const profile = await getPlayerProfile(candidate.id, lastKnownSeason);
        position = profile.position;
        nationality = profile.nationality;
        // API-Football's shorthand "name" field is inconsistently
        // formatted across players (some full names, some just a first
        // initial — e.g. "N. Redmond" vs "Mohamed Salah"). firstname/
        // lastname are typically stored more consistently, so prefer a
        // reconstructed full name when both are available.
        if (profile.firstname && profile.lastname) {
          displayName = `${profile.firstname} ${profile.lastname}`.trim();
        }
      } catch (err) {
        console.warn(`[build-attributes] position lookup failed for ${candidate.name}: ${err.message}`);
      }

      let transferFeeBand = "Unknown";
      try {
        const recordFee = await getRecordTransferFee(candidate.id);
        await sleep(REQUEST_PAUSE_MS);
        transferFeeBand = bandTransferFee(recordFee);
      } catch (err) {
        console.warn(`[build-attributes] transfer fee lookup failed for ${candidate.name}: ${err.message}`);
      }

      // Collision check runs against the FINAL display name, not the raw
      // one — two players with different shorthand names could still
      // resolve to the same real full name once reconstructed above.
      const nameKey = normalizeNameForDedup(displayName);
      if (usedNames.has(nameKey)) {
        console.warn(`[build-attributes] skipping "${displayName}" (id ${candidate.id}) — name collides with an already-added player.`);
        nameCollisions++;
        continue;
      }

      attributesById[candidate.id] = {
        name: displayName,
        position,
        nationality,
        debutDecade: attrs.debutDecade,
        clubCount: attrs.clubCount,
        transferFeeBand,
        plAppsBand: bandPlApps(candidate.totalPlApps),
      };
      usedNames.add(nameKey);

      processed++;
      if (processed % 50 === 0) console.log(`[build-attributes] ${processed}/${candidates.length} done...`);
    } catch (err) {
      console.warn(`[build-attributes] failed for ${candidate.name} (${candidate.id}): ${err.message}`);
      skipped++;
    }
  }

  saveJSON(OUTPUT_PATH, attributesById);
  console.log(`[build-attributes] wrote ${processed} players to ${OUTPUT_PATH} (${skipped} skipped, ${nameCollisions} name collisions resolved).`);
}

const poolSizeArg = process.argv[2];
run(poolSizeArg).catch((err) => {
  console.error("[build-attributes] fatal error:", err);
  process.exit(1);
});