const express = require("express");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const logger = require("./logger");
const { getMetricsText } = require("./metrics");
const { aggregateStreams } = require("./services/upstreams");
const sourceStore = require("./services/sourceStore");
const { translationStatus, queueTranslationJob, savePendingSubtitle, subtitleUrl, subtitlePath } = require("./services/subtitleService");
const { readMeta } = require("./services/metadata");
const { verifyPath } = require("./utils/security");
const { getQueue } = require("./jobs/queue");
const { ensureHls, outputPath: hlsOutputPath, pruneHlsCache } = require("./services/hlsPlayback");
const { scheduleSeriesPrefetch, fetchSeriesMetadata, readSeriesMetadataCache } = require("./services/seriesPrefetch");
const watchStore = require("./services/watchStore");
const manager = require("./services/manager");
const { parseVideoId } = require("./services/videoId");
const { repairSubtitleLayout } = require("./services/subtitleLayout");

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

function streamView(item, mode = "direct", options = {}) {
  const { stream, record } = item;
  const status = translationStatus(record.sourceId);
  const localReady = Boolean(record.localPath && fs.existsSync(record.localPath));
  const fileName = status.status === "ready"
    ? mode === "direct" && status.assPath ? "pt-BR.ass" : "pt-BR.vtt"
    : "pending.vtt";
  if (status.status !== "ready" && options.savePending !== false) savePendingSubtitle(record.sourceId).catch(() => {});
  const behaviorHints = { ...(stream.behaviorHints || {}), bingeGroup: stream.behaviorHints?.bingeGroup || `pt-auto-${record.sourceId}` };
  if (mode === "hls") delete behaviorHints.filename;
  const result = {
    ...stream,
    name: mode === "hls"
      ? `${localReady ? "WEB HLS" : "WEB PREPARAR"} · ${stream.name || "Stream"}`
      : `${localReady ? "LOCAL" : record.infoHash ? "PREPARAR" : record.addonName} · ${stream.name || "Stream"}`,
    title: mode === "hls"
      ? localReady
        ? `Compatível com navegador · ${stream.title || stream.name || record.filename || "Stream"}`
        : `Primeiro acesso prepara; tente novamente depois · ${stream.title || stream.name || record.filename || "Stream"}`
      : localReady
        ? `Pronto · ${stream.title || stream.name || record.filename || "Stream"}`
        : record.infoHash
          ? `Primeiro clique baixa e prepara · ${stream.title || stream.name || record.filename || "Stream"}`
          : stream.title || stream.name || record.filename || "Stream",
    behaviorHints,
    subtitles: [{
      id: `pt-auto-layout-v2-${record.sourceId}`,
      lang: "por",
      name: status.status === "ready" ? "PT-AUTO · posição original" : "PT-AUTO (preparando)",
      url: subtitleUrl(record.sourceId, fileName),
    }],
  };
  if (mode === "hls") {
    delete result.infoHash;
    delete result.fileIdx;
    result.url = `${config.baseUrl}/hls/${record.sourceId}/master.m3u8`;
  } else if (record.url || record.infoHash) {
    delete result.infoHash;
    delete result.fileIdx;
    result.url = `${config.baseUrl}/play/${record.sourceId}`;
  }
  return result;
}

function streamViews(item, options = {}) {
  const direct = streamView(item, "direct", options);
  const { record } = item;
  if (!record.infoHash && !record.localPath) return [direct];
  return [direct, streamView(item, "hls", options)];
}

