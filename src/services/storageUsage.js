const fs = require("fs").promises;
const path = require("path");
const config = require("../config");

let cached = null;
let pending = null;
const CACHE_MS = 30000;

async function directorySize(root) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  let total = 0;
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += (await fs.stat(child)).size;
  }
  return total;
}

async function getStorageUsage({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.bytes;
  if (pending) return pending;
  pending = directorySize(config.storageDir).then((bytes) => {
    cached = { at: Date.now(), bytes };
    return bytes;
  }).finally(() => { pending = null; });
  return pending;
}

function invalidateStorageUsage() { cached = null; }

module.exports = { directorySize, getStorageUsage, invalidateStorageUsage };
