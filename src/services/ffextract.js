const fs = require("fs");
const path = require("path");
const config = require("../config");
const logger = require("../logger");
const { sanitizeUrl } = require("../utils/security");
const { runProcess } = require("../utils/processRunner");
const { applyPgsPositionsToVtt } = require("./pgs");
const { canonicalLanguage, languageMatches, subtitleLanguageOrder, translationRoute } = require("./languageStrategy");

function runCmd(bin, args, options = {}) {
  return runProcess(bin, args, { timeoutMs: config.mediaProcessTimeoutMs, maxBuffer: 8 * 1024 * 1024, ...options });
}

async function probeMediaTracks(sourceUrl) {
  const res = await runCmd("ffprobe", ["-v", "error", "-show_entries", "stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition", "-of", "json", sourceUrl], { timeoutMs: 30000 });
  if (res.status !== 0) throw new Error(`ffprobe falhou: ${res.stderr || res.stdout}`);
  const tracks = (JSON.parse(res.stdout || "{}").streams || []).map((stream, index) => ({
    ffIndex: stream.index ?? index,
    type: stream.codec_type,
    lang: canonicalLanguage(stream.tags?.language),
    title: stream.tags?.title || "",
    forced: Boolean(stream.disposition?.forced),
    disposition: stream.disposition || {},
    codec: stream.codec_name,
  }));
  return {
    audioTracks: tracks.filter((track) => track.type === "audio"),
    subtitleTracks: tracks.filter((track) => track.type === "subtitle"),
  };
}

async function probeSubtitles(sourceUrl) {
  return (await probeMediaTracks(sourceUrl)).subtitleTracks;
}

function languageRank(track, preferredLangs) {
  const rank = preferredLangs.findIndex((language) => languageMatches(track.lang, language));
  return rank === -1 ? preferredLangs.length + 1 : rank;
}

function kindRank(track) {
  const title = String(track.title || "").toLowerCase();
  return track.forced || /songs?|signs?|forced|karaoke/.test(title) ? 1 : 0;
}

function pgsOcrSupported(track) {
  return languageMatches(track.lang, "en");
}

function pickTextTrack(tracks, preferredLangs) {
  const codecs = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "ttml"]);
  const textual = tracks.filter((track) => codecs.has(String(track.codec || "").toLowerCase()));
  return [...textual].sort((a, b) => Number(a.forced) - Number(b.forced) || languageRank(a, preferredLangs) - languageRank(b, preferredLangs))[0] || null;
}

function pickPgsTrack(tracks, preferredLangs) {
  const pgs = tracks.filter((track) => String(track.codec || "").toLowerCase() === "hdmv_pgs_subtitle");
  return [...pgs].sort((a, b) => kindRank(a) - kindRank(b) || Number(a.forced) - Number(b.forced) || languageRank(a, preferredLangs) - languageRank(b, preferredLangs))[0] || null;
}

function rankedTracks(tracks, preferredLangs, options = {}) {
  const textCodecs = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "ttml"]);
  const usable = tracks.filter((track) => textCodecs.has(String(track.codec || "").toLowerCase()) || String(track.codec || "").toLowerCase() === "hdmv_pgs_subtitle");
  const order = options.languageOrder || preferredLangs;
  return [...usable].sort((a, b) => kindRank(a) - kindRank(b)
    || languageRank(a, order) - languageRank(b, order)
    || Number(!textCodecs.has(String(a.codec || "").toLowerCase())) - Number(!textCodecs.has(String(b.codec || "").toLowerCase()))
    || Number(a.ffIndex) - Number(b.ffIndex));
}

async function extractTrackToVtt(sourceUrl, trackIndex, outputPath) {
  const res = await runCmd("ffmpeg", ["-y", "-i", sourceUrl, "-map", `0:${trackIndex}`, "-c:s", "webvtt", "-f", "webvtt", outputPath]);
  if (res.status !== 0) throw new Error(`ffmpeg falhou: ${res.stderr || res.stdout}`);
  if (!fs.existsSync(outputPath)) throw new Error("Arquivo de legenda não gerado");
  return fs.readFileSync(outputPath, "utf8");
}

function srtToVtt(content) {
  const normalized = String(content || "").replace(/^\uFEFF/, "").replace(/\r/g, "")
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})/g,
      (_match, start, startMs, end, endMs) => `${start.padStart(8, "0")}.${startMs} --> ${end.padStart(8, "0")}.${endMs}`);
  return `WEBVTT\n\n${normalized.trim()}\n`;
}

