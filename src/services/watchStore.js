const fs = require("fs");
const path = require("path");
const config = require("../config");
const { safeChildPath } = require("../utils/security");
const { parseVideoId } = require("./videoId");

const dbDir = safeChildPath(config.storageDir, "db");
const dbFile = safeChildPath(dbDir, "watching.json");

function readState() {
  try {
    const value = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    if (!value.items || typeof value.items !== "object") throw new Error("Invalid watch store");
    return value;
  } catch (_) {
    return { version: 1, items: {} };
  }
}

function persist(state) {
  fs.mkdirSync(dbDir, { recursive: true });
  const temporary = `${dbFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, dbFile);
}

function keyFor(source) {
  try { return parseVideoId(source.type, source.videoId).imdbId; }
  catch (_) { return source.videoId || source.sourceId; }
}

function markPlayback(source) {
  const state = readState();
  const key = keyFor(source);
  const current = state.items[key] || {};
  state.items[key] = {
    ...current,
    imdbId: key,
    type: source.type,
    status: current.status === "completed" ? "watching" : (current.status || "watching"),
    currentVideoId: source.videoId,
    currentSourceId: source.sourceId,
    prefetchAhead: Number.isInteger(current.prefetchAhead) ? current.prefetchAhead : 0,
    playCount: (current.playCount || 0) + 1,
    firstPlayedAt: current.firstPlayedAt || new Date().toISOString(),
    lastPlayedAt: new Date().toISOString(),
  };
  persist(state);
  return state.items[key];
}

function update(imdbId, patch) {
  const state = readState();
  const current = state.items[imdbId] || { imdbId, status: "watching", prefetchAhead: 0 };
  state.items[imdbId] = { ...current, ...patch, imdbId, updatedAt: new Date().toISOString() };
  persist(state);
  return state.items[imdbId];
}

function get(imdbId) { return readState().items[imdbId] || null; }
function list() { return Object.values(readState().items); }

module.exports = { get, keyFor, list, markPlayback, update };
