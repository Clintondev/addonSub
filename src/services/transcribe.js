const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const fetch = require("node-fetch");
const config = require("../config");

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => { error = `${error}${chunk}`.slice(-4000); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${binary} exited with ${code}: ${error}`)));
  });
}

async function transcribeSource(sourceUrl, outputDir, sourceId, prompt = "") {
  if (!config.intelligenceUrl) throw new Error("No textual subtitle found and INTELLIGENCE_URL is not configured");
  const audioPath = path.join(outputDir, "processing-audio.flac");
  await run("ffmpeg", ["-y", "-v", "error", "-i", sourceUrl, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", audioPath]);
  const response = await fetch(`${config.intelligenceUrl}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceId, audioPath, prompt: String(prompt).slice(0, 500) }),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Transcription service returned ${response.status}: ${responseText.slice(0, 500)}`);
  const data = JSON.parse(responseText);
  if (typeof data.vtt !== "string" || !data.vtt.startsWith("WEBVTT")) throw new Error("Transcription service returned invalid VTT");
  fs.writeFileSync(path.join(outputDir, "transcribed.vtt"), data.vtt, "utf8");
  return { content: data.vtt, lang: data.language || "und", name: "faster-whisper" };
}

async function releaseTranscriptionModel() {
  if (!config.intelligenceUrl) return;
  try {
    await fetch(`${config.intelligenceUrl}/unload`, { method: "POST" });
  } catch (_) {
    // Translation can still attempt to run; its own timeout and validation are authoritative.
  }
}

module.exports = { releaseTranscriptionModel, transcribeSource };
