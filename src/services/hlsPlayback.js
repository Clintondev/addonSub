const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { execFile, spawn } = require("child_process");
const config = require("../config");
const logger = require("../logger");
const { safeChildPath, stableHash } = require("../utils/security");
const { writeJsonFileAtomic } = require("../utils/atomicJson");
const { acquireGpuLock } = require("./gpuLock");
const { acquireSemaphoreSlot } = require("./distributedSemaphore");
const { reserveStorage } = require("./storageQuota");
const { directorySize, invalidateStorageUsage } = require("./storageUsage");
const { probeMediaTracks } = require("./ffextract");
const { mediaIdentity } = require("./mediaIdentity");
const { isCancelled } = require("./cancellationStore");

const active = new Map();
const starting = new Map();
let nvencSupport;
const HLS_CACHE_VERSION = 7;

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

function outputDir(sourceId) {
  return safeChildPath(config.hlsDir, sourceId);
}

function outputPath(sourceId, fileName, generation = null) {
  const metadata = readMetadata(sourceId, generation);
  if (metadata?.generation) return safeChildPath(config.hlsDir, sourceId, "versions", metadata.generation, fileName);
  return safeChildPath(config.hlsDir, sourceId, fileName);
}

async function probeMedia(input) {
  return probeMediaTracks(input);
}

async function supportsNvenc() {
  if (nvencSupport === undefined) {
    nvencSupport = execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=size=320x180:rate=1",
      "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-",
    ]).then(() => true).catch((error) => {
      logger.warn("NVENC indisponível; HLS usará CPU", { error: String(error.stderr || error.message).trim().slice(-500) });
      return false;
    });
  }
  return nvencSupport;
}

function choosePlan(probe, nvencAvailable) {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audioStreams = probe.streams?.filter((stream) => stream.codec_type === "audio") || [];
  const audio = audioStreams[0];
  const declaredDefault = audioStreams.findIndex((stream) => Number(stream.disposition?.default) === 1);
  const defaultAudioIndex = declaredDefault >= 0 ? declaredDefault : 0;
  if (!video) throw new Error("O arquivo não contém vídeo");
  const pixelFormat = String(video.pix_fmt || "").toLowerCase();
  const profile = String(video.profile || "").toLowerCase();
  const browserCompatibleH264 = video.codec_name === "h264"
    && (!pixelFormat || ["yuv420p", "yuvj420p"].includes(pixelFormat))
    && !/(?:10|4:2:2|4:4:4)/.test(profile);
  return {
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name || null,
    videoMode: browserCompatibleH264 ? "copy" : nvencAvailable ? "nvenc" : "cpu",
    // HLS always gets a fresh AAC timeline. Copying audio from MKV files can
    // preserve a large source timestamp offset and leave web/VLC players on a
    // black screen while they wait for the first synchronized frame.
    audioMode: !audio ? "none" : "aac",
    audioTracks: audioStreams.map((stream, outputIndex) => ({
      inputIndex: stream.index,
      outputIndex,
      codec: stream.codec_name || null,
      channels: 2,
      sourceChannels: stream.channels || null,
      language: String(stream.tags?.language || "und").toLowerCase(),
      title: stream.tags?.title || null,
      isDefault: outputIndex === defaultAudioIndex,
      playlist: `audio-${outputIndex}.m3u8`,
    })),
  };
}

