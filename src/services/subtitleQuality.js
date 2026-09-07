const PT_BR_TERMS = [
  [/\bHuh(?=\s*[?!.,…])/gi, "Hã"],
  [/\btelemóveis\b/gi, "celulares"],
  [/\btelemóvel\b/gi, "celular"],
  [/\bautocarros\b/gi, "ônibus"],
  [/\bautocarro\b/gi, "ônibus"],
  [/\bcomboios\b/gi, "trens"],
  [/\bcomboio\b/gi, "trem"],
  [/\bficheiros\b/gi, "arquivos"],
  [/\bficheiro\b/gi, "arquivo"],
  [/\bequipas\b/gi, "equipes"],
  [/\bequipa\b/gi, "equipe"],
  [/\braparigas\b/gi, "garotas"],
  [/\brapariga\b/gi, "garota"],
  [/\bcasa de banho\b/gi, "banheiro"],
  [/\bpequeno-almoço\b/gi, "café da manhã"],
  [/\bcontactos\b/gi, "contatos"],
  [/\bcontacto\b/gi, "contato"],
  [/\bfactos\b/gi, "fatos"],
  [/\bfacto\b/gi, "fato"],
  [/\bexcepto\b/gi, "exceto"],
];

function localizeBrazilianPortuguese(text) {
  return PT_BR_TERMS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

function parseTimestamp(value) {
  const match = String(value).match(/^(\d+):(\d{2}):(\d{2})\.(\d{3})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function formatTimestamp(seconds) {
  let millis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(millis / 3600000);
  millis -= hours * 3600000;
  const minutes = Math.floor(millis / 60000);
  millis -= minutes * 60000;
  const secs = Math.floor(millis / 1000);
  millis -= secs * 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function cueTiming(cue) {
  const match = String(cue.time || "").match(/^(\d+:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d+:\d{2}:\d{2}\.\d{3})(.*)$/);
  if (!match) return null;
  return { start: parseTimestamp(match[1]), end: parseTimestamp(match[2]), settings: match[3] || "" };
}

function setCueTiming(cue, start, end, settings = "") {
  return { ...cue, time: `${formatTimestamp(start)} --> ${formatTimestamp(end)}${settings}` };
}

function plainText(text) {
  return String(text || "").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeDialogueMarkers(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/^\s*[-–—]\s*[-–—]+\s*/u, "- ").replace(/^\s*([-–—])(?=\S)/u, "$1 ").trimEnd())
    .join("\n")
    .trim();
}

function dialogueTurns(text) {
  const value = String(text || "").trim();
  const normalizeTurn = (line) => line.replace(/\s+/g, " ").trim();
  const lines = value.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((line) => /^[-–—]\s*/.test(line))) return lines.map((line) => normalizeTurn(line.replace(/^[-–—]\s*/, ""))).filter(Boolean);
  const marked = value.replace(/^\s*[-–—]+\s*/, "").split(/\s+[-–—]{1,2}\s*(?=[\p{Lu}\p{Lt}])/u).map(normalizeTurn).filter(Boolean);
  return marked.length > 1 ? marked : [];
}

function sentenceFragments(text) {
  return String(text || "").trim().split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{Lt}])/u).map((part) => part.trim()).filter(Boolean);
}

function preserveDialogueLayout(sourceText, translatedText) {
  const sourceTurns = dialogueTurns(sourceText);
  const normalized = normalizeDialogueMarkers(translatedText);
  if (sourceTurns.length < 2) {
    const alternatives = normalized.split(/(?<=[.!?…])\s*\/\s*(?=[\p{Lu}\p{Lt}])/u);
    return alternatives.length > 1 ? alternatives[0].trim() : normalized;
  }
  let translatedTurns = dialogueTurns(normalized.replace(/\s*\/\s*(?=[\p{Lu}\p{Lt}])/gu, " -- "));
  if (translatedTurns.length !== sourceTurns.length) {
    const sourceSentenceCounts = sourceTurns.map((turn) => sentenceFragments(turn).length);
    const fragments = sentenceFragments(normalized);
    if (sourceSentenceCounts.reduce((sum, count) => sum + count, 0) === fragments.length) {
      let cursor = 0;
      translatedTurns = sourceSentenceCounts.map((count) => {
        const turn = fragments.slice(cursor, cursor + count).join(" ");
        cursor += count;
        return turn;
      });
    }
  }
  if (translatedTurns.length !== sourceTurns.length) return normalized;
  return translatedTurns.map((line) => `- ${line}`).join("\n");
}

