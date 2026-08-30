const fetch = require("node-fetch");
const logger = require("../logger");
const { sanitizeUrl } = require("../utils/security");

function mapTargetLocale(locale) {
  const normalized = String(locale || "pt").trim().toLowerCase().replace("_", "-");
  if (["pt-br", "pb"].includes(normalized)) return "pt-BR";
  return normalized.split("-")[0];
}

async function detectLanguage(text, endpoint) {
  if (!text || !text.trim()) return "und";
  try {
    const res = await fetch(`${endpoint}/detect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: text.slice(0, 4000) }) });
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
  const response = await fetch(`${endpoint}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, source: sourceLang && sourceLang !== "und" ? sourceLang : "auto", target: mapTargetLocale(targetLocale), format: "text" }),
  });
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
    const item = { id: `cue-${String(index).padStart(6, "0")}`, text: String(text || "").trim(), index, startMs, endMs };
    const itemChars = item.text.length + 32;
    const sceneBreak = startMs !== null && previousEndMs !== null && startMs - previousEndMs >= 8000;
    if (chunk.length && (sceneBreak || chunk.length >= maxCues || chars + itemChars > maxChars)) {
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

async function translateGemmaChunk(chunk, { endpoint, model, sourceLang, targetLocale, contextTitle, timeoutMs = 300000, retries = 2 }) {
  const sourceName = String(sourceLang || "en").toLowerCase().startsWith("en") ? "English" : `source language ${sourceLang || "auto"}`;
  const taggedText = chunk.map((item) => `<sub id="${item.id}">${xmlEscape(normalizeSourceForTranslation(item.text))}</sub>`).join("\n");
  const semanticConstraints = [];
  chunk.forEach((item) => {
    if (/\bmy\b/i.test(item.text)) semanticConstraints.push(`${item.id}: English "my" is first-person possession; Portuguese must explicitly preserve meu/minha/meus/minhas, never seu/sua.`);
    if (/\bfor you\b/i.test(item.text)) semanticConstraints.push(`${item.id}: preserve the agent and the beneficiary "for you" explicitly as por você/pra você; do not replace it with merely helping you.`);
  });
  const prompt = [
    `You are a professional ${sourceName} (${sourceLang || "en"}) to Brazilian Portuguese (${mapTargetLocale(targetLocale)}) translator. Your goal is to accurately convey the meaning and nuances of the original ${sourceName} subtitle dialogue while adhering to Brazilian Portuguese grammar, vocabulary, natural speech, slang, and cultural sensitivities. Preserve the exact grammatical person, subject, agent, tense, modality, and negation: never turn a first-person statement into a command or change who performs an action. Use surrounding lines to resolve omitted pronouns and keep repeated concepts consistent throughout the scene. Preserve the register, humor, insults, and profanity. Never censor, soften, euphemize, or put offensive language in quotation marks. Translate idioms by meaning instead of word-for-word. Translate only the text inside each <sub> element. Preserve every XML tag and id exactly. Produce only the translated XML, without explanations or commentary. Please translate the following ${sourceName} subtitle dialogue into Brazilian Portuguese:`,
    semanticConstraints.length ? `Mandatory semantic constraints:\n${semanticConstraints.join("\n")}` : "",
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
        return parseTaggedTranslations(chunk, content);
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

async function translateContextualChunk(chunk, { endpoint, model, sourceLang, targetLocale, contextTitle, timeoutMs = 300000, retries = 2 }) {
  if (/^translategemma(?::|$)/i.test(model)) {
    return translateGemmaChunk(chunk, { endpoint, model, sourceLang, targetLocale, contextTitle, timeoutMs, retries });
  }
  const system = [
    "Você é um tradutor profissional brasileiro especializado em legendagem de filmes e séries.",
    `Traduza de ${sourceLang || "inglês"} para português do Brasil natural (pt-BR).`,
    "Antes de escrever, compreenda silenciosamente a cena, a intenção e a relação entre as falas do bloco.",
    "Localize expressões idiomáticas, humor, ironia, insultos e gírias para equivalentes que um brasileiro realmente diria. Nunca traduza metáforas palavra por palavra ou referências anatômicas sem sentido.",
    "Traduza também gírias e abreviações estrangeiras; não deixe palavras inglesas no texto, salvo nomes próprios, marcas e termos realmente usados no Brasil.",
    "Mantenha continuidade, registro social, tom e intensidade dos palavrões. Não censure, não resuma, não explique, não acrescente nem remova falas.",
    "Retorne exatamente um objeto para cada id recebido, preservando os ids.",
  ].join(" ");
  const user = JSON.stringify({ title: contextTitle || "", lines: chunk.map(({ id, text }) => ({ id, text })) });
  const reviewSystem = [
    "Você é o revisor-chefe brasileiro de uma plataforma de streaming.",
    "Compare cada tradução preliminar com a fala original e reescreva todo calque, estrangeirismo desnecessário ou frase que não soe como diálogo natural em português do Brasil.",
    "Preserve sentido, intenção, contexto, gírias, humor, insultos e nível dos palavrões. Prefira equivalência cultural a tradução literal.",
    "Não censure, não explique, não invente informação e não altere a quantidade nem os ids das falas.",
    "Entregue somente a versão final revisada de cada texto.",
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
      return validateContextualTranslations(chunk, await requestStructuredTranslations({
        endpoint, model, system: reviewSystem, user: reviewUser, count: chunk.length, timeoutMs,
      }));
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
  const output = [];
  for (const chunk of chunks) output.push(...await translateContextualChunk(chunk, options));
  if (output.length !== texts.length) throw new Error("Tradutor contextual alterou a quantidade total de falas");
  return output;
}

async function unloadContextualModel(endpoint, model) {
  try {
    await fetch(`${endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
  } catch (error) {
    logger.warn("Could not unload contextual model", { error: error.message });
  }
}

module.exports = {
  contextualChunks,
  detectLanguage,
  mapTargetLocale,
  translateBatch,
  translateContextual,
  translateContextualChunk,
  translateGemmaChunk,
  normalizeSourceForTranslation,
  translateText,
  unloadContextualModel,
  validateContextualTranslations,
  parseTaggedTranslations,
};
