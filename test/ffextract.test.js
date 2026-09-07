const test = require("node:test");
const assert = require("node:assert/strict");
const { extractFileSubtitle, pickTextTrack, pickPgsTrack, pgsOcrSupported, rankedTracks, srtToVtt } = require("../src/services/ffextract");

test("prefers Brazilian Portuguese textual subtitles before English", () => {
  const tracks = [{ ffIndex: 2, codec: "subrip", lang: "eng", forced: false }, { ffIndex: 3, codec: "ass", lang: "pob", forced: false }];
  assert.equal(pickTextTrack(tracks, ["pob", "por", "eng"]).ffIndex, 3);
});

test("prefers a full PGS track over songs and signs", () => {
  const tracks = [
    { ffIndex: 3, codec: "hdmv_pgs_subtitle", lang: "eng", title: "English PGS Songs / Signs", forced: false },
    { ffIndex: 4, codec: "hdmv_pgs_subtitle", lang: "eng", title: "English PGS Full", forced: false },
  ];
  assert.equal(pickPgsTrack(tracks, ["eng"]).ffIndex, 4);
});

test("prefers a complete PGS track even when a forced track has the preferred language", () => {
  const tracks = [
    { ffIndex: 3, codec: "hdmv_pgs_subtitle", lang: "pob", title: "Portuguese Signs / Forced", forced: true },
    { ffIndex: 4, codec: "hdmv_pgs_subtitle", lang: "eng", title: "English Full", forced: false },
  ];
  assert.equal(pickPgsTrack(tracks, ["pob", "eng"]).ffIndex, 4);
});

test("prefers a full original-language PGS track over an intermediate textual translation", () => {
  const tracks = [
    { ffIndex: 3, codec: "subrip", lang: "eng", title: "English Full", forced: false },
    { ffIndex: 4, codec: "hdmv_pgs_subtitle", lang: "jpn", title: "Japanese Full", forced: false },
  ];
  assert.equal(rankedTracks(tracks, ["eng"], { languageOrder: ["pt-br", "ja", "en"] })[0].ffIndex, 4);
});

test("does not require an explicit Full label to prefer the original language", () => {
  const tracks = [
    { ffIndex: 3, codec: "subrip", lang: "eng", title: "English Full", forced: false },
    { ffIndex: 4, codec: "hdmv_pgs_subtitle", lang: "jpn", title: "Japanese", forced: false },
  ];
  assert.equal(rankedTracks(tracks, ["eng"], { languageOrder: ["pt-br", "ja", "en"] })[0].ffIndex, 4);
});

test("never sends an unsupported image-subtitle language to the English OCR engine", () => {
  assert.equal(pgsOcrSupported({ lang: "eng" }), true);
  assert.equal(pgsOcrSupported({ lang: "jpn" }), false);
  assert.equal(pgsOcrSupported({ lang: "ara" }), false);
});

test("requests direct original-audio transcription before using an intermediate subtitle", async () => {
  const mediaTracks = {
    audioTracks: [{ ffIndex: 1, type: "audio", lang: "jpn", title: "Japanese Original", disposition: { original: 1 } }],
    subtitleTracks: [{ ffIndex: 2, type: "subtitle", codec: "subrip", lang: "eng", title: "English Full", forced: false }],
  };
  await assert.rejects(
    extractFileSubtitle("unused.mkv", ".", ["eng"], { mediaTracks, targetLocale: "pt-BR" }),
    /transcrição direta do áudio/,
  );
});

test("converts OCR SRT timestamps to WebVTT", () => {
  const output = srtToVtt("1\n00:00:01,250 --> 00:00:03,500\nHello!\n");
  assert.match(output, /^WEBVTT/);
  assert.match(output, /00:00:01\.250 --> 00:00:03\.500/);
});
