const express = require("express");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const logger = require("./logger");
const { getMetricsText } = require("./metrics");
const { aggregateStreams } = require("./services/upstreams");
const sourceStore = require("./services/sourceStore");
const { ensureSrtSubtitle, queueTranslationJob, savePendingSubtitle, subtitlePath } = require("./services/subtitleService");
const { readMeta, transition, transitionIf } = require("./services/metadata");
const { verifyPath } = require("./utils/security");
const { getQueue } = require("./jobs/queue");
const { ensureHls, outputPath: hlsOutputPath, pruneHlsCache, scheduleHlsCachePruning } = require("./services/hlsPlayback");
const { scheduleSeriesPrefetch, fetchSeriesMetadata, readSeriesMetadataCache, selectAffinityItem } = require("./services/seriesPrefetch");
const watchStore = require("./services/watchStore");
const manager = require("./services/manager");
const { parseVideoId } = require("./services/videoId");
const { repairSubtitleLayout } = require("./services/subtitleLayout");
const { markCancelled } = require("./services/cancellationStore");
const { createClientAccessMiddleware } = require("./utils/clientAccess");
const { healthReport } = require("./services/health");
const { parseVtt, serializeVtt } = require("./services/vtt");
const { associatedTranslationStatus, subtitleOwner } = require("./services/subtitleAssociation");
const { ensureEmbeddedPlayback } = require("./services/embeddedPlayback");
const { getStorageUsage } = require("./services/storageUsage");

