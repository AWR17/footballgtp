// scripts/pick-daily-answer.js
//
// THE DAILY JOB for FootballGTP (separate from Scouting Report's own
// daily-puzzle.js, but same underlying pattern). Run once a day via
// GitHub Actions:
// 1. Loads the full attribute pool (public/footygtp-attributes.json,
//    built by build-attributes.js).
// 2. Picks the next unused player, deterministic by date.
// 3. Writes public/daily-answer.json (what the frontend actually reads)
//    plus a dated archive copy.
// 4. Marks that player used, so it's never picked again.
//
// This exists because computing "today's answer" client-side by hashing
// the date against the attributes file (the original approach) breaks
// the moment that file is ever regenerated — the hash-to-player mapping
// shifts, meaning different visitors could see different answers, and
// nothing stops the same player recurring. This script makes the day's
// answer a committed, permanent fact instead of a live computation.
//
// Usage: node scripts/pick-daily-answer.js [YYYY-MM-DD]

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ATTRIBUTES_PATH = path.join(__dirname, "../public/footygtp-attributes.json");
const USED_PATH = path.join(__dirname, "../data/used-answers.json");
const DAILY_ANSWER_PATH = path.join(__dirname, "../public/daily-answer.json");
const ANSWERS_ARCHIVE_DIR = path.join(__dirname, "../public/answers");

function todayISO(argDate) {
  return argDate || new Date().toISOString().slice(0, 10);
}

function hashDateToInt(dateStr) {
  const hash = crypto.createHash("md5").update(dateStr).digest("hex");
  return parseInt(hash.slice(0, 8), 16);
}

function loadJSON(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function run(dateArg) {
  const date = todayISO(dateArg);

  const attributesById = loadJSON(ATTRIBUTES_PATH, null);
  if (!attributesById) {
    throw new Error(`No attributes file found at ${ATTRIBUTES_PATH}. Run build-attributes.js first.`);
  }

  const usedIds = new Set(loadJSON(USED_PATH, []));
  const allIds = Object.keys(attributesById);
  const unusedIds = allIds.filter((id) => !usedIds.has(id));

  if (unusedIds.length === 0) {
    throw new Error(
      "Player pool exhausted — every player has been used as an answer. " +
      "Run build-attributes.js with a larger pool size to top it up, or " +
      "clear data/used-answers.json to allow repeats."
    );
  }

  const index = hashDateToInt(date) % unusedIds.length;
  const playerId = unusedIds[index];
  const player = attributesById[playerId];

  const dailyAnswer = {
    date,
    playerId,
    playerName: player.name, // included for easy debugging/review — the frontend re-derives attributes from the full attributes file, not from this field
  };

  saveJSON(DAILY_ANSWER_PATH, dailyAnswer);
  saveJSON(path.join(ANSWERS_ARCHIVE_DIR, `${date}.json`), dailyAnswer);

  usedIds.add(playerId);
  saveJSON(USED_PATH, [...usedIds]);

  console.log(`[pick-daily-answer] ${date}: selected ${player.name} (id ${playerId}). ${unusedIds.length - 1} players remaining unused.`);
}

const dateArg = process.argv[2];
try {
  run(dateArg);
} catch (err) {
  console.error("[pick-daily-answer] fatal error:", err.message);
  process.exit(1);
}
