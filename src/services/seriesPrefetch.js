const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const config = require("../config");
const logger = require("../logger");
const sourceStore = require("./sourceStore");
const watchStore = require("./watchStore");
const { parseVideoId } = require("./videoId");
const { aggregateStreams, normalizeStream } = require("./upstreams");
const { getFiles } = require("./qbittorrent");
const { queueTranslationJob, savePendingSubtitle, translationStatus } = require("./subtitleService");
const { transitionIf } = require("./metadata");
const { safeChildPath } = require("../utils/security");

const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".ts", ".m2ts"]);
const running = new Map();
const lastScheduled = new Map();

function episodeNumbers(video) {
  const parsed = parseVideoId("series", video.id);
  return { id: video.id, season: Number(video.season ?? parsed.season), episode: Number(video.episode ?? video.number ?? parsed.episode) };
}

function nextEpisodeIds(videos, currentVideoId, ahead = 4) {
  const current = parseVideoId("series", currentVideoId);
  const ordered = (videos || [])
    .filter((video) => video?.id && video.season !== 0)
    .map((video) => {
      try { return episodeNumbers(video); } catch (_) { return null; }
    })
    .filter((video) => video && video.id.startsWith(`${current.imdbId}:`) && video.season > 0)
    .sort((left, right) => left.season - right.season || left.episode - right.episode);
  const index = ordered.findIndex((video) => video.id === currentVideoId);
  if (index === -1) return Array.from({ length: ahead }, (_, offset) => `${current.imdbId}:${current.season}:${current.episode + offset + 1}`);
  return ordered.slice(index + 1, index + 1 + ahead).map((video) => video.id);
}

function episodePatterns(season, episode) {
  const s = String(Number(season));
  const e = String(Number(episode));
  return [
    new RegExp(`(?:^|[^a-z0-9])s0*${s}[^a-z0-9]*e0*${e}(?:[^0-9]|$)`, "i"),
    new RegExp(`(?:^|[^a-z0-9])t0*${s}[^a-z0-9]*e0*${e}(?:[^0-9]|$)`, "i"),
    new RegExp(`(?:^|[^0-9])0*${s}x0*${e}(?:[^0-9]|$)`, "i"),
  ];
}

function findEpisodeFile(files, season, episode) {
  const patterns = episodePatterns(season, episode);
  return (files || [])
    .filter((file) => VIDEO_EXTENSIONS.has(path.extname(file.name || "").toLowerCase()))
    .filter((file) => !/(?:^|[._ -])(?:sample|trailer)(?:[._ -]|$)/i.test(file.name || ""))
    .filter((file) => patterns.some((pattern) => pattern.test(file.name || "")))
    .sort((left, right) => Number(right.size || 0) - Number(left.size || 0))[0] || null;
}

