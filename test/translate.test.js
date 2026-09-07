const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { containsProtectedTerm, contextualChunks, inferProtectedTerms, looksRomanizedJapanese, normalizeOcrSourceText, normalizeSourceForTranslation, parseTaggedTranslations, preserveProtectedTermsFromDraft, translateContextualChunk, translateGemmaChunkResilient, validateContextualTranslations, validateSemanticFidelity } = require("../src/services/translate");

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

test("TranslateGemma requires a bilingual review and retries objective semantic failures", async (t) => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      calls += 1;
      const prompt = JSON.parse(body).messages[0].content;
      if (calls > 1) assert.match(prompt, /Draft to review:/);
      const text = calls < 3 ? "Garoto Bonitão tem 100 soldados." : "Sugarboy tem 100 soldados.";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content: `<sub id="cue-000000">${text}</sub>` } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const chunk = contextualChunks(["Sugarboy has 100 soldiers."], 1000, 20)[0];
  const output = await translateContextualChunk(chunk, {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    model: "translategemma:test",
    sourceLang: "en",
    targetLocale: "pt-BR",
    protectedTerms: ["Sugarboy"],
    timeoutMs: 2000,
    retries: 0,
  });
  assert.deepEqual(output, ["Sugarboy tem 100 soldados."]);
  assert.equal(calls, 3);
});

test("TranslateGemma repairs only a persistently rejected subtitle line", async (t) => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      calls += 1;
      const prompt = JSON.parse(body).messages[0].content;
      const targeted = (prompt.match(/<sub id=/g) || []).length === 1;
      const content = targeted
        ? '<sub id="cue-000000">Bem-vindos à Fairy Tail.</sub>'
        : '<sub id="cue-000000">Bem-vindos à Cauda de Fada.</sub>\n<sub id="cue-000001">Vamos começar.</sub>';
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const chunk = contextualChunks(["Welcome to Fairy Tail.", "Let's begin."], 1000, 20)[0];
  const output = await translateContextualChunk(chunk, {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    model: "translategemma:test",
    sourceLang: "en",
    targetLocale: "pt-BR",
    protectedTerms: ["Fairy Tail"],
    timeoutMs: 2000,
    retries: 0,
  });
  assert.deepEqual(output, ["Bem-vindos à Fairy Tail.", "Vamos começar."]);
  assert.equal(calls, 4);
});

test("TranslateGemma protects names with immutable tokens and restores them", async (t) => {
  let receivedPrompt = "";
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      receivedPrompt = JSON.parse(body).messages[0].content;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content: '<sub id="cue-000000">Esta é uma ZXQKEEP000ZXQ em Edolas.</sub>' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const chunk = contextualChunks(["This is a Fairy Tail in Edolas."], 1000, 20)[0];
  const output = await translateGemmaChunkResilient(chunk, {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    model: "translategemma:test",
    sourceLang: "en",
    targetLocale: "pt-BR",
    protectedTerms: ["Fairy Tail", "Fairy"],
    timeoutMs: 2000,
    retries: 0,
  });
  assert.match(receivedPrompt, /<sub id="cue-000000">This is a ZXQKEEP000ZXQ in Edolas\.<\/sub>/);
  assert.doesNotMatch(receivedPrompt, /This is a Fairy Tail in Edolas/);
  assert.deepEqual(output, ["Esta é uma Fairy Tail em Edolas."]);
});

test("semantic review keeps the faithful draft only for lines where it drops a name", () => {
  const chunk = contextualChunks([
    "It can have a Fairy Tail of its own.",
    "You cannot be serious!",
  ], 1000, 20)[0];
  assert.deepEqual(preserveProtectedTermsFromDraft(
    chunk,
    ["Pode ter sua própria Fairy Tail.", "Você não pode estar falando sério!"],
    ["Pode ter sua própria guilda.", "Não acredito!"],
    ["Fairy Tail"],
  ), ["Pode ter sua própria Fairy Tail.", "Não acredito!"]);
});

test("known ambiguous subtitle idioms are expanded before translation", () => {
  assert.equal(normalizeSourceForTranslation("Do my time and get out."), "serve my prison sentence and get out.");
  assert.equal(normalizeSourceForTranslation("Ain't nobody gonna serve it for you."), "Ain't nobody gonna serve your prison sentence for you.");
  assert.equal(normalizeSourceForTranslation("You talking out the side of your neck?"), "Are you talking nonsense and being disrespectful?");
});

