const test = require("node:test");
const assert = require("node:assert/strict");
const { affinityScore, findEpisodeFile, nextEpisodeIds, releaseProfile, selectAffinityItem } = require("../src/services/seriesPrefetch");

test("discovers the next episodes across a season boundary and ignores specials", () => {
  const videos = [
    { id: "tt1234567:0:1", season: 0, episode: 1 },
    { id: "tt1234567:1:1", season: 1, episode: 1 },
    { id: "tt1234567:1:2", season: 1, episode: 2 },
    { id: "tt1234567:2:1", season: 2, episode: 1 },
    { id: "tt1234567:2:2", season: 2, episode: 2 },
  ];
  assert.deepEqual(nextEpisodeIds(videos, "tt1234567:1:1", 3), ["tt1234567:1:2", "tt1234567:2:1", "tt1234567:2:2"]);
});

test("finds the exact episode inside a season pack", () => {
  const files = [
    { index: 1, name: "Show.S01E01.1080p.mkv", size: 1000 },
    { index: 2, name: "Show.S01E02.1080p.mkv", size: 1000 },
    { index: 3, name: "Show.S01E02.sample.mkv", size: 100 },
    { index: 4, name: "Show.S01E03.1080p.mkv", size: 1000 },
  ];
  assert.equal(findEpisodeFile(files, 1, 2).index, 2);
  assert.equal(findEpisodeFile(files, 1, 4), null);
});

test("understands Portuguese T01E02 and 1x02 episode naming", () => {
  assert.equal(findEpisodeFile([{ index: 5, name: "Serie T01E02 Dual.mkv", size: 50 }], 1, 2).index, 5);
  assert.equal(findEpisodeFile([{ index: 6, name: "Serie.1x02.HDTV.avi", size: 50 }], 1, 2).index, 6);
});

test("prefers the same add-on and release profile", () => {
  const selected = { addonId: "torrentio", filename: "Show.S01E01.1080p.BluRay.x265-Silence.mkv", videoSize: 1000 };
  const close = { addonId: "torrentio", filename: "Show.S01E02.1080p.BluRay.x265-Silence.mkv", videoSize: 1050 };
  const distant = { addonId: "other", filename: "Show.S01E02.720p.WEBRip.x264-Other.mkv", videoSize: 400 };
  assert.ok(affinityScore(close, selected) > affinityScore(distant, selected));
  assert.equal(selectAffinityItem([{ record: distant }, { record: close }], selected).record, close);
  assert.deepEqual(releaseProfile(close).codec, "h265");
});

test("same torrent always outranks a merely similar release", () => {
  const selected = { addonId: "one", infoHash: "abc", filename: "Show.S01E01.1080p.x265.mkv" };
  const sameTorrent = { addonId: "other", infoHash: "abc", filename: "Show.S01E02.720p.x264.mkv" };
  const similar = { addonId: "one", infoHash: "different", filename: "Show.S01E02.1080p.x265.mkv" };
  assert.ok(affinityScore(sameTorrent, selected) > affinityScore(similar, selected));
});
