const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { containsProtectedTerm, contextualChunks, inferProtectedTerms, looksRomanizedJapanese, normalizeOcrSourceText, normalizeSourceForTranslation, parseTaggedTranslations, preserveProtectedTermsFromDraft, translateContextual, translateContextualChunk, translateGemmaChunkResilient, validateContextualTranslations, validateSemanticFidelity, validateTargetScript } = require("../src/services/translate");

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

test("contextual validation removes leaked prompt and formatting tags, including cached translations", () => {
  const chunk = contextualChunks(["Line one", "Line two"], 1000, 20)[0];
  const output = validateContextualTranslations(chunk, [
    { id: "cue-000000", text: "Primeira linha.</span></pt>" },
    { id: "cue-000001", text: "Segunda linha.</previous></code>" },
  ]);
  assert.deepEqual(output, ["Primeira linha.", "Segunda linha."]);
  assert.throws(() => validateTargetScript(["Texto.</unrecognized>"], "pt-BR"), /marcação indevida/);
});

test("contextual validation rejects omitted, empty, and duplicated cues", () => {
  const chunk = contextualChunks(["First", "Second"], 1000, 20)[0];
  assert.throws(() => validateContextualTranslations(chunk, [{ id: "cue-000000", text: "Primeira" }]), /quantidade/);
  assert.throws(() => validateContextualTranslations(chunk, [
    { id: "cue-000000", text: "Primeira" },
    { id: "cue-000000", text: "Duplicada" },
  ]), /duplicado/);
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
  assert.equal(calls, 3);
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

test("PT-BR rejects names left in a non-Latin script but accepts romanized names", () => {
  const chunk = contextualChunks(["シャルルはどこ?"], 1000, 20)[0];
  assert.throws(() => validateSemanticFidelity(chunk, ["Onde está シャルル?"], [], "pt-BR"), /escrita não latina em cue-000000/);
  assert.deepEqual(validateSemanticFidelity(chunk, ["Onde está Charle?"], [], "pt-BR"), ["Onde está Charle?"]);
  assert.throws(() => validateTargetScript(["Eu vou proteger a ウェンディー."], "pt-BR"), /escrita não latina/);
  assert.doesNotThrow(() => validateTargetScript(["Onde está シャルル?"], "ja"));
});

test("a reviewed name in Latin script is not replaced by a source-script draft", () => {
  const chunk = contextualChunks(["Fairy Tail e シャルル"], 1000, 20)[0];
  assert.deepEqual(preserveProtectedTermsFromDraft(
    chunk,
    ["Fairy Tail e シャルル"],
    ["A guilda e Charle"],
    ["Fairy Tail"],
  ), ["A guilda e Charle"]);
});

test("TranslateGemma repairs a Japanese name left in a PT-BR subtitle", async (t) => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      calls += 1;
      const prompt = JSON.parse(body).messages[0].content;
      assert.match(prompt, /established Latin-script spelling/);
      if (calls === 4) {
        assert.match(prompt, /Correct this rejected translation/);
        assert.doesNotMatch(prompt, /Draft to review:/);
      }
      const name = calls < 4 ? "シャルル" : "Charle";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content: `<sub id="cue-000000">Onde está ${name}?</sub>` } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const chunk = contextualChunks(["シャルルはどこ?"], 1000, 20)[0];
  const output = await translateContextualChunk(chunk, {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    model: "translategemma:test",
    sourceLang: "ja",
    targetLocale: "pt-BR",
    timeoutMs: 2000,
    retries: 0,
  });
  assert.deepEqual(output, ["Onde está Charle?"]);
  assert.equal(calls, 4);
});

test("confirmed title spelling repairs a model response that still copies Kana", async (t) => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      calls++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content: '<sub id="cue-000000">Onde está シャルル?</sub>' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const chunk = contextualChunks(["Charleはどこ?"], 1000, 20)[0];
  const result = await translateContextualChunk(chunk, {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    model: "translategemma:test",
    sourceLang: "ja",
    targetLocale: "pt-BR",
    nameAliases: { "シャルル": "Charle" },
    timeoutMs: 2000,
    retries: 0,
  });
  assert.deepEqual(result, ["Onde está Charle?"]);
  assert.equal(calls, 2);
});

