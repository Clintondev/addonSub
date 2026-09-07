const config = require("../config");
const { safeChildPath } = require("../utils/security");
const { withFileLock } = require("../utils/fileLock");
const { readJsonFile, writeJsonFileAtomic } = require("../utils/atomicJson");

const dbDir = safeChildPath(config.storageDir, "db");
const dbFile = safeChildPath(dbDir, "sources.json");
const lockFile = safeChildPath(dbDir, "sources.lock");

function readState() {
  return readJsonFile(dbFile, {
    fallback: () => ({ version: 1, sources: {} }),
    validate: (loaded) => Boolean(loaded && loaded.sources && typeof loaded.sources === "object" && !Array.isArray(loaded.sources)),
  });
}

function persist(nextState) {
  writeJsonFileAtomic(dbFile, nextState);
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
  const safe = { ...source };
  delete safe.url;
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
