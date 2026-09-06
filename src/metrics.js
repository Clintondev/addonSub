const fs = require("fs");
const config = require("./config");
const { safeChildPath } = require("./utils/security");
const { withFileLock } = require("./utils/fileLock");

const defaults = {
  jobs_total: 0,
  jobs_failed: 0,
  translations_total: 0,
  cache_hits: 0,
  extraction_failed: 0,
};
const metricsDir = safeChildPath(config.storageDir, "db");
const metricsFile = safeChildPath(metricsDir, "metrics.json");
const lockFile = safeChildPath(metricsDir, "metrics.lock");

function readCounters() {
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(metricsFile, "utf8")) }; }
  catch (_) { return { ...defaults }; }
}

function inc(name, value = 1) {
  try {
    withFileLock(lockFile, () => {
      const counters = readCounters();
      counters[name] = (counters[name] || 0) + value;
      fs.mkdirSync(metricsDir, { recursive: true });
      const temporary = `${metricsFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(counters, null, 2), "utf8");
      fs.renameSync(temporary, metricsFile);
    });
  } catch (_) {
    // Observability must never fail a media or subtitle request.
  }
}

function getMetricsText() {
  return Object.entries(readCounters())
    .map(([k, v]) => `${k} ${v}`)
    .join("\n");
}

module.exports = {
  inc,
  getMetricsText,
};
