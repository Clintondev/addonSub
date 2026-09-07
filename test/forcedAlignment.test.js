const test = require("node:test");
const assert = require("node:assert/strict");
const { assertTranslationsPreserved, buildForcedAlignedCues, matchedAudioRange, phraseChunks, reconstructTranslations } = require("../src/services/forcedAlignment");

test("splits only at semantic sentence boundaries without losing text", () => {
  const text = "Estou ansiosa para preparar tudo para a apreciação das flores de amanhã! Vai ser incrível.";
  const chunks = phraseChunks(text);
  assert.deepEqual(chunks, [
    "Estou ansiosa para preparar tudo para a apreciação das flores de amanhã!",
    "Vai ser incrível.",
  ]);
  assert.equal(chunks.join(" "), text);
});

test("does not create artificial timed fragments for a long single sentence", () => {
  const text = "Esta é uma única frase longa que deve continuar inteira mesmo quando precisa ser apresentada visualmente em duas linhas.";
  assert.deepEqual(phraseChunks(text), [text]);
});

test("removes malformed model markers without losing adjacent dialogue", () => {
  const chunks = phraseChunks('Você não vai, Lucy?</sub id="cue-000209">\nA vista das flores é incrível.');
  assert.equal(chunks.join(" "), "Você não vai, Lucy? A vista das flores é incrível.");
  assert.doesNotMatch(chunks.join(" "), /cue-000209|<\/?sub/i);
});

test("uses fuzzy official words to discard unrelated speech around a cue", () => {
  const candidates = [
    { text: "noise", start: 0.8, end: 1.0 },
    { text: "this", start: 1.1, end: 1.3 },
    { text: "is", start: 1.31, end: 1.42 },
    { text: "magic", start: 1.5, end: 1.9 },
    { text: "extra", start: 2.0, end: 2.2 },
  ];
  const result = matchedAudioRange("This is magick.", candidates);
  assert.deepEqual(result.words.map((word) => word.text), ["this", "is", "magic"]);
  assert.ok(result.confidence >= 0.66);
});

test("aligns each displayed phrase to detected word boundaries inside the official cue", () => {
  const source = [{ id: "1", time: "00:00:01.000 --> 00:00:05.000", text: "Get ready for tomorrow. It will be incredible." }];
  const translated = ["Prepare-se para amanhã. Vai ser incrível."];
  const words = [
    { text: "Get", start: 1.2, end: 1.4 },
    { text: "ready", start: 1.45, end: 1.8 },
    { text: "for", start: 1.85, end: 2.0 },
    { text: "tomorrow", start: 2.05, end: 2.5 },
    { text: "It", start: 3.0, end: 3.1 },
    { text: "will", start: 3.12, end: 3.3 },
    { text: "be", start: 3.32, end: 3.42 },
    { text: "incredible", start: 3.5, end: 4.1 },
  ];
  const result = buildForcedAlignedCues(source, translated, words);
  assert.equal(result.cues.length, 2);
  assert.equal(result.cues.map((cue) => cue.text).join(" "), translated[0]);
  assert.equal(result.cues[0].time, "00:00:01.000 --> 00:00:02.750");
  assert.equal(result.cues[1].time, "00:00:02.750 --> 00:00:05.000");
  assert.equal(result.stats.alignedCues, 1);
  assert.equal(result.stats.fallbackCues, 0);
});

test("uses spoken word edges when an English dub paraphrases the official subtitle", () => {
  const source = [{ time: "00:00:10.000 --> 00:00:13.000", text: "The official wording is completely different." }];
  const translated = ["Primeira frase. Segunda frase."];
  const words = [
    { text: "Dubbed", start: 10.4, end: 10.8 },
    { text: "dialogue", start: 10.9, end: 11.4 },
    { text: "changed", start: 11.8, end: 12.2 },
    { text: "here", start: 12.25, end: 12.6 },
  ];
  const result = buildForcedAlignedCues(source, translated, words);
  assert.equal(result.cues[0].time.startsWith("00:00:10.000"), true);
  assert.equal(result.cues.at(-1).time.endsWith("00:00:13.000"), true);
  assert.equal(result.stats.alignedCues, 1);
  assert.equal(result.stats.textMatchedCues, 0);
  assert.equal(result.stats.fallbackCues, 0);
});

test("keeps an unavoidable dense phrase to at most two display lines", () => {
  const source = [{ time: "00:00:01.000 --> 00:00:03.000", text: "A very fast sentence." }];
  const translated = ["Esta frase integral é deliberadamente extensa demais para ser dividida no curto tempo disponível."];
  const result = buildForcedAlignedCues(source, translated, []);
  assert.equal(result.cues.length, 1);
  assert.ok(result.cues[0].text.split("\n").length <= 2);
  assert.equal(result.cues[0].text.replace(/\n/g, " "), translated[0]);
});

test("reconstructs the original translations from split display cues without duplication", () => {
  const source = [
    { time: "00:00:01.000 --> 00:00:03.000", text: "One." },
    { time: "00:00:04.000 --> 00:00:06.000", text: "Two." },
  ];
  const display = [
    { time: "00:00:01.000 --> 00:00:02.000", text: "Primeira" },
    { time: "00:00:02.000 --> 00:00:03.000", text: "frase." },
    { time: "00:00:04.000 --> 00:00:06.000", text: "Segunda frase." },
  ];
  assert.deepEqual(reconstructTranslations(source, display), ["Primeira frase.", "Segunda frase."]);
  assert.doesNotThrow(() => assertTranslationsPreserved(source, ["Primeira frase.", "Segunda frase."], display));
  assert.throws(() => assertTranslationsPreserved(source, ["Primeira diferente.", "Segunda frase."], display), /alterou o conteúdo/);
});
