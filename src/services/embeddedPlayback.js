const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const { promisify } = require("util");
const config = require("../config");
const logger = require("../logger");
const { safeChildPath, stableHash } = require("../utils/security");

const execFileAsync = promisify(execFile);
const active = new Map();
const FORMAT_VERSION = 2;
const LOCK_STALE_MS = 60 * 60 * 1000;

function outputDir(sourceId) {
  return safeChildPath(config.playbackDir, sourceId);
}

function outputPath(sourceId, fileName = "pt-BR.mkv") {
  return safeChildPath(outputDir(sourceId), fileName);
}

function buildEmbeddedArgs(input, subtitle, output) {
  return [
    "-hide_banner", "-loglevel", "warning", "-y",
    "-i", input, "-i", subtitle,
    "-map", "0:v:0", "-map", "0:a?", "-map", "0:t?", "-map", "0:d?", "-map", "1:0",
    "-map_metadata", "0", "-map_chapters", "0",
    "-c", "copy",
    "-metadata:s:s:0", "language=por",
    "-metadata:s:s:0", "title=Português (Brasil)",
    "-disposition:s:0", "default",
    // HTTP players should not need to seek to the end of a large MKV before
    // they can resolve subtitle and media cue points. Short, regular clusters
    // also keep range reads local while a subtitle packet becomes active.
    "-reserve_index_space", "200000",
    "-cues_to_front", "1",
    "-cluster_time_limit", "1000",
    "-f", "matroska", output,
  ];
}

function fileIdentity(file) {
  const stat = fs.statSync(file);
  return { path: path.resolve(file), size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
}

function expectedFingerprint(input, subtitle) {
  return stableHash(JSON.stringify({ version: FORMAT_VERSION, input: fileIdentity(input), subtitle: fileIdentity(subtitle) }), 48);
}

async function probe(file) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries",
    "format=duration:stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=default",
    "-of", "json", file,
  ], { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout || "{}");
}

function validateEmbeddedProbe(inputProbe, outputProbe) {
  const inputStreams = inputProbe.streams || [];
  const streams = outputProbe.streams || [];
  const inputAudioCount = inputStreams.filter((stream) => stream.codec_type === "audio").length;
  const audioCount = streams.filter((stream) => stream.codec_type === "audio").length;
  const videoCount = streams.filter((stream) => stream.codec_type === "video").length;
  const subtitles = streams.filter((stream) => stream.codec_type === "subtitle");
  const ptBr = subtitles[0];
  if (videoCount !== 1) throw new Error(`MKV preparado contém ${videoCount} faixas de vídeo; esperado 1`);
  if (audioCount !== inputAudioCount) throw new Error(`MKV preparado contém ${audioCount}/${inputAudioCount} faixas de áudio`);
  if (subtitles.length !== 1 || ptBr.codec_name !== "subrip") throw new Error("MKV preparado não contém exatamente uma legenda SRT interna");
  if (String(ptBr.tags?.language || "").toLowerCase() !== "por") throw new Error("Legenda interna não foi marcada como português");
  if (ptBr.disposition?.default !== 1) throw new Error("Legenda interna PT-BR não foi marcada como padrão");
  const inputDuration = Number(inputProbe.format?.duration);
  const outputDuration = Number(outputProbe.format?.duration);
  if (!Number.isFinite(outputDuration) || outputDuration <= 0) throw new Error("MKV preparado não possui duração válida");
  if (Number.isFinite(inputDuration) && Math.abs(inputDuration - outputDuration) > 1) throw new Error("Duração do MKV preparado difere da mídia original");
  return { videoCount, audioCount, subtitleCount: subtitles.length, duration: outputDuration };
}

