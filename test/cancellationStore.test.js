const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "addon-cancellation-"));
process.env.STORAGE_DIR = storage;

const { cancelledAt, clearCancellation, isCancelled, markCancelled } = require("../src/services/cancellationStore");

test.after(() => fs.rmSync(storage, { recursive: true, force: true }));

test("a newly requested deterministic source id can start after deletion", () => {
  const sourceId = "src_0123456789abcdef0123456789abcdef";
  markCancelled(sourceId, 100);
  assert.equal(cancelledAt(sourceId), 100);
  assert.equal(isCancelled(sourceId, 99), true);

  clearCancellation(sourceId);
  assert.equal(cancelledAt(sourceId), 0);
  assert.equal(isCancelled(sourceId, 101), false);
});
