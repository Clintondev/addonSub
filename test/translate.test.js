const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { contextualChunks, normalizeSourceForTranslation, parseTaggedTranslations, translateGemmaChunkResilient, validateContextualTranslations } = require("../src/services/translate");

test("contextual chunks preserve stable cue ids and original indexes", () => {
  const chunks = contextualChunks(["First line", "Second line", "Third line"], 1000, 2);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.flat().map(({ id, index }) => [id, index]), [
    ["cue-000000", 0], ["cue-000001", 1], ["cue-000002", 2],
  ]);
});

test("contextual chunks do not mix scenes separated by a long subtitle gap", () => {
  const chunks = contextualChunks([
    { text: "End of scene one", startMs: 1000, endMs: 2500 },
    { text: "Start of scene two", startMs: 12000, endMs: 14000 },
  ], 1000, 20);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk[0].index), [0, 1]);
});

test("contextual validation restores source order even if model reorders JSON", () => {
  const chunk = contextualChunks(["How are you?", "Get out."], 1000, 20)[0];
  const output = validateContextualTranslations(chunk, [
    { id: "cue-000001", text: "Saia." },
    { id: "cue-000000", text: "Como você está?" },
  ]);
  assert.deepEqual(output, ["Como você está?", "Saia."]);
});

test("contextual validation rejects omitted, empty, and duplicated cues", () => {
  const chunk = contextualChunks(["First", "Second"], 1000, 20)[0];
  assert.throws(() => validateContextualTranslations(chunk, [{ id: "cue-000000", text: "Primeira" }]), /quantidade/);
  assert.throws(() => validateContextualTranslations(chunk, [
    { id: "cue-000000", text: "Primeira" },
    { id: "cue-000000", text: "Duplicada" },
  ]), /ausente/);
});

test("TranslateGemma tagged output preserves ids and decodes subtitle text", () => {
  const chunk = contextualChunks(["Rock & roll", "Get out."], 1000, 20)[0];
  const output = parseTaggedTranslations(chunk, [
    '<sub id="cue-000000">Rock &amp; roll</sub>',
    '<sub id="cue-000001">Cai fora.</sub>',
  ].join("\n"));
  assert.deepEqual(output, ["Rock & roll", "Cai fora."]);
});

test("TranslateGemma tagged output tolerates omitted closing XML tags", () => {
  const chunk = contextualChunks(["One", "Two"], 1000, 20)[0];
  const output = parseTaggedTranslations(chunk, '```xml\n<sub id="cue-000000">Um\n<sub id="cue-000001">Dois\n```');
  assert.deepEqual(output, ["Um", "Dois"]);
});

test("TranslateGemma recovers omitted continuation cues by translating smaller verified parts", async (t) => {
  const translations = new Map([
    ["cue-000000", "Mais importante, isso não seria ruim,"],
    ["cue-000001", "mesmo estando na floresta?!"],
    ["cue-000002", "Pergunte ao monstro gigante, não a mim!"],
  ]);
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      const content = JSON.parse(body).messages[0].content;
      const ids = [...content.matchAll(/<sub id="([^"]+)">/g)].map((match) => match[1]);
      // Emulate the real failure: a multi-cue answer merges a continuation
      // and therefore omits an immutable id. Single verified retries comply.
      const returned = ids.length > 1 ? ids.slice(0, -1) : ids;
      const output = returned.map((id) => `<sub id="${id}">${translations.get(id)}</sub>`).join("\n");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content: output } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const chunk = contextualChunks([
    { text: "More importantly, would that not be bad,", startMs: 1000, endMs: 2000 },
    { text: "even if we are in the forest?!", startMs: 2100, endMs: 3000 },
    { text: "Ask the giant monster, not me!", startMs: 3200, endMs: 4100 },
  ], 1000, 20)[0];
  const output = await translateGemmaChunkResilient(chunk, {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    model: "translategemma:test",
    sourceLang: "en",
    targetLocale: "pt-BR",
    timeoutMs: 2000,
    retries: 0,
  });
  assert.deepEqual(output, [...translations.values()]);
});

test("known ambiguous subtitle idioms are expanded before translation", () => {
  assert.equal(normalizeSourceForTranslation("Do my time and get out."), "serve my prison sentence and get out.");
  assert.equal(normalizeSourceForTranslation("Ain't nobody gonna serve it for you."), "Ain't nobody gonna serve your prison sentence for you.");
  assert.equal(normalizeSourceForTranslation("You talking out the side of your neck?"), "Are you talking nonsense and being disrespectful?");
});
