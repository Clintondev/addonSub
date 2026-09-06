const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config");
const { buildFfmpegArgs, choosePlan } = require("../src/services/hlsPlayback");
const { addHlsTimestampMap, buildHlsMasterPlaylist, buildHlsSubtitlePlaylist, buildHlsSubtitleSegment, externalSubtitleView, streamView, streamViews, subtitleRequestSelector } = require("../src/index");
const { vttToSrt } = require("../src/services/subtitleService");

function probe(videoCodec, audioCodec = "aac", channels = 2) {
  return {
    streams: [
      { codec_type: "video", codec_name: videoCodec },
      ...(audioCodec ? [{ index: 1, codec_type: "audio", codec_name: audioCodec, channels, tags: { language: "eng", title: "English" } }] : []),
    ],
  };
}

test("copies browser-compatible H.264 but rebuilds the AAC timeline", () => {
  assert.deepEqual(choosePlan(probe("h264"), true), {
    videoCodec: "h264",
    audioCodec: "aac",
    videoMode: "copy",
    audioMode: "aac",
    audioTracks: [{
      inputIndex: 1,
      outputIndex: 0,
      codec: "aac",
      channels: 2,
      sourceChannels: 2,
      language: "eng",
      title: "English",
      isDefault: true,
      playlist: "audio-0.m3u8",
    }],
  });
});

test("transcodes H.264 profiles and pixel formats that browsers commonly reject", () => {
  const media = probe("h264");
  media.streams[0].profile = "High 10";
  media.streams[0].pix_fmt = "yuv420p10le";
  assert.equal(choosePlan(media, true).videoMode, "nvenc");
  assert.equal(choosePlan(media, false).videoMode, "cpu");
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
  assert.ok(args.includes("0:1"));
});

test("burns PT-BR into browser video while preserving HLS audio renditions", () => {
  const plan = choosePlan(probe("hevc", "truehd", 6), true);
  plan.subtitleBurnedIn = true;
  const args = buildFfmpegArgs("episode.mkv", "cache/video.m3u8", plan, config.hls, "/storage/subtitles/src_test/pt-BR.ass");
  const filter = args[args.indexOf("-vf") + 1];
  assert.match(filter, /subtitles=filename='\/storage\/subtitles\/src_test\/pt-BR\.ass'/);
  assert.ok(args.includes("aac"));
  assert.ok(args.some((argument) => argument.endsWith("audio-0.m3u8")));
});

test("muxes the default audio with video and generates explicit playlists for every language", () => {
  const media = probe("hevc", "truehd", 6);
  media.streams.push({ index: 2, codec_type: "audio", codec_name: "truehd", channels: 2, tags: { language: "jpn", title: "Japanese" } });
  const plan = choosePlan(media, true);
  const args = buildFfmpegArgs("episode.mkv", "cache/video.m3u8", plan, config.hls);
  assert.equal(plan.audioTracks[0].playlist, "audio-0.m3u8");
  assert.equal(plan.audioTracks[1].playlist, "audio-1.m3u8");
  assert.ok(args.some((argument) => argument.endsWith("audio-0.m3u8")));
  assert.ok(args.some((argument) => argument.endsWith("audio-1.m3u8")));
  assert.ok(args.includes("0:1"));
  assert.ok(args.includes("0:2"));
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
  assert.match(views[0].url, /\/play\/src_hls_test\?profile=ptbr-stream-v2$/);
  assert.match(views[1].url, /\/hls\/src_hls_test\/master\.m3u8\?profile=web-av-subs-v2$/);
  assert.equal(views[1].behaviorHints.filename, "pt-auto-src_hls_test.m3u8");
  assert.match(views[1].name, /^WEB PREPARAR/);
});

