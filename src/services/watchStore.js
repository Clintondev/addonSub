const config = require("../config");
const { safeChildPath } = require("../utils/security");
const { withFileLock } = require("../utils/fileLock");
const { readJsonFile, writeJsonFileAtomic } = require("../utils/atomicJson");
const { parseVideoId } = require("./videoId");

const dbDir = safeChildPath(config.storageDir, "db");
const dbFile = safeChildPath(dbDir, "watching.json");
const lockFile = safeChildPath(dbDir, "watching.lock");

function readState() {
  return readJsonFile(dbFile, {
    fallback: () => ({ version: 1, items: {} }),
    validate: (value) => Boolean(value && value.items && typeof value.items === "object" && !Array.isArray(value.items)),
  });
}

function persist(state) {
  writeJsonFileAtomic(dbFile, state);
}

function keyFor(source) {
  try { return parseVideoId(source.type, source.videoId).imdbId; }
  catch (_) { return source.videoId || source.sourceId; }
}

function markPlayback(source) {
  return withFileLock(lockFile, () => {
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
  });
}

function update(imdbId, patch) {
  return withFileLock(lockFile, () => {
    const state = readState();
    const current = state.items[imdbId] || { imdbId, status: "watching", prefetchAhead: 0 };
    state.items[imdbId] = { ...current, ...patch, imdbId, updatedAt: new Date().toISOString() };
    persist(state);
    return state.items[imdbId];
  });
}

function get(imdbId) { return readState().items[imdbId] || null; }
function list() { return Object.values(readState().items); }

module.exports = { get, keyFor, list, markPlayback, update };
