const fs = require("fs");
const path = require("path");
const config = require("../config");
const sourceStore = require("./sourceStore");
const watchStore = require("./watchStore");
const { parseVideoId } = require("./videoId");
const { readMeta } = require("./metadata");
const { translationStatus, subtitlePath } = require("./subtitleService");
const { cancelHls, outputPath: hlsOutputPath } = require("./hlsPlayback");
const { cancelEmbeddedPlayback } = require("./embeddedPlayback");
const { request } = require("./qbittorrent");
const { safeChildPath } = require("../utils/security");

function existsSize(file) {
  try { return fs.statSync(file).size; } catch (_) { return 0; }
}

function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  return fs.readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const child = path.join(root, entry.name);
    return total + (entry.isDirectory() ? directorySize(child) : entry.isFile() ? existsSize(child) : 0);
  }, 0);
}

function episodeView(source) {
  let identity = { imdbId: source.videoId, season: null, episode: null };
  try { identity = parseVideoId(source.type, source.videoId); } catch (_) {}
  const meta = readMeta(source.sourceId);
  const status = translationStatus(source.sourceId);
  const subtitlesDir = safeChildPath(config.storageDir, "subtitles", source.sourceId);
  const hlsDir = safeChildPath(config.hlsDir, source.sourceId);
  const playbackDir = safeChildPath(config.playbackDir, source.sourceId);
  const mediaReady = Boolean(source.localPath && existsSize(source.localPath));
  const downloadProgress = meta.downloadProgress ?? (mediaReady ? 100 : 0);
  const downloadStatus = mediaReady ? "ready"
    : meta.stage === "acquiring" ? "downloading"
      : ["queued", "prefetch-queued"].includes(meta.stage) || source.acquisitionState === "queued" ? "queued"
        : meta.stage === "failed" && downloadProgress < 100 ? "failed" : "not-started";
  const origin = String(meta.origin || "");
  const sourceMethod = origin.startsWith("ocr-pgs") ? "PGS convertido por OCR"
    : origin === "faster-whisper" ? "Áudio transcrito pelo Whisper"
      : /hls/i.test(origin) ? "Legenda extraída do HLS"
        : /dash/i.test(origin) ? "Legenda extraída do DASH"
          : origin ? "Legenda textual extraída da mídia" : null;
  return {
    ...sourceStore.publicSource(source),
    ...identity,
    status: meta.stage || status.status,
    progress: meta.progress || 0,
    downloadProgress,
    download: {
      status: downloadStatus,
      progress: downloadProgress,
      downloadedBytes: meta.downloadedBytes || (mediaReady ? existsSize(source.localPath) : 0),
      totalBytes: meta.totalBytes || source.videoSize || 0,
      speedBytes: meta.downloadSpeedBytes || 0,
      etaSeconds: Number.isFinite(meta.etaSeconds) ? meta.etaSeconds : null,
    },
    error: meta.error || null,
    subtitle: {
      status: status.status,
      origin: meta.origin || null,
      sourceMethod,
      languageDeclared: meta.languageDeclared || null,
      languageDetected: meta.languageDetected || meta.from || null,
      translated: meta.translated ?? null,
      provider: meta.translationProvider || null,
      alignment: meta.alignmentQuality || null,
      sourceQuality: meta.sourceQuality || null,
      finalQuality: meta.finalQuality || null,
      cues: meta.cues || null,
      updatedAt: meta.updatedAt || null,
      hasOriginal: existsSize(path.join(subtitlesDir, "original.vtt")) > 0,
      hasFinal: existsSize(path.join(subtitlesDir, "pt-BR.vtt")) > 0,
      outputs: {
        vtt: existsSize(path.join(subtitlesDir, "pt-BR.vtt")) > 0,
        srt: existsSize(path.join(subtitlesDir, "pt-BR.srt")) > 0,
        embedded: directorySize(playbackDir) > 0,
      },
    },
    storage: {
      mediaBytes: source.localPath ? existsSize(source.localPath) : 0,
      subtitleBytes: directorySize(subtitlesDir),
      hlsBytes: directorySize(hlsDir),
      playbackBytes: directorySize(playbackDir),
    },
  };
}

function titleFromSource(source, imdbId) {
  const value = source.title || source.name || source.filename || imdbId;
  return String(value).replace(/[._]/g, " ").replace(/\bS\d{1,2}E\d{1,3}\b.*$/i, "").replace(/\s+/g, " ").trim() || imdbId;
}

function sourceRank(source) {
  return (source.localPath ? 1000000 : 0) + (source.acquisitionState === "ready" ? 500000 : 0)
    + (source.prefetchPosition ? 100000 : 0) + Number(source.refreshedAt || 0) / 1e10;
}

function isManagedSource(source, watch) {
  if (watch?.currentSourceId === source.sourceId) return true;
  if (source.localPath || source.acquisitionState || source.prefetchParentSourceId || source.prefetchPosition) return true;
  return Boolean(readMeta(source.sourceId).stage);
}

