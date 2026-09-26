const crypto = require("crypto");
const fetch = require("node-fetch");
const config = require("../config");
const { applyNameAliases } = require("./nameAliases");
const logger = require("../logger");
const { sanitizeUrl } = require("../utils/security");
const { fetchWithTimeout } = require("../utils/fetchWithTimeout");
const { readJsonFile, writeJsonFileAtomic } = require("../utils/atomicJson");
const { createTranslationBudget, fitPromptSections, isTranslationControlError, watchTranslationRequest } = require("./translationBudget");

const TRANSLATION_CACHE_VERSION = 3;
const TRANSLATION_PROMPT_VERSION = 3;

function mapTargetLocale(locale) {
  const normalized = String(locale || "pt").trim().toLowerCase().replace("_", "-");
  if (["pt-br", "pb"].includes(normalized)) return "pt-BR";
  return normalized.split("-")[0];
}

function hasNonLatinLetters(value) {
  return [...String(value || "")].some((character) => /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character));
}

function nonLatinTerms(value) {
  const terms = [];
  let current = "";
  let currentGroup = null;
  for (const character of String(value || "")) {
    const group = /[\u30A0-\u30FF]/u.test(character) ? "katakana"
      : /[\u3040-\u309F]/u.test(character) ? "hiragana"
        : /\p{Script=Han}/u.test(character) ? "han"
          : /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character) ? "other" : null;
    if (group && group === currentGroup) current += character;
    else {
      if ([...current].length >= 2) terms.push(current);
      current = group ? character : "";
      currentGroup = group;
    }
  }
  if ([...current].length >= 2) terms.push(current);
  return terms;
}

function likelySameKanaName(left, right) {
  if (!/^[\u30A0-\u30FF]{3,}$/u.test(left) || !/^[\u30A0-\u30FF]{3,}$/u.test(right)) return false;
  const a = [...left];
  const b = [...right];
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) return a.filter((character, index) => character !== b[index]).length === 1;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  let offset = 0;
  for (let index = 0; index < shorter.length; index++) {
    if (shorter[index] !== longer[index + offset]) {
      if (offset) return false;
      offset = 1;
      if (shorter[index] !== longer[index + offset]) return false;
    }
  }
  return true;
}

function validateTargetScript(texts, targetLocale = config.targetLocale, cueIds = []) {
  if (!/^pt(?:-|$)/i.test(mapTargetLocale(targetLocale))) return texts;
  texts.forEach((text, index) => {
    const id = cueIds[index] || `cue-${String(index).padStart(6, "0")}`;
    if (/<\/?[a-z][^<>\r\n]{0,160}>/iu.test(String(text))) {
      throw new Error(`Tradução PT-BR contém marcação indevida em ${id}`);
    }
    if (!hasNonLatinLetters(text)) return;
    const residual = [...String(text)].filter((character) => /\p{L}/u.test(character) && !/\p{Script=Latin}/u.test(character)).join("").slice(0, 40);
    throw new Error(`Tradução PT-BR contém escrita não latina em ${id}: ${residual}`);
  });
  return texts;
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
    const item = { id: `cue-${String(index).padStart(6, "0")}`, text: String(text || "").trim(), index, startMs, endMs, sourceLang, maxTargetChars: isTimed ? entry.maxTargetChars : null };
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
  const expectedIds = new Set(chunk.map((item) => item.id));
  if (byId.size !== translations.length || translations.some((item) => !expectedIds.has(item?.id))) {
    throw new Error("Tradutor contextual retornou ids duplicados ou desconhecidos");
  }
  const output = chunk.map((item) => {
    const translated = byId.get(item.id);
    if (typeof translated !== "string" || !translated.trim()) throw new Error(`Tradução ausente para ${item.id}`);
    const cleaned = sanitizeTranslatedText(translated);
    if (!cleaned) throw new Error(`Tradução ausente para ${item.id}`);
    if (cleaned.length > Math.max(240, item.text.length * 5)) throw new Error(`Tradução anormalmente longa para ${item.id}`);
    return cleaned;
  });
  const nameParticles = new Set(["de", "da", "do", "dos", "das", "van", "von", "del", "di", "la", "le", "of", "and", "the"]);
  const suspicious = output.filter((text, index) => {
    const source = chunk[index].text;
    const words = source.match(/\p{L}+/gu) || [];
    const dialogue = words.some((word) => word.length > 1 && word === word.toLocaleLowerCase() && !nameParticles.has(word))
      || /\b(?:is|are|was|were|have|has|don't|can't|should|would|must)\b/i.test(source);
    return dialogue && source.length >= 14 && text.toLocaleLowerCase() === source.toLocaleLowerCase();
  });
  if (suspicious.length && suspicious.length >= Math.max(1, Math.ceil(chunk.length * 0.15))) throw new Error("Tradutor contextual deixou falas demais sem traduzir");
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
  const known = words.filter((word) => ROMAJI_WORDS.has(word));
  return words.length >= 4 && new Set(known).size >= 3 && known.length / words.length >= 0.3 && words.some((word) => ["no", "ga", "wa", "wo", "ni", "to"].includes(word));
}

