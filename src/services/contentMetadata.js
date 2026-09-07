const fetch = require("node-fetch");
const config = require("../config");
const logger = require("../logger");
const { parseVideoId } = require("./videoId");

async function enrichContentLanguageMetadata(source) {
  if (!source || source.originalLanguage || source.original_language || source.country) return source;
  let parsed;
  try { parsed = parseVideoId(source.type, source.videoId); }
  catch (_) { return source; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  try {
    const response = await fetch(`${config.prefetch.cinemetaUrl}/meta/${encodeURIComponent(source.type)}/${encodeURIComponent(parsed.imdbId)}.json`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "stremio-pt-auto/1.0" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const meta = (await response.json())?.meta || {};
    return {
      ...source,
      country: typeof meta.country === "string" ? meta.country : null,
      originalLanguage: meta.originalLanguage || meta.original_language || null,
      contentLanguageMetadataSource: "cinemeta",
    };
  } catch (error) {
    logger.warn("Content language metadata unavailable", { sourceId: source.sourceId, error: error.message });
    return source;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { enrichContentLanguageMetadata };
