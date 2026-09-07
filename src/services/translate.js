const fetch = require("node-fetch");
const config = require("../config");
const logger = require("../logger");
const { sanitizeUrl } = require("../utils/security");
const { fetchWithTimeout } = require("../utils/fetchWithTimeout");

function mapTargetLocale(locale) {
  const normalized = String(locale || "pt").trim().toLowerCase().replace("_", "-");
  if (["pt-br", "pb"].includes(normalized)) return "pt-BR";
  return normalized.split("-")[0];
}

async function detectLanguage(text, endpoint) {
  if (!text || !text.trim()) return "und";
  try {
    const res = await fetchWithTimeout(`${endpoint}/detect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: text.slice(0, 4000) }) }, config.internalHttpTimeoutMs);
    if (!res.ok) throw new Error(`detect status ${res.status}`);
    const result = await res.json();
    return Array.isArray(result) && result[0]?.language ? result[0].language : "und";
  } catch (error) {
    logger.warn("Language detection failed", { endpoint: sanitizeUrl(endpoint), error: error.message });
    return "und";
  }
}

async function translateText(text, endpoint, targetLocale, sourceLang) {
  if (!text || !text.trim()) return text;
  const response = await fetchWithTimeout(`${endpoint}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, source: sourceLang && sourceLang !== "und" ? sourceLang : "auto", target: mapTargetLocale(targetLocale), format: "text" }),
  }, config.internalHttpTimeoutMs);
  if (!response.ok) throw new Error(`translate status ${response.status}`);
  const data = await response.json();
  if (typeof data.translatedText !== "string" || !data.translatedText.trim()) throw new Error("Translator returned an invalid response");
  return data.translatedText;
}

async function translateBatch(texts, endpoint, targetLocale, sourceLang, _maxChars = 3500) {
  if (!Array.isArray(texts)) throw new Error("texts must be an array");
  const output = [];
  const concurrency = 6;
  for (let index = 0; index < texts.length; index += concurrency) {
    const chunk = texts.slice(index, index + concurrency);
    const translated = await Promise.all(chunk.map((text) => translateText(text, endpoint, targetLocale, sourceLang)));
    output.push(...translated);
  }
  if (output.length !== texts.length || output.some((text) => typeof text !== "string")) throw new Error("Translation cue validation failed");
  return output;
}

