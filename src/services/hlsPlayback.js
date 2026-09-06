const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const config = require("../config");
const logger = require("../logger");
const { safeChildPath, stableHash } = require("../utils/security");
const { acquireGpuLock } = require("./gpuLock");

const active = new Map();
const starting = new Map();
let nvencSupport;
const HLS_CACHE_VERSION = 5;

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

function outputPath(sourceId, fileName) {
  return safeChildPath(config.hlsDir, sourceId, fileName);
}

async function probeMedia(input) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=index,codec_type,codec_name,profile,pix_fmt,channels,disposition:stream_tags=language,title:format=duration",
    "-of", "json",
    input,
  ]);
  return JSON.parse(stdout);
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
      // Keep the default rendition in-band as a compatibility fallback, but
      // also publish every language as an explicit rendition. Web players
      // only expose an audio selector when each choice has its own URI.
      playlist: `audio-${outputIndex}.m3u8`,
    })),
  };
}

function subtitleFilterPath(file) {
  return String(file).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function buildFfmpegArgs(input, playlist, plan, options = config.hls, subtitleFile = null) {
  const dir = path.dirname(playlist);
  const segmentPattern = path.join(dir, "segment-%05d.ts");
  const defaultAudio = (plan.audioTracks || []).find((track) => track.isDefault) || plan.audioTracks?.[0];
  const args = [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-fflags", "+genpts",
    "-i", input,
    "-map", "0:v:0",
  ];
  if (defaultAudio) args.push("-map", `0:${defaultAudio.inputIndex}`);
  else args.push("-an");
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
  if (defaultAudio) {
    args.push("-af", "asetpts=PTS-STARTPTS", "-c:a", "aac", "-b:a", `${options.audioBitrateKbps}k`, "-ac", "2");
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
  if (!fs.existsSync(playlist)) return false;
  const content = fs.readFileSync(playlist, "utf8");
  return content.includes("#EXTINF:") && /(?:segment|audio-\d+)-\d{5}\.ts/.test(content);
}

function playlistComplete(playlist) {
  return playlistReady(playlist) && fs.readFileSync(playlist, "utf8").includes("#EXT-X-ENDLIST");
}

function metadataPath(sourceId) {
  return outputPath(sourceId, "stream-info.json");
}

function inputFingerprint(input, subtitleFile = null) {
  const identity = (file) => {
    const stat = fs.statSync(file);
    return { path: path.resolve(file), size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  };
  return stableHash(JSON.stringify({ input: identity(input), subtitle: subtitleFile ? identity(subtitleFile) : null }), 48);
}

function writeMetadata(sourceId, plan, fingerprint) {
  fs.writeFileSync(metadataPath(sourceId), JSON.stringify({ version: HLS_CACHE_VERSION, fingerprint, plan }, null, 2), "utf8");
}

function readMetadata(sourceId) {
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath(sourceId), "utf8"));
    return metadata.version === HLS_CACHE_VERSION ? metadata : null;
  } catch (_) {
    return null;
  }
}

function cacheComplete(sourceId, fingerprint = null) {
  const metadata = readMetadata(sourceId);
  if (fingerprint && metadata?.fingerprint !== fingerprint) return null;
  if (!metadata || !playlistComplete(outputPath(sourceId, "video.m3u8"))) return null;
  if ((metadata.plan.audioTracks || []).filter((track) => track.playlist).some((track) => !playlistComplete(outputPath(sourceId, track.playlist)))) return null;
  return metadata;
}

function waitForPlaylist(playlist, child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (playlistReady(playlist)) {
        clearInterval(timer);
        resolve(playlist);
      } else if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error("A conversão HLS terminou antes de produzir segmentos"));
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Tempo limite aguardando o primeiro segmento HLS"));
      }
    }, 250);
  });
}

async function startHls(sourceId, input, { subtitleFile = null, fingerprint = inputFingerprint(input, subtitleFile) } = {}) {
  if (active.size >= config.hls.maxConcurrent) throw new Error("Conversor HLS ocupado; tente novamente em instantes");
  const dir = outputDir(sourceId);
  const playlist = outputPath(sourceId, "video.m3u8");
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const probe = await probeMedia(input);
  const nvencAvailable = await supportsNvenc();
  const plan = choosePlan(probe, nvencAvailable);
  if (subtitleFile) {
    plan.videoMode = nvencAvailable ? "nvenc" : "cpu";
    plan.subtitleBurnedIn = true;
  }
  const releaseGpu = plan.videoMode === "nvenc"
    ? await acquireGpuLock(`hls:${sourceId}`, { waitMs: config.hls.startTimeoutMs })
    : null;
  const args = buildFfmpegArgs(input, playlist, plan, config.hls, subtitleFile);
  writeMetadata(sourceId, plan, fingerprint);
  logger.info("Iniciando stream HLS", { sourceId, ...plan });
  let child;
  try { child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] }); }
  catch (error) { await releaseGpu?.(); throw error; }
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });

  const done = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      active.delete(sourceId);
      releaseGpu?.().catch(() => {});
      reject(error);
    });
    child.once("exit", (code) => {
      active.delete(sourceId);
      releaseGpu?.().catch(() => {});
      if (code === 0) {
        logger.info("Stream HLS concluído", { sourceId, playlist });
        resolve(playlist);
      } else {
        const error = new Error(`FFmpeg HLS encerrou com código ${code}: ${stderr.trim().slice(-1000)}`);
        logger.error("Falha no stream HLS", { sourceId, error: error.message });
        reject(error);
      }
    });
  });
  done.catch(() => {});
  const requiredPlaylists = [playlist, ...(plan.audioTracks || []).filter((track) => track.playlist).map((track) => outputPath(sourceId, track.playlist))];
  const ready = Promise.all(requiredPlaylists.map((file) => waitForPlaylist(file, child, config.hls.startTimeoutMs)))
    .then(() => ({ playlist, plan }));
  active.set(sourceId, { child, ready, done, plan });
  return ready;
}

async function ensureHls(sourceId, input, { subtitleFile = null } = {}) {
  const fingerprint = inputFingerprint(input, subtitleFile);
  const cached = cacheComplete(sourceId, fingerprint);
  if (cached) return { playlist: outputPath(sourceId, "video.m3u8"), plan: cached.plan };
  const running = active.get(sourceId);
  if (running) return running.ready;
  const pending = starting.get(sourceId);
  if (pending) return pending;
  const start = startHls(sourceId, input, { subtitleFile, fingerprint }).finally(() => starting.delete(sourceId));
  starting.set(sourceId, start);
  return start;
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
    if (!entry.isDirectory() || active.has(entry.name)) continue;
    const dir = outputDir(entry.name);
    if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
  }
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
  buildFfmpegArgs,
  cacheComplete,
  cancelHls,
  choosePlan,
  ensureHls,
  HLS_CACHE_VERSION,
  inputFingerprint,
  outputPath,
  playlistComplete,
  playlistReady,
  probeMedia,
  pruneHlsCache,
  scheduleHlsCachePruning,
  supportsNvenc,
};