test("advertises selectable audio tracks and non-forced PT-BR subtitles", () => {
  const master = buildHlsMasterPlaylist(true, [
    { title: "English: 5.1ch", language: "eng", channels: 2, isDefault: true, playlist: "audio-0.m3u8" },
    { title: "Japanese: Stereo", language: "jpn", channels: 2, isDefault: false, playlist: "audio-1.m3u8" },
  ]);
  assert.match(master, /TYPE=AUDIO.*NAME="English: 5\.1ch".*DEFAULT=YES/);
  assert.match(master, /NAME="English: 5\.1ch"[^\n]*DEFAULT=YES/);
  assert.doesNotMatch(master, /NAME="English: 5\.1ch"[^\n]*URI=/);
  assert.match(master, /TYPE=AUDIO.*NAME="Japanese: Stereo".*DEFAULT=NO.*URI="audio-1\.m3u8"/);
  assert.match(master, /AUDIO="audio"/);
  assert.match(master, /TYPE=SUBTITLES/);
  assert.match(master, /NAME="Português \(Brasil\)"/);
  assert.match(master, /TYPE=SUBTITLES.*DEFAULT=YES/);
  assert.match(master, /SUBTITLES="subs"/);
});

test("advertises SubRip instead of ASS to Stremio external subtitle clients", () => {
  const subtitle = externalSubtitleView(
    { sourceId: "src_ready", addonName: "Torrentio" },
    { status: "ready", url: "https://example.test/pt-BR.vtt", srtUrl: "https://example.test/pt-BR.srt", assUrl: "https://example.test/pt-BR.ass" },
    { includeAddon: true },
  );
  assert.match(subtitle.id, /^pt-auto-srt-v4-/);
  assert.match(subtitle.name, /Português \(Brasil\)/);
  assert.match(subtitle.url, /\.srt$/);
});

test("segments WebVTT into short HLS subtitle resources", () => {
  const vtt = "WEBVTT\n\n00:00:02.000 --> 00:00:05.000\nPrimeira\n\n00:00:09.000 --> 00:00:11.500\nSegunda\n";
  const playlist = buildHlsSubtitlePlaylist(vtt, 4);
  assert.match(playlist, /#EXT-X-TARGETDURATION:4/);
  assert.match(playlist, /#EXTINF:4\.000,[\s\S]*subtitle-00000\.vtt/);
  assert.match(playlist, /#EXTINF:3\.500,[\s\S]*subtitle-00002\.vtt/);
  assert.match(playlist, /#EXT-X-ENDLIST/);
  const first = buildHlsSubtitleSegment(vtt, 0, 4);
  const second = buildHlsSubtitleSegment(vtt, 2, 4);
  assert.match(first, /X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00\.000/);
  assert.match(first, /Primeira/);
  assert.doesNotMatch(first, /Segunda/);
  assert.match(second, /Segunda/);
});

test("advertises an exact-source SRT fallback in the HLS stream view", () => {
  const item = {
    stream: { name: "1080p", infoHash: "abc", fileIdx: 1 },
    record: { sourceId: "src_hls_subtitle", infoHash: "abc", addonName: "Torrentio" },
  };
  const hls = streamView(item, "hls", { status: { status: "ready", srtUrl: "https://example.test/pt-BR.srt" } });
  assert.equal(hls.subtitles.length, 1);
  assert.match(hls.subtitles[0].url, /pt-BR\.srt$/);
});

test("reuses the HLS cache when recovered records point to the same physical media", () => {
  const item = {
    stream: { name: "1080p", infoHash: "abc", fileIdx: 1 },
    record: { sourceId: "src_alias", infoHash: "abc", addonName: "Torrentio" },
  };
  const hls = streamView(item, "hls", { status: {
    status: "ready",
    associated: true,
    subtitleSourceId: "src_media_owner",
    srtUrl: "https://example.test/pt-BR.srt",
  } });
  assert.match(hls.url, /\/hls\/src_media_owner\/master\.m3u8\?profile=web-av-subs-v2$/);
  assert.equal(hls.behaviorHints.filename, "pt-auto-src_media_owner.m3u8");
});

test("converts WebVTT cues to broadly compatible SubRip", () => {
  const srt = vttToSrt("WEBVTT\n\n00:00:02.125 --> 00:00:05.900 line:80%\nPrimeira linha\nSegunda linha\n");
  assert.equal(srt, "1\n00:00:02,125 --> 00:00:05,900\nPrimeira linha\nSegunda linha\n");
});

test("maps the unique HLS filename back to the exact source", () => {
  assert.deepEqual(subtitleRequestSelector("filename=pt-auto-src_abc123.m3u8"), {
    filename: "pt-auto-src_abc123.m3u8",
    sourceId: "src_abc123",
  });
  assert.equal(subtitleRequestSelector("filename=master.m3u8").sourceId, null);
});
