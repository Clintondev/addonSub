const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canonicalLanguage, countryLanguageCandidates, languageMatches, selectOriginalAudio, speechRecognitionLanguage, subtitleLanguageOrder, translationRoute,
} = require("../src/services/languageStrategy");

test("normalizes common two and three-letter language tags", () => {
  assert.equal(canonicalLanguage("jpn"), "ja");
  assert.equal(canonicalLanguage("ENG"), "en");
  assert.equal(canonicalLanguage("pob"), "pt-br");
  assert.equal(languageMatches("por", "pt-BR"), true);
  assert.equal(speechRecognitionLanguage("pt-BR"), "pt");
});

test("selects an explicitly original audio instead of a default dub", () => {
  const audio = [
    { ffIndex: 1, lang: "eng", title: "English Dub", disposition: { default: 1, dub: 1 } },
    { ffIndex: 2, lang: "jpn", title: "Japanese Original", disposition: { original: 1 } },
  ];
  const selected = selectOriginalAudio(audio);
  assert.equal(selected.ffIndex, 2);
  assert.equal(selected.lang, "ja");
  assert.equal(selected.confidence, "high");
});

test("uses explicit source metadata for any language without title-specific rules", () => {
  const audio = [
    { ffIndex: 1, lang: "spa", disposition: {} },
    { ffIndex: 2, lang: "kor", disposition: {} },
  ];
  assert.equal(selectOriginalAudio(audio, { originalLanguage: "ko" }).ffIndex, 2);
  assert.equal(selectOriginalAudio([], { original_language: "jpn" }).lang, "ja");
});

test("infers Japanese audio from content country when an unmarked English dub comes first", () => {
  const audio = [
    { ffIndex: 1, lang: "eng", title: "English Stereo", disposition: {} },
    { ffIndex: 2, lang: "jpn", title: "Japanese Stereo", disposition: {} },
  ];
  const selected = selectOriginalAudio(audio, { country: "Japan, Poland" });
  assert.deepEqual(countryLanguageCandidates("Japan, Poland"), ["ja", "pl"]);
  assert.equal(selected.ffIndex, 2);
  assert.equal(selected.lang, "ja");
  assert.equal(selected.reason, "content-country-matched-audio");
  assert.equal(selected.confidence, "medium");
});

test("prefers an explicit original-track flag over country inference", () => {
  const audio = [
    { ffIndex: 1, lang: "fra", title: "French", disposition: {} },
    { ffIndex: 2, lang: "eng", title: "English Original", disposition: { original: 1 } },
  ];
  assert.equal(selectOriginalAudio(audio, { country: "France" }).ffIndex, 2);
});

test("orders target subtitles first, then the original audio language, then fallbacks", () => {
  const audio = [
    { ffIndex: 1, lang: "eng", title: "Dub", disposition: { dub: 1 } },
    { ffIndex: 2, lang: "jpn", disposition: { original: 1 } },
  ];
  const strategy = subtitleLanguageOrder({ audioTracks: audio, preferredLangs: ["eng", "spa"], targetLocale: "pt-BR" });
  assert.deepEqual(strategy.languages.slice(0, 3), ["pt-br", "ja", "en"]);
  assert.equal(translationRoute("jpn", strategy.originalAudio), "direct-original-language");
  assert.equal(translationRoute("eng", strategy.originalAudio), "intermediate-language-fallback");
});

test("ignores commentary and descriptive tracks when inferring original audio", () => {
  const selected = selectOriginalAudio([
    { ffIndex: 1, lang: "eng", title: "Director Commentary", disposition: { comment: 1 } },
    { ffIndex: 2, lang: "fra", title: "Français", disposition: {} },
  ]);
  assert.equal(selected.ffIndex, 2);
});
