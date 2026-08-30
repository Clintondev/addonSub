const fs = require("fs");
const { parseVtt, serializeVtt } = require("./vtt");
const { parseTimestamp } = require("./subtitleQuality");

function parsePgsPositions(buffer) {
  const events = [];
  let offset = 0;
  while (offset + 13 <= buffer.length) {
    if (buffer[offset] !== 0x50 || buffer[offset + 1] !== 0x47) { offset++; continue; }
    const pts = buffer.readUInt32BE(offset + 2) / 90000;
    const type = buffer[offset + 10];
    const size = buffer.readUInt16BE(offset + 11);
    const data = offset + 13;
    const end = data + size;
    if (end > buffer.length) break;
    if (type === 0x16 && size >= 19) {
      const width = buffer.readUInt16BE(data);
      const height = buffer.readUInt16BE(data + 2);
      const count = buffer[data + 10];
      const objects = [];
      let cursor = data + 11;
      for (let index = 0; index < count && cursor + 8 <= end; index++) {
        const cropped = Boolean(buffer[cursor + 3] & 0x80);
        objects.push({ x: buffer.readUInt16BE(cursor + 4), y: buffer.readUInt16BE(cursor + 6) });
        cursor += cropped ? 16 : 8;
      }
      if (objects.length) events.push({ at: pts, width, height, x: Math.min(...objects.map((item) => item.x)), y: Math.min(...objects.map((item) => item.y)) });
    }
    offset = end;
  }
  return events;
}

function cueStart(cue) {
  const match = String(cue.time || "").match(/^(\d+:\d{2}:\d{2}\.\d{3})\s+-->/);
  return match ? parseTimestamp(match[1]) : null;
}

function withPositionSettings(time, settings) {
  const base = String(time).replace(/\s+(?:line|position|align|size|vertical):\S+/g, "").trim();
  return `${base}${settings ? ` ${settings}` : ""}`;
}

function applyPgsPositions(cues, events, { topThreshold = 0.55, toleranceSeconds = 0.8 } = {}) {
  let cursor = 0;
  return cues.map((cue) => {
    const start = cueStart(cue);
    if (!Number.isFinite(start) || !events.length) return cue;
    while (cursor + 1 < events.length && Math.abs(events[cursor + 1].at - start) <= Math.abs(events[cursor].at - start)) cursor++;
    const event = events[cursor];
    if (Math.abs(event.at - start) > toleranceSeconds || event.y >= event.height * topThreshold) return cue;
    const line = Math.max(6, Math.min(70, Math.round(event.y / event.height * 100)));
    return { ...cue, time: withPositionSettings(cue.time, `line:${line}% position:50% align:center`) };
  });
}

function applyPgsPositionsToVtt(vtt, supPath) {
  if (!fs.existsSync(supPath)) return vtt;
  return serializeVtt(applyPgsPositions(parseVtt(vtt), parsePgsPositions(fs.readFileSync(supPath))));
}

module.exports = { applyPgsPositions, applyPgsPositionsToVtt, parsePgsPositions, withPositionSettings };
