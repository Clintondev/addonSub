const fs = require("fs");
const config = require("../config");
const { safeChildPath } = require("../utils/security");

function metaPath(sourceId) {
  return safeChildPath(config.storageDir, "subtitles", sourceId, "state.json");
}

function readMeta(sourceId) {
  try { return JSON.parse(fs.readFileSync(metaPath(sourceId), "utf8")); } catch (_) { return {}; }
}

function writeMeta(sourceId, data) {
  const file = metaPath(sourceId);
  fs.mkdirSync(require("path").dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function transition(sourceId, stage, patch = {}) {
  const current = readMeta(sourceId);
  const terminalCleanup = stage === "ready"
    ? { error: null, extractionError: null }
    : {};
  const normalizedPatch = { ...terminalCleanup, ...patch };
  const event = { stage, at: new Date().toISOString(), ...normalizedPatch };
  const history = [...(current.history || [])];
  if (current.stage === stage && history.length) history[history.length - 1] = event;
  else history.push(event);
  const updated = { ...current, sourceId, stage, updatedAt: event.at, ...normalizedPatch, history };
  writeMeta(sourceId, updated);
  return updated;
}

module.exports = { readMeta, writeMeta, mergeMeta: (id, patch) => transition(id, readMeta(id).stage || "discovered", patch), recordJob: (id, patch) => transition(id, patch.status || "unknown", patch), transition };
