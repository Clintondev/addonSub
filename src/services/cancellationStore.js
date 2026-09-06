const fs = require("fs");
const config = require("../config");
const { safeChildPath } = require("../utils/security");

function cancellationPath(sourceId) {
  return safeChildPath(config.storageDir, "db", "cancellations", `${sourceId}.json`);
}

function markCancelled(sourceId, at = Date.now()) {
  const file = cancellationPath(sourceId);
  fs.mkdirSync(require("path").dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${at}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ sourceId, cancelledAt: at }), "utf8");
  fs.renameSync(temporary, file);
  return at;
}

function cancelledAt(sourceId) {
  try { return Number(JSON.parse(fs.readFileSync(cancellationPath(sourceId), "utf8")).cancelledAt || 0); }
  catch (_) { return 0; }
}

function isCancelled(sourceId, requestedAt) {
  return cancelledAt(sourceId) >= Number(requestedAt || 0);
}

function clearCancellation(sourceId) {
  fs.rmSync(cancellationPath(sourceId), { force: true });
}

module.exports = { cancelledAt, cancellationPath, clearCancellation, isCancelled, markCancelled };