function libraryView(allSources = sourceStore.list({ limit: 5000 })) {
  const watching = new Map(watchStore.list().map((item) => [item.imdbId, item]));
  const groups = new Map();
  for (const source of allSources) {
    let imdbId = source.videoId;
    try { imdbId = parseVideoId(source.type, source.videoId).imdbId; } catch (_) {}
    // Stremio commonly asks for the previous/current/next stream while merely
    // browsing or restoring playback. Keep those discoveries in the source
    // cache, but do not present them as pending downloads in the manager.
    if (!isManagedSource(source, watching.get(imdbId))) continue;
    if (!groups.has(imdbId)) groups.set(imdbId, { imdbId, type: source.type, title: titleFromSource(source, imdbId), sourceByVideo: new Map() });
    const current = groups.get(imdbId).sourceByVideo.get(source.videoId);
    const ranked = { source, rank: sourceRank(source) };
    if (!current || ranked.rank > current.rank) groups.get(imdbId).sourceByVideo.set(source.videoId, ranked);
  }
  for (const item of watching.values()) {
    if (!groups.has(item.imdbId)) groups.set(item.imdbId, { imdbId: item.imdbId, type: item.type, title: item.imdbId, sourceByVideo: new Map() });
  }
  return [...groups.values()].map((group) => {
    const watch = watching.get(group.imdbId) || { status: "library", prefetchAhead: 0 };
    group.episodes = [...group.sourceByVideo.values()].map((item) => episodeView(item.source));
    delete group.sourceByVideo;
    group.episodes.sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
    const totals = group.episodes.reduce((sum, item) => ({
      ready: sum.ready + (item.subtitle.status === "ready" ? 1 : 0),
      failed: sum.failed + (item.status === "failed" ? 1 : 0),
      bytes: sum.bytes + item.storage.mediaBytes + item.storage.subtitleBytes + item.storage.hlsBytes + item.storage.playbackBytes,
    }), { ready: 0, failed: 0, bytes: 0 });
    return { ...group, ...watch, totals };
  }).sort((a, b) => String(b.lastPlayedAt || "").localeCompare(String(a.lastPlayedAt || "")) || a.title.localeCompare(b.title));
}

async function deleteArtifacts(sourceId, { media = true, subtitles = true, hls = true, playback = true, record = true } = {}) {
  const source = sourceStore.get(sourceId);
  if (!source) return null;
  // Removing the record first is the cooperative cancellation signal used by
  // an active worker. The captured source still contains everything required
  // to clean the files below.
  if (record) sourceStore.remove(sourceId);
  await cancelHls(sourceId);
  await cancelEmbeddedPlayback(sourceId);
  if (source.infoHash && source.fileIdx !== undefined) {
    try { await request("/torrents/filePrio", { method: "POST", body: { hash: String(source.infoHash).toLowerCase(), id: String(source.fileIdx), priority: "0" } }); } catch (_) {}
  }
  if (media && source.localPath) {
    const resolved = path.resolve(source.localPath);
    const relative = path.relative(path.resolve(config.mediaDir), resolved);
    const referencedElsewhere = sourceStore.list({ limit: 5000 }).some((item) => item.sourceId !== sourceId && item.localPath && path.resolve(item.localPath) === resolved);
    if (!referencedElsewhere && relative && !relative.startsWith("..") && !path.isAbsolute(relative)) fs.rmSync(resolved, { force: true });
  }
  if (subtitles) fs.rmSync(safeChildPath(config.storageDir, "subtitles", sourceId), { recursive: true, force: true });
  if (hls) fs.rmSync(safeChildPath(config.hlsDir, sourceId), { recursive: true, force: true });
  if (playback) fs.rmSync(safeChildPath(config.playbackDir, sourceId), { recursive: true, force: true });
  return source;
}

function storageView(shows = null, sourceCount = null) {
  if (Array.isArray(shows)) {
    const totals = shows.reduce((sum, show) => ({
      mediaBytes: sum.mediaBytes + show.episodes.reduce((value, item) => value + item.storage.mediaBytes, 0),
      subtitleBytes: sum.subtitleBytes + show.episodes.reduce((value, item) => value + item.storage.subtitleBytes, 0),
      hlsBytes: sum.hlsBytes + show.episodes.reduce((value, item) => value + item.storage.hlsBytes, 0),
      playbackBytes: sum.playbackBytes + show.episodes.reduce((value, item) => value + item.storage.playbackBytes, 0),
    }), { mediaBytes: 0, subtitleBytes: 0, hlsBytes: 0, playbackBytes: 0 });
    return { ...totals, usedBytes: totals.mediaBytes + totals.subtitleBytes + totals.hlsBytes + totals.playbackBytes, maxBytes: config.maxStorageBytes, sources: sourceCount ?? sourceStore.list({ limit: 5000 }).length };
  }
  return {
    usedBytes: directorySize(config.storageDir),
    maxBytes: config.maxStorageBytes,
    mediaBytes: directorySize(config.mediaDir),
    subtitleBytes: directorySize(path.join(config.storageDir, "subtitles")),
    hlsBytes: directorySize(config.hlsDir),
    playbackBytes: directorySize(config.playbackDir),
    sources: sourceStore.list({ limit: 5000 }).length,
  };
}

function stateErrorLogs(allSources = sourceStore.list({ limit: 5000 })) {
  const sources = new Map(allSources.map((source) => [source.sourceId, source]));
  const root = path.join(config.storageDir, "subtitles");
  let ids = [];
  try { ids = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch (_) {}
  return ids.flatMap((sourceId) => {
    const source = sources.get(sourceId) || { sourceId };
    const meta = readMeta(sourceId);
    if (!meta.error && !meta.extractionError) return [];
    return [{
      at: meta.updatedAt || new Date(source.refreshedAt || Date.now()).toISOString(),
      level: meta.stage === "failed" ? "error" : "warn",
      message: meta.stage === "failed" ? "Falha ao preparar mídia ou legenda" : "Falha de extração; usando transcrição",
      meta: { sourceId: source.sourceId, videoId: source.videoId, error: meta.error || meta.extractionError, stage: meta.stage },
    }];
  });
}

module.exports = { deleteArtifacts, directorySize, episodeView, isManagedSource, libraryView, stateErrorLogs, storageView };
