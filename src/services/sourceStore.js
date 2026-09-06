const fs = require("fs");
const path = require("path");
const config = require("../config");
const { safeChildPath } = require("../utils/security");
const { withFileLock } = require("../utils/fileLock");

const dbDir = safeChildPath(config.storageDir, "db");
const dbFile = safeChildPath(dbDir, "sources.json");
const lockFile = safeChildPath(dbDir, "sources.lock");

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
}

function upsert(source) {
  return withFileLock(lockFile, () => {
    const latest = readState();
    const current = latest.sources[source.sourceId] || {};
    const updated = { ...current, ...source, discoveredAt: current.discoveredAt || Date.now(), refreshedAt: Date.now() };
    latest.sources[source.sourceId] = updated;
    persist(latest);
    return updated;
  });
}

function get(sourceId) {
  return readState().sources[sourceId] || null;
}

function list({ videoId, limit = 200 } = {}) {
  return Object.values(readState().sources)
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
  return withFileLock(lockFile, () => {
    const latest = readState();
    const current = latest.sources[sourceId] || null;
    if (!current) return null;
    delete latest.sources[sourceId];
    persist(latest);
    return current;
  });
}

module.exports = { upsert, get, list, publicSource, remove };
