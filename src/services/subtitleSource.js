const { parseVtt, serializeVtt } = require("./vtt");
const { normalizeOcrSourceText } = require("./translate");
const { assertCueIntegrity, assertSubtitleCompleteness, mergeShortCues, removeEmptyCues, removeTransientOcrNoise, suspiciousTranscriptionRepetitions, suspiciousTranscriptionArtifacts } = require("./subtitleQuality");

async function prepareSubtitleSource(extraction, { duration, auditPgs, assertActive } = {}) {
  assertActive?.();
  const rawContent = extraction.rawContent || extraction.content;
  let parsed = removeEmptyCues(parseVtt(extraction.content));
  if (extraction.name.startsWith("ocr-pgs")) parsed = removeTransientOcrNoise(parsed.map((cue) => ({ ...cue, text: normalizeOcrSourceText(cue.text) })));
  const transcribed = extraction.name === "faster-whisper";
  const cues = transcribed ? mergeShortCues(parsed) : parsed;
  const maxCueSeconds = transcribed ? 20 : 60;
  const quality = assertCueIntegrity(cues, { maxCueSeconds });
  quality.completeness = assertSubtitleCompleteness(cues, duration, {
    strictDensity: false,
    maxInteriorGapSeconds: transcribed ? 45 : null,
    speechIntervals: transcribed ? extraction.speechIntervals : null,
  });
  if (transcribed) {
    const artifacts = suspiciousTranscriptionArtifacts(cues);
    if (artifacts.length) throw new Error(`Transcrição contém metadado de arquivo: ${artifacts[0].text.slice(0, 80)}`);
    quality.repetitionWarnings = suspiciousTranscriptionRepetitions(cues);
    quality.transcription = extraction.transcriptionQuality;
    quality.speechIntervals = extraction.speechIntervals || null;
    quality.transcriptionRecoveryReason = extraction.transcriptionRecoveryReason;
    quality.repairedTranscriptionSegments = extraction.repairedTranscriptionSegments || 0;
  } else if (auditPgs) {
    quality.embeddedPacketAudit = await auditPgs(extraction, cues);
  }
  return { ...extraction, rawContent, content: serializeVtt(parsed), cues, sourceQuality: quality, maxCueSeconds };
}

async function selectSubtitleSource({ cached, embedded, transcribe, prepare, assertActive }) {
  const errors = [];
  if (cached) {
    try { return await prepare(cached); }
    catch (error) { if (error.code === "SOURCE_CANCELLED") throw error; errors.push(`cache: ${error.message}`); }
  }
  for (const [name, operation] of [["embedded", () => embedded(false)], ["transcription", transcribe], ["intermediate", () => embedded(true)]]) {
    assertActive?.();
    try {
      const result = await operation();
      return { ...result, sourceSelectionFailures: errors };
    } catch (error) {
      if (error.code === "SOURCE_CANCELLED") throw error;
      errors.push(`${name}: ${error.message}`);
    }
  }
  throw new Error(`Nenhuma fonte de legenda foi aprovada: ${errors.join(" | ")}`);
}

module.exports = { prepareSubtitleSource, selectSubtitleSource };
