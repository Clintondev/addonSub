const fetch = require("node-fetch");
const config = require("../config");
const logger = require("../logger");
const { parseVideoId } = require("./videoId");
const metadataCache = new Map();

async function enrichContentLanguageMetadata(source) {
  if (!source || source.originalLanguage || source.original_language || source.country) return source;
  let parsed;
  try { parsed = parseVideoId(source.type, source.videoId); }
  catch (_) { return source; }
  const key = `${source.type}:${parsed.imdbId}`;
  const cached = metadataCache.get(key);
  if (cached && cached.expires > Date.now()) return { ...source, ...cached.fields };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  try {
    const response = await fetch(`${config.prefetch.cinemetaUrl}/meta/${encodeURIComponent(source.type)}/${encodeURIComponent(parsed.imdbId)}.json`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "stremio-pt-auto/1.0" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const meta = (await response.json())?.meta || {};
    const fields = {
      country: typeof meta.country === "string" ? meta.country : null,
      originalLanguage: meta.originalLanguage || meta.original_language || null,
      contentLanguageMetadataSource: "cinemeta",
    };
    metadataCache.set(key, { fields, expires: Date.now() + 6 * 60 * 60 * 1000 });
    if (metadataCache.size > 500) metadataCache.delete(metadataCache.keys().next().value);
    return { ...source, ...fields };
  } catch (error) {
    logger.warn("Content language metadata unavailable", { sourceId: source.sourceId, error: error.message });
    metadataCache.set(key, { fields: {}, expires: Date.now() + 60000 });
    return source;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { enrichContentLanguageMetadata };
