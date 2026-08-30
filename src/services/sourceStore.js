const fs = require("fs");
const path = require("path");
const config = require("../config");
const { safeChildPath } = require("../utils/security");

const dbDir = safeChildPath(config.storageDir, "db");
const dbFile = safeChildPath(dbDir, "sources.json");
let state;

function readState() {
  try {
    const loaded = JSON.parse(fs.readFileSync(dbFile, "utf8"));
    if (!loaded.sources || typeof loaded.sources !== "object") throw new Error("Invalid source store");
    return loaded;
  } catch (_) {
    return { version: 1, sources: {} };
  }
}

function persist(nextState) {
  fs.mkdirSync(dbDir, { recursive: true });
  const temporary = `${dbFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(nextState, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, dbFile);
  state = nextState;
}

function upsert(source) {
  const latest = readState();
  const current = latest.sources[source.sourceId] || {};
  const updated = { ...current, ...source, discoveredAt: current.discoveredAt || Date.now(), refreshedAt: Date.now() };
  latest.sources[source.sourceId] = updated;
  persist(latest);
  return updated;
}

function get(sourceId) {
  state = readState();
  return state.sources[sourceId] || null;
}

function list({ videoId, limit = 200 } = {}) {
  state = readState();
  return Object.values(state.sources)
    .filter((source) => !videoId || source.videoId === videoId)
    .sort((a, b) => b.refreshedAt - a.refreshedAt)
    .slice(0, limit);
}

function publicSource(source) {
  if (!source) return null;
  const { url, ...safe } = source;
  return safe;
}

function remove(sourceId) {
  const latest = readState();
  const current = latest.sources[sourceId] || null;
  if (!current) return null;
  delete latest.sources[sourceId];
  persist(latest);
  return current;
}

module.exports = { upsert, get, list, publicSource, remove };