function readMetadata(sourceId) {
  try { return JSON.parse(fs.readFileSync(outputPath(sourceId, "metadata.json"), "utf8")); }
  catch (_) { return null; }
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireGenerationLock(sourceId, { timeoutMs = 2 * 60 * 60 * 1000 } = {}) {
  const dir = outputDir(sourceId);
  const lock = outputPath(sourceId, "generation.lock");
  fs.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  while (true) {
    try {
      const handle = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");
      const heartbeat = setInterval(() => {
        try { fs.utimesSync(lock, new Date(), new Date()); } catch (_) {}
      }, 10000);
      heartbeat.unref();
      return () => {
        clearInterval(heartbeat);
        try { fs.closeSync(handle); } catch (_) {}
        fs.rmSync(lock, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch (_) {}
      if (Date.now() - started >= timeoutMs) throw new Error("Tempo esgotado aguardando outra preparação do MKV local");
      await pause(250);
    }
  }
}

function runFfmpeg(args, sourceId) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const chunks = [];
    let length = 0;
    child.stderr.on("data", (chunk) => {
      length += chunk.length;
      if (length <= 2 * 1024 * 1024) chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) return resolve();
      const detail = Buffer.concat(chunks).toString("utf8").trim().slice(-4000);
      reject(new Error(`ffmpeg falhou ao preparar reprodução local (${signal || code}): ${detail}`));
    });
    const entry = active.get(sourceId);
    if (entry) entry.child = child;
  });
}

async function generate(sourceId, input, subtitle, fingerprint) {
  const dir = outputDir(sourceId);
  const target = outputPath(sourceId);
  const temporary = outputPath(sourceId, `pt-BR.${process.pid}.${Date.now()}.tmp.mkv`);
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(temporary, { force: true });
  logger.info("Preparando MKV local com legenda PT-BR interna", { sourceId });
  try {
    const inputProbe = await probe(input);
    await runFfmpeg(buildEmbeddedArgs(input, subtitle, temporary), sourceId);
    const validation = validateEmbeddedProbe(inputProbe, await probe(temporary));
    fs.rmSync(target, { force: true });
    fs.renameSync(temporary, target);
    const metadata = { version: FORMAT_VERSION, fingerprint, generatedAt: new Date().toISOString(), outputBytes: fs.statSync(target).size, validation };
    fs.writeFileSync(outputPath(sourceId, "metadata.json"), JSON.stringify(metadata, null, 2), "utf8");
    logger.info("MKV local com legenda PT-BR pronto", { sourceId, ...validation, bytes: fs.statSync(target).size });
    return target;
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

async function ensureEmbeddedPlayback(sourceId, input, subtitle) {
  if (!input || !subtitle || !fs.existsSync(input) || !fs.existsSync(subtitle)) throw new Error("Mídia local ou legenda PT-BR não está disponível");
  const fingerprint = expectedFingerprint(input, subtitle);
  const target = outputPath(sourceId);
  const metadata = readMetadata(sourceId);
  if (fs.existsSync(target) && metadata?.version === FORMAT_VERSION && metadata.fingerprint === fingerprint
    && metadata.outputBytes === fs.statSync(target).size) return target;
  if (active.has(sourceId)) return active.get(sourceId).promise;
  const entry = { promise: null, child: null };
  entry.promise = (async () => {
    const release = await acquireGenerationLock(sourceId);
    try {
      const current = readMetadata(sourceId);
      if (fs.existsSync(target) && current?.version === FORMAT_VERSION && current.fingerprint === fingerprint
        && current.outputBytes === fs.statSync(target).size) return target;
      return await generate(sourceId, input, subtitle, fingerprint);
    } finally { release(); }
  })().finally(() => active.delete(sourceId));
  active.set(sourceId, entry);
  return entry.promise;
}

async function cancelEmbeddedPlayback(sourceId) {
  const entry = active.get(sourceId);
  if (entry?.child && !entry.child.killed) entry.child.kill("SIGTERM");
  try { await entry?.promise; } catch (_) {}
}

module.exports = {
  buildEmbeddedArgs,
  cancelEmbeddedPlayback,
  ensureEmbeddedPlayback,
  expectedFingerprint,
  outputPath,
  validateEmbeddedProbe,
};