function subtitleFilterPath(file) {
  return String(file).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function buildFfmpegArgs(input, playlist, plan, options = config.hls, subtitleFile = null) {
  const dir = path.dirname(playlist);
  const segmentPattern = path.join(dir, "video-only-%05d.ts");
  const args = [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-fflags", "+genpts",
    "-i", input,
    "-map", "0:v:0", "-an",
  ];
  args.push("-sn", "-dn");

  if (plan.videoMode === "copy") {
    // start_at_zero shifts copied streams without decoding them.
    args.push("-copyts", "-start_at_zero", "-c:v", "copy");
  } else if (plan.videoMode === "nvenc") {
    const filters = ["setpts=PTS-STARTPTS", `scale=-2:min(${options.maxHeight}\\,ih)`];
    if (subtitleFile) filters.push(`subtitles=filename='${subtitleFilterPath(subtitleFile)}'`);
    filters.push("format=yuv420p");
    args.push(
      "-vf", filters.join(","),
      "-c:v", "h264_nvenc", "-preset", "p4", "-tune", "ll",
      // NVENC's automatic delay can move MPEG-TS timestamps by more than two
      // minutes on some drivers. Low-latency output keeps the first frame at
      // zero and a fixed GOP gives HLS independently decodable segments.
      "-delay", "0", "-zerolatency", "1",
      "-g", String(Math.max(1, Math.round(24 * options.segmentSeconds))), "-forced-idr", "1",
      "-rc", "vbr", "-cq", "23", "-b:v", `${options.videoBitrateKbps}k`,
      "-maxrate", `${Math.round(options.videoBitrateKbps * 1.5)}k`,
      "-bufsize", `${options.videoBitrateKbps * 2}k`, "-profile:v", "high", "-pix_fmt", "yuv420p"
    );
  } else {
    const filters = ["setpts=PTS-STARTPTS", `scale=-2:min(${options.maxHeight}\\,ih)`];
    if (subtitleFile) filters.push(`subtitles=filename='${subtitleFilterPath(subtitleFile)}'`);
    filters.push("format=yuv420p");
    args.push(
      "-vf", filters.join(","),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      "-maxrate", `${Math.round(options.videoBitrateKbps * 1.5)}k`,
      "-bufsize", `${options.videoBitrateKbps * 2}k`, "-profile:v", "high", "-pix_fmt", "yuv420p"
    );
  }

  if (plan.videoMode !== "copy") {
    args.push("-force_key_frames", `expr:gte(t,n_forced*${options.segmentSeconds})`, "-sc_threshold", "0");
  }
  args.push(
    "-muxpreload", "0", "-muxdelay", "0",
    "-f", "hls", "-hls_time", String(options.segmentSeconds), "-hls_list_size", "0",
    "-hls_playlist_type", "event", "-hls_flags", "independent_segments+temp_file",
    "-hls_segment_filename", segmentPattern, playlist
  );

  for (const track of (plan.audioTracks || []).filter((candidate) => candidate.playlist)) {
    const audioPlaylist = path.join(dir, track.playlist);
    const audioSegmentPattern = path.join(dir, `audio-${track.outputIndex}-%05d.ts`);
    args.push(
      "-map", `0:${track.inputIndex}`, "-vn", "-sn", "-dn",
      "-af", "asetpts=PTS-STARTPTS", "-c:a", "aac",
      "-b:a", `${options.audioBitrateKbps}k`, "-ac", "2",
      "-muxpreload", "0", "-muxdelay", "0",
      "-f", "hls", "-hls_time", String(options.segmentSeconds), "-hls_list_size", "0",
      "-hls_playlist_type", "event", "-hls_flags", "independent_segments+temp_file",
      "-hls_segment_filename", audioSegmentPattern, audioPlaylist
    );
  }
  return args;
}

function playlistReady(playlist) {
  try {
    const content = fs.readFileSync(playlist, "utf8");
    return content.includes("#EXTINF:") && /(?:video-only|audio-\d+)-\d{5}\.ts/.test(content);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function playlistComplete(playlist) {
  try {
    const content = fs.readFileSync(playlist, "utf8");
    return content.includes("#EXTINF:") && /(?:video-only|audio-\d+)-\d{5}\.ts/.test(content)
      && content.includes("#EXT-X-ENDLIST");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function finalizeVodPlaylist(playlist) {
  const content = fs.readFileSync(playlist, "utf8");
  if (!content.includes("#EXT-X-ENDLIST")) throw new Error("A playlist HLS ainda não está completa");
  if (content.includes("#EXT-X-PLAYLIST-TYPE:VOD")) return;
  if (!content.includes("#EXT-X-PLAYLIST-TYPE:EVENT")) throw new Error("Tipo de playlist HLS inesperado");
  const temporary = `${playlist}.${process.pid}.${Date.now()}.vod.tmp`;
  try {
    fs.writeFileSync(temporary, content.replace("#EXT-X-PLAYLIST-TYPE:EVENT", "#EXT-X-PLAYLIST-TYPE:VOD"));
    fs.renameSync(temporary, playlist);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function finalizeVodPlaylists(sourceId, plan, directory = null) {
  const file = (name) => directory ? path.join(directory, name) : outputPath(sourceId, name);
  const playlists = [file("video-only.m3u8"),
    ...(plan.audioTracks || []).filter((track) => track.playlist).map((track) => file(track.playlist))];
  playlists.forEach(finalizeVodPlaylist);
}

function metadataPath(sourceId) {
  return safeChildPath(config.hlsDir, sourceId, "stream-info.json");
}

function inputFingerprint(input, subtitleFile = null) {
  const { segmentSeconds, videoBitrateKbps, audioBitrateKbps, maxHeight } = config.hls;
  return stableHash(JSON.stringify({ input: mediaIdentity(input), subtitle: subtitleFile ? mediaIdentity(subtitleFile) : null, version: HLS_CACHE_VERSION, encoding: { segmentSeconds, videoBitrateKbps, audioBitrateKbps, maxHeight } }), 48);
}

function writeMetadata(sourceId, plan, fingerprint, outputBytes = 0, generation = null, totalOutputBytes = outputBytes) {
  const metadata = { version: HLS_CACHE_VERSION, fingerprint, plan, outputBytes, totalOutputBytes, generation };
  if (generation) writeJsonFileAtomic(safeChildPath(config.hlsDir, sourceId, "versions", generation, "stream-info.json"), metadata);
  writeJsonFileAtomic(metadataPath(sourceId), metadata);
}

function readMetadata(sourceId, generation = null) {
  try {
    if (generation && !/^[a-f0-9]{48}-[a-f0-9]{16}$/.test(String(generation))) return null;
    const file = generation ? safeChildPath(config.hlsDir, sourceId, "versions", generation, "stream-info.json") : metadataPath(sourceId);
    const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
    if (metadata.generation && !/^[a-f0-9]{48}-[a-f0-9]{16}$/.test(metadata.generation)) return null;
    return metadata.version === HLS_CACHE_VERSION ? metadata : null;
  } catch (_) {
    return null;
  }
}

function cacheComplete(sourceId, fingerprint = null) {
  const metadata = readMetadata(sourceId);
  if (fingerprint && metadata?.fingerprint !== fingerprint) return null;
  if (!metadata || !metadata.outputBytes || !playlistComplete(outputPath(sourceId, "video-only.m3u8"))) return null;
  if ((metadata.plan.audioTracks || []).filter((track) => track.playlist).some((track) => !playlistComplete(outputPath(sourceId, track.playlist)))) return null;
  return metadata;
}

function conversionRunning(sourceId) {
  if (active.has(sourceId) || starting.has(sourceId)) return true;
  try { return Date.now() - fs.statSync(safeChildPath(outputDir(sourceId), "preparing.json")).mtimeMs < 45000; }
  catch (_) { return false; }
}

function waitForPlaylist(playlist, child, timeoutMs, completedPlaylist = () => null) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const completed = completedPlaylist();
      if (completed || playlistReady(playlist)) {
        clearInterval(timer);
        resolve(completed || playlist);
      } else if (child.exitCode !== null && child.exitCode !== 0) {
        clearInterval(timer);
        reject(new Error("A conversão HLS terminou antes de produzir segmentos"));
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Tempo limite aguardando o primeiro segmento HLS"));
      }
    }, 250);
  });
}

async function startHls(sourceId, input, { subtitleFile = null, fingerprint = inputFingerprint(input, subtitleFile), priority = 5, requestedAt = Date.now(), assertActive } = {}) {
  const releaseSource = await acquireSemaphoreSlot(`hls-source-${sourceId}`, 1, { owner: `hls:${sourceId}`, leaseMs: config.storageReservationLeaseMs });
  let releaseSlot;
  try {
    releaseSlot = await acquireSemaphoreSlot("hls", config.hls.maxConcurrent, { owner: `hls:${sourceId}`, leaseMs: config.storageReservationLeaseMs });
  } catch (_) {
    await releaseSource();
    throw new Error("Conversor HLS ocupado; tente novamente em instantes");
  }
  const generation = `${fingerprint}-${crypto.randomBytes(8).toString("hex")}`;
  const dir = safeChildPath(outputDir(sourceId), "staging", generation);
  const versionDir = safeChildPath(outputDir(sourceId), "versions", generation);
  const playlist = path.join(dir, "video-only.m3u8");
  const startedAt = requestedAt;
  const preparingMarker = safeChildPath(outputDir(sourceId), "preparing.json");
  let lastHeartbeat = 0;
  const heartbeat = () => { assertActive?.(); writeJsonFileAtomic(preparingMarker, { generation, fingerprint, at: Date.now() }); lastHeartbeat = Date.now(); };
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
    try { if (JSON.parse(fs.readFileSync(preparingMarker, "utf8")).generation === generation) fs.rmSync(preparingMarker, { force: true }); } catch (_) {}
    invalidateStorageUsage();
  };
  let releaseStorage = null;
  let releaseGpu = null;
  let child;
  let plan;
  try {
    assertActive?.();
    heartbeat();
    const probe = await probeMedia(input);
    const durationSeconds = Number(probe.format?.duration || 0);
    const audioCount = (probe.streams || []).filter((stream) => stream.codec_type === "audio").length;
    const bitrateEstimate = durationSeconds > 0
      ? Math.ceil(durationSeconds * (config.hls.videoBitrateKbps + audioCount * config.hls.audioBitrateKbps) * 1000 / 8 * 1.08)
      : 0;
    const outputEstimate = Math.max(fs.statSync(input).size, bitrateEstimate);
    releaseStorage = await reserveStorage(outputEstimate, `hls:${sourceId}`);
    const nvencAvailable = await supportsNvenc();
    plan = choosePlan(probe, nvencAvailable);
    if (subtitleFile) {
      plan.videoMode = nvencAvailable ? "nvenc" : "cpu";
      plan.subtitleBurnedIn = true;
    }
    releaseGpu = plan.videoMode === "nvenc"
      ? await acquireGpuLock(`hls:${sourceId}`, { waitMs: config.hls.startTimeoutMs, priority })
      : null;
    if (isCancelled(sourceId, startedAt)) throw new Error("Preparação WEB cancelada");
    assertActive?.();
    fs.mkdirSync(dir, { recursive: true });
    const args = buildFfmpegArgs(input, playlist, plan, config.hls, subtitleFile);
    logger.info("Iniciando stream HLS", { sourceId, ...plan });
    child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    try { cleanup(); } catch (_) {}
    await releaseGpu?.();
    await releaseStorage?.();
    await releaseSlot();
    await releaseSource();
    throw error;
  }
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });
  const cancellationTimer = setInterval(() => {
    if (isCancelled(sourceId, startedAt)) child.kill("SIGTERM");
    try {
      assertActive?.(); releaseGpu?.assertOwned(); releaseSource.assertOwned(); releaseSlot.assertOwned();
      if (Date.now() - lastHeartbeat >= 10000) heartbeat();
    } catch (_) { child.kill("SIGTERM"); }
  }, 1000);
  cancellationTimer.unref();

  let resourcesReleased = false;
  const releaseResources = async () => {
    if (resourcesReleased) return;
    resourcesReleased = true;
    clearInterval(cancellationTimer);
    try { cleanup(); } catch (error) { logger.warn("Falha ao limpar conversão WEB temporária", { sourceId, error: error.message }); }
    await releaseGpu?.();
    await releaseStorage?.();
    await releaseSlot();
    await releaseSource();
  };

  const done = new Promise((resolve, reject) => {
    child.once("error", async (error) => {
      active.delete(sourceId);
      await releaseResources();
      reject(error);
    });
    child.once("exit", async (code) => {
      if (code === 0) {
        try {
          releaseGpu?.assertOwned();
          releaseSource.assertOwned();
          releaseSlot.assertOwned();
          if (isCancelled(sourceId, startedAt)) throw new Error("Preparação WEB cancelada");
          assertActive?.();
          finalizeVodPlaylists(sourceId, plan, dir);
          const outputProbe = await probeMedia(path.join(dir, "video-only-00000.ts"));
          const video = outputProbe.streams?.find((stream) => stream.codec_type === "video");
          const profile = String(video?.profile || "").toLowerCase();
          const profileHex = profile.includes("baseline") ? "42e0" : profile.includes("main") ? "4d00" : "6400";
          const levelHex = Number.isInteger(video?.level) ? video.level.toString(16).padStart(2, "0") : "28";
          plan.codecs = `avc1.${profileHex}${levelHex}${plan.audioTracks.length ? ",mp4a.40.2" : ""}`;
          const outputBytes = await directorySize(dir);
          fs.mkdirSync(path.dirname(versionDir), { recursive: true });
          fs.renameSync(dir, versionDir);
          const versions = fs.readdirSync(path.dirname(versionDir)).filter((name) => /^[a-f0-9]{48}-[a-f0-9]{16}$/.test(name))
            .sort((left, right) => fs.statSync(path.join(path.dirname(versionDir), right)).mtimeMs - fs.statSync(path.join(path.dirname(versionDir), left)).mtimeMs);
          for (const stale of versions.filter((name) => name !== generation).slice(2)) fs.rmSync(safeChildPath(path.dirname(versionDir), stale), { recursive: true, force: true });
          writeMetadata(sourceId, plan, fingerprint, outputBytes, generation, await directorySize(outputDir(sourceId)));
          invalidateStorageUsage();
          logger.info("Stream HLS concluído", { sourceId, playlist, outputBytes });
          await releaseResources();
          active.delete(sourceId);
          resolve(path.join(versionDir, "video-only.m3u8"));
        } catch (error) {
          await releaseResources();
          active.delete(sourceId);
          reject(error);
        }
      } else {
        const error = new Error(`FFmpeg HLS encerrou com código ${code}: ${stderr.trim().slice(-1000)}`);
        logger.error("Falha no stream HLS", { sourceId, error: error.message });
        await releaseResources();
        active.delete(sourceId);
        reject(error);
      }
    });
  });
  done.catch(() => {});
  const requiredPlaylists = [playlist, ...(plan.audioTracks || []).filter((track) => track.playlist).map((track) => path.join(dir, track.playlist))];
  const ready = Promise.all(requiredPlaylists.map((file) => waitForPlaylist(file, child, config.hls.startTimeoutMs, () => cacheComplete(sourceId, fingerprint) ? outputPath(sourceId, path.basename(file)) : null)))
    .then(() => ({ playlist, plan }));
  active.set(sourceId, { child, ready, done, plan, fingerprint });
  return ready;
}

