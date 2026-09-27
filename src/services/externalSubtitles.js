const fs = require("fs");
const path = require("path");
const config = require("../config");
const { stableHash, safeChildPath } = require("../utils/security");
const { writeFileAtomic } = require("../utils/atomicFile");
const { readJsonFile, writeJsonFileAtomic } = require("../utils/atomicJson");
const { fetchWithTimeout } = require("../utils/fetchWithTimeout");
const { runProcess } = require("../utils/processRunner");
const { parseVtt, serializeVtt } = require("./vtt");
const { analyzeSpeechCoverage, analyzeReferenceCoverage, cueTiming, assertCueIntegrity, formatTimestamp, analyzeCueIntegrity } = require("./subtitleQuality");
const { selectTimingReferenceTrack, probeSubtitlePacketTimings } = require("./ffextract");
const { parsePgsPositions } = require("./pgs");
const { canonicalLanguage, selectOriginalAudio, translationRoute } = require("./languageStrategy");
const { parseVideoId } = require("./videoId");
const { createSubtitleProviders } = require("./subtitleProviders");

const providers = createSubtitleProviders();
const searches = new Map();

function publicCandidate(candidate) {
  return { provider: candidate.provider, id: candidate.id, language: candidate.lang, release: candidate.release,
    matchScore: candidate.score, hashMatch: Boolean(candidate.hashMatch), hearingImpaired: candidate.hearingImpaired };
}

function nearIntervals(timings, intervals, tolerance = 0.75) {
  const ordered = intervals.filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start).sort((a, b) => a.start - b.start);
  let cursor = 0;
  let matched = 0;
  for (const timing of [...timings].sort((a, b) => a.start - b.start)) {
    while (cursor < ordered.length && ordered[cursor].end < timing.start - tolerance) cursor++;
    if (ordered[cursor]?.start < timing.end + tolerance) matched++;
  }
  return timings.length ? matched / timings.length : 0;
}

function auditEmbeddedReference(cues, speech, reference) {
  if (!reference?.authoritative || !Array.isArray(reference.intervals) || reference.intervals.length < 20) return null;
  const timing = cues.map(cueTiming);
  const spoken = reference.intervals.filter((item) => nearIntervals([item], speech) === 1);
  const spokenCoverage = analyzeReferenceCoverage(cues, spoken, { toleranceSeconds: 0.75, minimumReferenceCues: 20 });
  const cueReferenceRatio = nearIntervals(timing, reference.intervals);
  const missingSpoken = spoken.filter((item) => nearIntervals([item], timing) !== 1);
  const openingGap = missingSpoken.filter((item) => item.start >= 25 && item.end <= 90).sort((a, b) => a.start - b.start);
  const openingOnlyGap = openingGap.length > 0 && openingGap.length === missingSpoken.length
    && openingGap.length <= Math.max(6, Math.ceil(spoken.length * 0.08))
    && openingGap[openingGap.length - 1].end - openingGap[0].start <= 25
    && cueReferenceRatio >= 0.95 && spokenCoverage.coverageRatio >= 0.9;
  return { trackIndex: reference.trackIndex, kind: reference.kind, metric: "temporal-overlap-only", cueReferenceRatio,
    spokenCoverage, openingOnlyGap, approved: cues.length >= 20 && cueReferenceRatio >= 0.9 && spokenCoverage.available
      && (spokenCoverage.coverageRatio >= 0.95 || openingOnlyGap) && spokenCoverage.longestUncoveredRunSeconds <= 25 };
}

