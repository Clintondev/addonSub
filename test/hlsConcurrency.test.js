const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");

test("concurrent requests during finalization share one encoder and publish a complete generation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hls-concurrency-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "input.mkv");
  fs.writeFileSync(input, "mock media");
  let releaseProbe;
  let outputProbeStarted;
  const probeStarted = new Promise((resolve) => { outputProbeStarted = resolve; });
  const delayedProbe = new Promise((resolve) => { releaseProbe = resolve; });
  const probe = { streams: [{ index: 0, codec_type: "video", codec_name: "h264", profile: "High", pix_fmt: "yuv420p", level: 40 }], format: { duration: "1" } };
  let encoders = 0;
  let releasedSlots = 0;
  let child;
  const modulePath = path.resolve(__dirname, "../src/services/hlsPlayback.js");
  const nativeRequire = createRequire(modulePath);
  const config = nativeRequire("../config");
  const semaphore = async () => { const release = async () => { releasedSlots++; }; release.assertOwned = () => {}; return release; };
  const overrides = {
    "../config": { ...config, hlsDir: path.join(root, "hls"), hls: { ...config.hls, maxConcurrent: 2, startTimeoutMs: 2000 } },
    "../logger": { info() {}, warn() {}, error() {} },
    "./distributedSemaphore": { acquireSemaphoreSlot: semaphore },
    "./storageQuota": { reserveStorage: async () => async () => {} },
    "./storageUsage": { invalidateStorageUsage() {}, directorySize: async () => 100 },
    "./cancellationStore": { isCancelled: () => false },
    "./ffextract": { probeMediaTracks: async (file) => {
      if (file.endsWith(".ts")) { outputProbeStarted(); return delayedProbe; }
      return probe;
    } },
    child_process: {
      execFile(_command, _args, _options, callback) { callback(new Error("mock: use CPU")); },
      spawn(_command, args) {
        encoders++;
        child = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
        child.kill = () => { child.exitCode = 1; child.emit("exit", 1); };
        const playlist = args[args.length - 1];
        fs.writeFileSync(path.join(path.dirname(playlist), "video-only-00000.ts"), "segment");
        fs.writeFileSync(playlist, "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:1,\nvideo-only-00000.ts\n#EXT-X-ENDLIST\n");
        return child;
      },
    },
  };
  const sandbox = { module: { exports: {} }, require: (name) => overrides[name] || nativeRequire(name), process, setInterval, clearInterval, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(modulePath, "utf8"), sandbox, { filename: modulePath });
  const hls = sandbox.module.exports;
  await hls.ensureHls("src_one", input);
  child.exitCode = 0;
  child.emit("exit", 0);
  await probeStarted;
  assert.equal(hls.conversionRunning("src_one"), true);
  assert.equal(hls.cacheComplete("src_one"), null);
  await Promise.all([hls.ensureHls("src_one", input), hls.ensureHls("src_one", input)]);
  assert.equal(encoders, 1);
  assert.equal(releasedSlots, 0);
  releaseProbe(probe);
  await hls.waitForHlsCompletion("src_one");
  assert.equal(hls.conversionRunning("src_one"), false);
  assert.equal(releasedSlots, 2);
  const metadata = hls.cacheComplete("src_one");
  assert.ok(metadata.generation);
  assert.match(hls.outputPath("src_one", "video-only.m3u8"), /versions/);
  assert.match(fs.readFileSync(hls.outputPath("src_one", "video-only.m3u8"), "utf8"), /PLAYLIST-TYPE:VOD/);
});