async function ensureHls(sourceId, input, { subtitleFile = null, priority = 5, requestedAt = Date.now(), assertActive } = {}) {
  assertActive?.();
  const fingerprint = inputFingerprint(input, subtitleFile);
  const cached = cacheComplete(sourceId, fingerprint);
  if (cached) return { playlist: outputPath(sourceId, "video-only.m3u8"), plan: cached.plan };
  const running = active.get(sourceId);
  if (running) {
    if (running.fingerprint !== fingerprint) { await running.done; return ensureHls(sourceId, input, { subtitleFile, priority, requestedAt, assertActive }); }
    return running.ready;
  }
  const pending = starting.get(sourceId);
  if (pending) { await pending; return ensureHls(sourceId, input, { subtitleFile, priority, requestedAt, assertActive }); }
  const start = startHls(sourceId, input, { subtitleFile, fingerprint, priority, requestedAt, assertActive }).finally(() => starting.delete(sourceId));
  starting.set(sourceId, start);
  return start;
}

async function waitForHlsCompletion(sourceId) {
  if (starting.has(sourceId)) await starting.get(sourceId);
  if (active.has(sourceId)) await active.get(sourceId).done;
  if (!cacheComplete(sourceId)) throw new Error("HLS não concluiu uma publicação válida");
}

