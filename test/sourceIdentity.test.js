const test = require("node:test");
const assert = require("node:assert/strict");
const { createSourceId, dedupeKey } = require("../src/services/sourceIdentity");

test("sourceId survives a temporary URL refresh", () => {
  const first = { url: "https://cdn.example/a?token=one", name: "1080p", behaviorHints: { filename: "Show.S01E01.mkv", videoSize: 123 } };
  const second = { ...first, url: "https://cdn.example/a?token=two" };
  assert.equal(createSourceId(first, "upstream-1", "tt1:1:1"), createSourceId(second, "upstream-1", "tt1:1:1"));
});

test("torrent deduplication ignores upstream origin", () => {
  const stream = { infoHash: "ABC", fileIdx: 2 };
  assert.equal(dedupeKey(stream, "one", "tt1"), dedupeKey(stream, "two", "tt1"));
});
