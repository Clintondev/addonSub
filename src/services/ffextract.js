const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const logger = require("../logger");
const { sanitizeUrl } = require("../utils/security");

function runCmd(bin, args) {
  return spawnSync(bin, args, { encoding: "utf8" });
}

function probeSubtitles(sourceUrl) {
  const args = [
    "-v",
    "error",
    "-select_streams",
    "s",
    "-show_entries",
    "stream=index,codec_type,codec_name,channels,bit_rate,avg_frame_rate,tag:language,disposition:forced",
    "-of",
    "json",
    sourceUrl,
  ];
  const res = runCmd("ffprobe", args);
  if (res.status !== 0) {
    throw new Error(`ffprobe falhou: ${res.stderr || res.stdout}`);
  }
  const data = JSON.parse(res.stdout || "{}");
  const streams = data.streams || [];
  return streams.map((s, idx) => ({
    ffIndex: s.index ?? idx,
    lang: (s.tags?.language || "").toLowerCase(),
    forced: Boolean(s.disposition?.forced),
    codec: s.codec_name,
  }));
}

function pickTrack(tracks, preferredLangs) {
  if (!tracks.length) return null;
  const nonForced = tracks.filter((t) => !t.forced);
  for (const pref of preferredLangs) {
    const found = (nonForced.length ? nonForced : tracks).find(
      (t) => t.lang === pref
    );
    if (found) return found;
  }
  return nonForced[0] || tracks[0];
}

function extractTrackToVtt(sourceUrl, trackIndex, outputPath) {
  const args = [
    "-y",
    "-i",
    sourceUrl,
    "-map",
    `0:${trackIndex}`,
    "-c:s",
    "webvtt",
    "-f",
    "webvtt",
    outputPath,
  ];
  const res = runCmd("ffmpeg", args);
  if (res.status !== 0) {
    throw new Error(`ffmpeg falhou: ${res.stderr || res.stdout}`);
  }
  if (!fs.existsSync(outputPath)) {
    throw new Error("Arquivo de legenda não gerado");
  }
  return fs.readFileSync(outputPath, "utf8");
}

async function extractFileSubtitle(sourceUrl, outputDir, preferredLangs) {
  logger.info("Extraindo legenda via ffprobe/ffmpeg", {
    source: sanitizeUrl(sourceUrl),
  });
  const tracks = probeSubtitles(sourceUrl);
  if (!tracks.length) {
    throw new Error("Nenhuma trilha de legenda textual no arquivo");
  }
  const track = pickTrack(tracks, preferredLangs);
  const outPath = path.join(outputDir, `track-${track.ffIndex}.vtt`);
  const content = extractTrackToVtt(sourceUrl, track.ffIndex, outPath);
  return {
    lang: track.lang || "und",
    name: `track-${track.ffIndex}`,
    content,
  };
}

module.exports = {
  extractFileSubtitle,
};
