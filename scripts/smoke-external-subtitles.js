// Downloads subtitles only; never queues a video or publishes a generation.
const fs = require("fs");
const crypto = require("crypto");
const config = require("../src/config");
const sourceStore = require("../src/services/sourceStore");
const { safeChildPath } = require("../src/utils/security");
const { probeMediaTracks } = require("../src/services/ffextract");
const { prepareSubtitleSource } = require("../src/services/subtitleSource");
const { createExternalSubtitleSession } = require("../src/services/externalSubtitles");

async function main() {
  const source = sourceStore.get(process.argv[2]);
  if (!source?.localPath || !fs.existsSync(source.localPath)) throw new Error("Informe o sourceId de um vídeo local existente");
  const outputDir = safeChildPath(config.storageDir, "external-smoke", crypto.randomUUID());
  fs.mkdirSync(outputDir, { recursive: true });
  const mediaTracks = await probeMediaTracks(source.localPath);
  const session = createExternalSubtitleSession({ source, mediaInput: source.localPath, outputDir, mediaTracks,
    prepare: (candidate) => prepareSubtitleSource(candidate, { duration: mediaTracks.duration }) });
  try {
    const result = await session.find("target");
    console.log(JSON.stringify({ ok: true, videoId: source.videoId, language: result.lang, external: result.external, cues: result.cues.length }));
  } finally {
    session.cleanup();
    // This directory was created exclusively for this smoke run above.
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
