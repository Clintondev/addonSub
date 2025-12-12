const fetch = require("node-fetch");
const logger = require("../logger");
const { sanitizeUrl } = require("../utils/security");

function mapTargetLocale(locale) {
  if (!locale) return "pt";
  const base = locale.toLowerCase().split("-")[0];
  return base === "pt" ? "pt" : base;
}

async function detectLanguage(text, endpoint) {
  if (!text || text.trim().length === 0) return "und";
  try {
    const res = await fetch(`${endpoint}/detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text.slice(0, 4000) }),
    });
    if (!res.ok) {
      throw new Error(`detect status ${res.status}`);
    }
    const result = await res.json();
    if (Array.isArray(result) && result.length > 0) {
      return result[0].language || "und";
    }
  } catch (err) {
    logger.warn("Detector falhou, assumindo 'und'", {
      target: sanitizeUrl(endpoint),
      err: err.message,
    });
  }
  return "und";
}

async function translateText(text, endpoint, targetLocale, sourceLang) {
  if (!text || text.trim().length === 0) return text;
  const target = mapTargetLocale(targetLocale);
  const body = {
    q: text,
    source: sourceLang && sourceLang !== "und" ? sourceLang : "auto",
    target,
    format: "text",
  };
  const res = await fetch(`${endpoint}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`translate status ${res.status}`);
  }
  const data = await res.json();
  return data.translatedText || text;
}

async function translateBatch(texts, endpoint, targetLocale, sourceLang, maxChars = 3500) {
  if (!texts || texts.length === 0) return [];
  const target = mapTargetLocale(targetLocale);
  const batches = [];
  let current = [];
  let currentSize = 0;
  const sentinel = "|||@@@|||";

  texts.forEach((txt) => {
    const len = txt.length;
    if (currentSize + len + sentinel.length > maxChars && current.length > 0) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(txt);
    currentSize += len + sentinel.length;
  });
  if (current.length) batches.push(current);

  const output = [];
  for (const chunk of batches) {
    const payload = chunk.join(sentinel);
    try {
      const translated = await translateText(
        payload,
        endpoint,
        target,
        sourceLang
      );
      const parts = translated.split(sentinel);
      if (parts.length === chunk.length) {
        output.push(...parts);
      } else {
        // Fallback: keep originals if sizes mismatch.
        logger.warn("Mismatch ao separar batch traduzido, mantendo originais");
        output.push(...chunk);
      }
    } catch (err) {
      logger.warn("Falha ao traduzir batch, mantendo originais", {
        err: err.message,
      });
      output.push(...chunk);
    }
  }

  return output;
}

module.exports = {
  detectLanguage,
  translateText,
  mapTargetLocale,
  translateBatch,
};