async function cancelHls(sourceId) {
  const running = active.get(sourceId);
  if (!running) return false;
  if (running.child.exitCode === null) running.child.kill("SIGTERM");
  await Promise.race([
    running.done.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  active.delete(sourceId);
  return true;
}

function pruneHlsCache(now = Date.now()) {
  fs.mkdirSync(config.hlsDir, { recursive: true });
  const cutoff = now - config.hls.cacheMaxAgeMs;
  for (const entry of fs.readdirSync(config.hlsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || conversionRunning(entry.name)) continue;
    const dir = outputDir(entry.name);
    if (fs.statSync(dir).mtimeMs < cutoff) {
      fs.rmSync(dir, { recursive: true, force: true });
      invalidateStorageUsage();
    }
  }
}

function storageBytes(sourceId) {
  const metadata = readMetadata(sourceId);
  return Number(metadata?.totalOutputBytes || metadata?.outputBytes || 0);
}

let pruneTimer;
function scheduleHlsCachePruning() {
  if (pruneTimer) return pruneTimer;
  const intervalMs = Math.max(60 * 1000, Math.min(60 * 60 * 1000, Math.floor(config.hls.cacheMaxAgeMs / 4)));
  pruneTimer = setInterval(() => {
    try { pruneHlsCache(); }
    catch (error) { logger.warn("Falha ao limpar cache HLS", { error: error.message }); }
  }, intervalMs);
  pruneTimer.unref();
  return pruneTimer;
}

module.exports = {
  waitForHlsCompletion,
  readMetadata,
  buildFfmpegArgs,
  cacheComplete,
  cancelHls,
  choosePlan,
  conversionRunning,
  ensureHls,
  finalizeVodPlaylist,
  HLS_CACHE_VERSION,
  inputFingerprint,
  outputPath,
  playlistComplete,
  playlistReady,
  probeMedia,
  pruneHlsCache,
  scheduleHlsCachePruning,
  storageBytes,
  supportsNvenc,
};
