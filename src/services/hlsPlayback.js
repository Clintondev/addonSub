const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const config = require("../config");
const logger = require("../logger");
const { safeChildPath } = require("../utils/security");

const active = new Map();
let nvencSupport;

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
    "-show_entries", "stream=index,codec_type,codec_name,profile,pix_fmt,channels:format=duration",
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
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  if (!video) throw new Error("O arquivo não contém vídeo");
  return {
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name || null,
    videoMode: video.codec_name === "h264" ? "copy" : nvencAvailable ? "nvenc" : "cpu",
    // HLS always gets a fresh AAC timeline. Copying audio from MKV files can
    // preserve a large source timestamp offset and leave web/VLC players on a
    // black screen while they wait for the first synchronized frame.
    audioMode: !audio ? "none" : "aac",
  };
}

function buildFfmpegArgs(input, playlist, plan, options = config.hls) {
  const segmentPattern = path.join(path.dirname(playlist), "segment-%05d.ts");
  const args = [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-fflags", "+genpts",
    "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
  ];

  if (plan.videoMode === "copy") {
    // start_at_zero shifts copied streams without decoding them.
    args.push("-copyts", "-start_at_zero", "-c:v", "copy");
  } else if (plan.videoMode === "nvenc") {
    args.push(
      "-vf", `setpts=PTS-STARTPTS,scale=-2:min(${options.maxHeight}\\,ih),format=yuv420p`,
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
    args.push(
      "-vf", `setpts=PTS-STARTPTS,scale=-2:min(${options.maxHeight}\\,ih),format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
      "-maxrate", `${Math.round(options.videoBitrateKbps * 1.5)}k`,
      "-bufsize", `${options.videoBitrateKbps * 2}k`, "-profile:v", "high", "-pix_fmt", "yuv420p"
    );
  }

  if (plan.audioMode === "aac") {
    args.push("-af", "asetpts=PTS-STARTPTS", "-c:a", "aac", "-b:a", `${options.audioBitrateKbps}k`, "-ac", "2");
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
  return args;
}

function playlistReady(playlist) {
  if (!fs.existsSync(playlist)) return false;
  const content = fs.readFileSync(playlist, "utf8");
  return content.includes("#EXTINF:") && /segment-\d{5}\.ts/.test(content);
}

function playlistComplete(playlist) {
  return playlistReady(playlist) && fs.readFileSync(playlist, "utf8").includes("#EXT-X-ENDLIST");
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

async function startHls(sourceId, input) {
  if (active.size >= config.hls.maxConcurrent) throw new Error("Conversor HLS ocupado; tente novamente em instantes");
  const dir = outputDir(sourceId);
  const playlist = outputPath(sourceId, "video.m3u8");
  if (playlistComplete(playlist)) return playlist;
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const probe = await probeMedia(input);
  const plan = choosePlan(probe, await supportsNvenc());
  const args = buildFfmpegArgs(input, playlist, plan);
  logger.info("Iniciando stream HLS", { sourceId, ...plan });
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });

  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      active.delete(sourceId);
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
  const ready = waitForPlaylist(playlist, child, config.hls.startTimeoutMs);
  active.set(sourceId, { child, ready, done, plan });
  return ready;
}

async function ensureHls(sourceId, input) {
  const playlist = outputPath(sourceId, "video.m3u8");
  if (playlistComplete(playlist)) return playlist;
  const running = active.get(sourceId);
  if (running) return running.ready;
  return startHls(sourceId, input);
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

module.exports = {
  buildFfmpegArgs,
  choosePlan,
  ensureHls,
  outputPath,
  playlistComplete,
  playlistReady,
  probeMedia,
  pruneHlsCache,
  supportsNvenc,
};
