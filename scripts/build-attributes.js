// scripts/build-attributes.js
//
// PREMSTREAK ATTRIBUTE PIPELINE — precomputes 5 comparable attributes per
// player: Team, Position, Age, PL debut year, Career PL appearances.
// Nationality is also computed but used only as a free clue shown before
// any guess — it's never a comparison attribute.
//
// SOURCE: data/pl-squad.json — the CURRENT Premier League squad, built by
// scripts/build-pl-squad.js. Run that first if this file doesn't exist yet.
//
// Usage: API_FOOTBALL_KEY=xxx node scripts/build-attributes.js

const fs = require("fs");
const path = require("path");

const { getPlayerTeams, getPlayerSeasonStats, getPlayerSeasonAnyTeamLeague, getPlayerProfile, sleep } =
  require("../lib/api-football");
const { tierFor } = require("../lib/league-tiers");

const SOURCE_POOL_PATH = path.join(__dirname, "../data/pl-squad.json");
const VALID_TEAMS_PATH = path.join(__dirname, "../data/pl-teams.json");
const CACHE_DIR = path.join(__dirname, "../data/career-cache");
const OUTPUT_PATH = path.join(__dirname, "../public/footygtp-attributes.json");

const REQUEST_PAUSE_MS = 300;
const PL_LEAGUE_ID = 39;

function isYouthOrReserveTeam(teamName) {
  if (!teamName) return false;
  if (/\b(u1[4-9]|u2[0-3]|youth|reserves?|academy|juniors?)\b/i.test(teamName)) return true;
  const trimmed = teamName.trim();
  return /\sII$/.test(trimmed) || /\sB$/.test(trimmed);
}

const KNOWN_COUNTRY_NAMES = new Set([
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Argentina", "Armenia",
  "Australia", "Austria", "Azerbaijan", "Bahrain", "Bangladesh", "Belarus", "Belgium",
  "Benin", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Bulgaria",
  "Burkina Faso", "Burundi", "Cambodia", "Cameroon", "Canada", "Cape Verde", "Chad",
  "Chile", "China", "Colombia", "Congo", "Costa Rica", "Croatia", "Cuba", "Cyprus",
  "Czech Republic", "DR Congo", "Denmark", "Ecuador", "Egypt", "El Salvador",
  "England", "Equatorial Guinea", "Estonia", "Ethiopia", "Fiji", "Finland", "France",
  "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Guatemala", "Guinea",
  "Haiti", "Honduras", "Hungary", "Iceland", "India", "Indonesia", "Iran", "Iraq",
  "Ireland", "Israel", "Italy", "Ivory Coast", "Jamaica", "Japan", "Jordan",
  "Kazakhstan", "Kenya", "Kosovo", "Kuwait", "Latvia", "Lebanon", "Liberia", "Libya",
  "Lithuania", "Luxembourg", "Madagascar", "Malawi", "Malaysia", "Mali", "Malta",
  "Mexico", "Moldova", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar",
  "Namibia", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria",
  "North Korea", "North Macedonia", "Northern Ireland", "Norway", "Oman", "Pakistan",
  "Panama", "Paraguay", "Peru", "Philippines", "Poland", "Portugal", "Qatar",
  "Republic of Ireland", "Romania", "Russia", "Rwanda", "Saudi Arabia", "Scotland",
  "Senegal", "Serbia", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Somalia",
  "South Africa", "South Korea", "Spain", "Sri Lanka", "Sudan", "Sweden",
  "Switzerland", "Syria", "Tanzania", "Thailand", "Togo", "Trinidad and Tobago",
  "Tunisia", "Turkey", "Uganda", "Ukraine", "United Arab Emirates", "United States",
  "USA", "Uruguay", "Uzbekistan", "Venezuela", "Vietnam", "Wales", "Zambia", "Zimbabwe",
]);

function normalizeClubKey(name) {
  if (!name) return "";
  const key = name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.']/g, "")
    .trim();
  const genericTokens = ["afc", "fc", "cf"];
  const words = key.split(/\s+/).filter(Boolean);
  while (words.length > 1 && genericTokens.includes(words[0])) words.shift();
  while (words.length > 1 && genericTokens.includes(words[words.length - 1])) words.pop();
  return words.join(" ");
}

