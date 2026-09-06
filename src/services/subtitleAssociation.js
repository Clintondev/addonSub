const fs = require("fs");
const path = require("path");
const sourceStore = require("./sourceStore");
const { subtitlePath, translationStatus } = require("./subtitleService");

function hasReadySubtitle(record) {
  return Boolean(record && fs.existsSync(subtitlePath(record.sourceId, "pt-BR.vtt")));
}

function sameLocalMedia(left, right) {
  if (!left?.localPath || !right?.localPath) return false;
  return path.resolve(left.localPath) === path.resolve(right.localPath)
    && fs.existsSync(left.localPath)
    && fs.existsSync(right.localPath);
}

function subtitleOwner(record) {
  if (!record || hasReadySubtitle(record)) return record || null;
  if (!record.localPath || !fs.existsSync(record.localPath)) return record;
  return sourceStore.list({ videoId: record.videoId, limit: 500 })
    .find((candidate) => hasReadySubtitle(candidate) && sameLocalMedia(record, candidate)) || record;
}

function associatedTranslationStatus(record) {
  const owner = subtitleOwner(record);
  const status = translationStatus(owner.sourceId);
  return { ...status, subtitleSourceId: owner.sourceId, associated: owner.sourceId !== record.sourceId };
}

module.exports = { associatedTranslationStatus, hasReadySubtitle, sameLocalMedia, subtitleOwner };