function auditExternalSynchronization(raw, synced, intervals, duration, settings = config.externalSubtitles, reference = null, method = "alass") {
  const original = parseVtt(raw);
  const cues = parseVtt(synced);
  assertCueIntegrity(cues, { maxCueSeconds: 60 });
  if (!original.length || original.length !== cues.length || original.some((cue, index) => cue.text.replace(/\s+/g, " ").trim() !== cues[index].text.replace(/\s+/g, " ").trim())) {
    throw new Error("Sincronização alterou ou perdeu falas da legenda");
  }
  const timings = cues.map(cueTiming);
  if (!Number.isFinite(duration) || duration <= 0 || timings.some((item) => item.start < 0 || item.end > duration + 0.5)) throw new Error("Legenda fora da duração do vídeo");
  if (!Array.isArray(intervals) || !intervals.length) throw new Error("Sem fala detectada para conferir a sincronização externa");
  const coverage = analyzeSpeechCoverage(cues, intervals, 0.75);
  const cueSpeechRatio = nearIntervals(timings, intervals);
  const embeddedReference = auditEmbeddedReference(cues, intervals, reference);
  const speechInsufficient = !coverage.available || coverage.coverageRatio < settings.minimumSpeechCoverage || coverage.longestUncoveredRunSeconds > 25;
  const cueRatioInsufficient = cueSpeechRatio < settings.minimumCueSpeechRatio;
  if (speechInsufficient || (cueRatioInsufficient && !embeddedReference?.approved)) {
    const error = new Error(`Sincronia externa insuficiente: cobertura ${Math.round(coverage.coverageRatio * 100)}%, falas coincidentes ${Math.round(cueSpeechRatio * 100)}%`);
    if (!speechInsufficient && cueRatioInsufficient) error.code = "EXTERNAL_CUE_SPEECH_RATIO";
    throw error;
  }
  const offsets = cues.map((cue, index) => cueTiming(cue).start - cueTiming(original[index]).start);
  return { method, ...coverage, cueSpeechRatio, cues: cues.length,
    minimumOffsetSeconds: Math.min(...offsets), maximumOffsetSeconds: Math.max(...offsets),
    adjustedBySections: Math.max(...offsets) - Math.min(...offsets) > 1,
    validationBasis: cueRatioInsufficient ? "audio-and-embedded-timings" : "audio",
    embeddedReference, semanticMatchVerified: false };
}

function repairIncidentalSyncOverlaps(raw, synced) {
  const original = parseVtt(raw);
  const cues = parseVtt(synced);
  if (original.length !== cues.length || analyzeCueIntegrity(original).overlaps) return { vtt: synced, repairedOverlaps: 0 };
  let repairedOverlaps = 0;
  for (let index = 1; index < cues.length; index++) {
    const previous = cueTiming(cues[index - 1]);
    const current = cueTiming(cues[index]);
    if (!previous || !current || current.start >= previous.end - 0.25) continue;
    const overlap = previous.end - current.start;
    const shortenedEnd = current.start - 0.02;
    // Alass can leave a few adjacent cues overlapping after moving sections.
    // Trim only a small tail; a large collision may indicate a wrong match.
    if (overlap > 2 || overlap > (previous.end - previous.start) * 0.6 || shortenedEnd - previous.start < 0.5) {
      return { vtt: synced, repairedOverlaps: 0 };
    }
    cues[index - 1] = { ...cues[index - 1], time: `${formatTimestamp(previous.start)} --> ${formatTimestamp(shortenedEnd)}${previous.settings}` };
    repairedOverlaps++;
  }
  if (repairedOverlaps > Math.max(2, Math.floor(cues.length * 0.05))) return { vtt: synced, repairedOverlaps: 0 };
  return { vtt: repairedOverlaps ? serializeVtt(cues) : synced, repairedOverlaps };
}

async function selectVerifiedExternalTimings(result, duration, settings, embeddedReference) {
  const repaired = repairIncidentalSyncOverlaps(result.rawVtt, result.vtt);
  let audit;
  try {
    try { audit = auditExternalSynchronization(result.rawVtt, repaired.vtt, result.speechIntervals, duration, settings); }
    catch (error) {
      if (error.code !== "EXTERNAL_CUE_SPEECH_RATIO") throw error;
      audit = auditExternalSynchronization(result.rawVtt, repaired.vtt, result.speechIntervals, duration, settings, await embeddedReference());
    }
    return { vtt: repaired.vtt, audit: { ...audit, repairedOverlaps: repaired.repairedOverlaps } };
  } catch (alignedError) {
    // A cut or opening music can make Alass collapse otherwise correct cues to
    // time zero. Use original timestamps only with independent packet evidence.
    const reference = await embeddedReference();
    if (!reference?.authoritative) throw alignedError;
    try {
      audit = auditExternalSynchronization(result.rawVtt, result.rawVtt, result.speechIntervals, duration, settings, reference, "original-verified");
      if (!audit.embeddedReference?.approved) throw new Error("Tempos originais sem confirmação da faixa embutida");
      return { vtt: result.rawVtt, audit: { ...audit, repairedOverlaps: 0, alignmentRejected: alignedError.message } };
    } catch (originalError) {
      throw new Error(`Alinhamento recusado: ${alignedError.message}; tempos originais recusados: ${originalError.message}`);
    }
  }
}