function containsProtectedTerm(value, term) {
  const escaped = String(term || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(String(value || ""));
}

function protectedTermBindings(terms = []) {
  // Repeated capitalized words are only translation hints. Protecting them
  // mechanically split phrases such as "Dragon Slayers" and left ordinary
  // words like "Majesty" and "Code" in English in the PT-BR output.
  return [...new Set(terms.map((term) => String(term || "").trim())
    .filter((term) => STRICT_PROTECTED_TERMS.has(term.toLocaleLowerCase())))]
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

const PORTUGUESE_CARDINALS = new Map([
  [1, "um|uma"], [2, "dois|duas"], [3, "tr[eê]s"], [4, "quatro"], [5, "cinco"],
  [6, "seis"], [7, "sete"], [8, "oito"], [9, "nove"], [10, "dez"],
]);
const PORTUGUESE_FRACTIONS = new Map([
  [2, "mei[oa]|metade"], [3, "ter[cç]o"], [4, "quarto"], [5, "quinto"],
  [6, "sexto"], [7, "s[eé]timo"], [8, "oitavo"], [9, "nono"], [10, "d[eé]cimo"],
]);

function preservesJapaneseFractions(source, translation) {
  const fractions = [...String(source || "").matchAll(/(\d+)\s*分の\s*(\d+)/g)];
  for (const match of fractions) {
    const denominator = Number(match[1]);
    const numerator = Number(match[2]);
    const numeric = new RegExp(`\\b${numerator}\\s*(?:/|de)\\s*${denominator}\\b`);
    const cardinal = PORTUGUESE_CARDINALS.get(numerator);
    const fraction = PORTUGUESE_FRACTIONS.get(denominator);
    const written = cardinal && fraction
      ? new RegExp(`\\b(?:${cardinal})\\s+(?:${fraction})s?\\b`, "iu")
      : null;
    if (!numeric.test(translation) && !(written && written.test(translation))) return false;
  }
  return true;
}

function validateSemanticFidelity(chunk, translations, protectedTerms = [], targetLocale = config.targetLocale, seriesTerminology = []) {
  validateTargetScript(translations, targetLocale, chunk.map((item) => item.id));
  translations.forEach((translation, index) => {
    if (/[|\uFFFD]/.test(translation)) throw new Error(`Tradução contém resíduo de OCR para ${chunk[index].id}`);
    if (/\b(?:da|do)\s+mim\b/iu.test(translation)) {
      throw new Error(`Tradução contém regência inválida em ${chunk[index].id}: use de mim`);
    }
    if (/^en(?:-|$)/i.test(String(chunk[index].sourceLang || ""))) {
      const source = chunk[index].text;
      for (const rule of seriesTerminology) {
        if (new RegExp(rule.sourcePattern, "iu").test(source)
          && (!new RegExp(rule.targetPattern, "iu").test(translation)
            || (rule.forbiddenTargetPattern && new RegExp(rule.forbiddenTargetPattern, "iu").test(translation)))) {
          throw new Error(`Tradução alterou o termo ${rule.label} em ${chunk[index].id}`);
        }
      }
    }
    if (!preservesJapaneseFractions(chunk[index].text, translation)) {
      throw new Error(`Tradução alterou uma fração em ${chunk[index].id}`);
    }
    // Japanese writes 1/3 as 3分の1. Once the fraction as a whole has been
    // verified, do not incorrectly require both Arabic digits in natural
    // Portuguese ("um terço"). Other numbers remain strictly protected.
    const sourceWithoutJapaneseFractions = chunk[index].text.replace(/\d+\s*分の\s*\d+/g, "");
    const sourceNumbers = sourceWithoutJapaneseFractions.match(/\b\d+(?:[.,]\d+)?\b/g) || [];
    const normalizedTranslation = translation.replace(/,(?=\d)/g, ".");
    for (const number of sourceNumbers) {
      const normalizedNumber = number.replace(",", ".");
      const numeral = new RegExp(`(?<!\\d)${normalizedNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`);
      const cardinal = Number.isInteger(Number(number)) ? PORTUGUESE_CARDINALS.get(Number(number)) : null;
      const writtenNumber = cardinal && new RegExp(`\\b(?:${cardinal})\\b`, "iu");
      if (!numeral.test(normalizedTranslation) && !(writtenNumber && writtenNumber.test(translation))) {
        throw new Error(`Tradução alterou o número ${number} em ${chunk[index].id}`);
      }
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
    const sourceTerms = protectedTerms.filter((term) => STRICT_PROTECTED_TERMS.has(String(term).toLocaleLowerCase())
      && containsProtectedTerm(chunk[index].text, term));
    const droppedTerm = sourceTerms.some((term) => containsProtectedTerm(draft[index], term) && !containsProtectedTerm(translation, term));
    // A draft with source-script text must never replace a clean review.
    return droppedTerm && !hasNonLatinLetters(draft[index]) ? draft[index] : translation;
  });
}

function applySeriesDialogueCorrections(chunk, translations, corrections = []) {
  if (!corrections.length) return translations;
  const bySource = new Map(corrections.map(({ source, target }) => [String(source).replace(/\s+/g, " ").trim().toLocaleLowerCase(), target]));
  return translations.map((translation, index) => bySource.get(String(chunk[index]?.text || "").replace(/\s+/g, " ").trim().toLocaleLowerCase()) || translation);
}

function inferProtectedTerms(items, { includeSeriesTerms = true } = {}) {
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
  return [...terms].filter((term) => includeSeriesTerms || !STRICT_PROTECTED_TERMS.has(term.toLocaleLowerCase())).slice(0, 80);
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
    .replace(/\bhell\s+if\s+i\s+know\b[.!?]*/gi, "I have absolutely no idea!")
    .replace(/\b(?:are\s+)?you\s+talking\s+out\s+(?:of\s+)?the\s+side\s+of\s+your\s+neck\??/gi, "Are you talking nonsense and being disrespectful?")
    .replace(/\bdo\s+my\s+time\b/gi, "serve my prison sentence")
    .replace(/\bserve\s+it\s+for\s+you\b/gi, "serve your prison sentence for you");
}

function sanitizeTranslatedText(value) {
  return String(value || "")
    .replace(/<\/?(?:i|b|u|font|span|pt|previous|code|context|source|draft)(?:\s[^>\r\n]*)?>/gi, "")
    // Do not let a malformed, unclosed model tag consume following subtitle
    // lines while cleaning output (for example: </sub id="cue-000209">).
    .replace(/<\/?sub\b[^\r\n>]*>?/gi, "")
    // Model responses occasionally invent an XML/HTML element around a
    // word while translating a larger block. Subtitle output is plain text,
    // so no element name is meaningful here. Strip the complete tag while
    // preserving its visible inner text; validateTargetScript remains the
    // final guard for cached or externally supplied text.
    .replace(/<\/?[a-z][^<>\r\n]{0,160}>/giu, "")
    .replace(/```(?:xml)?/gi, "")
    .trim();
}

function parseTaggedTranslations(chunk, output) {
  const found = new Map();
  const expectedIds = new Set(chunk.map((item) => item.id));
  // TranslateGemma occasionally preserves every opening marker but omits the
  // closing tags. Treat the next immutable marker as the safe boundary while
  // still accepting well-formed XML.
  const pattern = /<sub\s+id=["']([^"']+)["']\s*>([\s\S]*?)(?=<sub\s+id=["']|<\/sub>|```|$)/gi;
  let match;
  while ((match = pattern.exec(String(output || "")))) {
    if (!expectedIds.has(match[1]) || found.has(match[1])) throw new Error(`Id duplicado ou desconhecido: ${match[1]}`);
    found.set(match[1], sanitizeTranslatedText(xmlUnescape(match[2])));
  }
  return validateContextualTranslations(chunk, chunk.map((item) => ({ id: item.id, text: found.get(item.id) })));
}

async function translateGemmaChunk(chunk, { endpoint, model, gpuLayers = config.contextualTranslatorGpuLayers, sourceLang, targetLocale, contextTitle, contextItems = [], priorTranslations = [], protectedTerms = [], nameAliases = {}, seriesTerminology = [], drafts = null, repairReason = null, timeoutMs = 300000, retries = 0, budget, episodeBudget, assertActive, telemetry = [], contextTokens = config.contextualTranslatorContextTokens }) {
  const sourceName = String(sourceLang || "en").toLowerCase().startsWith("en")
    ? "English"
    : String(sourceLang || "").toLowerCase() === "ja-latn" ? "romanized Japanese"
      : String(sourceLang || "").toLowerCase().startsWith("ja") ? "Japanese" : `source language ${sourceLang || "auto"}`;
  const termBindings = protectedTermBindings(protectedTerms);
  const activeSeriesTerminology = seriesTerminology.filter((rule) => chunk.some((item) => new RegExp(rule.sourcePattern, "iu").test(item.text)));
  // The source is immutable. Idiom and terminology hints never replace it.
  const taggedText = chunk.map((item) => `<sub id="${item.id}">${xmlEscape(protectTerms(item.text, termBindings))}</sub>`).join("\n");
  const firstTime = chunk[0]?.startMs;
  const lastTime = chunk[chunk.length - 1]?.endMs;
  const distance = (item) => Number.isFinite(firstTime) && Number.isFinite(lastTime) && Number.isFinite(item.startMs)
    ? Math.max(0, firstTime - (item.endMs ?? item.startMs), item.startMs - lastTime) : Math.min(...chunk.map((target) => Math.abs((item.index ?? target.index) - target.index)));
  const contextSections = [...contextItems].sort((left, right) => distance(left) - distance(right))
    .map((item) => `<context${Number.isFinite(item.startMs) ? ` start_ms="${item.startMs}"` : ""}>${xmlEscape(protectTerms(item.text, termBindings))}</context>`);
  const priorSections = priorTranslations.map(({ source, target }) => `<previous><source>${xmlEscape(String(source).slice(0, 140))}</source><pt>${xmlEscape(String(target).slice(0, 140))}</pt></previous>`);
  const draftText = drafts ? chunk.map((item, index) => `<draft id="${item.id}">${xmlEscape(protectTerms(drafts[index], termBindings))}</draft>`).join("\n") : "";
  const semanticConstraints = [];
  chunk.forEach((item) => {
    if (Number.isFinite(item.maxTargetChars)) semanticConstraints.push(`${item.id}: fit at most ${item.maxTargetChars} characters for reading time. Condense naturally without losing meaning, negation, identities or numbers.`);
    if (/\bmy\b/i.test(item.text)) semanticConstraints.push(`${item.id}: English "my" is first-person possession; Portuguese must explicitly preserve meu/minha/meus/minhas, never seu/sua.`);
    if (/\bfor you\b/i.test(item.text)) semanticConstraints.push(`${item.id}: preserve the agent and the beneficiary "for you" explicitly as por você/pra você; do not replace it with merely helping you.`);
    if (/^en(?:-|$)/i.test(String(item.sourceLang || sourceLang || "")) && /\b(?:he|him|his|she|her|hers)\b/i.test(item.text)) {
      semanticConstraints.push(`${item.id}: preserve each person's identity and gender from the English original; he/him/his is masculine, she/her/hers is feminine. Do not switch ele/ela or dele/dela.`);
    }
  });
  const required = [
    `You are a professional ${sourceName} (${sourceLang || "en"}) to Brazilian Portuguese (${mapTargetLocale(targetLocale)}) subtitle translator and bilingual fidelity reviewer. ${drafts ? "Review the draft against the original and rewrite every inaccurate, literal, inconsistent, or contextually wrong line." : "Translate the original dialogue accurately."} Preserve the exact meaning, grammatical person, subject, agent, tense, modality, negation, numbers, and named entities. Never replace a place, character, organization, or fictional term with a contextually plausible alternative. Write names originally in a non-Latin script using their established Latin-script spelling in Brazilian Portuguese; preserve the identity, not the source characters. Use the same spelling for a name throughout the episode. Every output line must use Latin-script letters only, including names and place names. Use the context lines only to understand the scene; never output or translate <context> elements. Preserve register, humor, insults, and profanity. Translate idioms by meaning instead of word-for-word. Translate only the text inside each <sub> element. Return exactly one non-empty <sub> element for every input id, in the same order. Never merge, omit, renumber, or shift fragments. Produce only translated <sub> XML without explanations.`,
    draftText ? `Draft to review:\n${draftText}` : "",
    semanticConstraints.length ? `Mandatory semantic constraints:\n${semanticConstraints.join("\n")}` : "",
    termBindings.length ? `Copy every immutable ZXQKEEP name token byte-for-byte; it will be restored after translation.` : "",
    `Original ${sourceName} lines to translate:\n${taggedText}`,
  ];
  const optional = [
    repairReason ? `Correct this rejected translation: ${String(repairReason).slice(0, 300)}` : "",
    activeSeriesTerminology.length ? `Established terminology for this series:\n${activeSeriesTerminology.map((rule) => rule.guidance).join("\n")}` : "",
    Object.keys(nameAliases).length ? `Confirmed name spellings (use only for the corresponding entity): ${JSON.stringify(nameAliases)}` : "",
    contextTitle ? `Context title: ${String(contextTitle).slice(0, 1000)}` : "",
    ...priorSections,
    ...contextSections,
  ];
  const outputTokens = Math.min(2048, Math.max(320, chunk.length * 80));
  const prompt = fitPromptSections(required, optional, contextTokens, outputTokens);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    assertActive?.();
    budget?.take();
    episodeBudget?.take();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, budget?.remainingMs() ?? timeoutMs, episodeBudget?.remainingMs() ?? timeoutMs));
    const guard = watchTranslationRequest(controller, { assertActive, budget, episodeBudget });
    const requestMetric = { model, review: Boolean(drafts), startedAt: Date.now(), success: false };
    telemetry.push(requestMetric);
    try {
      const response = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: "10m",
          options: {
            temperature: 0,
            num_ctx: contextTokens,
            num_gpu: gpuLayers,
            num_predict: outputTokens,
          },
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Ollama respondeu ${response.status}: ${body.slice(0, 500)}`);
      const envelope = JSON.parse(body);
      Object.assign(requestMetric, { success: true, promptTokens: envelope.prompt_eval_count ?? null,
        outputTokens: envelope.eval_count ?? null, durationNs: envelope.total_duration ?? null });
      const content = envelope.message?.content || "";
      try {
        return parseTaggedTranslations(chunk, content).map((translation) => applyNameAliases(restoreTerms(translation, termBindings), nameAliases));
      } catch (error) {
        throw new Error(`${error.message}; formato recebido: ${content.slice(0, 800).replace(/\s+/g, " ")}`);
      }
    } catch (error) {
      error = guard.error() || error;
      lastError = error;
      requestMetric.success = false;
      requestMetric.error = error.message.slice(0, 500);
      logger.warn("TranslateGemma block rejected", { attempt: attempt + 1, error: error.message });
      if (isContextualModelUnavailable(error) || isTranslationControlError(error)) throw error;
    } finally {
      clearTimeout(timer);
      guard.stop();
      requestMetric.elapsedMs = Date.now() - requestMetric.startedAt;
    }
  }
  throw lastError || new Error("Falha no TranslateGemma");
}

function isContextualModelUnavailable(error) {
  if (error?.code === "GPU_RESOURCE_BUSY") return true;
  const message = String(error?.message || error || "");
  return /(?:llama-server startup failed|cudaMalloc failed|out of memory|unable to allocate CUDA\d* buffer|model (?:cannot|could not) be allocated|insufficient (?:GPU )?memory)/i.test(message);
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
  options = { ...options, budget: options.budget || createTranslationBudget({ maxCalls: config.translationBlockMaxCalls, timeoutMs: config.translationBlockTimeoutMs }) };
  options.assertActive?.();
  const exactCorrections = applySeriesDialogueCorrections(
    chunk, chunk.map(() => ""), options.seriesCorrections || [],
  );
  if (exactCorrections.every((translation) => String(translation || "").trim())) return exactCorrections;
  try {
    // One deterministic attempt per node, under the shared block budget.
    return await translateGemmaChunk(chunk, { ...options, retries: 0 });
  } catch (error) {
    // Dividing the subtitle block cannot fix a model that failed to load.
    // Return control to translateContextual so it can switch models at once.
    if (isContextualModelUnavailable(error) || isTranslationControlError(error)) throw error;
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

async function requestStructuredTranslations({ endpoint, model, system, user, count, timeoutMs, budget, episodeBudget, assertActive, telemetry = [], gpuLayers = config.contextualTranslatorGpuLayers }) {
  const outputTokens = Math.min(2048, Math.max(320, count * 80));
  const content = fitPromptSections([system, user], [], config.contextualTranslatorContextTokens, outputTokens);
  assertActive?.();
  budget?.take();
  episodeBudget?.take();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, budget?.remainingMs() ?? timeoutMs, episodeBudget?.remainingMs() ?? timeoutMs));
  const guard = watchTranslationRequest(controller, { assertActive, budget, episodeBudget });
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
        options: { temperature: 0, num_ctx: config.contextualTranslatorContextTokens, num_gpu: gpuLayers, num_predict: outputTokens },
        messages: [{ role: "user", content }],
      }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Ollama respondeu ${response.status}: ${body.slice(0, 500)}`);
    const envelope = JSON.parse(body);
    telemetry.push({ model, promptTokens: envelope.prompt_eval_count ?? null, outputTokens: envelope.eval_count ?? null, durationNs: envelope.total_duration ?? null });
    const parsed = JSON.parse(envelope.message?.content || "{}");
    return parsed.translations;
  } catch (error) {
    throw guard.error() || error;
  } finally {
    clearTimeout(timer);
    guard.stop();
  }
}