// Real, commonly-used contracted club names — a substring check alone
// misses these, since letters are DROPPED ("Nottm" from "Nottingham"),
// not just cut off at the end.
const CLUB_NAME_ALIASES = {
  "man utd": "manchester united",
  "man united": "manchester united",
  "man city": "manchester city",
  "nottm forest": "nottingham forest",
  "spurs": "tottenham",
  "tottenham hotspur": "tottenham",
  "wolves": "wolverhampton wanderers",
  "newcastle": "newcastle united",
  "leeds": "leeds united",
  "west ham": "west ham united",
  "brighton": "brighton and hove albion",
  "palace": "crystal palace",
  "villa": "aston villa",
};

function resolveClubAlias(normalizedKey) {
  return CLUB_NAME_ALIASES[normalizedKey] || normalizedKey;
}

function loadJSON(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function getCareerData(playerId) {
  const cachePath = path.join(CACHE_DIR, `${playerId}.json`);
  const cached = loadJSON(cachePath, null);
  const isValidCache = cached && cached.stints && cached.seasonRecords &&
    cached.stints.every((s) => typeof s.yearEnd === "number" && typeof s.goals === "number");
  if (isValidCache) return cached;

  const teams = await getPlayerTeams(playerId);
  await sleep(REQUEST_PAUSE_MS);

  const stints = [];
  const seasonRecords = [];

  for (const t of teams) {
    const seasons = t.seasons || [];
    if (seasons.length === 0) continue;
    if (isYouthOrReserveTeam(t.team.name)) continue;

    const isNationalTeam = t.team.name === t.team.country || KNOWN_COUNTRY_NAMES.has(t.team.name);
    const seasonLeagues = [];
    let seasonCountry = null;
    let totalApps = 0;
    let totalGoals = 0;

    for (const season of seasons) {
      const stat = await getPlayerSeasonStats(playerId, season, t.team.id);
      totalApps += stat.appearances;
      totalGoals += stat.goals;
      if (stat.leagueId) {
        seasonLeagues.push({ season, leagueId: stat.leagueId });
        if (!isNationalTeam) {
          seasonRecords.push({ season, leagueId: stat.leagueId, appearances: stat.appearances });
        }
      }
      if (!seasonCountry && stat.country) seasonCountry = stat.country;
      await sleep(REQUEST_PAUSE_MS);
    }

    let fallbackCountry = null;
    if (!isNationalTeam && seasonLeagues.length === 0) {
      try {
        const fallback = await getPlayerSeasonAnyTeamLeague(playerId, Math.min(...seasons), t.team.id);
        await sleep(REQUEST_PAUSE_MS);
        if (fallback.leagueId) {
          seasonLeagues.push({ season: Math.min(...seasons), leagueId: fallback.leagueId });
          seasonRecords.push({ season: Math.min(...seasons), leagueId: fallback.leagueId, appearances: totalApps });
        }
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
      yearEnd: Math.max(...seasons),
      appearances: totalApps,
      goals: totalGoals,
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
      yearEnd: Math.max(existing.yearEnd, s.yearEnd),
      appearances: existing.appearances + s.appearances,
      goals: existing.goals + s.goals,
    });
  }
  const mergedStints = [...mergedByClub.values()];

  const result = { stints: mergedStints, seasonRecords };
  saveJSON(cachePath, result);
  return result;
}

function derivePlStats(seasonRecords) {
  const plSeasons = seasonRecords.filter((r) => r.leagueId === PL_LEAGUE_ID);
  const totalPlApps = plSeasons.reduce((sum, r) => sum + r.appearances, 0);
  const plDebutYear = plSeasons.length > 0 ? Math.min(...plSeasons.map((r) => r.season)) : null;
  return { totalPlApps, plDebutYear };
}

function bandPlApps(totalPlApps) {
  if (totalPlApps >= 300) return "300+";
  if (totalPlApps >= 150) return "150-300";
  if (totalPlApps >= 50) return "50-150";
  return "<50";
}

function normalizePosition(rawPosition) {
  if (!rawPosition) return null;
  const p = rawPosition.trim().toLowerCase();
  if (p === "gk" || p.includes("keeper")) return "Goalkeeper";
  if (p.includes("midfield")) return "Midfielder";
  if (p.includes("back") || p.includes("defen")) return "Defender";
  if (p.includes("forward") || p.includes("attack") || p.includes("striker") || p.includes("winger")) return "Attacker";
  return rawPosition;
}

function getCurrentClub(stints) {
  const clubStints = stints.filter((s) => !s.isNationalTeam);
  if (clubStints.length === 0) return null;
  const mostRecent = clubStints.reduce((latest, s) => {
    if (s.yearEnd > latest.yearEnd) return s;
    if (s.yearEnd === latest.yearEnd && s.yearStart > latest.yearStart) return s;
    return latest;
  });
  return mostRecent.clubName;
}

// International caps and goals — purely display info in the free-clue
// banner, never compared. Pulled straight from the national-team
// stint(s) already sitting in the same career data used for everything
// else, so this costs zero extra API calls.
function getInternationalStats(stints) {
  const nationalStints = stints.filter((s) => s.isNationalTeam);
  const caps = nationalStints.reduce((sum, s) => sum + (s.appearances || 0), 0);
  const goals = nationalStints.reduce((sum, s) => sum + (s.goals || 0), 0);
  return { caps, goals };
}

function computeAge(birthDateStr) {
  if (!birthDateStr) return null;
  const birthDate = new Date(birthDateStr);
  if (Number.isNaN(birthDate.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const hasHadBirthdayThisYear =
    today.getMonth() > birthDate.getMonth() ||
    (today.getMonth() === birthDate.getMonth() && today.getDate() >= birthDate.getDate());
  if (!hasHadBirthdayThisYear) age--;
  return age;
}

const SKIPPED_LOG_PATH = path.join(__dirname, "../data/skipped-players.json");

function logSkipped(entries) {
  saveJSON(SKIPPED_LOG_PATH, entries.map((e) => ({ ...e, loggedAt: new Date().toISOString() })));
}

function normalizeNameForDedup(name) {
  return name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toLowerCase().replace(/[^a-z\s]/g, "");
}

async function run() {
  const candidates = loadJSON(SOURCE_POOL_PATH, []);
  if (candidates.length === 0) {
    throw new Error(`No source pool found at ${SOURCE_POOL_PATH}. Run build-pl-squad.js first.`);
  }

  const validTeamNames = loadJSON(VALID_TEAMS_PATH, []);
  const validTeamKeys = new Set(validTeamNames.map(normalizeClubKey));
  if (validTeamKeys.size === 0) {
    console.warn("[build-attributes] no valid-teams list found (run build-pl-squad.js first for full protection) — skipping the not-actually-in-the-PL check.");
  }

  console.log(`[build-attributes] processing ${candidates.length} players...`);

  const attributesById = {};
  const usedNames = new Set();
  const skippedEntries = [];
  let processed = 0;
  let skipped = 0;
  let nameCollisions = 0;

  for (const candidate of candidates) {
    try {
      const { stints, seasonRecords } = await getCareerData(candidate.id);
      if (stints.filter((s) => !s.isNationalTeam).length === 0) {
        skippedEntries.push({ name: candidate.name, id: candidate.id, reason: "No usable club stints found (all filtered as youth/reserve/national team, or genuinely no career data)." });
        skipped++;
        continue;
      }

      const { totalPlApps, plDebutYear } = derivePlStats(seasonRecords);

      if (plDebutYear === null) {
        skippedEntries.push({ name: candidate.name, id: candidate.id, reason: "No PL debut year could be determined — API-Football's season data for this player had no matching Premier League league-ID records." });
        skipped++;
        continue;
      }

      const { caps: internationalCaps, goals: internationalGoals } = getInternationalStats(stints);

      // Eligibility rule: a real PL appearance is always required (this
      // is a Premier League guessing game, full stop), but 1 appearance
      // alone barely narrows anything — almost every squad player picks
      // up at least one substitute cameo eventually. The real filter is
      // the second condition: either genuinely established in the PL
      // (2+ appearances), or independently recognisable regardless of
      // PL history (1+ international cap) — this specifically keeps a
      // big-name new signing like Xavi Schlager in the pool even before
      // they've racked up PL minutes, while still excluding a genuinely
      // obscure academy player with neither.
      if (totalPlApps < 1) {
        skippedEntries.push({ name: candidate.name, id: candidate.id, reason: "Zero real Premier League appearances." });
        skipped++;
        continue;
      }
      if (totalPlApps < 2 && internationalCaps < 1) {
        skippedEntries.push({ name: candidate.name, id: candidate.id, reason: `Below the recognisability threshold — only ${totalPlApps} PL appearance(s) and ${internationalCaps} international cap(s).` });
        skipped++;
        continue;
      }

      let position = null;
      let nationality = null;
      let age = null;
      let displayName = candidate.name;
      try {
        const lastKnownSeason = stints[stints.length - 1]?.yearStart ?? new Date().getFullYear();
        const profile = await getPlayerProfile(candidate.id, lastKnownSeason);
        position = normalizePosition(profile.position);
        nationality = profile.nationality;
        age = computeAge(profile.birthDate);
        const looksAbbreviated = /^[A-Z]\.\s?[A-Z]/.test(candidate.name);
        if (looksAbbreviated && profile.firstname && profile.lastname) {
          const firstGivenName = profile.firstname.trim().split(/\s+/)[0];
          displayName = `${firstGivenName} ${profile.lastname}`.trim();
        }
      } catch (err) {
        console.warn(`[build-attributes] position lookup failed for ${candidate.name}: ${err.message}`);
      }

      const currentClub = getCurrentClub(stints);

      const clubKey = resolveClubAlias(normalizeClubKey(currentClub));
      const looksLikeYouthOrReserve = currentClub && isYouthOrReserveTeam(currentClub);
      const looksLikeRealPlClub = !looksLikeYouthOrReserve && (validTeamKeys.size === 0 || [...validTeamKeys].some((rawValidKey) => {
        const validKey = resolveClubAlias(rawValidKey);
        return clubKey === validKey || clubKey.includes(validKey) || validKey.includes(clubKey);
      }));
      if (currentClub && !looksLikeRealPlClub) {
        console.warn(`[build-attributes] skipping "${candidate.name}" (id ${candidate.id}) — current club "${currentClub}" isn't a real Premier League team; likely already left the league (stale squad-list data).`);
        skippedEntries.push({ name: candidate.name, id: candidate.id, reason: `Current club "${currentClub}" isn't a real Premier League team — likely already left the league; the source squad list was stale.` });
        skipped++;
        continue;
      }

      const nameKey = normalizeNameForDedup(displayName);
      if (usedNames.has(nameKey)) {
        console.warn(`[build-attributes] skipping "${displayName}" (id ${candidate.id}) — name collides with an already-added player.`);
        skippedEntries.push({ name: candidate.name, id: candidate.id, reason: `Name collision — resolved display name "${displayName}" matches an already-added player.` });
        nameCollisions++;
        continue;
      }

      attributesById[candidate.id] = {
        name: displayName,
        position,
        age,
        currentClub,
        plDebutYear,
        plAppsBand: bandPlApps(totalPlApps),
        nationality,
        internationalCaps,
        internationalGoals,
      };
      usedNames.add(nameKey);

      processed++;
      if (processed % 50 === 0) console.log(`[build-attributes] ${processed}/${candidates.length} done...`);
    } catch (err) {
      console.warn(`[build-attributes] failed for ${candidate.name} (${candidate.id}): ${err.message}`);
      skippedEntries.push({ name: candidate.name, id: candidate.id, reason: `API/processing error: ${err.message}` });
      skipped++;
    }
  }

  saveJSON(OUTPUT_PATH, attributesById);
  logSkipped(skippedEntries);
  console.log(`[build-attributes] wrote ${processed} players to ${OUTPUT_PATH} (${skipped} skipped, ${nameCollisions} name collisions resolved).`);
  console.log(`[build-attributes] skip reasons logged to ${SKIPPED_LOG_PATH} — check this file to see why any specific player is missing.`);
}

run().catch((err) => {
  console.error("[build-attributes] fatal error:", err);
  process.exit(1);
});