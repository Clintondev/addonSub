const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const storage = fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-pipeline-"));
process.env.STORAGE_DIR = storage;
const { createTranslationBudget, fitPromptSections, watchTranslationRequest } = require("../src/services/translationBudget");
const { contextualChunks, parseTaggedTranslations, validateContextualTranslations, translateContextual, translateGemmaChunkResilient } = require("../src/services/translate");
const { analyzeSpeechCoverage, assertCueIntegrity, assertSubtitleCompleteness, finalizeCues } = require("../src/services/subtitleQuality");
const { prepareSubtitleSource, selectSubtitleSource } = require("../src/services/subtitleSource");
const { publishSubtitle, readPublication, publishedFile } = require("../src/services/subtitlePublication");
const { translationStatus } = require("../src/services/subtitleService");
const { seriesTerminologyForSource } = require("../src/services/seriesTerminology");
const http = require("node:http");
test.after(() => fs.rmSync(storage, { recursive: true, force: true }));
const cue = (text = "Olá.", time = "00:00:01.000 --> 00:00:03.000") => ({ text, time });

test("translation budgets bound calls and elapsed time without resetting", () => {
  let now = 100;
  const budget = createTranslationBudget({ maxCalls: 2, timeoutMs: 1000, now: () => now });
  budget.take(); budget.take();
  assert.throws(() => budget.take(), { code: "TRANSLATION_BUDGET_EXHAUSTED" });
  now = 1101;
  assert.throws(() => budget.remainingMs(), { code: "TRANSLATION_BUDGET_EXHAUSTED" });
  assert.equal(budget.stats().calls, 2);
});
test("an in-flight translation stops promptly when its source is cancelled", async () => {
  const controller = new AbortController();
  const guard = watchTranslationRequest(controller, { intervalMs: 10, assertActive: () => { throw Object.assign(new Error("cancelled"), { code: "SOURCE_CANCELLED" }); } });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
    assert.equal(guard.error().code, "SOURCE_CANCELLED");
  } finally { guard.stop(); clearTimeout(keepAlive); }
});
test("context trimming preserves source and draft and rejects oversized mandatory content", () => {
  const prompt = fitPromptSections(["draft: correto", "source: do not omit"], ["x".repeat(5000), "brief context"], 256, 80);
  assert.match(prompt, /source: do not omit/);
  assert.match(prompt, /draft: correto/);
  assert.doesNotMatch(prompt, /xxx/);
  assert.throws(() => fitPromptSections(["x".repeat(5000)], [], 256, 80), { code: "TRANSLATION_CONTEXT_LIMIT" });
});
test("duplicate and unknown translation IDs cannot overwrite a valid line", () => {
  const chunk = contextualChunks(["Hello."], 1000, 20)[0];
  assert.throws(() => parseTaggedTranslations(chunk, '<sub id="cue-000000">Olá.</sub><sub id="cue-000000">Adeus.</sub>'), /duplicado/);
  assert.throws(() => parseTaggedTranslations(chunk, '<sub id="cue-000000">Olá.</sub><sub id="extra">Extra.</sub>'), /desconhecido/);
  const two = contextualChunks(["Hello.", "Goodbye."], 1000, 20)[0];
  assert.throws(() => validateContextualTranslations(two, [{ id: two[0].id, text: "Olá." }, { id: two[0].id, text: "Adeus." }]), /duplicado/);
});
test("an unchanged proper-name cue is valid", () => {
  const chunk = contextualChunks(["Shagotte, Fairy Tail!"], 1000, 20)[0];
  assert.deepEqual(validateContextualTranslations(chunk, [{ id: chunk[0].id, text: "Shagotte, Fairy Tail!" }]), ["Shagotte, Fairy Tail!"]);
});
test("silence is allowed and partial speech coverage cannot masquerade as completeness", () => {
  assert.equal(assertSubtitleCompleteness([cue()], 1500, { strictDensity: false, maxInteriorGapSeconds: 45, speechIntervals: [{ start: 1, end: 3 }] }).speechCoverage.coverageRatio, 1);
  const coverage = analyzeSpeechCoverage([cue()], [{ start: 1, end: 100 }], 0);
  assert.equal(coverage.uncoveredSeconds, 97);
  assert.throws(() => assertSubtitleCompleteness([cue()], 1500, { strictDensity: false, maxInteriorGapSeconds: 45, speechIntervals: [{ start: 1, end: 100 }] }), /perdeu fala detectada/);
});
test("dense display fragments use spare time while preserving every word", () => {
  const text = "Precisamos preservar cada palavra desta frase longa, aproveitando o tempo disponível antes da próxima fala para permitir uma leitura confortável.";
  const output = finalizeCues([cue(text, "00:00:01.000 --> 00:00:01.500"), cue("Depois.", "00:00:12.000 --> 00:00:14.000")]);
  assert.equal(output.slice(0, -1).map((item) => item.text.replace(/\n/g, " ")).join(" "), text);
  assert.doesNotThrow(() => assertCueIntegrity(output, { maxCps: 30, minCueSeconds: 0.35, maxLines: 2, maxLineChars: 42 }));
  assert.throws(() => assertCueIntegrity([cue("Fala muito rápida.", "00:00:01.000 --> 00:00:01.100")], { maxCps: 30, minCueSeconds: 0.35 }), { code: "SUBTITLE_READABILITY" });
});
test("all candidate failures advance to the next prepared source and cancellation stops fallback", async () => {
  const attempts = [];
  const result = await selectSubtitleSource({ cached: { name: "cache" }, prepare: async () => { throw new Error("invalid cache"); },
    embedded: async (intermediate) => { attempts.push(intermediate ? "intermediate" : "embedded"); if (!intermediate) throw new Error("invalid track"); return { name: "validated" }; },
    transcribe: async () => { attempts.push("transcription"); throw new Error("low confidence"); } });
  assert.deepEqual(attempts, ["embedded", "transcription", "intermediate"]);
  assert.equal(result.sourceSelectionFailures.length, 3);
  await assert.rejects(selectSubtitleSource({ embedded: async () => { throw Object.assign(new Error("cancelled"), { code: "SOURCE_CANCELLED" }); }, transcribe: async () => { throw new Error("must not run"); } }), { code: "SOURCE_CANCELLED" });
});
test("repeated legitimate dialogue remains an advisory warning", async () => {
  const content = "WEBVTT\n\n" + Array.from({ length: 5 }, (_, i) => `${i}\n00:${String(i).padStart(2, "0")}:00.000 --> 00:${String(i).padStart(2, "0")}:02.000\nUma frase repetida.\n`).join("\n");
  const prepared = await prepareSubtitleSource({ content, name: "faster-whisper", speechIntervals: [] }, { duration: 1500 });
  assert.equal(prepared.cues.length, 5);
  assert.ok(prepared.sourceQuality.repetitionWarnings.length);
});
test("atomic generation publishes all formats, stays read-only on lookup and detects corruption", () => {
  const sourceId = "src_publication";
  publishSubtitle(sourceId, [cue()], { fingerprint: "media", profile: "rules-v3" });
  const first = readPublication(sourceId);
  assert.equal(first.profile, "rules-v3");
  assert.deepEqual(Object.keys(first.files).sort(), ["pt-BR.ass", "pt-BR.srt", "pt-BR.vtt"]);
  const srt = publishedFile(sourceId, "pt-BR.srt");
  const before = fs.statSync(srt).mtimeMs;
  assert.match(fs.readFileSync(srt, "utf8"), /00:00:01,000 --> 00:00:03,000/);
  assert.equal(translationStatus(sourceId).status, "ready");
  assert.equal(fs.statSync(srt).mtimeMs, before);
  publishSubtitle(sourceId, [cue("Outra.")], { fingerprint: "media", profile: "rules-v3" });
  assert.notEqual(readPublication(sourceId).generation, first.generation);
  fs.writeFileSync(publishedFile(sourceId, "pt-BR.srt"), "corrupt");
  assert.equal(readPublication(sourceId), null);
  assert.equal(translationStatus(sourceId).status, "pending");
});
test("scene-specific magic guidance does not leak to a different episode", () => {
  assert.ok(seriesTerminologyForSource({ videoId: "tt1528406:2:37" }).some((rule) => rule.episode));
  assert.ok(seriesTerminologyForSource({ videoId: "tt1528406:2:38" }).every((rule) => !rule.episode));
});
test("semantic failure obeys the episode budget and never switches models", async (t) => {
  const models = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (part) => { body += part; });
    req.on("end", () => { models.push(JSON.parse(body).model); res.end(JSON.stringify({ message: { content: '<sub id="cue-000000">Só uma pessoa.</sub>' } })); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(translateContextual(["There are 100 soldiers."], { endpoint: `http://127.0.0.1:${server.address().port}`, model: "translategemma:test", fallbackModel: "translategemma:other", sourceLang: "en", targetLocale: "pt-BR", maxCalls: 2 }), { code: "TRANSLATION_BUDGET_EXHAUSTED" });
  assert.deepEqual(models, ["translategemma:test", "translategemma:test"]);
});

test("terminology hints never replace a source sentence containing negation", async (t) => {
  let prompt;
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (part) => { body += part; });
    req.on("end", () => { prompt = JSON.parse(body).messages[0].content; res.end(JSON.stringify({ message: { content: '<sub id="cue-000000">Eles não são membros da nossa guilda.</sub>' } })); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const chunk = contextualChunks([{ text: "They are not members of our guild.", sourceLang: "en" }], 1000, 20)[0];
  await translateGemmaChunkResilient(chunk, { endpoint: `http://127.0.0.1:${server.address().port}`, model: "translategemma:test", sourceLang: "en", targetLocale: "pt-BR",
    seriesTerminology: [{ sourcePattern: "our guild", guidance: "Use guilda.", sourceRewrite: "They are members of our guild." }] });
  assert.match(prompt, /<sub id="cue-000000">They are not members of our guild\.<\/sub>/);
});
