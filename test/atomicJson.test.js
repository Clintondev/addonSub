const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readJsonFile, writeJsonFileAtomic } = require("../src/utils/atomicJson");

test("recovers the last valid JSON backup instead of replacing a corrupt store", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-auto-json-"));
  const file = path.join(dir, "store.json");
  try {
    writeJsonFileAtomic(file, { version: 1 });
    writeJsonFileAtomic(file, { version: 2 });
    fs.writeFileSync(file, "{corrupt", "utf8");
    assert.deepEqual(readJsonFile(file, { fallback: {}, validate: (value) => Number.isInteger(value.version) }), { version: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not silently accept corruption when no valid backup exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-auto-json-"));
  const file = path.join(dir, "store.json");
  try {
    fs.writeFileSync(file, "not-json", "utf8");
    assert.throws(() => readJsonFile(file, { fallback: {} }), /Could not read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
