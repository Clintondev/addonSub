const TIMESTAMP_LINE = /^(\d+:\d{2}(?::\d{2})?\.\d{3})(\s+-->\s+)(\d+:\d{2}(?::\d{2})?\.\d{3})(.*)$/;

function normalizeTimestamp(value) {
  return String(value).split(":").length === 2 ? `00:${value}` : String(value);
}

function normalizeTimestampLine(value) {
  const match = String(value).trim().match(TIMESTAMP_LINE);
  if (!match) return null;
  return `${normalizeTimestamp(match[1])}${match[2]}${normalizeTimestamp(match[3])}${match[4]}`;
}

function parseVtt(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const cues = [];
  let i = 0;

  // Skip header lines like "WEBVTT" or notes at top.
  if (lines[i] && lines[i].toUpperCase().startsWith("WEBVTT")) {
    i++;
    while (i < lines.length && lines[i].trim() !== "") i++;
  }

  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;

    let id = null;
    let startIdx = i;
    const possibleId = lines[i].trim();
    const isTimestampLine = Boolean(normalizeTimestampLine(possibleId));
    if (!isTimestampLine) {
      id = possibleId;
      i++;
    }

    if (i >= lines.length || !normalizeTimestampLine(lines[i])) {
      // malformed; skip to next blank.
      while (i < lines.length && lines[i].trim() !== "") i++;
      continue;
    }

    const timeLine = normalizeTimestampLine(lines[i]);
    i++;
    const textLines = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }

    cues.push({
      id,
      time: timeLine,
      text: textLines.join("\n"),
      rawIndex: startIdx,
    });
  }
  return cues;
}

function serializeVtt(cues) {
  const parts = ["WEBVTT", ""];
  cues.forEach((cue) => {
    if (cue.id) parts.push(String(cue.id));
    parts.push(cue.time);
    parts.push(cue.text || "");
    parts.push(""); // blank line between cues
  });
  return parts.join("\n");
}

module.exports = {
  normalizeTimestampLine,
  parseVtt,
  serializeVtt,
};
