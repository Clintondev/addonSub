const util = require("util");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { redact } = require("./utils/security");

const logDir = path.join(config.storageDir, "logs");
const logFile = path.join(logDir, "addon.jsonl");
const memory = [];
const MAX_MEMORY = 1000;

function remember(entry) {
  memory.push(entry);
  if (memory.length > MAX_MEMORY) memory.splice(0, memory.length - MAX_MEMORY);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
      fs.renameSync(logFile, path.join(logDir, "addon.previous.jsonl"));
    }
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (_) {}
}

function write(level, message, meta) {
  const at = new Date().toISOString();
  const safeMessage = redact(message);
  const safeMeta = meta && Object.keys(meta).length ? redact(meta) : {};
  remember({ at, level, message: safeMessage, meta: safeMeta });
  const suffix = Object.keys(safeMeta).length ? ` ${util.inspect(safeMeta, { depth: 5 })}` : "";
  const line = `[${at}] ${level.toUpperCase()} ${safeMessage}${suffix}`;
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

function readLogs({ level, sourceId, limit = 200 } = {}) {
  let entries;
  try {
    entries = fs.readFileSync(logFile, "utf8").trim().split("\n").slice(-MAX_MEMORY).map((line) => JSON.parse(line));
  } catch (_) { entries = [...memory]; }
  return entries.filter((entry) => !level || entry.level === level)
    .filter((entry) => !sourceId || entry.meta?.sourceId === sourceId || entry.meta?.jobId === sourceId)
    .slice(-Math.max(1, Math.min(1000, Number(limit) || 200))).reverse();
}

module.exports = {
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta),
  readLogs,
};
