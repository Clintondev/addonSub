const { parseVtt, serializeVtt } = require("./vtt");
const { normalizeOcrSourceText } = require("./translate");
const { languageMatches } = require("./languageStrategy");
const { assertCueIntegrity, assertSubtitleCompleteness, mergeShortCues, removeEmptyCues, removeTransientOcrNoise, suspiciousTranscriptionRepetitions, suspiciousTranscriptionArtifacts } = require("./subtitleQuality");

async function prepareSubtitleSource(extraction, { duration, auditPgs, assertActive } = {}) {
  assertActive?.();
  const rawContent = extraction.rawContent || extraction.content;
  let parsed = parseVtt(extraction.content);
  if (extraction.external) parsed = parsed.map((cue) => ({ ...cue,
    text: cue.text.replace(/<\/?(?:i|b|u|font)(?:\s+[^<>]{0,120})?>/giu, ""),
  }));
  parsed = removeEmptyCues(parsed);
  if (extraction.name.startsWith("ocr-pgs")) parsed = removeTransientOcrNoise(parsed.map((cue) => ({ ...cue, text: normalizeOcrSourceText(cue.text) })));
  const transcribed = extraction.name === "faster-whisper";
  const cues = transcribed ? mergeShortCues(parsed) : parsed;
  const maxCueSeconds = transcribed ? 20 : 60;
  const quality = assertCueIntegrity(cues, { maxCueSeconds });
  if (extraction.external) quality.externalSynchronization = extraction.external.synchronization;
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

async function selectSubtitleSource({ cached, embedded, transcribe, prepare, assertActive, external, isTarget = (candidate) => languageMatches(candidate.lang, "pt") }) {
  const errors = [];
  if (cached && !(external && languageMatches(cached.lang, "pt") && !isTarget(cached))) {
    try { return await prepare(cached); }
    catch (error) { if (error.code === "SOURCE_CANCELLED") throw error; errors.push(`cache: ${error.message}`); }
  }
  let original = null;
  if (external) {
    assertActive?.();
    try {
      original = await embedded(false, { allowOcr: false });
      if (isTarget(original)) return { ...original, sourceSelectionFailures: errors };
    } catch (error) { if (error.code === "SOURCE_CANCELLED") throw error; errors.push(`embedded: ${error.message}`); }
  }
  const operations = external
    ? [["external-target", () => external("target")], ["embedded-original", () => { if (original) return original; throw new Error("sem faixa original aprovada"); }],
      ["external-original", () => external("original")], ["intermediate-text", () => embedded(true, { allowOcr: false })], ["external-fallback", () => external("fallback")],
      ["embedded-ocr", () => embedded(false)], ["intermediate-ocr", () => embedded(true)], ["transcription", transcribe]]
    : [["embedded", () => embedded(false)], ["transcription", transcribe], ["intermediate", () => embedded(true)]];
  for (const [name, operation] of operations) {
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
