const test = require("node:test");
const assert = require("node:assert/strict");
const { chooseFile, isPausedState, torrentStorageRoot } = require("../src/services/qbittorrent");

const files = [
  { index: 0, name: "sample.txt", size: 5000 },
  { index: 1, name: "episode-small.mkv", size: 1000 },
  { index: 2, name: "episode-main.mkv", size: 9000 },
];

test("selects the upstream fileIdx even when it is a string", () => {
  assert.equal(chooseFile(files, "1").index, 1);
});

test("falls back to the largest video file", () => {
  assert.equal(chooseFile(files, null).index, 2);
});

test("recognizes qBittorrent paused and stopped states", () => {
  assert.equal(isPausedState("pausedDL"), true);
  assert.equal(isPausedState("stoppedDL"), true);
  assert.equal(isPausedState("stalledDL"), false);
  assert.equal(isPausedState("downloading"), false);
});

test("reuses the actual storage folder of an existing torrent", () => {
  const root = torrentStorageRoot({ save_path: "/downloads/src_existing" }, "src_new");
  assert.match(root.replace(/\\/g, "/"), /storage\/media\/src_existing$/);
});
