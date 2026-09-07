const fs = require("fs");
const path = require("path");
const config = require("../config");
const { parseVtt, serializeVtt } = require("./vtt");
const { applyPgsPositions, parsePgsPositions, withPositionSettings } = require("./pgs");
const { finalizeCues, normalizeDialogueMarkers, parseTimestamp, preserveDialogueLayout } = require("./subtitleQuality");
const { safeChildPath } = require("../utils/security");
const { vttCuesToAss } = require("./ass");
const { inferProtectedTerms } = require("./translate");

const LAYOUT_VERSION = 4;

function writeAss(dir, cues) {
  const assPath = path.join(dir, "pt-BR.ass");
  const temporary = `${assPath}.layout.tmp`;
  fs.writeFileSync(temporary, vttCuesToAss(cues), "utf8");
  fs.renameSync(temporary, assPath);
  return assPath;
}

function timing(cue) {
  const match = String(cue.time || "").match(/^(\d+:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d+:\d{2}:\d{2}\.\d{3})(.*)$/);
  return match ? { start: parseTimestamp(match[1]), end: parseTimestamp(match[2]), settings: match[3].trim() } : null;
}

function repairSubtitleLayout(sourceId, { backup = false, force = false } = {}) {
  const dir = safeChildPath(config.storageDir, "subtitles", sourceId);
  const originalPath = path.join(dir, "original.vtt");
  const finalPath = path.join(dir, "pt-BR.vtt");
  const statePath = path.join(dir, "state.json");
  const markerPath = path.join(dir, "layout-complete.json");
  const assPath = path.join(dir, "pt-BR.ass");
  if (![originalPath, finalPath, statePath].every(fs.existsSync)) return { skipped: "artifacts-missing" };
  const finalMtime = fs.statSync(finalPath).mtimeMs;
  if (!force && fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (marker.version === LAYOUT_VERSION && marker.finalMtimeMs === finalMtime && fs.existsSync(assPath)) return { skipped: "current", ...marker };
    } catch (_) {}
  }
  const meta = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const track = /ocr-pgs-track-(\d+)/.exec(String(meta.origin || ""));
  if (!track) {
    const current = fs.readFileSync(finalPath, "utf8");
    const finalCues = finalizeCues(parseVtt(current).map((cue) => ({ ...cue, text: normalizeDialogueMarkers(cue.text) })));
    const serialized = serializeVtt(finalCues);
    if (serialized !== current) {
      const temporary = `${finalPath}.layout.tmp`;
      fs.writeFileSync(temporary, serialized, "utf8");
      fs.renameSync(temporary, finalPath);
    }
    writeAss(dir, finalCues);
    const result = { version: LAYOUT_VERSION, sourceId, cues: finalCues.length, positioned: 0, dialogues: 0, finalMtimeMs: fs.statSync(finalPath).mtimeMs, completedAt: new Date().toISOString() };
    fs.writeFileSync(markerPath, JSON.stringify(result, null, 2), "utf8");
    return result;
  }
  const supPath = path.join(dir, `track-${track[1]}.sup`);
  if (!fs.existsSync(supPath)) return { skipped: "sup-missing" };
  const sourceCues = applyPgsPositions(parseVtt(fs.readFileSync(originalPath, "utf8")), parsePgsPositions(fs.readFileSync(supPath)));
  const protectedTerms = inferProtectedTerms(sourceCues);
  const finalCues = parseVtt(fs.readFileSync(finalPath, "utf8"));
  let cursor = 0;
  let positioned = 0;
  let dialogues = 0;
  const repaired = finalCues.map((cue) => {
    const target = timing(cue);
    if (!target) return cue;
    while (cursor + 1 < sourceCues.length && timing(sourceCues[cursor + 1]).start <= target.start + 0.02) cursor++;
    const source = sourceCues[cursor];
    const sourceTime = timing(source);
    if (!sourceTime || target.start < sourceTime.start - 0.02 || target.start > sourceTime.end + 0.02) return cue;
    let text = cue.text;
    if (Math.abs(target.start - sourceTime.start) <= 0.05) {
      const preserved = preserveDialogueLayout(source.text, text);
      if (preserved !== text) { text = preserved; dialogues++; }
    }
    let time = cue.time;
    if (sourceTime.settings) { time = withPositionSettings(time, sourceTime.settings); positioned++; }
    return { ...cue, time, text };
  });
  const formatted = finalizeCues(repaired.map((cue) => ({ ...cue, text: normalizeDialogueMarkers(cue.text) })), { keepTogetherTerms: protectedTerms });
  if (backup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(finalPath, path.join(dir, `pt-BR-before-layout-${stamp}.vtt`));
  }
  const originalTemporary = `${originalPath}.layout.tmp`;
  const finalTemporary = `${finalPath}.layout.tmp`;
  fs.writeFileSync(originalTemporary, serializeVtt(sourceCues), "utf8");
  fs.writeFileSync(finalTemporary, serializeVtt(formatted), "utf8");
  fs.renameSync(originalTemporary, originalPath);
  fs.renameSync(finalTemporary, finalPath);
  writeAss(dir, formatted);
  const result = { version: LAYOUT_VERSION, sourceId, cues: formatted.length, positioned, dialogues, finalMtimeMs: fs.statSync(finalPath).mtimeMs, completedAt: new Date().toISOString() };
  fs.writeFileSync(markerPath, JSON.stringify(result, null, 2), "utf8");
  return result;
}

module.exports = { repairSubtitleLayout };