function buildHlsMasterPlaylist(hasPtBrSubtitle) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"];
  if (hasPtBrSubtitle) {
    lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Português (Brasil)",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="pt-BR",URI="subtitles.m3u8"');
  }
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${(config.hls.videoBitrateKbps + config.hls.audioBitrateKbps) * 1000}${hasPtBrSubtitle ? ',SUBTITLES="subs"' : ""}`);
  lines.push("video.m3u8", "");
  return lines.join("\n");
}

function subtitleDurationSeconds(vtt) {
  const matches = [...String(vtt).matchAll(/-->\s*(\d+:\d{2}:\d{2}\.\d{3})/g)];
  if (!matches.length) return 1;
  const [hours, minutes, seconds] = matches.at(-1)[1].split(":");
  return Math.max(1, Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds));
}

function buildHlsSubtitlePlaylist(vtt) {
  const duration = subtitleDurationSeconds(vtt);
  return [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.ceil(duration)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    `#EXTINF:${duration.toFixed(3)},`,
    "subtitle.vtt",
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
}

function addHlsTimestampMap(vtt) {
  if (/^X-TIMESTAMP-MAP=/m.test(vtt)) return vtt;
  return String(vtt).replace(/^(?:\uFEFF)?WEBVTT[^\r\n]*(?:\r?\n)/i, (header) => `${header}X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n`);
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
    const subtitles = sourceStore.list({ videoId: id }).map((source) => ({ source, status: translationStatus(source.sourceId) }))
      .filter(({ status }) => status.status === "ready")
      .map(({ source, status }) => ({
        id: `pt-auto-layout-v2-${source.sourceId}`,
        lang: "por",
        name: `PT-AUTO · posição original · ${source.addonName}`,
        url: status.assUrl || status.url,
      }));
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

function createApp() {
  const app = express();
  fs.mkdirSync(config.storageDir, { recursive: true });
  try { pruneHlsCache(); } catch (error) { logger.warn("Falha ao limpar cache HLS", { error: error.message }); }
  app.disable("x-powered-by");
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
  app.use((req, res, next) => { const started = Date.now(); res.on("finish", () => logger.info("HTTP request", { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started })); next(); });
  app.get("/healthz", (_req, res) => res.json({ status: "ok", upstreams: config.upstreamAddons.length }));
  app.get("/metrics", (_req, res) => { res.type("text/plain").send(getMetricsText()); });

  function serveLocalMedia(req, res, file) {
    const stat = fs.statSync(file);
    const range = req.headers.range;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/x-matroska");
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
    scheduleSeriesPrefetch(source.sourceId).catch((error) => logger.warn("Series prefetch failed", { sourceId: source.sourceId, error: error.message }));
    if (source.localPath && fs.existsSync(source.localPath)) return serveLocalMedia(req, res, source.localPath);
    queueTranslationJob(source.sourceId, 1).catch((error) => logger.error("Failed to enqueue selected source", { sourceId: source.sourceId, error: error.message }));
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
    scheduleSeriesPrefetch(source.sourceId).catch((error) => logger.warn("Series prefetch failed", { sourceId: source.sourceId, error: error.message }));
    if (!source.localPath || !fs.existsSync(source.localPath)) {
      queueTranslationJob(source.sourceId, 1).catch((error) => logger.error("Failed to prepare HLS source", { sourceId: source.sourceId, error: error.message }));
      res.setHeader("Retry-After", "30");
      res.setHeader("Cache-Control", "no-store");
      return res.status(503).send("Download e preparação iniciados. Tente este stream novamente em alguns minutos.");
    }
    try {
      await ensureHls(source.sourceId, source.localPath);
      try { repairSubtitleLayout(source.sourceId); } catch (error) { logger.warn("Falha ao preservar layout HLS", { sourceId: source.sourceId, error: error.message }); }
      const translated = subtitlePath(source.sourceId, "pt-BR.vtt");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      return res.send(buildHlsMasterPlaylist(fs.existsSync(translated)));
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

  app.get("/hls/:sourceId/subtitles.m3u8", (req, res) => {
    let file;
    try { file = subtitlePath(req.params.sourceId, "pt-BR.vtt"); } catch (_) { return res.status(400).send("Invalid path"); }
    if (!fs.existsSync(file)) return res.status(404).send("Subtitle not found");
    const vtt = fs.readFileSync(file, "utf8");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.send(buildHlsSubtitlePlaylist(vtt));
  });

  app.get("/hls/:sourceId/subtitle.vtt", (req, res) => {
    let file;
    try { file = subtitlePath(req.params.sourceId, "pt-BR.vtt"); } catch (_) { return res.status(400).send("Invalid path"); }
    if (!fs.existsSync(file)) return res.status(404).send("Subtitle not found");
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.send(addHlsTimestampMap(fs.readFileSync(file, "utf8")));
  });

  app.get("/hls/:sourceId/:fileName", (req, res) => {
    const { sourceId, fileName } = req.params;
    if (!/^segment-\d{5}\.ts$/.test(fileName)) return res.status(404).send("Not found");
    let file;
    try { file = hlsOutputPath(sourceId, fileName); } catch (_) { return res.status(400).send("Invalid path"); }
    if (!fs.existsSync(file)) return res.status(404).send("Segment not found");
    res.setHeader("Content-Type", "video/mp2t");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return fs.createReadStream(file).pipe(res);
  });

  app.get("/assets/subtitles/:sourceId/:fileName", (req, res) => {
    const { sourceId, fileName } = req.params;
    if (!["pending.vtt", "pt-BR.vtt", "pt-BR.ass", "original.vtt"].includes(fileName)) return res.status(404).send("Not found");
    if (!verifyPath(req.query.token, [sourceId, fileName], config.subtitleTokenSecret)) return res.status(403).send("Invalid or expired token");
    if (["pt-BR.vtt", "pt-BR.ass"].includes(fileName)) try { repairSubtitleLayout(sourceId); } catch (error) { logger.warn("Falha ao preservar layout do recurso", { sourceId, error: error.message }); }
    let file;
    try { file = subtitlePath(sourceId, fileName); } catch (_) { return res.status(400).send("Invalid path"); }
    if (!fs.existsSync(file)) return res.status(404).send("Subtitle not found");
    res.setHeader("Content-Type", fileName.endsWith(".ass") ? "text/x-ssa; charset=utf-8" : "text/vtt; charset=utf-8");
    res.setHeader("Cache-Control", fileName === "original.vtt" ? "private, max-age=3600" : "no-cache, no-store, must-revalidate");
    fs.createReadStream(file).pipe(res);
  });

  app.use("/api", requireAdmin);
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
      res.json({
        generatedAt: new Date().toISOString(),
        shows,
        storage: manager.storageView(shows, allSources.length),
        recentErrors: logs.filter((entry) => ["warn", "error"].includes(entry.level)).slice(0, 12),
        settings: { defaultPrefetchAhead: config.prefetch.ahead, maxPrefetchAhead: 12, targetLocale: config.targetLocale },
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
      for (const fileName of ["pt-BR.vtt", "failed.json", "validation-debug.vtt"]) {
        const file = subtitlePath(req.params.sourceId, fileName);
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      }
      const job = await queueTranslationJob(req.params.sourceId, 1);
      res.status(202).json({ jobId: job.id });
    } catch (error) { next(error); }
  });

  app.get("/api/sources/:sourceId/subtitles/:kind", (req, res) => {
    const names = { original: "original.vtt", final: "pt-BR.vtt" };
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
      const deleted = await manager.deleteArtifacts(req.params.sourceId, req.body || {});
      if (!deleted) return res.status(404).json({ error: "Source not found" });
      logger.info("Source artifacts deleted from manager", { sourceId: req.params.sourceId });
      res.json({ deleted: req.params.sourceId });
    } catch (error) { next(error); }
  });

  app.delete("/api/shows/:imdbId", async (req, res, next) => {
    try {
      const matches = sourceStore.list({ limit: 5000 }).filter((source) => {
        try { return parseVideoId(source.type, source.videoId).imdbId === req.params.imdbId; } catch (_) { return source.videoId === req.params.imdbId; }
      });
      for (const source of matches) await manager.deleteArtifacts(source.sourceId, req.body || {});
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
  buildManifest,
  createApp,
  streamView,
  streamViews,
  subtitleDurationSeconds,
};