test("later translation chunks see the approved spelling despite a Kana recognition variant", async (t) => {
  let priorNameSeen = false;
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      const prompt = JSON.parse(body).messages[0].content;
      const id = /<sub id="([^"]+)">/.exec(prompt)[1];
      if (id === "cue-000001" && prompt.includes("<previous><source>シャルル!</source><pt>Charle!</pt></previous>")) priorNameSeen = true;
      const text = id === "cue-000000" ? "Charle!" : "Onde está Charle?";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content: `<sub id="${id}">${text}</sub>` } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const output = await translateContextual(["シャルル!", "シャレルはどこ?"], {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    model: "translategemma:test",
    sourceLang: "ja",
    targetLocale: "pt-BR",
    maxChars: 1000,
    maxCues: 1,
    timeoutMs: 2000,
    retries: 0,
  });
  assert.deepEqual(output, ["Charle!", "Onde está Charle?"]);
  assert.equal(priorNameSeen, true);
});

test("a verified translation block is reused on retry of the same source", async (t) => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      calls++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content: '<sub id="cue-000000">Olá, Charle!</sub>' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "translation-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    model: "translategemma:test",
    sourceLang: "ja",
    targetLocale: "pt-BR",
    cachePath: path.join(dir, "blocks.json"),
    timeoutMs: 2000,
    retries: 0,
  };
  assert.deepEqual(await translateContextual(["こんにちは、シャルル!"], options), ["Olá, Charle!"]);
  assert.deepEqual(await translateContextual(["こんにちは、シャルル!"], options), ["Olá, Charle!"]);
  assert.equal(calls, 2);
});

test("numeric fidelity accepts a Portuguese word for a Japanese digit", () => {
  const chunk = contextualChunks(["どういうことだ 2人だけだと"], 1000, 20)[0];
  assert.deepEqual(validateSemanticFidelity(chunk, ["Como assim, só duas pessoas?"], [], "pt-BR"), ["Como assim, só duas pessoas?"]);
  assert.throws(() => validateSemanticFidelity(chunk, ["Como assim, só três pessoas?"], [], "pt-BR"), /alterou o número 2/);
});

