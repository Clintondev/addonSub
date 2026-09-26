const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAudioFromMaster, parseSubtitlesFromMaster, pickTrack: pickHlsTrack } = require("../src/services/hls");
const { listAudioTracks, listSubtitleReps, pickTrack: pickDashTrack } = require("../src/services/dash");
const { subtitleLanguageOrder } = require("../src/services/languageStrategy");
const { tryAdaptiveCandidates } = require("../src/services/adaptiveCandidates");

test("HLS pairs an original audio language with its subtitle instead of a dub translation", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English Dub",LANGUAGE="eng",DEFAULT=YES,URI="en.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Japanese Original",LANGUAGE="jpn",DEFAULT=NO,URI="ja.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="eng",FORCED=NO,URI="en-sub.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Japanese",LANGUAGE="jpn",FORCED=NO,URI="ja-sub.m3u8"',
  ].join("\n");
  const audio = parseAudioFromMaster(master);
  const subtitles = parseSubtitlesFromMaster(master);
  const strategy = subtitleLanguageOrder({ audioTracks: audio, preferredLangs: ["eng"], targetLocale: "pt-BR" });
  assert.equal(strategy.originalAudio.lang, "ja");
  assert.equal(pickHlsTrack(subtitles, strategy.languages).lang, "ja");
});

test("DASH applies the same language pairing policy", () => {
  const manifest = { MPD: { Period: { AdaptationSet: [
    { "@_contentType": "audio", "@_lang": "eng", "@_label": "English Dub" },
    { "@_contentType": "audio", "@_lang": "kor", "@_label": "Korean Original" },
    { "@_contentType": "text", "@_lang": "eng", Representation: { "@_mimeType": "text/vtt", BaseURL: "en.vtt" } },
    { "@_contentType": "text", "@_lang": "kor", Representation: { "@_mimeType": "text/vtt", BaseURL: "ko.vtt" } },
  ] } } };
  const audio = listAudioTracks(manifest);
  const subtitles = listSubtitleReps(manifest, "https://example.test/master.mpd");
  const strategy = subtitleLanguageOrder({ audioTracks: audio, preferredLangs: ["eng"], targetLocale: "pt-BR" });
  assert.equal(strategy.originalAudio.lang, "ko");
  assert.equal(pickDashTrack(subtitles, strategy.languages).lang, "ko");
});

test("HLS preserves an absolute subtitle URI containing a colon", () => {
  const tracks = parseSubtitlesFromMaster('#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English",LANGUAGE="en",URI="https://media.example.test/sub.vtt"');
  assert.equal(tracks[0].uri, "https://media.example.test/sub.vtt");
});

test("adaptive subtitle candidates continue after validation failure and exclude signs", async () => {
  const tried = [];
  const result = await tryAdaptiveCandidates([{ lang: "pt", name: "Signs", content: "sign" }, { lang: "pt", name: "Full", content: "bad" }, { lang: "en", name: "Full", content: "good" }],
    { languages: ["pt", "en"], originalAudio: { lang: "en" } }, { allowIntermediateFallback: false, targetLocale: "pt-BR", validateCandidate: async (track) => { if (track.content === "bad") throw new Error("incomplete"); return track; } },
    async (track) => { tried.push(track.content); return track; });
  assert.deepEqual(tried, ["bad", "good"]);
  assert.equal(result.content, "good");
});