async function extractPgsToVtt(sourceUrl, trackIndex, outputDir) {
  const supPath = path.join(outputDir, `track-${trackIndex}.sup`);
  const srtPath = path.join(outputDir, `track-${trackIndex}.srt`);
  const completePath = path.join(outputDir, `track-${trackIndex}.ocr-complete.json`);
  // suptext writes the SRT progressively. Never trust an SRT without the
  // completion marker: an interrupted OCR previously left a valid-looking but
  // truncated subtitle that was silently reused on the next job.
  if (fs.existsSync(srtPath) && fs.existsSync(completePath)) {
    try {
      const cached = srtToVtt(fs.readFileSync(srtPath, "utf8"));
      const marker = JSON.parse(fs.readFileSync(completePath, "utf8"));
      const cueCount = (cached.match(/-->/g) || []).length;
      if (cueCount > 0 && cueCount === marker.cues) return applyPgsPositionsToVtt(cached, supPath);
    } catch (_) {
      // Corrupt cache metadata is treated exactly like an interrupted OCR.
    }
  }
  if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
  if (fs.existsSync(completePath)) fs.unlinkSync(completePath);
  const extraction = await runCmd("ffmpeg", ["-y", "-v", "error", "-i", sourceUrl, "-map", `0:${trackIndex}`, "-c:s", "copy", supPath]);
  if (extraction.status !== 0 || !fs.existsSync(supPath)) throw new Error(`Falha ao extrair legenda PGS: ${extraction.stderr || extraction.stdout}`);
  const ocr = await runCmd("suptext", [supPath]);
  if (ocr.status !== 0 || !fs.existsSync(srtPath)) throw new Error(`OCR da legenda PGS falhou: ${ocr.stderr || ocr.stdout}`);
  const vtt = srtToVtt(fs.readFileSync(srtPath, "utf8"));
  const cueCount = (vtt.match(/-->/g) || []).length;
  if (!cueCount) throw new Error("OCR da legenda PGS não produziu falas");
  fs.writeFileSync(completePath, JSON.stringify({ cues: cueCount, completedAt: new Date().toISOString() }, null, 2), "utf8");
  return applyPgsPositionsToVtt(vtt, supPath);
}

async function extractFileSubtitle(sourceUrl, outputDir, preferredLangs, { excludedTrackIndexes = [], mediaTracks = null, source = {}, targetLocale = "pt-BR", allowIntermediateFallback = false } = {}) {
  logger.info("Extraindo legenda embutida", { source: sanitizeUrl(sourceUrl) });
  const probed = mediaTracks || await probeMediaTracks(sourceUrl);
  const tracks = probed.subtitleTracks;
  if (!tracks.length) throw new Error("Nenhuma trilha de legenda no arquivo");
  const excluded = new Set(excludedTrackIndexes.map(Number));
  const strategy = subtitleLanguageOrder({ source, audioTracks: probed.audioTracks, preferredLangs, targetLocale });
  const ranked = rankedTracks(tracks, preferredLangs, { languageOrder: strategy.languages }).filter((track) => !excluded.has(Number(track.ffIndex)));
  const candidates = ranked.filter((track) => String(track.codec || "").toLowerCase() !== "hdmv_pgs_subtitle" || pgsOcrSupported(track));
  const fullTargetAvailable = candidates.some((track) => kindRank(track) === 0 && languageMatches(track.lang, targetLocale));
  const fullOriginalAvailable = candidates.some((track) => kindRank(track) === 0 && languageMatches(track.lang, strategy.originalAudio?.lang));
  if (!allowIntermediateFallback && !fullTargetAvailable && strategy.originalAudio && strategy.originalAudio.lang !== "und" && !fullOriginalAvailable) {
    throw new Error(`Nenhuma legenda completa e segura no idioma original (${strategy.originalAudio.lang}); transcrição direta do áudio será usada antes de qualquer idioma intermediário`);
  }
  if (!candidates.length) throw new Error("Nenhuma trilha de legenda textual ou PGS utilizável no arquivo");
  const errors = [];
  for (const track of candidates) {
    try {
      const pgs = String(track.codec || "").toLowerCase() === "hdmv_pgs_subtitle";
      if (pgs) logger.info("Convertendo legenda PGS embutida com OCR", { trackIndex: track.ffIndex, language: track.lang, title: track.title });
      const content = pgs
        ? await extractPgsToVtt(sourceUrl, track.ffIndex, outputDir)
        : await extractTrackToVtt(sourceUrl, track.ffIndex, path.join(outputDir, `track-${track.ffIndex}.vtt`));
      return {
        lang: track.lang || "und",
        name: pgs ? `ocr-pgs-track-${track.ffIndex}` : `track-${track.ffIndex}`,
        trackIndex: track.ffIndex,
        content,
        sourceAudioIndex: strategy.originalAudio?.ffIndex ?? null,
        sourceAudioLanguage: strategy.originalAudio?.lang || "und",
        sourceAudioReason: strategy.originalAudio?.reason || "unavailable",
        sourceAudioConfidence: strategy.originalAudio?.confidence || "unknown",
        translationRoute: translationRoute(track.lang, strategy.originalAudio),
      };
    } catch (error) {
      errors.push(`track ${track.ffIndex}: ${error.message}`);
      logger.warn("Falha ao extrair trilha; tentando a próxima", { trackIndex: track.ffIndex, error: error.message });
    }
  }
  throw new Error(`Nenhuma trilha embutida pôde ser extraída: ${errors.join(" | ")}`);
}

module.exports = { probeMediaTracks, probeSubtitles, pickTextTrack, pickPgsTrack, pgsOcrSupported, rankedTracks, srtToVtt, extractFileSubtitle };
