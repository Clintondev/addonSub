const fs = require("fs");
const path = require("path");
const config = require("../config");

function metaPath(videoKey) {
  return path.join(config.storageDir, videoKey, "meta.json");
}

function readMeta(videoKey) {
  const file = metaPath(videoKey);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return {};
  }
}

function writeMeta(videoKey, data) {
  const file = metaPath(videoKey);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function mergeMeta(videoKey, patch) {
  const current = readMeta(videoKey);
  const updated = { ...current, ...patch };
  writeMeta(videoKey, updated);
  return updated;
}

function recordJob(videoKey, payload) {
  const current = readMeta(videoKey);
  const jobs = current.jobs || [];
  jobs.push({
    ts: Date.now(),
    ...payload,
  });
  const updated = { ...current, jobs };
  writeMeta(videoKey, updated);
  return updated;
}

module.exports = {
  readMeta,
  writeMeta,
  mergeMeta,
  recordJob,
};
