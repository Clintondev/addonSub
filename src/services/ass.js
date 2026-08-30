const { parseTimestamp } = require("./subtitleQuality");

const PLAY_RES_X = 1920;
const PLAY_RES_Y = 1080;

function assTime(value) {
  const seconds = parseTimestamp(value);
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeAssText(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

function cuePosition(settings) {
  const line = /(?:^|\s)line:(\d+(?:\.\d+)?)%/.exec(settings || "");
  if (!line) return "";
  const percentage = Math.max(0, Math.min(100, Number(line[1])));
  // PGS top captions use their bitmap's vertical coordinate. In ASS, \an8
  // anchors the subtitle at its top centre, matching the original PGS layout.
  if (percentage >= 50) return "";
  const position = /(?:^|\s)position:(\d+(?:\.\d+)?)%/.exec(settings || "");
  const x = Math.round((position ? Number(position[1]) : 50) * PLAY_RES_X / 100);
  const y = Math.round(percentage * PLAY_RES_Y / 100);
  return `{\\an8\\pos(${x},${y})}`;
}

function vttCuesToAss(cues) {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${PLAY_RES_X}`,
    `PlayResY: ${PLAY_RES_Y}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,54,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,42,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = cues.flatMap((cue) => {
    const match = String(cue.time || "").match(/^(\d+:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d+:\d{2}:\d{2}\.\d{3})(.*)$/);
    if (!match) return [];
    const position = cuePosition(match[3].trim());
    return [`Dialogue: 0,${assTime(match[1])},${assTime(match[2])},Default,,0,0,0,,${position}${escapeAssText(cue.text)}`];
  });
  return [...header, ...events, ""].join("\n");
}

module.exports = { assTime, cuePosition, escapeAssText, vttCuesToAss };