test("known ambiguous subtitle idioms are expanded before translation", () => {
  assert.equal(normalizeSourceForTranslation("Hell if I know!"), "I have absolutely no idea!");
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
  assert.equal(looksRomanizedJapanese("Kara and Sora went to the library."), false);
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

test("accepts a faithful natural translation of Japanese numeric fractions", () => {
  const chunk = [{ id: "cue-000203", text: "3分の1を残して北に向かう!" }];
  assert.deepEqual(validateSemanticFidelity(chunk, ["Deixem um terço aqui e sigam para o norte!"]), ["Deixem um terço aqui e sigam para o norte!"]);
  assert.throws(() => validateSemanticFidelity(chunk, ["Deixem metade aqui e sigam para o norte!"]), /alterou uma fração/);
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

test("TranslateGemma removes invented XML elements without dropping their visible text", () => {
  const chunk = contextualChunks(["Come here."], 1000, 20)[0];
  assert.deepEqual(parseTaggedTranslations(chunk, '<sub id="cue-000000">Venha <place>aqui</place>.</sub>'), ["Venha aqui."]);
});

test("multiple referents do not trigger an unreliable pronoun regex veto", () => {
  const chunk = contextualChunks([{ text: "She took the king's book.", sourceLang: "en" }], 1000, 20)[0];
  assert.deepEqual(validateSemanticFidelity(chunk, ["Ela pegou o livro dele."], [], "pt-BR"), ["Ela pegou o livro dele."]);
});

test("semantic review rejects invalid Portuguese da mim or do mim", () => {
  const chunk = contextualChunks(["Take it from me."], 1000, 20)[0];
  assert.throws(() => validateSemanticFidelity(chunk, ["Tire isso da mim."], [], "pt-BR"), /regência inválida/);
});

test("inferred capitalized words are not frozen as names in English dialogue", async (t) => {
  let receivedPrompt = "";
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      receivedPrompt = JSON.parse(body).messages[0].content;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content: '<sub id="cue-000000">Sim, Vossa Majestade. Inicie o Código ETD. Os Dragon Slayers estão aqui.</sub>' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const chunk = contextualChunks(["Yes, Your Majesty. Initiate Code ETD. Dragon Slayers are here."], 1000, 20)[0];
  const output = await translateGemmaChunkResilient(chunk, {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    model: "translategemma:test",
    sourceLang: "en",
    targetLocale: "pt-BR",
    protectedTerms: ["Majesty", "Code", "Dragon", "Slayers", "ETD"],
    timeoutMs: 2000,
    retries: 0,
  });
  assert.doesNotMatch(receivedPrompt, /ZXQKEEP/);
  assert.deepEqual(output, ["Sim, Vossa Majestade. Inicie o Código ETD. Os Dragon Slayers estão aqui."]);
});

test("a verified block can be reused after switching to a smaller translation model", async (t) => {
  let calls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      calls++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content: '<sub id="cue-000000">Olá, Charle!</sub>' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "translation-cache-model-switch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = { endpoint: `http://127.0.0.1:${server.address().port}`, sourceLang: "ja", targetLocale: "pt-BR", cachePath: path.join(dir, "blocks.json"), timeoutMs: 2000, retries: 0 };
  assert.deepEqual(await translateContextual(["こんにちは、シャルル!"], { ...base, model: "translategemma:large" }), ["Olá, Charle!"]);
  assert.deepEqual(await translateContextual(["こんにちは、シャルル!"], { ...base, model: "translategemma:small", cacheModels: ["translategemma:large"] }), ["Olá, Charle!"]);
  assert.equal(calls, 2);
});

test("contextual translation falls back once and keeps using the CPU-safe model", async (t) => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (part) => { body += part; });
    request.on("end", () => {
      const payload = JSON.parse(body);
      if (payload.model === "translategemma:large") {
        primaryCalls++;
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "model cannot be allocated" }));
        return;
      }
      fallbackCalls++;
      const id = /<sub id="([^"]+)">/.exec(payload.messages[0].content)?.[1] || "cue-000000";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: { content: `<sub id="${id}">Tradução segura.</sub>` } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const output = await translateContextual(["Safe translation."], {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    model: "translategemma:large",
    gpuLayers: 999,
    fallbackModel: "translategemma:small",
    fallbackGpuLayers: 0,
    sourceLang: "en",
    targetLocale: "pt-BR",
    timeoutMs: 2000,
    retries: 2,
  });
  assert.deepEqual(output, ["Tradução segura."]);
  assert.equal(primaryCalls, 2);
  assert.equal(fallbackCalls, 2);
});


test("an exact series correction bypasses an empty model repair", async () => {
  const chunk = contextualChunks([{ text: "And Mystogan sent Gajeel here.", sourceLang: "en" }], 1000, 20)[0];
  const output = await translateContextualChunk(chunk, {
    endpoint: "http://127.0.0.1:1",
    model: "translategemma:4b",
    sourceLang: "en",
    targetLocale: "pt-BR",
    seriesCorrections: [{ source: "And Mystogan sent Gajeel here.", target: "E Mystogan enviou Gajeel para cá." }],
    timeoutMs: 20,
    retries: 0,
  });
  assert.deepEqual(output, ["E Mystogan enviou Gajeel para cá."]);
});

test("a nested resilient split also bypasses the model for an exact correction", async () => {
  const chunk = contextualChunks([{ text: "And Mystogan sent Gajeel here.", sourceLang: "en" }], 1000, 20)[0];
  const output = await translateGemmaChunkResilient(chunk, {
    endpoint: "http://127.0.0.1:1",
    model: "translategemma:4b",
    sourceLang: "en",
    targetLocale: "pt-BR",
    seriesCorrections: [{ source: "And Mystogan sent Gajeel here.", target: "E Mystogan enviou Gajeel para cá." }],
    timeoutMs: 20,
    retries: 0,
  }, 3);
  assert.deepEqual(output, ["E Mystogan enviou Gajeel para cá."]);
});