function releaseProfile(source) {
  const text = [source.filename, source.title, source.name].filter(Boolean).join(" ").toLowerCase();
  const resolution = text.match(/\b(2160|1080|720|576|480)p\b/)?.[1] || "";
  const codec = /\b(?:x265|h[ ._-]?265|hevc)\b/.test(text) ? "h265"
    : /\b(?:x264|h[ ._-]?264|avc)\b/.test(text) ? "h264"
      : /\bav1\b/.test(text) ? "av1" : "";
  const medium = /blu[ ._-]?ray|bdrip|brrip/.test(text) ? "bluray"
    : /web[ ._-]?dl/.test(text) ? "webdl"
      : /web[ ._-]?rip/.test(text) ? "webrip"
        : /hdtv/.test(text) ? "hdtv" : "";
  const cleaned = text
    .replace(/\.[a-z0-9]{2,4}\b/g, " ")
    .replace(/\b(?:s|t)\d{1,2}[ ._-]*e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b/g, " ")
    .replace(/\b(?:19|20)\d{2}\b|\b(?:2160|1080|720|576|480)p\b/g, " ");
  const tokens = new Set(cleaned.split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
  const group = text.match(/-([a-z0-9]+)(?:\.[a-z0-9]{2,4})?\s*$/)?.[1] || "";
  return { resolution, codec, medium, group, tokens, videoSize: Number(source.videoSize || source.behaviorHints?.videoSize || 0) };
}

function affinityScore(candidate, selected) {
  const candidateProfile = releaseProfile(candidate);
  const selectedProfile = releaseProfile(selected);
  let score = 0;
  if (candidate.addonId && candidate.addonId === selected.addonId) score += 200;
  if (candidate.infoHash && selected.infoHash && String(candidate.infoHash).toLowerCase() === String(selected.infoHash).toLowerCase()) score += 10000;
  if (selectedProfile.resolution && candidateProfile.resolution === selectedProfile.resolution) score += 80;
  if (selectedProfile.codec && candidateProfile.codec === selectedProfile.codec) score += 70;
  if (selectedProfile.medium && candidateProfile.medium === selectedProfile.medium) score += 50;
  if (selectedProfile.group && candidateProfile.group === selectedProfile.group) score += 120;
  const shared = [...selectedProfile.tokens].filter((token) => candidateProfile.tokens.has(token)).length;
  const union = new Set([...selectedProfile.tokens, ...candidateProfile.tokens]).size;
  if (union) score += Math.round(100 * shared / union);
  if (selectedProfile.videoSize && candidateProfile.videoSize) {
    const ratio = Math.min(selectedProfile.videoSize, candidateProfile.videoSize) / Math.max(selectedProfile.videoSize, candidateProfile.videoSize);
    score += Math.round(ratio * 30);
  }
  return score;
}

function selectAffinityItem(items, selected) {
  return [...(items || [])].sort((left, right) => affinityScore(right.record, selected) - affinityScore(left.record, selected))[0] || null;
}

function cacheFile(imdbId) {
  return safeChildPath(config.storageDir, "db", "series", `${imdbId}.json`);
}

function readSeriesMetadataCache(imdbId) {
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile(imdbId), "utf8"));
    return { meta: cached.meta || {}, videos: cached.videos || [] };
  } catch (_) { return { meta: {}, videos: [] }; }
}

