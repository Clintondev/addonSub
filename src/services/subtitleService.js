const fs = require("fs");
const config = require("../config");
const logger = require("../logger");
const { enqueueSubtitleJob } = require("../jobs/queue");
const { signPath, safeChildPath } = require("../utils/security");
const { inc } = require("../metrics");
const { repairSubtitleLayout } = require("./subtitleLayout");

function sourceDir(sourceId) {
  return safeChildPath(config.storageDir, "subtitles", sourceId);
}

function ensureSourceDir(sourceId) {
  fs.mkdirSync(sourceDir(sourceId), { recursive: true });
}

function subtitlePath(sourceId, fileName) {
  return safeChildPath(sourceDir(sourceId), fileName);
}

function subtitleUrl(sourceId, fileName) {
  const { token } = signPath([sourceId, fileName], config.subtitleTokenSecret, config.signedUrlTtlSeconds);
  return `${config.baseUrl}/assets/subtitles/${encodeURIComponent(sourceId)}/${encodeURIComponent(fileName)}?token=${token}`;
}

function translationStatus(sourceId) {
  const translated = subtitlePath(sourceId, "pt-BR.vtt");
  if (fs.existsSync(translated)) {
    try { repairSubtitleLayout(sourceId); } catch (error) { logger.warn("Falha ao preservar layout da legenda", { sourceId, error: error.message }); }
    inc("cache_hits");
    const ass = subtitlePath(sourceId, "pt-BR.ass");
    return {
      status: "ready",
      path: translated,
      url: subtitleUrl(sourceId, "pt-BR.vtt"),
      assPath: fs.existsSync(ass) ? ass : null,
      assUrl: fs.existsSync(ass) ? subtitleUrl(sourceId, "pt-BR.ass") : null,
    };
  }
  const failed = subtitlePath(sourceId, "failed.json");
  return { status: fs.existsSync(failed) ? "failed" : "pending" };
}

async function queueTranslationJob(sourceId, priority = 5) {
  ensureSourceDir(sourceId);
  return enqueueSubtitleJob({ sourceId }, priority);
}

async function savePendingSubtitle(sourceId) {
  ensureSourceDir(sourceId);
  const file = subtitlePath(sourceId, "pending.vtt");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nLegenda PT-AUTO em preparação. Atualize em instantes.\n", "utf8");
    logger.info("Created pending subtitle", { sourceId });
  }
  return file;
}

module.exports = { ensureSourceDir, translationStatus, queueTranslationJob, savePendingSubtitle, subtitleUrl, subtitlePath };
