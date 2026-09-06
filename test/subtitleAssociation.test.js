const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { sameLocalMedia } = require("../src/services/subtitleAssociation");

test("shares a subtitle only when two records resolve to the same existing media file", (context) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-auto-association-"));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = path.join(dir, "episode-a.mkv");
  const second = path.join(dir, "episode-b.mkv");
  fs.writeFileSync(first, "media");
  fs.writeFileSync(second, "other");
  assert.equal(sameLocalMedia({ localPath: first }, { localPath: first }), true);
  assert.equal(sameLocalMedia({ localPath: first }, { localPath: second }), false);
  assert.equal(sameLocalMedia({ localPath: first }, { localPath: path.join(dir, "missing.mkv") }), false);
});
