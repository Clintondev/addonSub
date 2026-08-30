const fs = require("fs");
const path = require("path");
const config = require("../src/config");
const sourceStore = require("../src/services/sourceStore");
const { subtitlePath } = require("../src/services/subtitleService");
const { parseVtt, serializeVtt } = require("../src/services/vtt");
const { assertCueIntegrity } = require("../src/services/subtitleQuality");
const { buildForcedAlignedCues, fetchWordTimestamps, reconstructTranslations } = require("../src/services/forcedAlignment");
const { releaseTranscriptionModel } = require("../src/services/transcribe");
const { transition } = require("../src/services/metadata");

async function main() {
  const sourceId = process.argv[2];
  if (!/^src_[a-f0-9]{32}$/i.test(sourceId || "")) throw new Error("Usage: node scripts/realign-existing.js src_<id>");
  const source = sourceStore.get(sourceId);
  if (!source?.localPath || !fs.existsSync(source.localPath)) throw new Error("Source media is not available locally");
  const originalPath = subtitlePath(sourceId, "original.vtt");
  const finalPath = subtitlePath(sourceId, "pt-BR.vtt");
  const backup = subtitlePath(sourceId, "pt-BR.before-forced-alignment.vtt");
  const baselinePath = fs.existsSync(backup) ? backup : finalPath;
  const sourceCues = parseVtt(fs.readFileSync(originalPath, "utf8"));
  const baselineCues = parseVtt(fs.readFileSync(baselinePath, "utf8"));
  const translations = reconstructTranslations(sourceCues, baselineCues);
  const outputDir = path.dirname(finalPath);
  const timestamps = await fetchWordTimestamps(source.localPath, outputDir, sourceId, {
    endpoint: config.intelligenceUrl,
    language: "en",
    prompt: [source.filename, source.title, source.name].filter(Boolean).join(". "),
    timeoutMs: config.forcedAlignmentTimeoutMs,
  });
  const aligned = buildForcedAlignedCues(sourceCues, translations, timestamps.words);
  const quality = assertCueIntegrity(aligned.cues, { maxCueSeconds: 60 });
  if (!fs.existsSync(backup)) fs.copyFileSync(finalPath, backup);
  const temporary = `${finalPath}.tmp`;
  fs.writeFileSync(temporary, serializeVtt(aligned.cues), "utf8");
  fs.renameSync(temporary, finalPath);
  transition(sourceId, "ready", {
    progress: 100,
    cues: aligned.cues.length,
    finalQuality: quality,
    alignmentQuality: {
      ...aligned.stats,
      audioStream: timestamps.audioStream,
      audioLanguage: timestamps.audioLanguage,
      detectedWords: timestamps.words.length,
    },
  });
  console.log(JSON.stringify({ sourceId, cues: aligned.cues.length, quality, alignment: aligned.stats, audioStream: timestamps.audioStream, audioLanguage: timestamps.audioLanguage, detectedWords: timestamps.words.length }, null, 2));
}

main().finally(releaseTranscriptionModel).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
