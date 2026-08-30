const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config");
const { buildFfmpegArgs, choosePlan } = require("../src/services/hlsPlayback");
const { addHlsTimestampMap, buildHlsMasterPlaylist, buildHlsSubtitlePlaylist, streamViews } = require("../src/index");

function probe(videoCodec, audioCodec = "aac", channels = 2) {
  return {
    streams: [
      { codec_type: "video", codec_name: videoCodec },
      ...(audioCodec ? [{ codec_type: "audio", codec_name: audioCodec, channels }] : []),
    ],
  };
}

test("copies browser-compatible H.264 but rebuilds the AAC timeline", () => {
  assert.deepEqual(choosePlan(probe("h264"), true), {
    videoCodec: "h264",
    audioCodec: "aac",
    videoMode: "copy",
    audioMode: "aac",
  });
});

test("uses NVENC and converts incompatible audio for HEVC sources", () => {
  const plan = choosePlan(probe("hevc", "ac3", 6), true);
  assert.equal(plan.videoMode, "nvenc");
  assert.equal(plan.audioMode, "aac");
  const args = buildFfmpegArgs("episode.mkv", "cache/master.m3u8", plan, config.hls);
  assert.ok(args.includes("h264_nvenc"));
  assert.ok(args.includes("aac"));
  assert.ok(args.includes("setpts=PTS-STARTPTS,scale=-2:min(1080\\,ih),format=yuv420p"));
  assert.ok(args.includes("asetpts=PTS-STARTPTS"));
  assert.equal(args[args.indexOf("-delay") + 1], "0");
  assert.equal(args[args.indexOf("-g") + 1], "96");
  assert.ok(args.includes("-forced-idr"));
  assert.ok(args.includes("independent_segments+temp_file"));
});

test("falls back to libx264 when NVENC is unavailable", () => {
  const plan = choosePlan(probe("hevc", "aac", 2), false);
  assert.equal(plan.videoMode, "cpu");
  assert.ok(buildFfmpegArgs("episode.mkv", "cache/master.m3u8", plan, config.hls).includes("libx264"));
});

test("adds a browser HLS option without leaking the MKV filename hint", () => {
  const item = {
    stream: { name: "1080p", title: "HEVC", infoHash: "abc", fileIdx: 1, behaviorHints: { filename: "episode.mkv" } },
    record: { sourceId: "src_hls_test", infoHash: "abc", addonName: "Torrentio", filename: "episode.mkv" },
  };
  const views = streamViews(item, { savePending: false });
  assert.equal(views.length, 2);
  assert.match(views[0].url, /\/play\/src_hls_test$/);
  assert.match(views[1].url, /\/hls\/src_hls_test\/master\.m3u8$/);
  assert.equal(views[1].behaviorHints.filename, undefined);
  assert.match(views[1].name, /^WEB PREPARAR/);
});

test("advertises PT-BR as the default HLS subtitle track", () => {
  const master = buildHlsMasterPlaylist(true);
  assert.match(master, /TYPE=SUBTITLES/);
  assert.match(master, /NAME="Português \(Brasil\)"/);
  assert.match(master, /DEFAULT=YES/);
  assert.match(master, /SUBTITLES="subs"/);
});

test("builds a complete WebVTT subtitle media playlist", () => {
  const vtt = "WEBVTT\n\n00:00:02.000 --> 00:42:10.500\nFim\n";
  const playlist = buildHlsSubtitlePlaylist(vtt);
  assert.match(playlist, /#EXT-X-TARGETDURATION:2531/);
  assert.match(playlist, /#EXTINF:2530\.500/);
  assert.match(playlist, /subtitle\.vtt/);
  assert.match(playlist, /#EXT-X-ENDLIST/);
  assert.match(addHlsTimestampMap(vtt), /X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00\.000/);
});