async function translateContextualChunk(chunk, options) {
  options = { ...options, budget: options.budget || createTranslationBudget({ maxCalls: config.translationBlockMaxCalls, timeoutMs: config.translationBlockTimeoutMs }) };
  const { endpoint, model, sourceLang, targetLocale, contextTitle, timeoutMs = 300000, retries = 0 } = options;
  if (/^translategemma(?::|$)/i.test(model)) {
    const exactCorrections = applySeriesDialogueCorrections(
      chunk, chunk.map(() => ""), options.seriesCorrections || [],
    );
    if (exactCorrections.every((translation) => String(translation || "").trim())) {
      return validateSemanticFidelity(
        chunk, exactCorrections, options.protectedTerms || [], targetLocale, options.seriesTerminology || [],
      );
    }
    const draft = await translateGemmaChunkResilient(chunk, { ...options, endpoint, model, sourceLang, targetLocale, contextTitle, timeoutMs, retries });
    let reviewDraft = draft;
    let semanticError;
    for (let reviewAttempt = 0; reviewAttempt < 1; reviewAttempt++) {
      const reviewed = preserveProtectedTermsFromDraft(chunk, draft, await translateGemmaChunkResilient(chunk, {
        ...options, endpoint, model, sourceLang, targetLocale, contextTitle,
        drafts: reviewDraft.some(hasNonLatinLetters) ? null : reviewDraft,
        repairReason: semanticError?.message, timeoutMs, retries: 1,
      }), options.protectedTerms || []);
      try {
        const corrected = applySeriesDialogueCorrections(chunk, reviewed, options.seriesCorrections || []);
        return validateSemanticFidelity(chunk, corrected, options.protectedTerms || [], targetLocale, options.seriesTerminology || []);
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
      // A human-reviewed, series-scoped correction is authoritative. Apply
      // it before asking the model to repair one line; small models can emit
      // an empty response when the rejected line contains an immutable name.
      const deterministicRepair = applySeriesDialogueCorrections(
        [chunk[failedIndex]], [reviewDraft[failedIndex]], options.seriesCorrections || [],
      )[0];
      if (deterministicRepair !== reviewDraft[failedIndex]) {
        reviewDraft[failedIndex] = deterministicRepair;
        try {
          const corrected = applySeriesDialogueCorrections(chunk, reviewDraft, options.seriesCorrections || []);
          return validateSemanticFidelity(chunk, corrected, options.protectedTerms || [], targetLocale, options.seriesTerminology || []);
        } catch (error) {
          semanticError = error;
          continue;
        }
      }
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
        drafts: hasNonLatinLetters(reviewDraft[failedIndex]) ? null : [reviewDraft[failedIndex]],
        repairReason: semanticError.message,
        timeoutMs,
        retries: 1,
      });
      reviewDraft[failedIndex] = preserveProtectedTermsFromDraft(
        [chunk[failedIndex]], [draft[failedIndex]], repaired, options.protectedTerms || [],
      )[0];
      try {
        const corrected = applySeriesDialogueCorrections(chunk, reviewDraft, options.seriesCorrections || []);
        return validateSemanticFidelity(chunk, corrected, options.protectedTerms || [], targetLocale, options.seriesTerminology || []);
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
        ...options, endpoint, model, system, user, count: chunk.length, timeoutMs,
      })).map((translation) => applyNameAliases(translation, options.nameAliases));
      const reviewUser = JSON.stringify({
        title: contextTitle || "",
        lines: chunk.map((item, index) => ({ id: item.id, original: item.text, draft: draft[index] })),
      });
      const reviewed = validateContextualTranslations(chunk, await requestStructuredTranslations({
        ...options, endpoint, model, system: reviewSystem, user: reviewUser, count: chunk.length, timeoutMs,
      })).map((translation) => applyNameAliases(translation, options.nameAliases));
      return validateSemanticFidelity(chunk, reviewed, options.protectedTerms || [], targetLocale, options.seriesTerminology || []);
    } catch (error) {
      if (isTranslationControlError(error) || isContextualModelUnavailable(error)) throw error;
      if (error.code === "TRANSLATION_CONTEXT_LIMIT" && chunk.length > 1) {
        const split = resilientSplitIndex(chunk);
        return [...await translateContextualChunk(chunk.slice(0, split), options), ...await translateContextualChunk(chunk.slice(split), options)];
      }
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
  const episodeBudget = options.episodeBudget || createTranslationBudget({ maxCalls: options.maxCalls ?? config.translationEpisodeMaxCalls, timeoutMs: options.totalTimeoutMs ?? config.translationEpisodeTimeoutMs });
  const callsAtStart = episodeBudget.stats().calls;
  const telemetry = [];
  const blocks = [];
  let cache = null;
  if (options.cachePath) {
    try {
      cache = readJsonFile(options.cachePath, {
        fallback: () => ({ version: TRANSLATION_CACHE_VERSION, entries: {} }),
        validate: (value) => value?.version === TRANSLATION_CACHE_VERSION && value.entries && typeof value.entries === "object" && !Array.isArray(value.entries),
      });
    } catch (error) {
      logger.warn("Translation checkpoint could not be read; starting fresh", { error: error.message });
      cache = { version: TRANSLATION_CACHE_VERSION, entries: {} };
    }
  }
  const output = [];
  let activeModel = options.model;
  let activeGpuLayers = options.gpuLayers;
  let fallbackReason = null;
  for (const chunk of chunks) {
    options.assertActive?.();
    episodeBudget.remainingMs();
    const first = chunk[0].index;
    const last = chunk[chunk.length - 1].index;
    const contextRadius = Number.isInteger(options.contextCues) ? options.contextCues : 12;
    const contextItems = [...allItems.slice(Math.max(0, first - contextRadius), first), ...allItems.slice(last + 1, last + 1 + contextRadius), ...(options.contextItems || []).slice(0, contextRadius * 2)];
    const recurringTerms = [...new Set(chunk.flatMap((item) => nonLatinTerms(item.text)))];
    const priorTranslations = recurringTerms.flatMap((term) => {
      const earlier = allItems.slice(0, first).reverse().filter((item) => output[item.index]);
      const previous = earlier.find((item) => item.text.includes(term))
        || earlier.find((item) => nonLatinTerms(item.text).some((candidate) => likelySameKanaName(term, candidate)));
      return previous ? [{ source: previous.text, target: output[previous.index] }] : [];
    }).slice(0, 8);
    const chunkOptions = {
      ...options,
      model: activeModel,
      gpuLayers: activeGpuLayers,
      sourceLang: chunk[0].sourceLang || options.sourceLang,
      contextItems,
      priorTranslations,
      protectedTerms,
      episodeBudget,
      budget: createTranslationBudget({ maxCalls: options.blockMaxCalls ?? config.translationBlockMaxCalls, timeoutMs: options.blockTimeoutMs ?? config.translationBlockTimeoutMs }),
      telemetry,
      drafts: options.drafts ? options.drafts.slice(first, last + 1) : null,
    };
    const cacheKey = (model) => crypto.createHash("sha256").update(JSON.stringify({
      version: TRANSLATION_CACHE_VERSION,
      chunk: chunk.map((item) => [item.id, item.text, item.startMs, item.endMs, item.sourceLang]),
      context: contextItems.map((item) => [item.index, item.text]),
      priorTranslations,
      model,
      sourceLang: chunkOptions.sourceLang,
      targetLocale: options.targetLocale,
      protectedTerms,
      nameAliases: options.nameAliases,
      contextTitle: options.contextTitle,
      promptVersion: TRANSLATION_PROMPT_VERSION,
      seriesTerminology: options.seriesTerminology,
      seriesCorrections: options.seriesCorrections,
      maxTargetChars: chunk.map((item) => item.maxTargetChars),
    })).digest("hex");
    const reusableModels = [...new Set([options.model, options.fallbackModel, ...(options.cacheModels || [])].filter(Boolean))];
    let translated;
    let reusedModel = null;
    for (const candidateModel of reusableModels) {
      try {
        const checkpoint = options.retranslate ? null : cache?.entries[cacheKey(candidateModel)]?.translations;
        if (!Array.isArray(checkpoint)) continue;
        translated = validateContextualTranslations(chunk, checkpoint.map((text, index) => ({ id: chunk[index].id, text })));
        translated = applySeriesDialogueCorrections(chunk, translated, options.seriesCorrections || []);
        validateSemanticFidelity(chunk, translated, protectedTerms, options.targetLocale, options.seriesTerminology || []);
        reusedModel = candidateModel;
        break;
      } catch (_) {
        translated = undefined;
      }
    }
    if (translated) {
      logger.info("Reusing verified translation block", { firstCue: first, cues: chunk.length, cachedModel: reusedModel });
    } else {
      let usedModel = activeModel;
      try {
        translated = options.runWithModel
          ? await options.runWithModel(() => translateContextualChunk(chunk, chunkOptions), { model: activeModel, gpuLayers: activeGpuLayers })
          : await translateContextualChunk(chunk, chunkOptions);
      } catch (primaryError) {
        if (!isContextualModelUnavailable(primaryError) || !options.fallbackModel || activeModel === options.fallbackModel) throw primaryError;
        logger.warn("Primary contextual model failed; switching remaining uncached blocks to the fallback model", {
          primaryModel: activeModel,
          fallbackModel: options.fallbackModel,
          firstCue: first,
          error: primaryError.message,
        });
        await (options.releaseModel ? options.releaseModel() : unloadContextualModel(options.endpoint, activeModel));
        activeModel = options.fallbackModel;
        fallbackReason = primaryError.message.slice(0, 500);
        activeGpuLayers = options.fallbackGpuLayers;
        usedModel = activeModel;
        const fallbackOptions = {
          ...chunkOptions,
          model: activeModel,
          gpuLayers: activeGpuLayers,
        };
        translated = options.runWithModel
          ? await options.runWithModel(() => translateContextualChunk(chunk, fallbackOptions), { model: activeModel, gpuLayers: activeGpuLayers })
          : await translateContextualChunk(chunk, fallbackOptions);
      }
      translated = applySeriesDialogueCorrections(chunk, translated, options.seriesCorrections || []);
      blocks.push({ firstCue: first, cues: chunk.length, model: usedModel, fallbackReason: usedModel === options.fallbackModel ? fallbackReason : null, cached: false, ...chunkOptions.budget.stats() });
      if (cache) {
        cache.entries[cacheKey(usedModel)] = { translations: translated, at: new Date().toISOString(), model: usedModel };
        const keys = Object.keys(cache.entries);
        for (const stale of keys.slice(0, Math.max(0, keys.length - Math.max(256, chunks.length * 2)))) delete cache.entries[stale];
        try { writeJsonFileAtomic(options.cachePath, cache); }
        catch (error) { logger.warn("Translation checkpoint could not be saved", { error: error.message }); }
      }
    }
    if (reusedModel) blocks.push({ firstCue: first, cues: chunk.length, model: reusedModel, cached: true, calls: 0 });
    options.assertActive?.();
    await options.onBlockComplete?.(blocks[blocks.length - 1]);
    output.push(...translated);
  }
  if (output.length !== texts.length) throw new Error("Tradutor contextual alterou a quantidade total de falas");
  const metrics = { ...episodeBudget.stats(), episodeCalls: episodeBudget.stats().calls, calls: episodeBudget.stats().calls - callsAtStart,
    promptTokens: telemetry.reduce((sum, request) => sum + (request.promptTokens || 0), 0),
    outputTokens: telemetry.reduce((sum, request) => sum + (request.outputTokens || 0), 0), requests: telemetry.slice(-32), blocks };
  logger.info("Contextual translation completed", { calls: metrics.calls, elapsedMs: metrics.elapsedMs, cachedBlocks: blocks.filter((block) => block.cached).length, models: [...new Set(blocks.map((block) => block.model))] });
  return options.returnDetails ? { texts: output, blocks, metrics } : output;
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
  validateTargetScript,
  preserveProtectedTermsFromDraft,
  applySeriesDialogueCorrections,
};
