const fs = require("fs");
const path = require("path");
const config = require("../config");
const { fetchWithTimeout } = require("../utils/fetchWithTimeout");
const { runProcess } = require("../utils/processRunner");

async function run(binary, args) {
  const result = await runProcess(binary, args, { timeoutMs: config.mediaProcessTimeoutMs, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${binary} exited with ${result.status}: ${result.stderr.slice(-4000)}`);
}

async function transcribeSource(sourceUrl, outputDir, sourceId, prompt = "", options = {}) {
  if (!config.intelligenceUrl) throw new Error("No textual subtitle found and INTELLIGENCE_URL is not configured");
  const audioPath = path.join(outputDir, "processing-audio.flac");
  const audioMap = Number.isInteger(options.audioStreamIndex) ? ["-map", `0:${options.audioStreamIndex}`] : [];
  await run("ffmpeg", ["-y", "-v", "error", "-i", sourceUrl, ...audioMap, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", audioPath]);
  const response = await fetchWithTimeout(`${config.intelligenceUrl}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceId, audioPath, prompt: String(prompt).slice(0, 500), language: options.language || null }),
  }, config.transcriptionTimeoutMs);
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Transcription service returned ${response.status}: ${responseText.slice(0, 500)}`);
  const data = JSON.parse(responseText);
  if (typeof data.vtt !== "string" || !data.vtt.startsWith("WEBVTT")) throw new Error("Transcription service returned invalid VTT");
  fs.writeFileSync(path.join(outputDir, "transcribed.vtt"), data.vtt, "utf8");
  return {
    content: data.vtt,
    lang: data.language || options.language || "und",
    name: "faster-whisper",
    sourceAudioIndex: options.audioStreamIndex ?? null,
    sourceAudioLanguage: options.language || data.language || "und",
    sourceAudioReason: options.reason || "automatic-transcription-audio",
    sourceAudioConfidence: options.confidence || "unknown",
    translationRoute: "direct-original-audio-transcription",
  };
}

async function releaseTranscriptionModel() {
  if (!config.intelligenceUrl) return;
  try {
    await fetchWithTimeout(`${config.intelligenceUrl}/unload`, { method: "POST" }, Math.min(config.internalHttpTimeoutMs, 15000));
  } catch (_) {
    // Translation can still attempt to run; its own timeout and validation are authoritative.
  }
}

module.exports = { releaseTranscriptionModel, transcribeSource };
