const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const config = require("../config");
const logger = require("../logger");
const { enqueueSubtitleJob } = require("../jobs/queue");
const { hashUrl, signSubtitlePath } = require("../utils/security");
const { inc } = require("../metrics");
const { mergeMeta, readMeta } = require("./metadata");

function videoDir(videoKey) {
  return path.join(config.storageDir, videoKey);
}

function ensureVideoDir(videoKey) {
  fs.mkdirSync(videoDir(videoKey), { recursive: true });
}

function subtitlePath(videoKey, fileName) {
  return path.join(videoDir(videoKey), fileName);
}

function subtitleUrl(videoKey, fileName) {
  const token = signSubtitlePath(
    videoKey,
    fileName,
    config.subtitleTokenSecret || "change-me"
  );
  return `${config.baseUrl}/assets/subtitles/${videoKey}/${fileName}?token=${token}`;
}

function translationStatus(videoKey) {
  const translated = subtitlePath(videoKey, "pt-auto.vtt");
  if (fs.existsSync(translated)) {
    inc("cache_hits");
    return { status: "ready", path: translated, url: subtitleUrl(videoKey, "pt-auto.vtt") };
  }
  return { status: "pending" };
}

async function queueTranslationJob({ videoKey, targetUrl, streamType }) {
  ensureVideoDir(videoKey);
  return enqueueSubtitleJob({
    videoKey,
    targetUrl,
    streamType,
    storageDir: videoDir(videoKey),
    targetLocale: config.targetLocale,
    libreTranslateUrl: config.libreTranslateUrl,
  });
}

async function savePlaceholderSubtitle(videoKey) {
  ensureVideoDir(videoKey);
  const targetFile = subtitlePath(videoKey, "pt-auto.vtt");
  if (fs.existsSync(targetFile)) return targetFile;

  const payload = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:02.000",
    "Legenda PT-AUTO em preparação...",
    "",
  ].join("\n");

  fs.writeFileSync(targetFile, payload, "utf8");
  logger.info("Wrote placeholder subtitle", { targetFile });
  return targetFile;
}

function deriveVideoKey({ type, id, targetUrl }) {
  const hash = hashUrl(targetUrl || id || "");
  return `${type || "video"}.${id || "unknown"}.${hash}`;
}

module.exports = {
  deriveVideoKey,
  ensureVideoDir,
  translationStatus,
  queueTranslationJob,
  savePlaceholderSubtitle,
  subtitleUrl,
  subtitlePath,
};
