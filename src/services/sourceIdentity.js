const { stableHash } = require("../utils/security");

function canonicalSource(stream, addonId, videoId) {
  const hints = stream.behaviorHints || {};
  const torrentIdentity = stream.infoHash ? `torrent:${String(stream.infoHash).toLowerCase()}:${stream.fileIdx ?? ""}` : null;
  const stableHttp = [hints.filename, hints.videoSize, stream.name, stream.title].filter((value) => value !== undefined && value !== null).join("|");
  return [addonId, videoId, torrentIdentity || `http:${stableHttp || stableHash(stream.url || "", 24)}`].join("|");
}

function createSourceId(stream, addonId, videoId) {
  return `src_${stableHash(canonicalSource(stream, addonId, videoId), 32)}`;
}

function dedupeKey(stream, addonId, videoId) {
  if (stream.infoHash) return `torrent:${String(stream.infoHash).toLowerCase()}:${stream.fileIdx ?? ""}`;
  return canonicalSource(stream, addonId, videoId);
}

module.exports = { canonicalSource, createSourceId, dedupeKey };