async function fetchSeriesMetadata(imdbId) {
  const file = cacheFile(imdbId);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < config.prefetch.metadataCacheMs) {
      const cached = JSON.parse(fs.readFileSync(file, "utf8"));
      return { meta: cached.meta || {}, videos: cached.videos || [] };
    }
  } catch (_) {}
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  try {
    const response = await fetch(`${config.prefetch.cinemetaUrl}/meta/series/${encodeURIComponent(imdbId)}.json`, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Cinemeta returned HTTP ${response.status}`);
    const body = await response.json();
    const meta = body?.meta || {};
    const videos = Array.isArray(meta.videos) ? meta.videos : [];
    if (!videos.length) throw new Error("Cinemeta returned no episodes");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ fetchedAt: Date.now(), meta: { name: meta.name, poster: meta.poster, background: meta.background, year: meta.year, country: meta.country, originalLanguage: meta.originalLanguage || meta.original_language || null }, videos }), "utf8");
    fs.renameSync(temporary, file);
    return { meta, videos };
  } finally { clearTimeout(timer); }
}

async function fetchSeriesVideos(imdbId) { return (await fetchSeriesMetadata(imdbId)).videos; }

function sameTorrentItem(selected, videoId, file) {
  const addon = config.upstreamAddons.find((item) => item.id === selected.addonId) || { id: selected.addonId, name: selected.addonName };
  const stream = {
    infoHash: selected.infoHash,
    fileIdx: file.index,
    name: selected.name || selected.addonName,
    title: selected.title || selected.filename || "",
    behaviorHints: { ...(selected.behaviorHints || {}), filename: file.name, videoSize: file.size },
  };
  return normalizeStream(stream, addon, "series", videoId);
}

async function discoverPrefetchSource(selected, videoId, torrentFiles) {
  const episode = parseVideoId("series", videoId);
  if (selected.infoHash && torrentFiles?.length) {
    const file = findEpisodeFile(torrentFiles, episode.season, episode.episode);
    if (file) return sameTorrentItem(selected, videoId, file);
  }
  return selectAffinityItem(await aggregateStreams("series", videoId), selected);
}

async function runPrefetch(selected, aheadOverride) {
  const current = parseVideoId("series", selected.videoId);
  const configured = watchStore.get(current.imdbId)?.prefetchAhead;
  const ahead = Number.isInteger(aheadOverride) ? aheadOverride : Number.isInteger(configured) ? configured : config.prefetch.ahead;
  if (ahead <= 0) return [];
  let videos = [];
  try { videos = await fetchSeriesVideos(current.imdbId); }
  catch (error) { logger.warn("Series metadata unavailable; using same-season sequence", { imdbId: current.imdbId, error: error.message }); }
  const nextIds = nextEpisodeIds(videos, selected.videoId, ahead);
  let torrentFiles = [];
  if (selected.infoHash) {
    try { torrentFiles = await getFiles(String(selected.infoHash).toLowerCase()); }
    catch (error) { logger.warn("Could not inspect selected torrent package", { sourceId: selected.sourceId, error: error.message }); }
  }
  const queued = [];
  for (let index = 0; index < nextIds.length; index++) {
    const videoId = nextIds[index];
    try {
      const item = await discoverPrefetchSource(selected, videoId, torrentFiles);
      if (!item) { logger.warn("No affinity source found for prefetch", { videoId, selectedSourceId: selected.sourceId }); continue; }
      const record = sourceStore.upsert({
        ...item.record,
        affinitySourceId: selected.affinitySourceId || selected.sourceId,
        prefetchParentSourceId: selected.sourceId,
        prefetchPosition: index + 1,
      });
      if (translationStatus(record.sourceId).status !== "ready") {
        await savePendingSubtitle(record.sourceId);
        await queueTranslationJob(record.sourceId, config.prefetch.priority);
        const processingStages = new Set(["acquiring", "recovering", "probing", "transcribing", "synchronizing", "contextualizing", "aligning", "translating", "validating", "packaging"]);
        transitionIf(record.sourceId, "prefetch-queued", { parentSourceId: selected.sourceId, position: index + 1, videoId }, (currentMeta) => !processingStages.has(currentMeta.stage));
      }
      queued.push({ sourceId: record.sourceId, videoId, sameTorrent: record.infoHash === selected.infoHash });
    } catch (error) {
      logger.warn("Episode prefetch discovery failed", { videoId, selectedSourceId: selected.sourceId, error: error.message });
    }
  }
  logger.info("Series prefetch window scheduled", { sourceId: selected.sourceId, currentVideoId: selected.videoId, queued });
  return queued;
}

function scheduleSeriesPrefetch(sourceId, { force = false, ahead } = {}) {
  if (!config.prefetch.enabled) return Promise.resolve([]);
  const selected = sourceStore.get(sourceId);
  if (!selected || selected.type !== "series") return Promise.resolve([]);
  const key = `${selected.videoId}|${selected.affinitySourceId || selected.sourceId}`;
  if (running.has(key)) return running.get(key);
  if (!force && Date.now() - (lastScheduled.get(key) || 0) < config.prefetch.cooldownMs) return Promise.resolve([]);
  lastScheduled.set(key, Date.now());
  const task = runPrefetch(selected, ahead).finally(() => running.delete(key));
  running.set(key, task);
  return task;
}

module.exports = {
  affinityScore,
  fetchSeriesMetadata,
  findEpisodeFile,
  nextEpisodeIds,
  readSeriesMetadataCache,
  releaseProfile,
  scheduleSeriesPrefetch,
  selectAffinityItem,
};
