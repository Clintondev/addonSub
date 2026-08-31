const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { validateLocalMedia } = require("../src/services/mediaValidation");
const { currentRecoveryCandidate, recoveryCandidates, seedCount } = require("../src/services/mediaRecovery");

test("rejects a correctly sized media file containing only zero bytes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-validation-"));
  const file = path.join(dir, "episode.mkv");
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024));
  assert.match(validateLocalMedia(file, { probe: false }).reason, /bytes zerados/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("accepts sampled nonzero data before the FFprobe stage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "media-validation-"));
  const file = path.join(dir, "episode.mkv");
  const content = Buffer.alloc(2 * 1024 * 1024);
  content[0] = 0x1a;
  content[Math.floor(content.length / 2)] = 0x45;
  content[content.length - 1] = 0xdf;
  fs.writeFileSync(file, content);
  assert.equal(validateLocalMedia(file, { probe: false }).valid, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recovery candidates exclude the corrupt hash, deduplicate, and prefer seeds", () => {
  const source = { infoHash: "a".repeat(40) };
  const items = [
    { record: { sourceId: "same", infoHash: "a".repeat(40), title: "👤 99" } },
    { record: { sourceId: "low", infoHash: "b".repeat(40), title: "👤 2" } },
    { record: { sourceId: "high", infoHash: "c".repeat(40), title: "👤 50" } },
    { record: { sourceId: "duplicate", infoHash: "c".repeat(40), title: "👤 1" } },
  ];
  assert.equal(seedCount(items[2].record), 50);
  assert.deepEqual(recoveryCandidates(items, source, 3).map((item) => item.record.sourceId), ["high", "low"]);
});

test("always schedules the same torrent for recheck before alternate releases", () => {
  const source = { sourceId: "episode", infoHash: "A".repeat(40) };
  const candidate = currentRecoveryCandidate(source);
  assert.equal(candidate.record.infoHash, "a".repeat(40));
  assert.equal(candidate.record.sourceId, "episode");
  assert.equal(candidate.recheck, true);
  assert.equal(candidate.sameSource, true);
  assert.equal(currentRecoveryCandidate({ sourceId: "direct-url" }), null);
});
