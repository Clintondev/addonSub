const test = require("node:test");
const assert = require("node:assert/strict");
const { buildEmbeddedArgs, validateEmbeddedProbe } = require("../src/services/embeddedPlayback");

test("remuxes video and every audio track while replacing subtitles with one default PT-BR track", () => {
  const args = buildEmbeddedArgs("episode.mkv", "pt-BR.srt", "prepared.mkv");
  assert.deepEqual(args.filter((value, index) => args[index - 1] === "-map"), ["0:v:0", "0:a?", "0:t?", "0:d?", "1:0"]);
  assert.equal(args[args.indexOf("-c") + 1], "copy");
  assert.ok(args.includes("language=por"));
  assert.ok(args.includes("title=Português (Brasil)"));
  assert.equal(args[args.indexOf("-disposition:s:0") + 1], "default");
  assert.equal(args[args.indexOf("-reserve_index_space") + 1], "200000");
  assert.equal(args[args.indexOf("-cues_to_front") + 1], "1");
  assert.equal(args[args.indexOf("-cluster_time_limit") + 1], "1000");
});

test("accepts a prepared MKV only when media, audio and the PT-BR subtitle are intact", () => {
  const input = { format: { duration: "1466.884" }, streams: [{ codec_type: "video" }, { codec_type: "audio" }, { codec_type: "audio" }] };
  const output = {
    format: { duration: "1466.884" },
    streams: [
      { codec_type: "video", codec_name: "hevc" },
      { codec_type: "audio", codec_name: "truehd" },
      { codec_type: "audio", codec_name: "truehd" },
      { codec_type: "subtitle", codec_name: "subrip", tags: { language: "por", title: "Português (Brasil)" }, disposition: { default: 1 } },
    ],
  };
  assert.deepEqual(validateEmbeddedProbe(input, output), { videoCount: 1, audioCount: 2, subtitleCount: 1, duration: 1466.884 });
  assert.throws(() => validateEmbeddedProbe(input, { ...output, streams: output.streams.slice(0, 3) }), /legenda SRT interna/);
});
