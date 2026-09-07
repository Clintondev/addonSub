const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const config = require("../config");
const { runProcess } = require("../utils/processRunner");
const { dialogueTurns, formatTimestamp, localizeBrazilianPortuguese, parseTimestamp } = require("./subtitleQuality");

async function run(binary, args, { captureStdout = false } = {}) {
  const result = await runProcess(binary, args, { timeoutMs: config.mediaProcessTimeoutMs, maxBuffer: captureStdout ? 8 * 1024 * 1024 : 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${binary} exited with ${result.status}: ${result.stderr.slice(-8000)}`);
  return captureStdout ? result.stdout : "";
}

function cueTiming(cue) {
  const match = String(cue.time || "").match(/^(\d+:\d{2}:\d{2}\.\d{3})\s+-->\s+(\d+:\d{2}:\d{2}\.\d{3})(.*)$/);
  if (!match) return null;
  return { start: parseTimestamp(match[1]), end: parseTimestamp(match[2]), settings: match[3] || "" };
}

function plainText(value) {
  return String(value || "").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
}

function reconstructTranslations(sourceCues, displayCues) {
  const consumed = new Set();
  const translations = sourceCues.map((sourceCue, index) => {
    const timing = cueTiming(sourceCue);
    const nextTiming = index + 1 < sourceCues.length ? cueTiming(sourceCues[index + 1]) : null;
    if (!timing) return "";
    const nextStart = nextTiming ? nextTiming.start : Number.POSITIVE_INFINITY;
    const matches = displayCues.map((cue, displayIndex) => ({ cue, displayIndex, timing: cueTiming(cue) }))
      .filter((item) => item.timing && item.timing.start >= timing.start - 0.001 && item.timing.start < nextStart - 0.001);
    matches.forEach((item) => consumed.add(item.displayIndex));
    return matches.map((item) => plainText(item.cue.text)).join(" ").trim();
  });
  if (translations.some((value) => !value)) throw new Error("Could not reconstruct every source translation");
  if (consumed.size !== displayCues.length) throw new Error(`Could not map ${displayCues.length - consumed.size} displayed cues back to source cues`);
  return translations;
}

function assertTranslationsPreserved(sourceCues, expectedTexts, displayCues) {
  if (sourceCues.length !== expectedTexts.length) throw new Error("Expected translation count does not match source cues");
  const normalized = (value) => String(value || "").replace(/\s+/g, " ").trim();
  reconstructTranslations(sourceCues, displayCues).forEach((text, index) => {
    if (normalized(text) !== normalized(expectedTexts[index])) {
      throw new Error(`Formatação ou alinhamento alterou o conteúdo da fala ${index + 1}`);
    }
  });
}

function normalizedToken(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9']/g, "")
    .replace(/^'+|'+$/g, "");
}

function sourceTokens(value) {
  return plainText(value).split(/\s+/).map(normalizedToken).filter(Boolean);
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[right.length];
}

function tokenSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  return 1 - editDistance(left, right) / Math.max(left.length, right.length);
}

function matchedAudioRange(text, candidates) {
  const source = sourceTokens(text);
  const audio = candidates.map((word) => normalizedToken(word.text));
  if (!source.length || !audio.length) return { words: candidates, confidence: 0 };
  const rows = source.length + 1;
  const columns = audio.length + 1;
  const score = Array.from({ length: rows }, () => Array(columns).fill(0));
  const trace = Array.from({ length: rows }, () => Array(columns).fill(""));
  const gap = -0.8;
  for (let i = 1; i < rows; i++) { score[i][0] = i * gap; trace[i][0] = "up"; }
  for (let j = 1; j < columns; j++) { score[0][j] = j * gap; trace[0][j] = "left"; }
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < columns; j++) {
      const similarity = tokenSimilarity(source[i - 1], audio[j - 1]);
      const diagonal = score[i - 1][j - 1] + (similarity >= 0.82 ? 2.5 : similarity >= 0.6 ? 0.8 : -1.2);
      const up = score[i - 1][j] + gap;
      const left = score[i][j - 1] + gap;
      if (diagonal >= up && diagonal >= left) { score[i][j] = diagonal; trace[i][j] = "diag"; }
      else if (up >= left) { score[i][j] = up; trace[i][j] = "up"; }
      else { score[i][j] = left; trace[i][j] = "left"; }
    }
  }
  let i = source.length;
  let j = audio.length;
  const matched = [];
  while (i > 0 || j > 0) {
    const direction = trace[i][j];
    if (direction === "diag") {
      const similarity = tokenSimilarity(source[i - 1], audio[j - 1]);
      if (similarity >= 0.6) matched.push(j - 1);
      i--; j--;
    } else if (direction === "up") i--;
    else if (direction === "left") j--;
    else break;
  }
  if (!matched.length) return { words: candidates, confidence: 0 };
  matched.sort((a, b) => a - b);
  return {
    words: candidates.slice(matched[0], matched[matched.length - 1] + 1),
    confidence: matched.length / Math.max(1, source.length),
  };
}

function phraseChunks(value) {
  const text = plainText(localizeBrazilianPortuguese(String(value || "").replace(/<\/?sub\b[^\r\n>]*>?/gi, "")));
  if (!text) return [];
  // Timing must follow meaning, not screen width. Splitting at commas or at an
  // arbitrary character count made otherwise good dialogue feel fragmented.
  // Long sentences are only wrapped visually later; a new timed cue is created
  // exclusively for a real sentence boundary.
  return (typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("pt-BR", { granularity: "sentence" }).segment(text)].map((part) => part.segment.trim())
    : text.split(/(?<=[.!?…])\s+/u))
    .map((part) => part.trim())
    .filter(Boolean);
}

function fitChunksToDuration(chunks, duration, { minDuration = 0.75, maxCps = 25 } = {}) {
  const output = [...chunks];
  const requirement = (chunk) => Math.max(minDuration, plainText(chunk).length / maxCps);
  while (output.length > 1 && output.reduce((sum, chunk) => sum + requirement(chunk), 0) > duration) {
    let mergeAt = 0;
    let smallest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < output.length - 1; index++) {
      const combined = plainText(`${output[index]} ${output[index + 1]}`).length;
      if (combined < smallest) { smallest = combined; mergeAt = index; }
    }
    output.splice(mergeAt, 2, `${output[mergeAt]} ${output[mergeAt + 1]}`);
  }
  return output;
}

function wrapPhrase(value, maxLineChars = 42) {
  const turns = dialogueTurns(value);
  if (turns.length > 1) return turns.map((line) => `- ${line}`).join("\n");
  const words = plainText(value).split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > maxLineChars) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length <= 2) return lines.join("\n");
  let best = null;
  for (let index = 1; index < words.length; index++) {
    const left = words.slice(0, index).join(" ");
    const right = words.slice(index).join(" ");
    const score = Math.max(left.length, right.length) * 10 + Math.abs(left.length - right.length);
    if (!best || score < best.score) best = { left, right, score };
  }
  return best ? `${best.left}\n${best.right}` : plainText(value);
}

function allocatePhraseRanges(chunks, words, fallbackStart, fallbackEnd, { minDuration = 0.75, maxCps = 25, timingWeights = null } = {}) {
  if (chunks.length === 1) return [{ start: fallbackStart, end: fallbackEnd }];
  const requirements = chunks.map((chunk) => Math.max(minDuration, plainText(chunk).length / maxCps));
  const weights = Array.isArray(timingWeights) && timingWeights.length === chunks.length
    ? timingWeights.map((weight) => Math.max(1, weight))
    : chunks.map((chunk) => Math.max(1, plainText(chunk).length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const audioBoundaries = [];
  for (let index = 1; index < words.length; index++) {
    audioBoundaries.push((words[index - 1].end + words[index].start) / 2);
  }
  const boundaries = [fallbackStart];
  let consumedWeight = 0;
  for (let index = 0; index < chunks.length - 1; index++) {
    consumedWeight += weights[index];
    const proportional = fallbackStart + (fallbackEnd - fallbackStart) * consumedWeight / totalWeight;
    let preferred = proportional;
    if (audioBoundaries.length) {
      if (Array.isArray(timingWeights) && timingWeights.length === chunks.length) {
        const wordBoundary = Math.max(1, Math.min(words.length - 1, Math.round(words.length * consumedWeight / totalWeight)));
        preferred = (words[wordBoundary - 1].end + words[wordBoundary].start) / 2;
      } else {
        preferred = audioBoundaries.reduce((best, value) => Math.abs(value - proportional) < Math.abs(best - proportional) ? value : best, audioBoundaries[0]);
      }
    }
    const minimum = boundaries[index] + requirements[index];
    const remainingRequired = requirements.slice(index + 1).reduce((sum, value) => sum + value, 0);
    const maximum = fallbackEnd - remainingRequired;
    boundaries.push(Math.max(minimum, Math.min(maximum, preferred)));
  }
  boundaries.push(fallbackEnd);
  return chunks.map((_, index) => ({ start: boundaries[index], end: boundaries[index + 1] }));
}

function buildForcedAlignedCues(sourceCues, translatedTexts, timestampedWords, { maxLineChars = 48 } = {}) {
  if (sourceCues.length !== translatedTexts.length) throw new Error("Forced alignment requires one translation per source cue");
  const output = [];
  const stats = { sourceCues: sourceCues.length, outputCues: 0, alignedCues: 0, textMatchedCues: 0, fallbackCues: 0, averageConfidence: 0 };
  let confidenceTotal = 0;
  sourceCues.forEach((sourceCue, cueIndex) => {
    const timing = cueTiming(sourceCue);
    const sourceTurns = dialogueTurns(sourceCue.text);
    const initialChunks = sourceTurns.length > 1 ? [translatedTexts[cueIndex]] : phraseChunks(translatedTexts[cueIndex]);
    const chunks = timing ? fitChunksToDuration(initialChunks, timing.end - timing.start) : initialChunks;
    if (!timing || !chunks.length) return;
    const candidates = timestampedWords.filter((word) => word.end > timing.start && word.start < timing.end);
    const alignment = matchedAudioRange(sourceCue.text, candidates);
    const textMatched = alignment.words.length > 0 && alignment.confidence >= 0.2;
    // English dub scripts frequently paraphrase the official English subtitle.
    // Exact/fuzzy text matches refine the range; otherwise detected speech
    // inside the authoritative PGS interval still supplies real word edges.
    const speechWords = textMatched ? alignment.words : candidates;
    const alignedWords = speechWords.map((word) => ({
      ...word,
      start: Math.max(timing.start, word.start),
      end: Math.min(timing.end, word.end),
    })).filter((word) => word.end > word.start);
    const sourcePhrases = phraseChunks(sourceCue.text);
    const timingWeights = sourcePhrases.length === chunks.length
      ? sourcePhrases.map((phrase) => Math.max(1, sourceTokens(phrase).length))
      : null;
    const ranges = allocatePhraseRanges(chunks, alignedWords, timing.start, timing.end, { timingWeights });
    if (alignedWords.length) {
      stats.alignedCues++;
      if (textMatched) { stats.textMatchedCues++; confidenceTotal += alignment.confidence; }
    }
    else stats.fallbackCues++;
    chunks.forEach((text, chunkIndex) => {
      const range = ranges[chunkIndex];
      output.push({
        id: chunkIndex === 0 ? sourceCue.id : null,
        time: `${formatTimestamp(range.start)} --> ${formatTimestamp(range.end)}${timing.settings}`,
        text: wrapPhrase(text, maxLineChars),
      });
    });
  });
  stats.outputCues = output.length;
  stats.averageConfidence = stats.textMatchedCues ? confidenceTotal / stats.textMatchedCues : 0;
  return { cues: output, stats };
}

async function selectAudioStream(mediaInput, language = "en", preferredIndex = null) {
  const raw = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index:stream_tags=language,title", "-of", "json", mediaInput], { captureStdout: true });
  const streams = JSON.parse(raw).streams || [];
  if (!streams.length) throw new Error("Media has no audio streams for forced alignment");
  if (Number.isInteger(preferredIndex)) {
    const exact = streams.find((stream) => Number(stream.index) === preferredIndex);
    if (exact) return exact;
  }
  const wanted = String(language).toLowerCase();
  return streams.find((stream) => {
    const declared = String(stream.tags?.language || "").toLowerCase();
    const title = String(stream.tags?.title || "").toLowerCase();
    return declared === wanted || declared.startsWith(wanted) || (wanted.startsWith("en") && (declared === "eng" || title.includes("english")));
  }) || streams[0];
}

async function fetchWordTimestamps(mediaInput, outputDir, sourceId, options) {
  const cachePath = path.join(outputDir, "alignment-en-words.json");
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const sameStream = !Number.isInteger(options.audioStreamIndex) || Number(cached.audioStream) === options.audioStreamIndex;
    const sameLanguage = !options.language || String(cached.requestedLanguage || cached.language || "").toLowerCase() === String(options.language).toLowerCase();
    if (Array.isArray(cached.words) && cached.words.length && sameStream && sameLanguage) return cached;
  }
  const stream = await selectAudioStream(mediaInput, options.language || "en", options.audioStreamIndex);
  const audioPath = path.join(outputDir, "alignment-audio-en.flac");
  await run("ffmpeg", ["-y", "-v", "error", "-i", mediaInput, "-map", `0:${stream.index}`, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", audioPath]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(`${options.endpoint}/word-timestamps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ sourceId, mediaPath: audioPath, language: options.language || "en", prompt: String(options.prompt || "").slice(0, 500) }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Alignment service returned ${response.status}: ${body.slice(0, 500)}`);
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed.words) || !parsed.words.length) throw new Error("Alignment service returned no words");
    const complete = { ...parsed, requestedLanguage: options.language || "und", audioStream: stream.index, audioLanguage: stream.tags?.language || "und" };
    const temporary = `${cachePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(complete), "utf8");
    fs.renameSync(temporary, cachePath);
    return complete;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  assertTranslationsPreserved,
  buildForcedAlignedCues,
  fetchWordTimestamps,
  matchedAudioRange,
  phraseChunks,
  reconstructTranslations,
  selectAudioStream,
};
