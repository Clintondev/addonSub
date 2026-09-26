const fs = require("fs");
const config = require("../config");
const logger = require("../logger");
const { enqueueSubtitleJob } = require("../jobs/queue");
const { signPath, safeChildPath } = require("../utils/security");
const { readPublication } = require("./subtitlePublication");
const { readMeta } = require("./metadata");
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

function subtitleUrl(sourceId, fileName, version = null) {
  const { token } = signPath([sourceId, fileName], config.subtitleTokenSecret, config.signedUrlTtlSeconds);
  return `${config.baseUrl}/assets/subtitles/${encodeURIComponent(sourceId)}/${encodeURIComponent(fileName)}?token=${token}${version ? `&v=${version}` : ""}`;
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
  const publication = readPublication(sourceId);
  const legacy = !fs.existsSync(subtitlePath(sourceId, "publication.json")) && readMeta(sourceId).stage === "ready";
  const translated = publication ? pathFromPublication(publication, "pt-BR.vtt") : subtitlePath(sourceId, "pt-BR.vtt");
  if (publication || (legacy && fs.existsSync(translated))) {
    const srtFile = publication ? pathFromPublication(publication, "pt-BR.srt") : subtitlePath(sourceId, "pt-BR.srt");
    const srt = fs.existsSync(srtFile) ? srtFile : null;
    const ass = publication ? pathFromPublication(publication, "pt-BR.ass") : subtitlePath(sourceId, "pt-BR.ass");
    const version = publication?.generation || null;
    return {
      status: "ready",
      version,
      legacy: !publication,
      path: translated,
      url: subtitleUrl(sourceId, "pt-BR.vtt", version),
      srtPath: srt,
      srtUrl: srt ? subtitleUrl(sourceId, "pt-BR.srt", version) : null,
      assPath: fs.existsSync(ass) ? ass : null,
      assUrl: fs.existsSync(ass) ? subtitleUrl(sourceId, "pt-BR.ass", version) : null,
    };
  }
  const failed = subtitlePath(sourceId, "failed.json");
  return { status: fs.existsSync(failed) ? "failed" : "pending" };
}

function pathFromPublication(publication, fileName) { return safeChildPath(publication.directory, fileName); }

async function queueTranslationJob(sourceId, priority = 5, options = {}) {
  if (["web", "local"].includes(options.playbackProfile)) {
    const sourceStore = require("./sourceStore");
    const source = sourceStore.get(sourceId);
    if (source && source.playbackProfile !== options.playbackProfile) sourceStore.upsert({ ...source, playbackProfile: options.playbackProfile });
  }
  // Source ids are deterministic. Deleting an episode and selecting the same
  // release later therefore reuses the id; the old tombstone must not cancel
  // the newly requested job.
  clearCancellation(sourceId);
  ensureSourceDir(sourceId);
  return enqueueSubtitleJob({ ...options, sourceId, requestedAt: Date.now() }, priority);
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
