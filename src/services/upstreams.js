const fetch = require("node-fetch");
const fs = require("fs");
const config = require("../config");
const logger = require("../logger");
const sourceStore = require("./sourceStore");
const { parseVideoId } = require("./videoId");
const { createSourceId, dedupeKey } = require("./sourceIdentity");
const { subtitleOwner, hasReadySubtitle } = require("./subtitleAssociation");

function readinessScore(item) {
  const subtitleReady = hasReadySubtitle(subtitleOwner(item.record));
  const mediaReady = Boolean(item.record.localPath && fs.existsSync(item.record.localPath));
  return Number(subtitleReady) * 4 + Number(mediaReady) * 2;
}

function streamEndpoint(addonUrl, type, videoId) {
  const base = addonUrl.replace(/\/manifest\.json$/i, "").replace(/\/$/, "");
  return `${base}/stream/${encodeURIComponent(type)}/${encodeURIComponent(videoId)}.json`;
}

async function fetchStreams(addon, type, videoId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  try {
    const response = await fetch(streamEndpoint(addon.url, type, videoId), {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "stremio-pt-auto/1.0" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    return Array.isArray(body.streams) ? body.streams : [];
  } finally {
    clearTimeout(timer);
  }
}

function normalizeStream(stream, addon, type, videoId) {
  // externalUrl/ytId bypass the gateway, so the selected source could never
  // receive a prepared PT-AUTO subtitle. Only resolvable media is advertised.
  if (!stream || typeof stream !== "object" || (!stream.url && !stream.infoHash)) return null;
  const sourceId = createSourceId(stream, addon.id, videoId);
  const record = sourceStore.upsert({
    sourceId,
    videoId,
    type,
    addonId: addon.id,
    addonName: addon.name,
    url: typeof stream.url === "string" ? stream.url : null,
    infoHash: stream.infoHash || null,
    fileIdx: stream.fileIdx ?? null,
    filename: stream.behaviorHints?.filename || null,
    videoSize: stream.behaviorHints?.videoSize || null,
    name: stream.name || addon.name,
    title: stream.title || "",
    behaviorHints: stream.behaviorHints || {},
  });
  return { stream, record, key: dedupeKey(stream, addon.id, videoId) };
}

async function aggregateStreams(type, videoId) {
  parseVideoId(type, videoId);
  const outcomes = await Promise.allSettled(config.upstreamAddons.map(async (addon) => ({ addon, streams: await fetchStreams(addon, type, videoId) })));
  const unique = new Map();
  // Prepared media remains available and appears before remote results, even
  // if the originating add-on is temporarily unavailable.
  sourceStore.list({ videoId }).filter((record) => record.localPath && fs.existsSync(record.localPath)).forEach((record) => {
    const stream = {
      infoHash: record.infoHash || undefined,
      fileIdx: record.fileIdx ?? undefined,
      url: record.url || undefined,
      name: record.name || record.addonName,
      title: record.title || record.filename || "",
      behaviorHints: record.behaviorHints || { filename: record.filename, videoSize: record.videoSize },
    };
    const key = dedupeKey(stream, record.addonId, videoId);
    if (!unique.has(key)) unique.set(key, { stream, record, key });
  });
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      logger.warn("Upstream request failed", { addonId: config.upstreamAddons[index].id, error: outcome.reason.message });
      return;
    }
    for (const stream of outcome.value.streams) {
      const normalized = normalizeStream(stream, outcome.value.addon, type, videoId);
      if (normalized && !unique.has(normalized.key)) unique.set(normalized.key, normalized);
    }
  });
  return [...unique.values()]
    .map((item, index) => ({ item, index, score: readinessScore(item) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => item);
}

module.exports = { streamEndpoint, normalizeStream, aggregateStreams, readinessScore };
