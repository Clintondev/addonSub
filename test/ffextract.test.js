const test = require("node:test");
const assert = require("node:assert/strict");
const { pickTextTrack, pickPgsTrack, srtToVtt } = require("../src/services/ffextract");

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

test("converts OCR SRT timestamps to WebVTT", () => {
  const output = srtToVtt("1\n00:00:01,250 --> 00:00:03,500\nHello!\n");
  assert.match(output, /^WEBVTT/);
  assert.match(output, /00:00:01\.250 --> 00:00:03\.500/);
});
