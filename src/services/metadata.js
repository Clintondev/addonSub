const config = require("../config");
const { safeChildPath } = require("../utils/security");
const { withFileLock } = require("../utils/fileLock");
const { readJsonFile, writeJsonFileAtomic } = require("../utils/atomicJson");

function metaPath(sourceId) {
  return safeChildPath(config.storageDir, "subtitles", sourceId, "state.json");
}

function lockPath(sourceId) {
  return safeChildPath(config.storageDir, "subtitles", sourceId, "state.lock");
}

function readMeta(sourceId) {
  return readJsonFile(metaPath(sourceId), { fallback: () => ({}), validate: (value) => Boolean(value && typeof value === "object" && !Array.isArray(value)) });
}

function writeMeta(sourceId, data) {
  writeJsonFileAtomic(metaPath(sourceId), data);
}

function transitionIf(sourceId, stage, patch = {}, predicate = () => true) {
  return withFileLock(lockPath(sourceId), () => {
    const current = readMeta(sourceId);
    if (!predicate(current)) return current;
    const terminalCleanup = stage === "ready"
      ? { error: null, extractionError: null }
      : {};
    const normalizedPatch = { ...terminalCleanup, ...patch };
    const now = Date.now();
    const stageChanged = current.stage !== stage;
    const stageDurationsMs = { ...current.stageDurationsMs };
    if (stageChanged && current.stage && current.stageStartedAt) stageDurationsMs[current.stage] = (stageDurationsMs[current.stage] || 0) + Math.max(0, now - Date.parse(current.stageStartedAt));
    const event = { stage, at: new Date(now).toISOString(), ...normalizedPatch };
    const history = [...(current.history || [])];
    if (current.stage === stage && history.length) history[history.length - 1] = event;
    else history.push(event);
    const updated = { ...current, sourceId, stage, updatedAt: event.at, ...normalizedPatch, stageStartedAt: stageChanged ? event.at : (current.stageStartedAt || event.at), stageDurationsMs, history: history.slice(-64) };
    writeMeta(sourceId, updated);
    return updated;
  });
}

function transition(sourceId, stage, patch = {}) {
  return transitionIf(sourceId, stage, patch);
}

module.exports = { readMeta, writeMeta, mergeMeta: (id, patch) => transition(id, readMeta(id).stage || "discovered", patch), recordJob: (id, patch) => transition(id, patch.status || "unknown", patch), transition, transitionIf };