function mergeShortCues(cues, { maxChars = 105, maxGapSeconds = 0.65, minDurationSeconds = 1.1, maxCps = 20 } = {}) {
  const output = [];
  for (let index = 0; index < cues.length; index++) {
    let cue = { ...cues[index], text: plainText(cues[index].text) };
    let timing = cueTiming(cue);
    while (timing && index + 1 < cues.length) {
      const duration = Math.max(0.001, timing.end - timing.start);
      const needsMerge = duration < minDurationSeconds || cue.text.length / duration > maxCps;
      const next = { ...cues[index + 1], text: plainText(cues[index + 1].text) };
      const nextTiming = cueTiming(next);
      if (!needsMerge || !nextTiming || nextTiming.start - timing.end > maxGapSeconds || `${cue.text} ${next.text}`.length > maxChars) break;
      cue = { ...cue, text: `${cue.text} ${next.text}` };
      timing.end = nextTiming.end;
      cue = setCueTiming(cue, timing.start, timing.end, timing.settings);
      index++;
    }
    output.push(cue);
  }
  return output;
}

function displayChunks(text, maxLineChars = 42, maxLines = 2, keepTogetherTerms = []) {
  const normalized = normalizeDialogueMarkers(text);
  const turns = dialogueTurns(normalized);
  const wrapLines = (value) => {
    let protectedValue = plainText(value);
    for (const term of [...new Set(keepTogetherTerms)].filter((item) => /\s/.test(item)).sort((a, b) => b.length - a.length)) {
      const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
      protectedValue = protectedValue.replace(pattern, (match) => match.replace(/\s+/g, "\u00a0"));
    }
    const words = protectedValue.split(" ").filter(Boolean);
    if (!words.length) return [""];
    const output = [];
    let line = "";
    for (const word of words) {
      if (line && `${line} ${word}`.length > maxLineChars) {
        output.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) output.push(line);
    return output.map((line) => line.replace(/\u00a0/g, " "));
  };
  const lines = turns.length > 1
    ? turns.flatMap((turn) => wrapLines(`- ${turn}`))
    : wrapLines(normalized);
  const chunks = [];
  for (let index = 0; index < lines.length; index += maxLines) chunks.push(lines.slice(index, index + maxLines).join("\n"));
  return chunks;
}

function finalizeCues(cues, { targetCps = 17, minDurationSeconds = 1, maxDurationSeconds = 7, gapSeconds = 0.08, keepTogetherTerms = [] } = {}) {
  const displayCues = cues.flatMap((sourceCue) => {
    const chunks = displayChunks(localizeBrazilianPortuguese(sourceCue.text), 42, 2, keepTogetherTerms);
    if (chunks.length === 1) return [{ ...sourceCue, text: chunks[0] }];
    const timing = cueTiming(sourceCue);
    if (!timing) return chunks.map((text) => ({ ...sourceCue, id: null, text }));
    const weights = chunks.map((text) => Math.max(1, plainText(text).length));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const duration = timing.end - timing.start;
    let elapsedWeight = 0;
    return chunks.map((text, index) => {
      const start = timing.start + duration * elapsedWeight / totalWeight;
      elapsedWeight += weights[index];
      const end = index === chunks.length - 1 ? timing.end : timing.start + duration * elapsedWeight / totalWeight;
      return setCueTiming({ ...sourceCue, id: index === 0 ? sourceCue.id : null, text }, start, end, timing.settings);
    });
  });
  return displayCues.map((sourceCue, index) => {
    let cue = sourceCue;
    const timing = cueTiming(cue);
    if (!timing) return cue;
    const nextTiming = index + 1 < displayCues.length ? cueTiming(displayCues[index + 1]) : null;
    const desired = Math.min(maxDurationSeconds, Math.max(minDurationSeconds, plainText(cue.text).length / targetCps));
    const latestEnd = nextTiming ? Math.max(timing.end, nextTiming.start - gapSeconds) : timing.start + maxDurationSeconds;
    const end = Math.min(latestEnd, Math.max(timing.end, timing.start + desired));
    return setCueTiming(cue, timing.start, end, timing.settings);
  });
}

function analyzeCueIntegrity(cues, { maxCueSeconds = 20, maxLineChars = null, maxLines = null } = {}) {
  const stats = { cues: cues.length, invalid: 0, empty: 0, overlaps: 0, longCues: 0, overlongLines: 0, tooManyLines: 0, maxLines: 0, maxLineChars: 0, maxGapSeconds: 0, maxCueSeconds: 0 };
  let previousEnd = null;
  for (const cue of cues) {
    const timing = cueTiming(cue);
    if (!timing || !Number.isFinite(timing.start) || !Number.isFinite(timing.end) || timing.end <= timing.start) {
      stats.invalid++;
      continue;
    }
    if (!plainText(cue.text)) stats.empty++;
    const lines = String(cue.text || "").split("\n");
    stats.maxLines = Math.max(stats.maxLines, lines.length);
    if (Number.isFinite(maxLines) && lines.length > maxLines) stats.tooManyLines++;
    for (const line of lines) {
      stats.maxLineChars = Math.max(stats.maxLineChars, line.length);
      if (Number.isFinite(maxLineChars) && line.length > maxLineChars) stats.overlongLines++;
    }
    const duration = timing.end - timing.start;
    stats.maxCueSeconds = Math.max(stats.maxCueSeconds, duration);
    if (duration > maxCueSeconds) stats.longCues++;
    if (previousEnd !== null) {
      if (timing.start < previousEnd - 0.25) stats.overlaps++;
      else stats.maxGapSeconds = Math.max(stats.maxGapSeconds, timing.start - previousEnd);
    }
    previousEnd = Math.max(previousEnd ?? timing.end, timing.end);
  }
  return stats;
}

function assertCueIntegrity(cues, options) {
  const stats = analyzeCueIntegrity(cues, options);
  if (!stats.cues) throw new Error("Legenda não contém falas");
  if (stats.invalid) throw new Error(`Legenda contém ${stats.invalid} marcações de tempo inválidas`);
  if (stats.empty) throw new Error(`Legenda contém ${stats.empty} falas vazias`);
  if (stats.longCues) throw new Error(`Legenda contém ${stats.longCues} falas com duração anormal (máximo ${stats.maxCueSeconds.toFixed(1)}s)`);
  if (stats.overlongLines) throw new Error(`Legenda contém ${stats.overlongLines} linhas acima de ${options.maxLineChars} caracteres (máximo ${stats.maxLineChars})`);
  if (stats.tooManyLines) throw new Error(`Legenda contém ${stats.tooManyLines} falas acima de ${options.maxLines} linhas (máximo ${stats.maxLines})`);
  if (stats.overlaps > Math.max(2, Math.ceil(stats.cues * 0.01))) throw new Error(`Legenda contém sobreposições excessivas (${stats.overlaps})`);
  return stats;
}

function removeEmptyCues(cues) {
  return cues.filter((cue) => plainText(cue.text));
}

function assertSubtitleCompleteness(cues, mediaDurationSeconds, { minimumCuesPerMinute = 2, minimumSpanRatio = 0.5 } = {}) {
  const duration = Number(mediaDurationSeconds);
  if (!Number.isFinite(duration) || duration < 600) return { cues: cues.length, spanRatio: null };
  const timings = cues.map(cueTiming).filter(Boolean);
  const minimumCues = Math.max(20, Math.floor(duration / 60 * minimumCuesPerMinute));
  const first = timings.length ? Math.min(...timings.map((timing) => timing.start)) : 0;
  const last = timings.length ? Math.max(...timings.map((timing) => timing.end)) : 0;
  const spanRatio = Math.max(0, last - first) / duration;
  if (cues.length < minimumCues || spanRatio < minimumSpanRatio) {
    throw new Error(`Legenda embutida incompleta: ${cues.length} falas, cobertura ${(spanRatio * 100).toFixed(1)}%`);
  }
  return { cues: cues.length, minimumCues, spanRatio };
}

module.exports = {
  analyzeCueIntegrity,
  assertCueIntegrity,
  assertSubtitleCompleteness,
  displayChunks,
  finalizeCues,
  formatTimestamp,
  localizeBrazilianPortuguese,
  mergeShortCues,
  normalizeDialogueMarkers,
  parseTimestamp,
  dialogueTurns,
  preserveDialogueLayout,
  removeEmptyCues,
};