async function synchronizeCandidate({ candidate, payloadPath, audioPath, identity, assertActive }) {
  const controller = new AbortController();
  let cancellation = null;
  const timer = setInterval(() => {
    try { assertActive?.(); } catch (error) { cancellation = error; controller.abort(); }
  }, 1000);
  timer.unref?.();
  try {
    const response = await fetchWithTimeout(`${config.intelligenceUrl}/sync-subtitle`, {
      method: "POST", signal: controller.signal, size: config.remoteFetchMaxBytes * 3,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: identity.sourceId, audioPath, subtitlePath: payloadPath, fileName: candidate.fileName, season: identity.season, episode: identity.episode }),
    }, config.externalSubtitles.timeoutMs);
    if (!response.ok) { response.body?.destroy(); throw new Error(`Serviço de sincronização retornou HTTP ${response.status}`); }
    return await response.json();
  } catch (error) {
    if (cancellation) throw cancellation;
    if (/^Serviço de sincronização/.test(error.message)) throw error;
    throw new Error("Falha de comunicação com a sincronização externa");
  } finally { clearInterval(timer); }
}

function createExternalSubtitleSession({ source, mediaInput, outputDir, mediaTracks, prepare, assertActive,
  client = providers, sync = synchronizeCandidate, settings = config.externalSubtitles } = {}) {
  const failures = [];
  const tried = new Set();
  const providersFailed = new Set();
  const originalAudio = selectOriginalAudio(mediaTracks?.audioTracks || [], source);
  const identity = { ...parseVideoId(source.type, source.videoId), sourceId: source.sourceId };
  let attempts = 0;
  let audioReady = false;
  let referenceLoaded = false;
  let reference = null;
  const audioPath = path.join(outputDir, "external-sync-audio.flac");
  const referencePath = path.join(outputDir, "external-timing-reference.sup");
  async function embeddedReference() {
    if (referenceLoaded) return reference;
    referenceLoaded = true;
    const track = selectTimingReferenceTrack(mediaTracks.subtitleTracks || [], originalAudio);
    if (!track) return null;
    assertActive?.();
    let intervals;
    const pgs = track.codec === "hdmv_pgs_subtitle";
    if (pgs) {
      // Read display timestamps from image packets; this does not run OCR.
      const result = await runProcess("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", mediaInput, "-map", `0:${track.ffIndex}`, "-c:s", "copy", referencePath], { timeoutMs: settings.timeoutMs });
      if (result.status !== 0 || !fs.existsSync(referencePath) || fs.statSync(referencePath).size > 64 * 1024 * 1024) throw new Error("Referência temporal embutida não disponível");
      intervals = parsePgsPositions(fs.readFileSync(referencePath)).map((event) => ({ start: event.at, end: event.at + 0.01 }));
    } else {
      intervals = await probeSubtitlePacketTimings(mediaInput, track.ffIndex);
      if (!intervals.length || intervals.some((item) => !item.durationKnown)) return null;
    }
    assertActive?.();
    reference = { intervals, authoritative: true, trackIndex: track.ffIndex, kind: pgs ? "pgs-display-timestamps" : "text-packet-timestamps" };
    return reference;
  }
  async function audio() {
    if (audioReady) return;
    if (!config.intelligenceUrl || !fs.existsSync(mediaInput) || !Number.isInteger(originalAudio?.ffIndex)) throw new Error("Sincronização externa exige vídeo local e faixa de áudio confirmada");
    assertActive?.();
    const result = await runProcess("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", mediaInput, "-map", `0:${originalAudio.ffIndex}`, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", audioPath], { timeoutMs: settings.timeoutMs });
    if (result.status !== 0) throw new Error("Falha ao preparar áudio para sincronização externa");
    assertActive?.();
    audioReady = true;
  }
  async function listing(provider, language) {
    const key = stableHash(JSON.stringify({ version: 1, provider, language, videoId: source.videoId, fileName: source.fileName || source.filename || path.basename(mediaInput),
      // Credential changes invalidate cached provider failures without storing secrets.
      account: stableHash(provider === "subdl" ? settings.subdlKey : `${settings.opensubtitlesKey}|${settings.opensubtitlesUsername}`),
      size: fs.statSync(mediaInput).size, mtime: fs.statSync(mediaInput).mtimeMs }), 48);
    const file = safeChildPath(config.storageDir, "provider-search", `${key}.json`);
    const cached = readJsonFile(file, { fallback: () => null, validate: (data) => Array.isArray(data.candidates) && Number.isFinite(data.expires) });
    if (cached?.expires > Date.now()) return cached.candidates;
    if (!searches.has(key)) {
      const pending = client.search(provider, source, { language, mediaPath: mediaInput }).then((candidates) => {
        writeJsonFileAtomic(file, { candidates, expires: Date.now() + (candidates.length ? 6 * 3600000 : 15 * 60000) });
        return candidates;
      }).finally(() => searches.delete(key));
      searches.set(key, pending);
    }
    return searches.get(key);
  }
  async function find(tier) {
    const configured = client.configured();
    if (!settings.enabled || !configured.length || !fs.existsSync(mediaInput)) throw new Error("Busca externa não disponível para esta fonte");
    // Keep attempts available for original/intermediate text before falling back to OCR.
    const attemptLimit = tier === "target" ? Math.max(1, settings.maxCandidates - 2)
      : tier === "original" ? Math.max(1, settings.maxCandidates - 1) : settings.maxCandidates;
    let languages = tier === "target" ? ["pt-br", "pt"] : tier === "original" ? [originalAudio?.lang] : ["en", ...config.preferredSubtitleLangs];
    languages = [...new Set(languages.filter(Boolean).map(canonicalLanguage))].filter((lang) => lang !== "und" && (tier === "target" || !lang.startsWith("pt")) && (tier !== "fallback" || lang !== originalAudio?.lang));
    for (const language of languages) {
      if (attempts >= attemptLimit) break;
      const candidates = [];
      for (const provider of configured) {
        if (providersFailed.has(provider)) continue;
        assertActive?.();
        try { candidates.push(...await listing(provider, language)); }
        catch (error) { if (error.code === "SOURCE_CANCELLED") throw error; failures.push({ provider, stage: "search", reason: error.message }); providersFailed.add(provider); }
      }
      candidates.sort((a, b) => b.score - a.score || Number(a.hearingImpaired) - Number(b.hearingImpaired));
      for (const candidate of candidates) {
        if (candidate.lang !== language || candidate.machineTranslated || candidate.aiTranslated) continue;
        const key = `${candidate.provider}:${candidate.id}`;
        if (tried.has(key) || attempts >= attemptLimit) continue;
        tried.add(key);
        attempts++;
        const payloadPath = path.join(outputDir, `external-${stableHash(key, 24)}.bin`);
        try {
          assertActive?.();
          await audio();
          if (!fs.existsSync(payloadPath)) {
            writeFileAtomic(payloadPath, await client.download(candidate));
          }
          assertActive?.();
          const result = await sync({ candidate, payloadPath, audioPath, identity, assertActive });
          const verified = await selectVerifiedExternalTimings(result, mediaTracks.duration, settings, embeddedReference);
          const audit = verified.audit;
          const external = { ...publicCandidate(candidate), sourceMember: result.sourceMember, synchronization: audit, failures: [...failures] };
          const extraction = await prepare({ name: `external-${candidate.provider}`, content: verified.vtt, rawContent: result.rawVtt, lang: candidate.lang,
            trackIndex: null, sourceAudioIndex: originalAudio.ffIndex, sourceAudioLanguage: originalAudio.lang,
            sourceAudioConfidence: originalAudio.confidence, sourceAudioReason: originalAudio.reason,
            translationRoute: translationRoute(candidate.lang, originalAudio), external });
          writeFileAtomic(path.join(outputDir, "external-original.vtt"), result.rawVtt);
          return extraction;
        } catch (error) {
          if (error.code === "SOURCE_CANCELLED") throw error;
          failures.push({ ...publicCandidate(candidate), stage: "validation", reason: error.message });
        }
      }
    }
    throw new Error(`Nenhuma legenda externa aprovada (${tier}); ${failures.map((item) => `${item.provider}: ${item.reason}`).join("; ") || "sem resultados"}`);
  }
  return { find, failures, cleanup: () => { for (const file of [audioPath, referencePath]) fs.rmSync(file, { force: true }); } };
}

module.exports = { createExternalSubtitleSession, auditExternalSynchronization, publicCandidate, repairIncidentalSyncOverlaps, selectVerifiedExternalTimings };
