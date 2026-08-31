const path = require("path");
require("dotenv").config();

function number(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const value = raw == null || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function list(name, fallback = "") {
  return (process.env[name] || fallback).split(",").map((item) => item.trim()).filter(Boolean);
}

function httpUrl(name, fallback) {
  const parsed = new URL(process.env[name] || fallback);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${name} must use http or https`);
  return parsed.toString().replace(/\/$/, "");
}

const storageDir = path.resolve(process.env.STORAGE_DIR || path.join(process.cwd(), "storage"));
const hlsDir = path.join(storageDir, "hls");
const upstreamAddons = list("UPSTREAM_ADDONS").map((entry, index) => {
  const separator = entry.indexOf("|");
  const name = separator === -1 ? `upstream-${index + 1}` : entry.slice(0, separator).trim();
  const url = separator === -1 ? entry : entry.slice(separator + 1).trim();
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`UPSTREAM_ADDONS entry ${index + 1} must use http or https`);
  return { id: `upstream-${index + 1}`, name, url: parsed.toString().replace(/\/$/, "") };
});

const subtitleTokenSecret = process.env.SUBTITLE_TOKEN_SECRET || "change-me";
if (process.env.NODE_ENV === "production" && subtitleTokenSecret === "change-me") {
  throw new Error("SUBTITLE_TOKEN_SECRET must be changed in production");
}

module.exports = Object.freeze({
  env: process.env.NODE_ENV || "development",
  port: number("PORT", 7000, { min: 1, max: 65535 }),
  baseUrl: httpUrl("BASE_URL", "http://localhost:7000"),
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  libreTranslateUrl: httpUrl("LIBRETRANSLATE_URL", "http://localhost:5000"),
  contextualTranslatorUrl: httpUrl("CONTEXTUAL_TRANSLATOR_URL", "http://ollama:11434"),
  contextualTranslatorModel: process.env.CONTEXTUAL_TRANSLATOR_MODEL || "translategemma:12b",
  contextualTranslatorMaxCues: number("CONTEXTUAL_TRANSLATOR_MAX_CUES", 10, { min: 4, max: 80 }),
  contextualTranslatorTimeoutMs: number("CONTEXTUAL_TRANSLATOR_TIMEOUT_SECONDS", 300, { min: 30, max: 1800 }) * 1000,
  allowLiteralTranslationFallback: /^(1|true|yes)$/i.test(process.env.ALLOW_LITERAL_TRANSLATION_FALLBACK || "false"),
  intelligenceUrl: process.env.INTELLIGENCE_URL ? httpUrl("INTELLIGENCE_URL", process.env.INTELLIGENCE_URL) : "",
  forcedAlignmentEnabled: /^(1|true|yes)$/i.test(process.env.FORCED_ALIGNMENT_ENABLED || "true"),
  forcedAlignmentTimeoutMs: number("FORCED_ALIGNMENT_TIMEOUT_MINUTES", 120, { min: 5, max: 720 }) * 60 * 1000,
  qbittorrentUrl: httpUrl("QBITTORRENT_URL", "http://qbittorrent:8080"),
  storageDir,
  hlsDir,
  mediaDir: path.join(storageDir, "media"),
  torrentDownloadTimeoutMs: number("TORRENT_DOWNLOAD_TIMEOUT_MINUTES", 720, { min: 5, max: 10080 }) * 60 * 1000,
  torrentMetadataTimeoutMs: number("TORRENT_METADATA_TIMEOUT_SECONDS", 180, { min: 30, max: 900 }) * 1000,
  torrentNoProgressTimeoutMs: number("TORRENT_NO_PROGRESS_TIMEOUT_SECONDS", 180, { min: 30, max: 3600 }) * 1000,
  mediaRecoveryMaxAttempts: number("MEDIA_RECOVERY_MAX_ATTEMPTS", 2, { min: 1, max: 5 }),
  mediaRecoveryMaxSources: number("MEDIA_RECOVERY_MAX_SOURCES", 3, { min: 1, max: 10 }),
  mediaRecoveryRecheckTimeoutMs: number("MEDIA_RECOVERY_RECHECK_MINUTES", 10, { min: 1, max: 120 }) * 60 * 1000,
  maxStorageBytes: number("MAX_STORAGE_GB", 100, { min: 1, max: 100000 }) * 1024 * 1024 * 1024,
  targetLocale: process.env.TARGET_LOCALE || "pt-BR",
  subtitleTokenSecret,
  adminToken: process.env.ADMIN_TOKEN || "",
  upstreamAddons,
  upstreamTimeoutMs: number("UPSTREAM_TIMEOUT_MS", 12000, { min: 500, max: 60000 }),
  signedUrlTtlSeconds: number("SIGNED_URL_TTL_SECONDS", 86400, { min: 60, max: 604800 }),
  preferredSubtitleLangs: list("PREFERRED_SUB_LANGS", "pob,pt-br,pb,por,pt,eng,en,spa,fra,ita").map((s) => s.toLowerCase()),
  translateBatchChars: number("TRANSLATE_BATCH_CHARS", 3500, { min: 250, max: 20000 }),
  job: {
    concurrency: number("JOB_CONCURRENCY", 2, { min: 1, max: 16 }),
    rateLimit: number("JOB_RATE_LIMIT", 4, { min: 1, max: 100 }),
    lockDurationMs: number("JOB_LOCK_DURATION_MS", 3600000, { min: 30000, max: 3600000 }),
  },
  prefetch: {
    enabled: /^(1|true|yes)$/i.test(process.env.SERIES_PREFETCH_ENABLED || "true"),
    ahead: number("SERIES_PREFETCH_AHEAD", 0, { min: 0, max: 12 }),
    priority: number("SERIES_PREFETCH_PRIORITY", 20, { min: 2, max: 100 }),
    cooldownMs: number("SERIES_PREFETCH_COOLDOWN_MINUTES", 5, { min: 1, max: 1440 }) * 60 * 1000,
    metadataCacheMs: number("SERIES_METADATA_CACHE_HOURS", 24, { min: 1, max: 720 }) * 60 * 60 * 1000,
    cinemetaUrl: httpUrl("CINEMETA_URL", "https://v3-cinemeta.strem.io"),
  },
  hls: {
    segmentSeconds: number("HLS_SEGMENT_SECONDS", 4, { min: 2, max: 10 }),
    startTimeoutMs: number("HLS_START_TIMEOUT_SECONDS", 45, { min: 5, max: 180 }) * 1000,
    videoBitrateKbps: number("HLS_VIDEO_BITRATE_KBPS", 5000, { min: 500, max: 30000 }),
    audioBitrateKbps: number("HLS_AUDIO_BITRATE_KBPS", 192, { min: 64, max: 512 }),
    maxHeight: number("HLS_MAX_HEIGHT", 1080, { min: 360, max: 2160 }),
    maxConcurrent: number("HLS_MAX_CONCURRENT", 1, { min: 1, max: 4 }),
    cacheMaxAgeMs: number("HLS_CACHE_MAX_AGE_HOURS", 72, { min: 1, max: 8760 }) * 60 * 60 * 1000,
  },
});
