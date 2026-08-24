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

const REQUEST_PAUSE_MS = 300;
const DEFAULT_POOL_SIZE = 750;

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

async function getStintsForAttributes(playerId) {
  const cachePath = path.join(CACHE_DIR, `${playerId}.json`);
  const cached = loadJSON(cachePath, null);
  if (cached) return cached;

  const teams = await getPlayerTeams(playerId);
  await sleep(REQUEST_PAUSE_MS);

  const stints = [];

  for (const t of teams) {
    const seasons = t.seasons || [];
    if (seasons.length === 0) continue;
    if (isYouthOrReserveTeam(t.team.name)) continue;

    const isNationalTeam = t.team.name === t.team.country;
    const seasonLeagues = [];
    let seasonCountry = null;
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

  saveJSON(cachePath, mergedStints);
  return mergedStints;
}

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

async function getRecordTransferFee(playerId) {
  const transfers = await getPlayerTransfers(playerId);
  let maxFee = null;
  for (const t of transfers) {
    const amount = parseFeeAmount(t.fee);
    if (amount !== null && (maxFee === null || amount > maxFee)) maxFee = amount;
  }
  return maxFee;
}

function bandTransferFee(amount) {
  if (amount === null) return "Unknown";
  if (amount === 0) return "Free";
  if (amount < 5_000_000) return "<5M";
  if (amount < 20_000_000) return "5-20M";
  if (amount < 50_000_000) return "20-50M";
  return "50M+";
}

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

  const candidates = [...sourcePool]
    .sort((a, b) => b.totalPlApps - a.totalPlApps)
    .slice(0, poolSize);

  console.log(`[build-attributes] processing ${candidates.length} players...`);

  const attributesById = {};
  const usedNames = new Set();
  let processed = 0;
  let skipped = 0;
  let nameCollisions = 0;

  for (const candidate of candidates) {
    try {
      const stints = await getStintsForAttributes(candidate.id);
      if (stints.filter((s) => !s.isNationalTeam).length === 0) {
        skipped++;
        continue;
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
        const looksAbbreviated = /^[A-Z]\.\s?[A-Z]/.test(candidate.name);
        if (looksAbbreviated && profile.firstname && profile.lastname) {
          const firstGivenName = profile.firstname.trim().split(/\s+/)[0];
          displayName = `${firstGivenName} ${profile.lastname}`.trim();
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