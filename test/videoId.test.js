const test = require("node:test");
const assert = require("node:assert/strict");
const { parseVideoId } = require("../src/services/videoId");

test("parses IMDb movie ids", () => {
  assert.deepEqual(parseVideoId("movie", "tt1234567"), { type: "movie", imdbId: "tt1234567", videoId: "tt1234567" });
});

test("parses IMDb episode ids", () => {
  assert.deepEqual(parseVideoId("series", "tt1234567:2:5"), { type: "series", imdbId: "tt1234567", season: 2, episode: 5, videoId: "tt1234567:2:5" });
});

test("rejects malformed and mismatched ids", () => {
  assert.throws(() => parseVideoId("movie", "rdpt:1"));
  assert.throws(() => parseVideoId("series", "tt1234567"));
});
