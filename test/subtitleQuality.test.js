const test = require("node:test");
const assert = require("node:assert/strict");
const { mapTargetLocale } = require("../src/services/translate");
const { analyzeCueIntegrity, assertCueIntegrity, assertSubtitleCompleteness, localizeBrazilianPortuguese, mergeShortCues, finalizeCues, displayChunks, normalizeDialogueMarkers, preserveDialogueLayout, removeEmptyCues } = require("../src/services/subtitleQuality");

test("maps Brazilian Portuguese to LibreTranslate API code", () => {
  assert.equal(mapTargetLocale("pt-BR"), "pt-BR");
  assert.equal(mapTargetLocale("pt_BR"), "pt-BR");
  assert.equal(mapTargetLocale("pt-PT"), "pt");
});

test("normalizes common European Portuguese terms", () => {
  assert.equal(localizeBrazilianPortuguese("O telemóvel está no autocarro com a rapariga."), "O celular está no ônibus com a garota.");
  assert.equal(localizeBrazilianPortuguese("Excepto pelo facto no ficheiro."), "exceto pelo fato no arquivo.");
});

test("localizes untranslated English hesitation interjections", () => {
  assert.equal(localizeBrazilianPortuguese("Huh? Ah, certo..."), "Hã? Ah, certo...");
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

test("final cue validation rejects lines that are too long to read", () => {
  const cue = { time: "00:00:01.000 --> 00:00:05.000", text: "Esta é uma linha deliberadamente longa demais para passar pela validação de leitura." };
  assert.throws(() => assertCueIntegrity([cue], { maxLineChars: 42 }), /linhas acima de 42 caracteres/);
  const finalized = finalizeCues([cue]);
  const stats = assertCueIntegrity(finalized, { maxLineChars: 42 });
  assert.equal(stats.overlongLines, 0);
  assert.ok(stats.maxLineChars <= 42);
});

test("final cue validation rejects captions with more than two visual lines", () => {
  const cues = [{ time: "00:00:01.000 --> 00:00:04.000", text: "Linha um\nLinha dois\nLinha três" }];
  assert.throws(() => assertCueIntegrity(cues, { maxCueSeconds: 20, maxLineChars: 42, maxLines: 2 }), /acima de 2 linhas/);
});

test("preserves one visual line for each speaker in translated dialogue", () => {
  const source = "-He's not going to take this well.\n-Can you blame him? He's your nephew.";
  const translated = "-Ele não vai levar isso bem. -Você pode culpá-lo? Ele é seu sobrinho.";
  const preserved = preserveDialogueLayout(source, translated);
  assert.equal(preserved, "- Ele não vai levar isso bem.\n- Você pode culpá-lo? Ele é seu sobrinho.");
  assert.deepEqual(displayChunks(preserved), [preserved]);
});

test("restores speaker lines when the translator joins double-dash dialogue", () => {
  const source = "--Mira seems normal!\n--Kind of a letdown, in a way.";
  const translated = "- A Mira parece normal! --É meio decepcionante, de certa forma.";
  assert.equal(preserveDialogueLayout(source, translated), "- A Mira parece normal!\n- É meio decepcionante, de certa forma.");
});

test("restores speaker lines from punctuation when the translator removes every marker", () => {
  assert.equal(
    preserveDialogueLayout("--Welcome back, dear!\n--Huh? Oh, right...", "Bem-vinda de volta, querida! Hã? Ah, certo..."),
    "- Bem-vinda de volta, querida!\n- Hã? Ah, certo...",
  );
});

test("restores speaker lines when the translator replaces the marker with a slash", () => {
  assert.equal(
    preserveDialogueLayout("--I'll keep you safe!\n--No, I will!", "Eu vou te proteger!/ Não, eu vou!"),
    "- Eu vou te proteger!\n- Não, eu vou!",
  );
});

test("removes a second slash-separated translation alternative from a single-speaker cue", () => {
  assert.equal(
    preserveDialogueLayout("Forget it! You're stifling me!", "Esquece! Você está me sufocando!/ Não, para! Você está me sufocando!"),
    "Esquece! Você está me sufocando!",
  );
  assert.equal(preserveDialogueLayout("Use and/or.", "Use e/ou."), "Use e/ou.");
  assert.equal(preserveDialogueLayout("Drive at 80 km/h.", "Dirija a 80 km/h."), "Dirija a 80 km/h.");
});

test("does not wrap inside protected multi-word terms", () => {
  const chunks = displayChunks("Eles são os que nos enviaram para Earth Land.", 42, 2, ["Earth Land"]);
  assert.equal(chunks.some((chunk) => /Earth\nLand/.test(chunk)), false);
  assert.equal(chunks.join(" ").replace(/\n/g, " "), "Eles são os que nos enviaram para Earth Land.");
});

test("normalizes duplicated dialogue markers before wrapping", () => {
  const normalized = normalizeDialogueMarkers("- -Existe uma expressão para isso... Hum...");
  assert.equal(normalized, "- Existe uma expressão para isso... Hum...");
  assert.equal(displayChunks(normalized).flatMap((chunk) => chunk.split("\n")).every((line) => line.length <= 42), true);
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

test("rejects a one-line subtitle for a full episode", () => {
  const cues = [{ time: "00:00:04.000 --> 00:00:09.000", text: "This is a world of magic." }];
  assert.throws(() => assertSubtitleCompleteness(cues, 1467), /incompleta: 1 falas/);
});

test("removes OCR frames that contain no readable text", () => {
  const cues = [
    { time: "00:00:01.000 --> 00:00:02.000", text: "  " },
    { time: "00:00:03.000 --> 00:00:04.000", text: "Dialogue" },
  ];
  assert.deepEqual(removeEmptyCues(cues).map((cue) => cue.text), ["Dialogue"]);
});