test("normalizes unambiguous PGS OCR artifacts before translation", () => {
  assert.equal(normalizeOcrSourceText("Little did | realize it was mine"), "Little did I realize it was mine");
  assert.equal(normalizeOcrSourceText("I-ls she here? I-l dunno."), "I-Is she here? I-I dunno.");
});

test("separates romanized Japanese song lines from English dialogue", () => {
  assert.equal(looksRomanizedJapanese("anata no ude ga ima koishii to omou"), true);
  assert.equal(looksRomanizedJapanese("kyou no sora wa aoku sumi watatte ite"), true);
  assert.equal(looksRomanizedJapanese("I want to be in your arms right now"), false);
  const chunks = contextualChunks([
    { text: "Where are you going?", sourceLang: "en" },
    { text: "anata no ude ga ima koishii to omou", sourceLang: "ja-Latn" },
  ], 1000, 20);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((chunk) => chunk[0].sourceLang), ["en", "ja-Latn"]);
});

test("protects repeated names and rejects objective semantic corruption", () => {
  const chunk = contextualChunks(["Sugarboy has 100 soldiers.", "Tell Sugarboy to wait."], 1000, 20)[0];
  const terms = inferProtectedTerms(chunk);
  assert.ok(terms.includes("Sugarboy"));
  assert.deepEqual(validateSemanticFidelity(chunk, ["Sugarboy tem 100 soldados.", "Diga ao Sugarboy para esperar."], terms), [
    "Sugarboy tem 100 soldados.", "Diga ao Sugarboy para esperar.",
  ]);
  assert.throws(() => validateSemanticFidelity(chunk, ["Garoto Bonitão tem 100 soldados.", "Diga ao Sugarboy para esperar."], terms), /nome protegido/);
  assert.throws(() => validateSemanticFidelity(chunk, ["Sugarboy tem 10 soldados.", "Diga ao Sugarboy para esperar."], terms), /alterou o número/);
  assert.throws(() => validateSemanticFidelity(chunk, ["Sugarboy tem 100 soldados |", "Diga ao Sugarboy para esperar."], terms), /resíduo de OCR/);
});

test("matches protected names as complete terms instead of substrings", () => {
  assert.equal(containsProtectedTerm("We came to Edolas", "All"), false);
  assert.equal(containsProtectedTerm("Tell Sugarboy to wait", "Sugarboy"), true);
  const chunk = contextualChunks(["We came to Edolas"], 1000, 20)[0];
  assert.doesNotThrow(() => validateSemanticFidelity(chunk, ["Viemos para Edolas"], ["All"]));
});

test("uses inferred ambiguous single words as hints without hard-failing valid localization", () => {
  const chunk = contextualChunks(["The Fairy Hunter is here."], 1000, 20)[0];
  assert.doesNotThrow(() => validateSemanticFidelity(chunk, ["A Caçadora de Fadas está aqui."], ["Fairy", "Hunter"]));
  assert.throws(() => validateSemanticFidelity(
    contextualChunks(["Welcome to Fairy Tail."], 1000, 20)[0],
    ["Bem-vindos à Cauda de Fada."],
    ["Fairy Tail"],
  ), /nome protegido Fairy Tail/);
});

test("does not infer ordinary words seen in lowercase as protected names", () => {
  const chunk = contextualChunks([
    "All the guild members are acting strangely.",
    "All right, let's go.",
    "They are all safe now.",
    "Natsu called Charle.",
    "Charle answered Natsu.",
    "Natsu thanked Charle.",
  ], 1000, 20)[0];
  const terms = inferProtectedTerms(chunk);
  assert.equal(terms.includes("All"), false);
  assert.equal(terms.includes("Natsu"), true);
  assert.equal(terms.includes("Charle"), true);
});

test("does not infer repeated sentence-opening interjections as names", () => {
  const chunk = contextualChunks([
    "Hey, what are you doing?",
    "Hey! Come back here.",
    "Natsu called Charle.",
    "Charle answered Natsu.",
    "Natsu thanked Charle.",
  ], 1000, 20)[0];
  const terms = inferProtectedTerms(chunk);
  assert.equal(terms.includes("Hey"), false);
  assert.equal(terms.includes("Natsu"), true);
});