function contextualChunks(texts, maxChars = 6000, maxCues = 28) {
  const chunks = [];
  let chunk = [];
  let chars = 0;
  let previousEndMs = null;
  texts.forEach((entry, index) => {
    const isTimed = entry && typeof entry === "object";
    const text = isTimed ? entry.text : entry;
    const startMs = isTimed && Number.isFinite(entry.startMs) ? entry.startMs : null;
    const endMs = isTimed && Number.isFinite(entry.endMs) ? entry.endMs : null;
    const sourceLang = isTimed ? entry.sourceLang || null : null;
    const item = { id: `cue-${String(index).padStart(6, "0")}`, text: String(text || "").trim(), index, startMs, endMs, sourceLang };
    const itemChars = item.text.length + 32;
    const sceneBreak = startMs !== null && previousEndMs !== null && startMs - previousEndMs >= 8000;
    const languageBreak = chunk.length && sourceLang && chunk[0].sourceLang && sourceLang !== chunk[0].sourceLang;
    if (chunk.length && (sceneBreak || languageBreak || chunk.length >= maxCues || chars + itemChars > maxChars)) {
      chunks.push(chunk);
      chunk = [];
      chars = 0;
    }
    chunk.push(item);
    chars += itemChars;
    if (endMs !== null) previousEndMs = endMs;
  });
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function validateContextualTranslations(chunk, translations) {
  if (!Array.isArray(translations) || translations.length !== chunk.length) {
    throw new Error(`Tradutor contextual alterou a quantidade de falas: esperado ${chunk.length}, recebido ${translations?.length ?? 0}`);
  }
  const byId = new Map(translations.map((item) => [item?.id, item?.text]));
  const output = chunk.map((item) => {
    const translated = byId.get(item.id);
    if (typeof translated !== "string" || !translated.trim()) throw new Error(`Tradução ausente para ${item.id}`);
    if (translated.length > Math.max(240, item.text.length * 5)) throw new Error(`Tradução anormalmente longa para ${item.id}`);
    return translated.trim();
  });
  const suspicious = output.filter((text, index) => chunk[index].text.length >= 14 && text.toLocaleLowerCase() === chunk[index].text.toLocaleLowerCase());
  if (suspicious.length > Math.max(2, Math.ceil(chunk.length * 0.15))) throw new Error("Tradutor contextual deixou falas demais sem traduzir");
  return output;
}

function normalizeOcrSourceText(value) {
  return String(value || "")
    .replace(/\|/g, "I")
    .replace(/\bI-ls\b/g, "I-Is")
    .replace(/\bI-l\b/g, "I-I")
    .replace(/[\uFFFD]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

const ROMAJI_WORDS = new Set([
  "aenai", "aoku", "anata", "atta", "boku", "dake", "hibi", "hitotsu", "ima", "itsumo", "kara", "kikitai",
  "kimi", "kitto", "koishii", "koko", "kyou", "migi", "nara", "negau", "omou", "onegai", "poketto",
  "sagashiteru", "shoumei", "sora", "sore", "sukoshi", "tsunagu", "tsuzuite", "ude", "watashi", "wataru",
]);

const PROTECTED_TERM_CANDIDATES = ["Earth Land", "Fairy Tail", "Edolas", "Sugarboy"];
const STRICT_PROTECTED_TERMS = new Set(PROTECTED_TERM_CANDIDATES.map((term) => term.toLocaleLowerCase()));

function looksRomanizedJapanese(value) {
  const words = String(value || "").toLocaleLowerCase().match(/[a-z']+/g) || [];
  return words.length >= 4 && words.filter((word) => ROMAJI_WORDS.has(word)).length >= 2;
}

function containsProtectedTerm(value, term) {
  const escaped = String(term || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(String(value || ""));
}

function protectedTermBindings(terms = []) {
  return [...new Set(terms.map((term) => String(term || "").trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((term, index) => ({ term, token: `ZXQKEEP${String(index).padStart(3, "0")}ZXQ` }));
}

function protectTerms(value, bindings) {
  let output = String(value || "");
  for (const { term, token } of bindings) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"), token);
  }
  return output;
}

function restoreTerms(value, bindings) {
  let output = String(value || "");
  for (const { term, token } of bindings) output = output.replace(new RegExp(token, "gi"), term);
  return output;
}

function validateSemanticFidelity(chunk, translations, protectedTerms = []) {
  translations.forEach((translation, index) => {
    if (/[|\uFFFD]/.test(translation)) throw new Error(`Tradução contém resíduo de OCR para ${chunk[index].id}`);
    const sourceNumbers = chunk[index].text.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
    const normalizedTranslation = translation.replace(/,(?=\d)/g, ".");
    for (const number of sourceNumbers) {
      if (!normalizedTranslation.includes(number.replace(",", "."))) throw new Error(`Tradução alterou o número ${number} em ${chunk[index].id}`);
    }
    for (const term of protectedTerms) {
      // Inferred single words are useful prompting hints, but can also be
      // ordinary translated words (for example "Fairy" in "Fairy Hunter").
      // Only confirmed terms may reject an otherwise valid full subtitle.
      if (!STRICT_PROTECTED_TERMS.has(String(term).toLocaleLowerCase())) continue;
      if (containsProtectedTerm(chunk[index].text, term) && !containsProtectedTerm(translation, term)) {
        throw new Error(`Tradução alterou o nome protegido ${term} em ${chunk[index].id}`);
      }
    }
  });
  return translations;
}

function preserveProtectedTermsFromDraft(chunk, draft, reviewed, protectedTerms = []) {
  return reviewed.map((translation, index) => {
    const sourceTerms = protectedTerms.filter((term) => containsProtectedTerm(chunk[index].text, term));
    const droppedTerm = sourceTerms.some((term) => containsProtectedTerm(draft[index], term) && !containsProtectedTerm(translation, term));
    return droppedTerm ? draft[index] : translation;
  });
}

function inferProtectedTerms(items) {
  const text = items.map((item) => item.text).join("\n");
  const terms = new Set(PROTECTED_TERM_CANDIDATES.filter((term) => containsProtectedTerm(text, term)));
  const counts = new Map();
  const interiorCounts = new Map();
  const seenLowercase = new Set();
  const ignored = new Set(["I", "A", "An", "And", "Are", "As", "At", "Brother", "But", "Captain", "Come", "Did", "Do", "Does", "English", "Father", "For", "From", "Get", "Go", "Good", "He", "Her", "Here", "His", "How", "If", "In", "Is", "It", "King", "Let", "Lord", "Magic", "Master", "Maybe", "Mother", "My", "No", "Not", "Now", "Oh", "Okay", "Our", "Please", "Previously", "Princess", "Queen", "She", "Sir", "Sister", "So", "That", "The", "Their", "There", "These", "They", "This", "Those", "To", "We", "What", "When", "Where", "Who", "Why", "With", "Yes", "You", "Your"]);
  for (const item of items) {
    for (const match of item.text.matchAll(/\b[a-z][A-Za-z]{2,}\b/g)) seenLowercase.add(match[0].toLocaleLowerCase());
    for (const match of item.text.matchAll(/\b[A-Z][A-Za-z]{2,}\b/g)) {
      const term = match[0];
      if (!ignored.has(term)) {
        counts.set(term, (counts.get(term) || 0) + 1);
        const before = item.text.slice(0, match.index).trimEnd();
        const previous = before.slice(-1);
        if (before && !/[.!?\n\-–—]/.test(previous)) interiorCounts.set(term, (interiorCounts.get(term) || 0) + 1);
      }
    }
  }
  for (const [term, count] of counts) {
    if (count >= 3 && interiorCounts.get(term) >= 1 && !seenLowercase.has(term.toLocaleLowerCase())) terms.add(term);
  }
  return [...terms].slice(0, 80);
}

function contextualSchema(count) {
  return {
    type: "object",
    properties: {
      translations: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          properties: { id: { type: "string" }, text: { type: "string" } },
          required: ["id", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["translations"],
    additionalProperties: false,
  };
}

function xmlEscape(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlUnescape(value) {
  return String(value || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function normalizeSourceForTranslation(value) {
  return String(value || "")
    .replace(/\b(?:are\s+)?you\s+talking\s+out\s+(?:of\s+)?the\s+side\s+of\s+your\s+neck\??/gi, "Are you talking nonsense and being disrespectful?")
    .replace(/\bdo\s+my\s+time\b/gi, "serve my prison sentence")
    .replace(/\bserve\s+it\s+for\s+you\b/gi, "serve your prison sentence for you");
}

function sanitizeTranslatedText(value) {
  return String(value || "")
    .replace(/<\/?(?:i|b|u|font)(?:\s[^>]*)?>/gi, "")
    // Do not let a malformed, unclosed model tag consume following subtitle
    // lines while cleaning output (for example: </sub id="cue-000209">).
    .replace(/<\/?sub\b[^\r\n>]*>?/gi, "")
    .replace(/```(?:xml)?/gi, "")
    .trim();
}

function parseTaggedTranslations(chunk, output) {
  const found = new Map();
  // TranslateGemma occasionally preserves every opening marker but omits the
  // closing tags. Treat the next immutable marker as the safe boundary while
  // still accepting well-formed XML.
  const pattern = /<sub\s+id=["']([^"']+)["']\s*>([\s\S]*?)(?=<sub\s+id=["']|<\/sub>|```|$)/gi;
  let match;
  while ((match = pattern.exec(String(output || "")))) found.set(match[1], sanitizeTranslatedText(xmlUnescape(match[2])));
  return validateContextualTranslations(chunk, chunk.map((item) => ({ id: item.id, text: found.get(item.id) })));
}

async function translateGemmaChunk(chunk, { endpoint, model, sourceLang, targetLocale, contextTitle, contextItems = [], protectedTerms = [], drafts = null, timeoutMs = 300000, retries = 2 }) {
  const sourceName = String(sourceLang || "en").toLowerCase().startsWith("en")
    ? "English"
    : String(sourceLang || "").toLowerCase() === "ja-latn" ? "romanized Japanese"
      : String(sourceLang || "").toLowerCase().startsWith("ja") ? "Japanese" : `source language ${sourceLang || "auto"}`;
  const termBindings = protectedTermBindings(protectedTerms);
  const taggedText = chunk.map((item) => `<sub id="${item.id}">${xmlEscape(protectTerms(normalizeSourceForTranslation(item.text), termBindings))}</sub>`).join("\n");
  const contextText = contextItems.map((item) => `<context>${xmlEscape(protectTerms(normalizeSourceForTranslation(item.text), termBindings))}</context>`).join("\n");
  const draftText = drafts ? chunk.map((item, index) => `<draft id="${item.id}">${xmlEscape(protectTerms(drafts[index], termBindings))}</draft>`).join("\n") : "";
  const semanticConstraints = [];
  chunk.forEach((item) => {
    if (/\bmy\b/i.test(item.text)) semanticConstraints.push(`${item.id}: English "my" is first-person possession; Portuguese must explicitly preserve meu/minha/meus/minhas, never seu/sua.`);
    if (/\bfor you\b/i.test(item.text)) semanticConstraints.push(`${item.id}: preserve the agent and the beneficiary "for you" explicitly as por você/pra você; do not replace it with merely helping you.`);
  });
  const prompt = [
    `You are a professional ${sourceName} (${sourceLang || "en"}) to Brazilian Portuguese (${mapTargetLocale(targetLocale)}) subtitle translator and bilingual fidelity reviewer. ${drafts ? "Review the draft against the original and rewrite every inaccurate, literal, inconsistent, or contextually wrong line." : "Translate the original dialogue accurately."} Preserve the exact meaning, grammatical person, subject, agent, tense, modality, negation, numbers, and named entities. Never replace a place, character, organization, or fictional term with a contextually plausible alternative. Use the context lines only to understand the scene; never output or translate <context> elements. Preserve register, humor, insults, and profanity. Translate idioms by meaning instead of word-for-word. Translate only the text inside each <sub> element. Return exactly one non-empty <sub> element for every input id, in the same order. Never merge, omit, renumber, or shift fragments. Produce only translated <sub> XML without explanations.`,
    semanticConstraints.length ? `Mandatory semantic constraints:\n${semanticConstraints.join("\n")}` : "",
    termBindings.length ? `Immutable name tokens: ${termBindings.map(({ term, token }) => `${token}=${term}`).join(", ")}. Copy every ZXQKEEP token byte-for-byte; it will be restored after translation.` : "",
    contextTitle ? `Context title: ${String(contextTitle).slice(0, 1000)}` : "",
    contextText ? `Surrounding context (do not output):\n${contextText}` : "",
    draftText ? `Draft to review:\n${draftText}` : "",
    `Original ${sourceName} lines to translate:`,
    "",
    taggedText,
  ].join("\n");
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: "10m",
          options: { temperature: 0, num_ctx: 4096, num_predict: 4096 },
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Ollama respondeu ${response.status}: ${body.slice(0, 500)}`);
      const envelope = JSON.parse(body);
      const content = envelope.message?.content || "";
      try {
        return parseTaggedTranslations(chunk, content).map((translation) => restoreTerms(translation, termBindings));
      } catch (error) {
        throw new Error(`${error.message}; formato recebido: ${content.slice(0, 800).replace(/\s+/g, " ")}`);
      }
    } catch (error) {
      lastError = error;
      logger.warn("TranslateGemma block rejected", { attempt: attempt + 1, error: error.message });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Falha no TranslateGemma");
}

function resilientSplitIndex(chunk) {
  if (chunk.length < 2) return 0;
  const middle = Math.floor(chunk.length / 2);
  // Prefer a pause or sentence boundary close to the middle so fragments of
  // the same sentence retain as much shared context as possible.
  const candidates = [];
  for (let index = 1; index < chunk.length; index++) {
    const previous = chunk[index - 1];
    const current = chunk[index];
    const gap = Number.isFinite(previous.endMs) && Number.isFinite(current.startMs)
      ? current.startMs - previous.endMs : 0;
    const sentenceEnd = /[.!?]["')\]]?\s*$/.test(previous.text);
    if (gap >= 1200 || sentenceEnd) candidates.push({ index, distance: Math.abs(index - middle), gap });
  }
  candidates.sort((left, right) => left.distance - right.distance || right.gap - left.gap);
  return candidates[0]?.index || middle;
}

async function translateGemmaChunkResilient(chunk, options, depth = 0) {
  try {
    // The full block gets the configured retries. Recovery blocks get one
    // deterministic attempt each before being divided again.
    return await translateGemmaChunk(chunk, { ...options, retries: depth === 0 ? options.retries : 0 });
  } catch (error) {
    if (chunk.length <= 1) throw error;
    const split = resilientSplitIndex(chunk);
    logger.warn("Retrying rejected TranslateGemma block in smaller verified parts", {
      cues: chunk.length,
      leftCues: split,
      rightCues: chunk.length - split,
      depth,
      error: error.message,
    });
    const leftOptions = options.drafts ? { ...options, drafts: options.drafts.slice(0, split) } : options;
    const rightOptions = options.drafts ? { ...options, drafts: options.drafts.slice(split) } : options;
    const siblingContext = [...(options.contextItems || []), ...chunk];
    const left = await translateGemmaChunkResilient(chunk.slice(0, split), { ...leftOptions, contextItems: siblingContext.filter((item) => !chunk.slice(0, split).includes(item)) }, depth + 1);
    const right = await translateGemmaChunkResilient(chunk.slice(split), { ...rightOptions, contextItems: siblingContext.filter((item) => !chunk.slice(split).includes(item)) }, depth + 1);
    return [...left, ...right];
  }
}

async function requestStructuredTranslations({ endpoint, model, system, user, count, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: "10m",
        format: contextualSchema(count),
        options: { temperature: 0.05, num_ctx: 8192 },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Ollama respondeu ${response.status}: ${body.slice(0, 500)}`);
    const envelope = JSON.parse(body);
    const parsed = JSON.parse(envelope.message?.content || "{}");
    return parsed.translations;
  } finally {
    clearTimeout(timer);
  }
}

async function translateContextualChunk(chunk, options) {
  const { endpoint, model, sourceLang, targetLocale, contextTitle, timeoutMs = 300000, retries = 2 } = options;
  if (/^translategemma(?::|$)/i.test(model)) {
    const draft = await translateGemmaChunkResilient(chunk, { ...options, endpoint, model, sourceLang, targetLocale, contextTitle, timeoutMs, retries });
    let reviewDraft = draft;
    let semanticError;
    for (let reviewAttempt = 0; reviewAttempt < 2; reviewAttempt++) {
      const reviewed = preserveProtectedTermsFromDraft(chunk, draft, await translateGemmaChunkResilient(chunk, {
        ...options, endpoint, model, sourceLang, targetLocale, contextTitle, drafts: reviewDraft, timeoutMs, retries: 1,
      }), options.protectedTerms || []);
      try {
        return validateSemanticFidelity(chunk, reviewed, options.protectedTerms || []);
      } catch (error) {
        semanticError = error;
        reviewDraft = reviewed;
        logger.warn("TranslateGemma semantic review rejected", { attempt: reviewAttempt + 1, error: error.message });
      }
    }
    for (let repairAttempt = 0; repairAttempt < 4 && semanticError; repairAttempt++) {
      const failedId = /\b(cue-\d+)\b/.exec(semanticError.message)?.[1];
      const failedIndex = chunk.findIndex((item) => item.id === failedId);
      if (failedIndex < 0) break;
      logger.warn("Repairing only the subtitle line that failed semantic validation", {
        attempt: repairAttempt + 1, cueId: failedId, error: semanticError.message,
      });
      const siblingContext = [...(options.contextItems || []), ...chunk.filter((_, index) => index !== failedIndex)];
      const repaired = await translateGemmaChunkResilient([chunk[failedIndex]], {
        ...options,
        endpoint,
        model,
        sourceLang,
        targetLocale,
        contextTitle,
        contextItems: siblingContext,
        drafts: [reviewDraft[failedIndex]],
        timeoutMs,
        retries: 1,
      });
      reviewDraft[failedIndex] = preserveProtectedTermsFromDraft(
        [chunk[failedIndex]], [draft[failedIndex]], repaired, options.protectedTerms || [],
      )[0];
      try {
        return validateSemanticFidelity(chunk, reviewDraft, options.protectedTerms || []);
      } catch (error) {
        semanticError = error;
      }
    }
    throw semanticError || new Error("Falha na revisão semântica do TranslateGemma");
  }
  const system = [
    "Você é um tradutor profissional brasileiro especializado em legendagem de filmes e séries.",
    `Traduza de ${sourceLang || "inglês"} para português do Brasil natural (pt-BR).`,
    "Antes de escrever, compreenda silenciosamente a cena, a intenção e a relação entre as falas do bloco.",
    "Localize expressões idiomáticas, humor, ironia, insultos e gírias para equivalentes que um brasileiro realmente diria. Nunca traduza metáforas palavra por palavra ou referências anatômicas sem sentido.",
    "Traduza também gírias e abreviações estrangeiras; não deixe palavras inglesas no texto, salvo nomes próprios, marcas e termos realmente usados no Brasil.",
    "Mantenha continuidade, registro social, tom e intensidade dos palavrões. Não censure, não resuma, não explique, não acrescente nem remova falas.",
    "Retorne exatamente um objeto para cada id recebido, preservando os ids.",
    options.protectedTerms?.length ? `Preserve exatamente estes nomes e termos quando aparecerem: ${options.protectedTerms.join(", ")}.` : "",
  ].join(" ");
  const user = JSON.stringify({ title: contextTitle || "", lines: chunk.map(({ id, text }) => ({ id, text })) });
  const reviewSystem = [
    "Você é o revisor-chefe brasileiro de uma plataforma de streaming.",
    "Compare cada tradução preliminar com a fala original e reescreva todo calque, estrangeirismo desnecessário ou frase que não soe como diálogo natural em português do Brasil.",
    "Preserve sentido, intenção, contexto, gírias, humor, insultos e nível dos palavrões. Prefira equivalência cultural a tradução literal.",
    "Não censure, não explique, não invente informação e não altere a quantidade nem os ids das falas.",
    "Entregue somente a versão final revisada de cada texto.",
    options.protectedTerms?.length ? `Preserve exatamente estes nomes e termos quando aparecerem: ${options.protectedTerms.join(", ")}.` : "",
  ].join(" ");
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const draft = validateContextualTranslations(chunk, await requestStructuredTranslations({
        endpoint, model, system, user, count: chunk.length, timeoutMs,
      }));
      const reviewUser = JSON.stringify({
        title: contextTitle || "",
        lines: chunk.map((item, index) => ({ id: item.id, original: item.text, draft: draft[index] })),
      });
      const reviewed = validateContextualTranslations(chunk, await requestStructuredTranslations({
        endpoint, model, system: reviewSystem, user: reviewUser, count: chunk.length, timeoutMs,
      }));
      return validateSemanticFidelity(chunk, reviewed, options.protectedTerms || []);
    } catch (error) {
      lastError = error;
      logger.warn("Contextual translation block rejected", { attempt: attempt + 1, error: error.message });
    }
  }
  throw lastError || new Error("Falha no tradutor contextual");
}

async function translateContextual(texts, options) {
  if (!Array.isArray(texts)) throw new Error("texts must be an array");
  const chunks = contextualChunks(texts, options.maxChars, options.maxCues);
  const allItems = chunks.flat();
  const protectedTerms = options.protectedTerms || inferProtectedTerms(allItems);
  const output = [];
  for (const chunk of chunks) {
    const first = chunk[0].index;
    const last = chunk[chunk.length - 1].index;
    const contextRadius = Number.isInteger(options.contextCues) ? options.contextCues : 12;
    const contextItems = allItems.filter((item) => item.index >= first - contextRadius && item.index <= last + contextRadius && (item.index < first || item.index > last));
    output.push(...await translateContextualChunk(chunk, {
      ...options,
      sourceLang: chunk[0].sourceLang || options.sourceLang,
      contextItems,
      protectedTerms,
    }));
  }
  if (output.length !== texts.length) throw new Error("Tradutor contextual alterou a quantidade total de falas");
  return output;
}

async function unloadContextualModel(endpoint, model) {
  try {
    await fetchWithTimeout(`${endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
    }, Math.min(config.internalHttpTimeoutMs, 15000));
  } catch (error) {
    logger.warn("Could not unload contextual model", { error: error.message });
  }
}

module.exports = {
  containsProtectedTerm,
  contextualChunks,
  detectLanguage,
  mapTargetLocale,
  translateBatch,
  translateContextual,
  translateContextualChunk,
  translateGemmaChunk,
  translateGemmaChunkResilient,
  normalizeSourceForTranslation,
  translateText,
  unloadContextualModel,
  validateContextualTranslations,
  parseTaggedTranslations,
  looksRomanizedJapanese,
  inferProtectedTerms,
  normalizeOcrSourceText,
  validateSemanticFidelity,
  preserveProtectedTermsFromDraft,
};
