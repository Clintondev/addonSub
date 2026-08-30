const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const logger = require("../logger");
const { sanitizeUrl } = require("../utils/security");
const { applyPgsPositionsToVtt } = require("./pgs");

function runCmd(bin, args) {
  return spawnSync(bin, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function probeSubtitles(sourceUrl) {
  const res = runCmd("ffprobe", ["-v", "error", "-select_streams", "s", "-show_entries", "stream=index,codec_name:stream_tags=language,title:stream_disposition=forced", "-of", "json", sourceUrl]);
  if (res.status !== 0) throw new Error(`ffprobe falhou: ${res.stderr || res.stdout}`);
  return (JSON.parse(res.stdout || "{}").streams || []).map((stream, index) => ({
    ffIndex: stream.index ?? index,
    lang: (stream.tags?.language || "").toLowerCase(),
    title: stream.tags?.title || "",
    forced: Boolean(stream.disposition?.forced),
    codec: stream.codec_name,
  }));
}

function languageRank(track, preferredLangs) {
  const rank = preferredLangs.indexOf(track.lang);
  return rank === -1 ? preferredLangs.length + 1 : rank;
}

function pickTextTrack(tracks, preferredLangs) {
  const codecs = new Set(["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text", "ttml"]);
  const textual = tracks.filter((track) => codecs.has(String(track.codec || "").toLowerCase()));
  return [...textual].sort((a, b) => Number(a.forced) - Number(b.forced) || languageRank(a, preferredLangs) - languageRank(b, preferredLangs))[0] || null;
}

function pickPgsTrack(tracks, preferredLangs) {
  const pgs = tracks.filter((track) => String(track.codec || "").toLowerCase() === "hdmv_pgs_subtitle");
  function kindRank(track) {
    const title = String(track.title || "").toLowerCase();
    if (/\bfull\b|complete|completa/.test(title)) return 0;
    if (/songs?|signs?|forced/.test(title)) return 2;
    return 1;
  }
  return [...pgs].sort((a, b) => languageRank(a, preferredLangs) - languageRank(b, preferredLangs) || kindRank(a) - kindRank(b) || Number(a.forced) - Number(b.forced))[0] || null;
}

function extractTrackToVtt(sourceUrl, trackIndex, outputPath) {
  const res = runCmd("ffmpeg", ["-y", "-i", sourceUrl, "-map", `0:${trackIndex}`, "-c:s", "webvtt", "-f", "webvtt", outputPath]);
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

function extractPgsToVtt(sourceUrl, trackIndex, outputDir) {
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
  const extraction = runCmd("ffmpeg", ["-y", "-v", "error", "-i", sourceUrl, "-map", `0:${trackIndex}`, "-c:s", "copy", supPath]);
  if (extraction.status !== 0 || !fs.existsSync(supPath)) throw new Error(`Falha ao extrair legenda PGS: ${extraction.stderr || extraction.stdout}`);
  const ocr = runCmd("suptext", [supPath]);
  if (ocr.status !== 0 || !fs.existsSync(srtPath)) throw new Error(`OCR da legenda PGS falhou: ${ocr.stderr || ocr.stdout}`);
  const vtt = srtToVtt(fs.readFileSync(srtPath, "utf8"));
  const cueCount = (vtt.match(/-->/g) || []).length;
  if (!cueCount) throw new Error("OCR da legenda PGS não produziu falas");
  fs.writeFileSync(completePath, JSON.stringify({ cues: cueCount, completedAt: new Date().toISOString() }, null, 2), "utf8");
  return applyPgsPositionsToVtt(vtt, supPath);
}

async function extractFileSubtitle(sourceUrl, outputDir, preferredLangs) {
  logger.info("Extraindo legenda embutida", { source: sanitizeUrl(sourceUrl) });
  const tracks = probeSubtitles(sourceUrl);
  if (!tracks.length) throw new Error("Nenhuma trilha de legenda no arquivo");
  const textTrack = pickTextTrack(tracks, preferredLangs);
  if (textTrack) {
    const content = extractTrackToVtt(sourceUrl, textTrack.ffIndex, path.join(outputDir, `track-${textTrack.ffIndex}.vtt`));
    return { lang: textTrack.lang || "und", name: `track-${textTrack.ffIndex}`, content };
  }
  const pgsTrack = pickPgsTrack(tracks, preferredLangs);
  if (!pgsTrack) throw new Error("Nenhuma trilha de legenda textual ou PGS utilizável no arquivo");
  logger.info("Convertendo legenda PGS embutida com OCR", { trackIndex: pgsTrack.ffIndex, language: pgsTrack.lang, title: pgsTrack.title });
  return { lang: pgsTrack.lang || "und", name: `ocr-pgs-track-${pgsTrack.ffIndex}`, content: extractPgsToVtt(sourceUrl, pgsTrack.ffIndex, outputDir) };
}

module.exports = { probeSubtitles, pickTextTrack, pickPgsTrack, srtToVtt, extractFileSubtitle };