function buildManifest() {
  return {
    id: "org.stremio.pt-auto.gateway",
    version: "1.0.0",
    name: "Gateway PT-AUTO",
    description: "Agrega streams e prepara legendas contextuais em português brasileiro.",
    catalogs: [],
    resources: ["stream", "subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["tt"],
    behaviorHints: { configurable: false, configurationRequired: config.upstreamAddons.length === 0 },
  };
}

function externalSubtitleView(record, status, { includeAddon = false } = {}) {
  const ready = status.status === "ready";
  return {
    // Bump the id when changing the advertised format so Stremio does not
    // reuse a cached ASS URL from an older subtitle response.
    id: `pt-auto-srt-v4-${record.sourceId}-${status.subtitleSourceId || record.sourceId}`,
    lang: "por",
    name: ready
      ? `PT-AUTO · Português (Brasil)${includeAddon ? ` · ${record.addonName}` : ""}`
      : "PT-AUTO (preparando)",
    url: status.srtUrl || status.url,
  };
}

function streamView(item, mode = "direct", options = {}) {
  const { stream, record } = item;
  const status = options.status || associatedTranslationStatus(record);
  const subtitleReady = status.status === "ready";
  const playbackSourceId = mode === "hls" && status.associated ? status.subtitleSourceId : record.sourceId;
  const localReady = Boolean(record.localPath && fs.existsSync(record.localPath));
  const behaviorHints = { ...(stream.behaviorHints || {}), bingeGroup: stream.behaviorHints?.bingeGroup || `pt-auto-${record.sourceId}` };
  if (mode === "hls") behaviorHints.filename = `pt-auto-${playbackSourceId}.m3u8`;
  const result = {
    ...stream,
    name: mode === "hls"
      ? `${localReady ? "WEB HLS" : "WEB PREPARAR"} · ${stream.name || "Stream"}`
      : `${localReady ? "LOCAL" : record.infoHash ? "PREPARAR" : record.addonName} · ${stream.name || "Stream"}`,
    title: mode === "hls"
      ? localReady
        ? `${subtitleReady ? "PT-BR pronta" : "Vídeo pronto · PT-BR em preparação"} · ${stream.title || stream.name || record.filename || "Stream"}`
        : `Primeiro acesso prepara; tente novamente depois · ${stream.title || stream.name || record.filename || "Stream"}`
      : localReady
        ? `${subtitleReady ? "Pronto com PT-BR interna" : "Vídeo pronto · PT-BR em preparação"} · ${stream.title || stream.name || record.filename || "Stream"}`
        : record.infoHash
          ? `Primeiro clique baixa e prepara · ${stream.title || stream.name || record.filename || "Stream"}`
          : stream.title || stream.name || record.filename || "Stream",
    behaviorHints,
  };
  if (mode === "hls") {
    delete result.infoHash;
    delete result.fileIdx;
    result.url = `${config.baseUrl}/hls/${playbackSourceId}/master.m3u8?profile=web-av-subs-v2`;
  } else if (record.url || record.infoHash) {
    delete result.infoHash;
    delete result.fileIdx;
    result.url = `${config.baseUrl}/play/${record.sourceId}?profile=ptbr-stream-v2`;
  }
  // Advertise the exact source subtitle in both modes. HLS also carries a
  // native WebVTT rendition, while SRT remains a broad player fallback.
  if (subtitleReady) result.subtitles = [externalSubtitleView(record, status)];
  return result;
}

function streamViews(item, options = {}) {
  const status = associatedTranslationStatus(item.record);
  if (item.record.localPath && status.status === "ready" && status.srtPath) {
    ensureEmbeddedPlayback(status.subtitleSourceId, item.record.localPath, status.srtPath)
      .catch((error) => logger.warn("Falha ao antecipar MKV local com PT-BR", { sourceId: item.record.sourceId, subtitleSourceId: status.subtitleSourceId, error: error.message }));
  }
  const viewOptions = { ...options, status };
  const direct = streamView(item, "direct", viewOptions);
  const { record } = item;
  if (!record.infoHash && !record.localPath) return [direct];
  return [direct, streamView(item, "hls", viewOptions)];
}

function normalizedFilename(value) {
  return path.posix.basename(String(value || "").replace(/\\/g, "/")).trim().toLocaleLowerCase("pt-BR");
}

function subtitleRequestSelector(extra = "") {
  const requested = new URLSearchParams(String(extra)).get("filename") || "";
  const hlsSource = /^pt-auto-(src_[a-f0-9]+)\.m3u8$/i.exec(requested);
  return { filename: normalizedFilename(requested), sourceId: hlsSource?.[1] || null };
}

function selectSubtitleSources(videoId, extra = "") {
  const selector = subtitleRequestSelector(extra);
  return sourceStore.list({ videoId }).filter((source) => {
    if (selector.sourceId) return source.sourceId === selector.sourceId;
    if (!selector.filename) return true;
    if (selector.filename === "master.m3u8") return false;
    return normalizedFilename(source.filename || source.behaviorHints?.filename) === selector.filename;
  });
}

function hlsAttribute(value) {
  return String(value || "").replace(/["\r\n]/g, " ").trim();
}

function buildHlsMasterPlaylist(hasPtBrSubtitle, audioTracks = []) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"];
  const declaredDefault = audioTracks.findIndex((track) => track.isDefault);
  const defaultAudioIndex = declaredDefault >= 0 ? declaredDefault : 0;
  audioTracks.forEach((track, index) => {
    const title = hlsAttribute(track.title || (track.language === "jpn" ? "Japonês" : track.language === "eng" ? "Inglês" : `Áudio ${index + 1}`));
    const language = hlsAttribute(track.language || "und");
    const channels = track.channels ? `,CHANNELS="${Number(track.channels)}"` : "";
    // The default rendition is already muxed into video.m3u8. Advertising a
    // second URI for it makes some web players discard both audio sources.
    // HLS represents an in-band rendition by omitting URI.
    const uri = index !== defaultAudioIndex && track.playlist ? `,URI="${hlsAttribute(track.playlist)}"` : "";
    lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${title}",DEFAULT=${index === defaultAudioIndex ? "YES" : "NO"},AUTOSELECT=YES,LANGUAGE="${language}"${uri}${channels}`);
  });
  if (hasPtBrSubtitle) {
    lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Português (Brasil)",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="pt-BR",URI="subtitles.m3u8"');
  }
  const attributes = [`BANDWIDTH=${(config.hls.videoBitrateKbps + (audioTracks.length ? config.hls.audioBitrateKbps : 0)) * 1000}`];
  if (audioTracks.length) attributes.push('AUDIO="audio"');
  if (hasPtBrSubtitle) attributes.push('SUBTITLES="subs"');
  lines.push(`#EXT-X-STREAM-INF:${attributes.join(",")}`);
  lines.push("video.m3u8", "");
  return lines.join("\n");
}

function subtitleDurationSeconds(vtt) {
  const matches = [...String(vtt).matchAll(/-->\s*(\d+:\d{2}:\d{2}\.\d{3})/g)];
  if (!matches.length) return 1;
  const [hours, minutes, seconds] = matches.at(-1)[1].split(":");
  return Math.max(1, Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds));
}

function buildHlsSubtitlePlaylist(vtt, segmentSeconds = config.hls.segmentSeconds) {
  const duration = subtitleDurationSeconds(vtt);
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentSeconds)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  const count = Math.ceil(duration / segmentSeconds);
  for (let index = 0; index < count; index += 1) {
    const length = Math.min(segmentSeconds, duration - index * segmentSeconds);
    lines.push(`#EXTINF:${length.toFixed(3)},`, `subtitle-${String(index).padStart(5, "0")}.vtt`);
  }
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

function addHlsTimestampMap(vtt) {
  if (/^X-TIMESTAMP-MAP=/m.test(vtt)) return vtt;
  return String(vtt).replace(/^(?:\uFEFF)?WEBVTT[^\r\n]*(?:\r?\n)/i, (header) => `${header}X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n`);
}

function cueStartSeconds(cue) {
  const match = cue.time.match(/^(\d+):(\d{2}):(\d{2})\.(\d{3})/);
  if (!match) return -1;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function buildHlsSubtitleSegment(vtt, segmentIndex, segmentSeconds = config.hls.segmentSeconds) {
  const start = segmentIndex * segmentSeconds;
  const end = start + segmentSeconds;
  const cues = parseVtt(vtt).filter((cue) => {
    const cueStart = cueStartSeconds(cue);
    return cueStart >= start && cueStart < end;
  });
  return addHlsTimestampMap(serializeVtt(cues));
}

function createAddonRouter() {
  const router = express.Router();
  router.get("/manifest.json", (_req, res) => res.json(buildManifest()));
  router.get("/stream/:type/:id.json", async (req, res) => {
    const { type, id } = req.params;
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    try { res.json({ streams: (await aggregateStreams(type, id)).flatMap(streamViews) }); }
    catch (error) { logger.warn("Stream aggregation rejected", { type, id, error: error.message }); res.json({ streams: [] }); }
  });
  const subtitlesHandler = ({ params }, res) => {
    const { id } = params;
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    const subtitles = selectSubtitleSources(id, params.extra).map((source) => ({ source, status: associatedTranslationStatus(source) }))
      .filter(({ status }) => status.status === "ready")
      .map(({ source, status }) => externalSubtitleView(source, status, { includeAddon: true }));
    res.json({ subtitles });
  };
  router.get("/subtitles/:type/:id/:extra.json", subtitlesHandler);
  router.get("/subtitles/:type/:id.json", subtitlesHandler);
  return router;
}

function requireAdmin(req, res, next) {
  if (!config.adminToken) return res.status(503).json({ error: "ADMIN_TOKEN is not configured" });
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  if (supplied !== config.adminToken) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function selectEpisodeSource(type, videoId, preferredSourceId = null) {
  parseVideoId(type, videoId);
  let items = await aggregateStreams(type, videoId);
  if (!items.length) {
    items = sourceStore.list({ videoId, limit: 500 }).filter((record) => record.url || record.infoHash).map((record) => ({ record }));
  }
  if (!items.length) throw new Error("Nenhuma fonte reproduzível foi encontrada para este conteúdo");
  if (preferredSourceId) {
    const preferred = items.find((item) => item.record.sourceId === preferredSourceId);
    if (preferred) return preferred;
  }
  let affinity = null;
  try {
    const { imdbId } = parseVideoId(type, videoId);
    const currentSourceId = watchStore.get(imdbId)?.currentSourceId;
    if (currentSourceId) affinity = sourceStore.get(currentSourceId);
  } catch (_) {}
  return affinity ? selectAffinityItem(items, affinity) : items[0];
}

async function prepareEpisodeSelection({ type, videoId, sourceId = null }) {
  if (!['movie', 'series'].includes(type)) throw new Error("Tipo de conteúdo inválido");
  const selected = await selectEpisodeSource(type, videoId, sourceId);
  const current = selected.record;
  const record = sourceStore.upsert(current.localPath ? current : { ...current, acquisitionState: "queued" });
  if (manager.episodeView(record).subtitle.status !== "ready") {
    await savePendingSubtitle(record.sourceId);
    const job = await queueTranslationJob(record.sourceId, 1);
    const processingStages = new Set(["acquiring", "recovering", "probing", "transcribing", "synchronizing", "contextualizing", "aligning", "translating", "validating", "packaging"]);
    transitionIf(record.sourceId, "queued", { progress: 0, downloadProgress: record.localPath ? 100 : 0, error: null }, (currentMeta) => !processingStages.has(currentMeta.stage));
    return manager.episodeView(sourceStore.get(record.sourceId), { jobId: job.id });
  }
  return manager.episodeView(sourceStore.get(record.sourceId));
}

function createApp() {
  const app = express();
  fs.mkdirSync(config.storageDir, { recursive: true });
  try { pruneHlsCache(); } catch (error) { logger.warn("Falha ao limpar cache HLS", { error: error.message }); }
  scheduleHlsCachePruning();
  app.disable("x-powered-by");
  app.use(createClientAccessMiddleware(config.allowedClientIps));
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type, Range");
    res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  app.use(express.json({ limit: "256kb" }));
  app.use("/manager", express.static(path.join(__dirname, "manager"), { extensions: ["html"] }));
  app.get("/manager", (_req, res) => res.redirect(302, "/manager/"));
  app.use((req, res, next) => {
    const started = Date.now();
    let finished = false;
    res.on("finish", () => {
      finished = true;
      logger.info("HTTP request", { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started });
    });
    res.on("close", () => {
      if (finished) return;
      logger.warn("HTTP client disconnected", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - started,
        range: req.headers.range || null,
        userAgent: String(req.headers["user-agent"] || "").slice(0, 200),
      });
    });
    next();
  });
  app.get("/healthz", async (_req, res) => {
    const report = await healthReport();
    res.status(report.status === "ok" ? 200 : 503).json(report);
  });
  app.get("/metrics", (_req, res) => { res.type("text/plain").send(getMetricsText()); });

  function serveLocalMedia(req, res, file) {
    const stat = fs.statSync(file);
    const range = req.headers.range;
    res.setHeader("Accept-Ranges", "bytes");
    const contentTypes = { ".mkv": "video/x-matroska", ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".webm": "video/webm", ".avi": "video/x-msvideo", ".mov": "video/quicktime", ".ts": "video/mp2t", ".m2ts": "video/mp2t" };
    res.setHeader("Content-Type", contentTypes[path.extname(file).toLowerCase()] || "application/octet-stream");
    if (!range) {
      res.setHeader("Content-Length", stat.size);
      return fs.createReadStream(file).pipe(res);
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
    let start;
    let end;
    if (!match[1] && match[2]) {
      const suffixLength = Number(match[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
      start = Math.max(0, stat.size - suffixLength);
      end = stat.size - 1;
    } else {
      start = match[1] ? Number(match[1]) : 0;
      end = match[2] ? Number(match[2]) : stat.size - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) return res.status(416).setHeader("Content-Range", `bytes */${stat.size}`).end();
    end = Math.min(end, stat.size - 1);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", end - start + 1);
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  app.get("/play/:sourceId", async (req, res) => {
    const source = sourceStore.get(req.params.sourceId);
    if (!source) return res.status(404).send("Source not found");
    watchStore.markPlayback(source);
    scheduleSeriesPrefetch(source.sourceId).catch((error) => logger.warn("Automatic series prefetch failed", { sourceId: source.sourceId, error: error.message }));
    const subtitleStatus = associatedTranslationStatus(source);
    if (subtitleStatus.status !== "ready") {
      queueTranslationJob(source.sourceId, 1).catch((error) => logger.error("Failed to enqueue selected subtitle", { sourceId: source.sourceId, error: error.message }));
    }
    if (source.localPath && fs.existsSync(source.localPath)) {
      if (subtitleStatus.status === "ready" && subtitleStatus.srtPath) {
        try {
          const prepared = await ensureEmbeddedPlayback(subtitleStatus.subtitleSourceId, source.localPath, subtitleStatus.srtPath);
          return serveLocalMedia(req, res, prepared);
        } catch (error) {
          logger.error("Falha ao servir MKV local com PT-BR interna", { sourceId: source.sourceId, subtitleSourceId: subtitleStatus.subtitleSourceId, error: error.message });
          res.setHeader("Retry-After", "15");
          return res.status(503).send("A reprodução local com legenda PT-BR ainda não pôde ser preparada. Tente novamente em instantes.");
        }
      }
      return serveLocalMedia(req, res, source.localPath);
    }
    res.setHeader("Cache-Control", "no-store");
    if (source.url) return res.redirect(307, source.url);
    if (source.infoHash) {
      res.setHeader("Retry-After", "30");
      return res.status(202).send("Download iniciado. Aguarde e selecione este stream novamente.");
    }
    return res.status(404).send("Source is unresolved");
  });

  app.get("/hls/:sourceId/master.m3u8", async (req, res) => {
    const source = sourceStore.get(req.params.sourceId);
    if (!source) return res.status(404).send("Source not found");
    watchStore.markPlayback(source);
    scheduleSeriesPrefetch(source.sourceId).catch((error) => logger.warn("Automatic series prefetch failed", { sourceId: source.sourceId, error: error.message }));
    if (associatedTranslationStatus(source).status !== "ready") {
      queueTranslationJob(source.sourceId, 1).catch((error) => logger.error("Failed to prepare HLS subtitle", { sourceId: source.sourceId, error: error.message }));
    }
    if (!source.localPath || !fs.existsSync(source.localPath)) {
      queueTranslationJob(source.sourceId, 1).catch((error) => logger.error("Failed to prepare HLS source", { sourceId: source.sourceId, error: error.message }));
      res.setHeader("Retry-After", "30");
      res.setHeader("Cache-Control", "no-store");
      return res.status(503).send("Download e preparação iniciados. Tente este stream novamente em alguns minutos.");
    }
    try {
      const subtitleSource = subtitleOwner(source);
      try { repairSubtitleLayout(subtitleSource.sourceId); } catch (error) { logger.warn("Falha ao preservar layout HLS", { sourceId: subtitleSource.sourceId, error: error.message }); }
      const translated = subtitlePath(subtitleSource.sourceId, "pt-BR.vtt");
      const ass = subtitlePath(subtitleSource.sourceId, "pt-BR.ass");
      const srt = subtitlePath(subtitleSource.sourceId, "pt-BR.srt");
      const subtitleFile = fs.existsSync(ass) ? ass : fs.existsSync(srt) ? srt : null;
      const { plan } = await ensureHls(source.sourceId, source.localPath, { subtitleFile });
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      return res.send(buildHlsMasterPlaylist(fs.existsSync(translated) && !plan.subtitleBurnedIn, plan.audioTracks));
    } catch (error) {
      logger.error("HLS preparation failed", { sourceId: source.sourceId, error: error.message });
      res.setHeader("Retry-After", "15");
      return res.status(503).send("Conversão HLS temporariamente indisponível");
    }
  });

  app.get("/hls/:sourceId/video.m3u8", (req, res) => {
    let file;
    try { file = hlsOutputPath(req.params.sourceId, "video.m3u8"); } catch (_) { return res.status(400).send("Invalid path"); }
    if (!fs.existsSync(file)) return res.status(404).send("Video playlist not found");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return fs.createReadStream(file).pipe(res);
  });

  app.get("/hls/:sourceId/:audioPlaylist", (req, res, next) => {
    if (!/^audio-\d+\.m3u8$/.test(req.params.audioPlaylist)) return next();
    let file;
    try { file = hlsOutputPath(req.params.sourceId, req.params.audioPlaylist); } catch (_) { return res.status(400).send("Invalid path"); }
    if (!fs.existsSync(file)) return res.status(404).send("Audio playlist not found");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return fs.createReadStream(file).pipe(res);
  });

  app.get("/hls/:sourceId/subtitles.m3u8", (req, res) => {
    let file;
    try {
      const source = sourceStore.get(req.params.sourceId);
      if (!source) return res.status(404).send("Source not found");
      file = subtitlePath(subtitleOwner(source).sourceId, "pt-BR.vtt");
    } catch (_) { return res.status(400).send("Invalid path"); }
    if (!fs.existsSync(file)) return res.status(404).send("Subtitle not found");
    const vtt = fs.readFileSync(file, "utf8");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.send(buildHlsSubtitlePlaylist(vtt));
  });

  app.get("/hls/:sourceId/subtitle-:segment.vtt", (req, res) => {
    if (!/^\d{5}$/.test(req.params.segment)) return res.status(404).send("Subtitle segment not found");
    let file;
    try {
      const source = sourceStore.get(req.params.sourceId);
      if (!source) return res.status(404).send("Source not found");
      file = subtitlePath(subtitleOwner(source).sourceId, "pt-BR.vtt");
    } catch (_) { return res.status(400).send("Invalid path"); }
    if (!fs.existsSync(file)) return res.status(404).send("Subtitle not found");
    const segmentIndex = Number(req.params.segment);
    const vtt = fs.readFileSync(file, "utf8");
    if (segmentIndex * config.hls.segmentSeconds >= subtitleDurationSeconds(vtt)) return res.status(404).send("Subtitle segment not found");
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.send(buildHlsSubtitleSegment(vtt, segmentIndex));
  });

  app.get("/hls/:sourceId/:fileName", (req, res) => {
    const { sourceId, fileName } = req.params;
    if (!/^(?:segment|audio-\d+)-\d{5}\.ts$/.test(fileName)) return res.status(404).send("Not found");
    let file;
    try { file = hlsOutputPath(sourceId, fileName); } catch (_) { return res.status(400).send("Invalid path"); }
    if (!fs.existsSync(file)) return res.status(404).send("Segment not found");
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return fs.createReadStream(file).pipe(res);
  });

  app.get("/assets/subtitles/:sourceId/:fileName", (req, res) => {
    const { sourceId, fileName } = req.params;
    if (!["pending.vtt", "pt-BR.vtt", "pt-BR.srt", "pt-BR.ass", "original.vtt"].includes(fileName)) return res.status(404).send("Not found");
    if (!verifyPath(req.query.token, [sourceId, fileName], config.subtitleTokenSecret)) return res.status(403).send("Invalid or expired token");
    if (["pt-BR.vtt", "pt-BR.ass"].includes(fileName)) try { repairSubtitleLayout(sourceId); } catch (error) { logger.warn("Falha ao preservar layout do recurso", { sourceId, error: error.message }); }
    if (fileName === "pt-BR.srt") try {
      const translated = subtitlePath(sourceId, "pt-BR.vtt");
      if (fs.existsSync(translated)) ensureSrtSubtitle(sourceId, translated);
    } catch (error) { logger.warn("Falha ao atualizar recurso SRT", { sourceId, error: error.message }); }
    let file;
    try { file = subtitlePath(sourceId, fileName); } catch (_) { return res.status(400).send("Invalid path"); }
    if (!fs.existsSync(file)) return res.status(404).send("Subtitle not found");
    res.setHeader("Content-Type", fileName.endsWith(".ass")
      ? "text/x-ssa; charset=utf-8"
      : fileName.endsWith(".srt") ? "application/x-subrip; charset=utf-8" : "text/vtt; charset=utf-8");
    res.setHeader("Cache-Control", fileName === "original.vtt" ? "private, max-age=3600" : "no-cache, no-store, must-revalidate");
    fs.createReadStream(file).pipe(res);
  });

  app.use("/api", requireAdmin);

  async function deleteManagedSource(sourceId, options = {}) {
    if (!sourceStore.get(sourceId)) return null;
    markCancelled(sourceId);
    const job = await getQueue().getJob(sourceId);
    let cancellation = "none";
    if (job) {
      const state = await job.getState();
      cancellation = state === "active" ? "requested" : "removed";
      if (state !== "active") await job.remove();
    }
    const deleted = await manager.deleteArtifacts(sourceId, options);
    return deleted ? { sourceId, cancellation } : null;
  }

  app.post("/api/batch/prepare", async (req, res, next) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (!items.length || items.length > 100) return res.status(400).json({ error: "Selecione entre 1 e 100 itens" });
      const results = [];
      for (const item of items) {
        try {
          const episode = await prepareEpisodeSelection(item || {});
          results.push({ ok: true, videoId: item.videoId, sourceId: episode.sourceId, status: episode.status });
        } catch (error) {
          results.push({ ok: false, videoId: item?.videoId || null, error: error.message });
        }
      }
      const prepared = results.filter((item) => item.ok).length;
      logger.info("Manager batch preparation requested", { requested: items.length, prepared, failed: items.length - prepared });
      res.status(prepared ? 202 : 422).json({ prepared, failed: items.length - prepared, results });
    } catch (error) { next(error); }
  });

  app.post("/api/batch/delete", async (req, res, next) => {
    try {
      const sourceIds = [...new Set((Array.isArray(req.body?.sourceIds) ? req.body.sourceIds : []).map(String))];
      if (!sourceIds.length || sourceIds.length > 100) return res.status(400).json({ error: "Selecione entre 1 e 100 itens preparados" });
      const results = [];
      for (const sourceId of sourceIds) {
        try {
          const deleted = await deleteManagedSource(sourceId, {});
          results.push(deleted ? { ok: true, ...deleted } : { ok: false, sourceId, error: "Fonte não encontrada" });
        } catch (error) { results.push({ ok: false, sourceId, error: error.message }); }
      }
      const deleted = results.filter((item) => item.ok).length;
      logger.info("Manager batch deletion requested", { requested: sourceIds.length, deleted, failed: sourceIds.length - deleted });
      res.json({ deleted, failed: sourceIds.length - deleted, results });
    } catch (error) { next(error); }
  });
  app.get("/api/jobs", (_req, res) => res.json({ jobs: sourceStore.list().map((source) => ({ sourceId: source.sourceId, videoId: source.videoId, addonName: source.addonName, ...readMeta(source.sourceId) })) }));
  app.get("/api/jobs/:sourceId", (req, res) => res.json({ source: sourceStore.publicSource(sourceStore.get(req.params.sourceId)), job: readMeta(req.params.sourceId) }));
  app.post("/api/sources/:sourceId/prepare", async (req, res, next) => { try { if (!sourceStore.get(req.params.sourceId)) return res.status(404).json({ error: "Source not found" }); const job = await queueTranslationJob(req.params.sourceId, 1); res.status(202).json({ jobId: job.id }); } catch (error) { next(error); } });
  app.post("/api/jobs/:sourceId/retry", async (req, res, next) => {
    try {
      const job = await getQueue().getJob(req.params.sourceId);
      if (!job) return res.status(404).json({ error: "Job not found" });
      if ((await job.getState()) !== "failed") return res.status(409).json({ error: "Only failed jobs can be retried" });
      const failedFile = subtitlePath(req.params.sourceId, "failed.json");
      if (fs.existsSync(failedFile)) fs.unlinkSync(failedFile);
      await job.retry();
      res.status(202).json({ jobId: job.id });
    } catch (error) { next(error); }
  });
  app.post("/api/jobs/:sourceId/cancel", async (req, res, next) => {
    try {
      const job = await getQueue().getJob(req.params.sourceId);
      if (!job) return res.status(404).json({ error: "Job not found" });
      const state = await job.getState();
      if (state === "active") return res.status(409).json({ error: "Active FFmpeg work cannot be interrupted safely; stop the worker first" });
      await job.remove();
      res.status(204).end();
    } catch (error) { next(error); }
  });
  app.get("/api/library", (_req, res) => res.json({ sources: sourceStore.list().map(sourceStore.publicSource) }));
  app.get("/api/storage", (_req, res) => res.json({ path: config.storageDir, sources: sourceStore.list().length }));

  app.get("/api/manager", async (_req, res, next) => {
    try {
      const allSources = sourceStore.list({ limit: 5000 });
      const shows = manager.libraryView(allSources);
      for (const show of shows.filter((item) => item.type === "series")) {
        const { meta, videos } = readSeriesMetadataCache(show.imdbId);
        show.title = meta.name || show.title;
        show.poster = meta.poster || null;
        show.background = meta.background || null;
        show.catalogEpisodes = videos.map((video) => ({ id: video.id, title: video.title || video.name || null, season: Number(video.season), episode: Number(video.episode ?? video.number), released: video.released || null }));
        if (!meta.name || !videos.length) fetchSeriesMetadata(show.imdbId).catch((error) => logger.warn("Series catalog refresh failed", { imdbId: show.imdbId, error: error.message }));
      }
      const logs = [...manager.stateErrorLogs(allSources), ...logger.readLogs({ limit: 100 })].sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const usedBytes = await getStorageUsage();
      res.json({
        generatedAt: new Date().toISOString(),
        shows,
        storage: manager.storageView(shows, allSources.length, usedBytes),
        recentErrors: logs.filter((entry) => ["warn", "error"].includes(entry.level)).slice(0, 12),
        settings: { defaultPrefetchAhead: 0, maxPrefetchAhead: 12, targetLocale: config.targetLocale },
      });
    } catch (error) { next(error); }
  });

  app.get("/api/logs", (req, res) => {
    const level = req.query.level || "";
    const sourceId = req.query.sourceId || "";
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
    const logs = [...manager.stateErrorLogs(sourceStore.list({ limit: 5000 })), ...logger.readLogs({ limit: 1000 })]
      .filter((entry) => !level || entry.level === level)
      .filter((entry) => !sourceId || entry.meta?.sourceId === sourceId || entry.meta?.jobId === sourceId)
      .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
    res.json({ logs });
  });

  app.patch("/api/shows/:imdbId", async (req, res, next) => {
    try {
      const patch = {};
      if (req.body.prefetchAhead !== undefined) {
        const value = Number(req.body.prefetchAhead);
        if (!Number.isInteger(value) || value < 0 || value > 12) return res.status(400).json({ error: "prefetchAhead must be an integer between 0 and 12" });
        patch.prefetchAhead = value;
      }
      if (req.body.status !== undefined) {
        if (!["watching", "paused", "completed", "library"].includes(req.body.status)) return res.status(400).json({ error: "Invalid status" });
        patch.status = req.body.status;
      }
      const item = watchStore.update(req.params.imdbId, patch);
      if (item.currentSourceId && patch.prefetchAhead !== undefined) {
        scheduleSeriesPrefetch(item.currentSourceId, { force: true, ahead: patch.prefetchAhead }).catch((error) => logger.warn("Manual prefetch update failed", { sourceId: item.currentSourceId, error: error.message }));
      }
      res.json({ item });
    } catch (error) { next(error); }
  });

  app.post("/api/sources/:sourceId/reprocess", async (req, res, next) => {
    try {
      if (!sourceStore.get(req.params.sourceId)) return res.status(404).json({ error: "Source not found" });
      const existing = await getQueue().getJob(req.params.sourceId);
      if (existing && (await existing.getState()) === "active") return res.status(409).json({ error: "A legenda já está sendo processada; aguarde a execução atual" });
      for (const fileName of ["pt-BR.vtt", "pt-BR.ass", "original.vtt", "original-raw.vtt", "transcribed.vtt", "processing-audio.flac", "alignment-en-words.json", "alignment-audio-en.flac", "layout-complete.json", "failed.json", "validation-debug.vtt"]) {
        const file = subtitlePath(req.params.sourceId, fileName);
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      }
      transition(req.params.sourceId, "queued", {
        progress: 0,
        cues: null,
        translated: null,
        from: null,
        to: null,
        provider: null,
        translationProvider: null,
        languageDeclared: null,
        languageDetected: null,
        translationSourceLanguage: null,
        translationRoute: null,
        sourceAudioLanguage: null,
        sourceAudioConfidence: null,
        sourceMethod: null,
        origin: null,
        trackIndex: null,
        alignment: null,
        alignmentQuality: null,
        sourceQuality: null,
        finalQuality: null,
        outputs: null,
        error: null,
        extractionError: null,
        transcriptionFallbackReason: null,
      });
      const job = await queueTranslationJob(req.params.sourceId, 1);
      res.status(202).json({ jobId: job.id });
    } catch (error) { next(error); }
  });

  app.get("/api/sources/:sourceId/subtitles/:kind", (req, res) => {
    const names = { raw: "original-raw.vtt", original: "original.vtt", final: "pt-BR.vtt" };
    const fileName = names[req.params.kind];
    if (!fileName) return res.status(404).json({ error: "Artifact not found" });
    let file;
    try { file = subtitlePath(req.params.sourceId, fileName); } catch (_) { return res.status(400).json({ error: "Invalid path" }); }
    if (!fs.existsSync(file)) return res.status(404).json({ error: "Subtitle not found" });
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${req.params.sourceId}-${fileName}"`);
    return fs.createReadStream(file).pipe(res);
  });

  app.delete("/api/sources/:sourceId", async (req, res, next) => {
    try {
      if (!sourceStore.get(req.params.sourceId)) return res.status(404).json({ error: "Source not found" });
      const result = await deleteManagedSource(req.params.sourceId, req.body || {});
      const deleted = result && req.params.sourceId;
      if (!deleted) return res.status(409).json({ error: "Source changed while deletion was being prepared" });
      logger.info("Source artifacts deleted from manager", { sourceId: req.params.sourceId });
      res.json({ deleted: req.params.sourceId, cancellation: result.cancellation });
    } catch (error) { next(error); }
  });

  app.delete("/api/shows/:imdbId", async (req, res, next) => {
    try {
      const matches = sourceStore.list({ limit: 5000 }).filter((source) => {
        try { return parseVideoId(source.type, source.videoId).imdbId === req.params.imdbId; } catch (_) { return source.videoId === req.params.imdbId; }
      });
      for (const source of matches) {
        markCancelled(source.sourceId);
        const job = await getQueue().getJob(source.sourceId);
        if (job && (await job.getState()) !== "active") await job.remove();
        await manager.deleteArtifacts(source.sourceId, req.body || {});
      }
      watchStore.update(req.params.imdbId, { status: "library", currentSourceId: null });
      logger.info("Show artifacts deleted from manager", { imdbId: req.params.imdbId, sources: matches.length });
      res.json({ deleted: matches.length });
    } catch (error) { next(error); }
  });

  app.use("/", createAddonRouter());
  app.use((error, _req, res, _next) => { logger.error("Unhandled request error", { error: error.message }); res.status(500).json({ error: "Internal server error" }); });
  return app;
}

if (require.main === module) createApp().listen(config.port, () => logger.info("Server started", { port: config.port }));

module.exports = {
  addHlsTimestampMap,
  buildHlsMasterPlaylist,
  buildHlsSubtitlePlaylist,
  buildHlsSubtitleSegment,
  buildManifest,
  createApp,
  normalizedFilename,
  selectSubtitleSources,
  subtitleRequestSelector,
  streamView,
  streamViews,
  externalSubtitleView,
  subtitleDurationSeconds,
};
