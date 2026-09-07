const test = require("node:test");
const assert = require("node:assert/strict");
const { isManagedSource, storageView } = require("../src/services/manager");

const discovered = { sourceId: "src_discovered" };

test("does not present a stream lookup as a pending download", () => {
  assert.equal(isManagedSource(discovered, null), false);
});

test("presents selected, downloaded and prefetched sources", () => {
  assert.equal(isManagedSource(discovered, { currentSourceId: discovered.sourceId }), true);
  assert.equal(isManagedSource({ ...discovered, localPath: "/media/episode.mkv" }, null), true);
  assert.equal(isManagedSource({ ...discovered, prefetchPosition: 1 }, null), true);
});

test("deduplicates shared physical media and reports measured total storage", () => {
  const storage = { mediaBytes: 100, subtitleBytes: 5, hlsBytes: 10, playbackBytes: 20 };
  const shows = [{ episodes: [
    { sourceId: "src_a", localPath: "/media/shared.mkv", storage },
    { sourceId: "src_b", localPath: "/media/shared.mkv", storage },
  ] }];
  const result = storageView(shows, 2, 999);
  assert.equal(result.mediaBytes, 100);
  assert.equal(result.subtitleBytes, 10);
  assert.equal(result.usedBytes, 999);
});
