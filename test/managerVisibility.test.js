const test = require("node:test");
const assert = require("node:assert/strict");
const { isManagedSource } = require("../src/services/manager");

const discovered = { sourceId: "src_discovered" };

test("does not present a stream lookup as a pending download", () => {
  assert.equal(isManagedSource(discovered, null), false);
});

test("presents selected, downloaded and prefetched sources", () => {
  assert.equal(isManagedSource(discovered, { currentSourceId: discovered.sourceId }), true);
  assert.equal(isManagedSource({ ...discovered, localPath: "/media/episode.mkv" }, null), true);
  assert.equal(isManagedSource({ ...discovered, prefetchPosition: 1 }, null), true);
});
