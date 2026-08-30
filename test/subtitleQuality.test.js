const test = require("node:test");
const assert = require("node:assert/strict");
const { mapTargetLocale } = require("../src/services/translate");
const { analyzeCueIntegrity, assertCueIntegrity, localizeBrazilianPortuguese, mergeShortCues, finalizeCues, displayChunks, preserveDialogueLayout } = require("../src/services/subtitleQuality");

test("maps Brazilian Portuguese to LibreTranslate API code", () => {
  assert.equal(mapTargetLocale("pt-BR"), "pt-BR");
  assert.equal(mapTargetLocale("pt_BR"), "pt-BR");
  assert.equal(mapTargetLocale("pt-PT"), "pt");
});

test("normalizes common European Portuguese terms", () => {
  assert.equal(localizeBrazilianPortuguese("O telemóvel está no autocarro com a rapariga."), "O celular está no ônibus com a garota.");
  assert.equal(localizeBrazilianPortuguese("Excepto pelo facto no ficheiro."), "exceto pelo fato no arquivo.");
});

test("merges excessively short adjacent transcription cues", () => {
  const cues = [
    { id: "1", time: "00:00:01.000 --> 00:00:01.200", text: "You know." },
    { id: "2", time: "00:00:01.400 --> 00:00:01.800", text: "The answer." },
    { id: "3", time: "00:00:04.000 --> 00:00:05.000", text: "Later." },
  ];
  const merged = mergeShortCues(cues);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, "You know. The answer.");
  assert.match(merged[0].time, /00:00:01\.800/);
});

test("wraps and extends readable cues without overlapping the next cue", () => {
  const cues = [
    { time: "00:00:01.000 --> 00:00:01.200", text: "Esta é uma frase suficientemente longa para precisar de mais tempo na tela." },
    { time: "00:00:04.000 --> 00:00:05.000", text: "Próxima fala." },
  ];
  const result = finalizeCues(cues);
  assert.ok(result[0].text.includes("\n"));
  assert.match(result[0].time, /--> 00:00:03\.920/);
});

test("splits expanded translations into at most two lines of 42 characters", () => {
  const text = "Esta tradução brasileira ficou muito maior do que a fala original e precisa ser dividida sem remover nenhuma palavra do conteúdo.";
  const chunks = displayChunks(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.flatMap((chunk) => chunk.split("\n")).every((line) => line.length <= 42), true);
  assert.equal(chunks.join(" ").replace(/\n/g, " "), text);
});

test("preserves one visual line for each speaker in translated dialogue", () => {
  const source = "-He's not going to take this well.\n-Can you blame him? He's your nephew.";
  const translated = "-Ele não vai levar isso bem. -Você pode culpá-lo? Ele é seu sobrinho.";
  const preserved = preserveDialogueLayout(source, translated);
  assert.equal(preserved, "- Ele não vai levar isso bem.\n- Você pode culpá-lo? Ele é seu sobrinho.");
  assert.deepEqual(displayChunks(preserved), [preserved]);
});

test("rejects a subtitle containing a silently stretched transcription cue", () => {
  const cues = [
    { time: "00:00:01.000 --> 00:00:02.000", text: "Normal." },
    { time: "00:00:03.000 --> 00:00:40.000", text: "Incorrectly stretched." },
  ];
  assert.equal(analyzeCueIntegrity(cues).longCues, 1);
  assert.throws(() => assertCueIntegrity(cues), /duração anormal/);
});

test("reports the largest silent interval for quality auditing", () => {
  const stats = analyzeCueIntegrity([
    { time: "00:00:01.000 --> 00:00:02.000", text: "One." },
    { time: "00:00:12.000 --> 00:00:13.000", text: "Two." },
  ]);
  assert.equal(stats.maxGapSeconds, 10);
});
