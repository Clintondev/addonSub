const fs = require("fs");
const config = require("../config");
const logger = require("../logger");
const { enqueueSubtitleJob } = require("../jobs/queue");
const { signPath, safeChildPath } = require("../utils/security");
const { inc } = require("../metrics");
const { repairSubtitleLayout } = require("./subtitleLayout");
const { parseVtt } = require("./vtt");
const { clearCancellation } = require("./cancellationStore");

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

function vttToSrt(vtt) {
  return `${parseVtt(String(vtt)).map((cue, index) => {
    const timing = String(cue.time)
      .replace(/^(\d+:\d{2}:\d{2})\.(\d{3})(\s+-->\s+)(\d+:\d{2}:\d{2})\.(\d{3}).*$/, "$1,$2$3$4,$5");
    return `${index + 1}\n${timing}\n${cue.text}`;
  }).join("\n\n")}\n`;
}

function ensureSrtSubtitle(sourceId, translated) {
  const target = subtitlePath(sourceId, "pt-BR.srt");
  const sourceStat = fs.statSync(translated);
  if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= sourceStat.mtimeMs) return target;
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, vttToSrt(fs.readFileSync(translated, "utf8")), "utf8");
  fs.renameSync(temporary, target);
  return target;
}

function translationStatus(sourceId) {
  const translated = subtitlePath(sourceId, "pt-BR.vtt");
  if (fs.existsSync(translated)) {
    try { repairSubtitleLayout(sourceId); } catch (error) { logger.warn("Falha ao preservar layout da legenda", { sourceId, error: error.message }); }
    let srt = null;
    try { srt = ensureSrtSubtitle(sourceId, translated); }
    catch (error) { logger.warn("Falha ao gerar fallback SRT", { sourceId, error: error.message }); }
    inc("cache_hits");
    const ass = subtitlePath(sourceId, "pt-BR.ass");
    return {
      status: "ready",
      path: translated,
      url: subtitleUrl(sourceId, "pt-BR.vtt"),
      srtPath: srt,
      srtUrl: srt ? subtitleUrl(sourceId, "pt-BR.srt") : null,
      assPath: fs.existsSync(ass) ? ass : null,
      assUrl: fs.existsSync(ass) ? subtitleUrl(sourceId, "pt-BR.ass") : null,
    };
  }
  const failed = subtitlePath(sourceId, "failed.json");
  return { status: fs.existsSync(failed) ? "failed" : "pending" };
}

async function queueTranslationJob(sourceId, priority = 5) {
  // Source ids are deterministic. Deleting an episode and selecting the same
  // release later therefore reuses the id; the old tombstone must not cancel
  // the newly requested job.
  clearCancellation(sourceId);
  ensureSourceDir(sourceId);
  return enqueueSubtitleJob({ sourceId, requestedAt: Date.now() }, priority);
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

module.exports = { ensureSourceDir, ensureSrtSubtitle, translationStatus, queueTranslationJob, savePendingSubtitle, subtitleUrl, subtitlePath, vttToSrt };
