const fs = require("fs");
const path = require("path");
const { Worker, UnrecoverableError } = require("bullmq");
const config = require("./config");
const logger = require("./logger");
const { getConnection } = require("./jobs/queue");
const sourceStore = require("./services/sourceStore");
const { subtitlePath, ensureSourceDir, ensureSrtSubtitle } = require("./services/subtitleService");
const { extractHlsSubtitle } = require("./services/hls");
const { extractDashSubtitle } = require("./services/dash");
const { extractFileSubtitle, probeMediaTracks, probeSubtitlePacketTimings, selectTimingReferenceTrack } = require("./services/ffextract");
const { releaseTranscriptionModel, transcribeSource } = require("./services/transcribe");
const { parseVtt, serializeVtt } = require("./services/vtt");
const { detectLanguage, inferProtectedTerms, translateBatch, translateContextual, mapTargetLocale, looksRomanizedJapanese, validateTargetScript } = require("./services/translate");
const { analyzeReferenceCoverage, assertCueIntegrity, displayChunks, finalizeCues, localizeBrazilianPortuguese, parseTimestamp, preserveDialogueLayout, removeEmptyCues, suspiciousTranscriptionArtifacts } = require("./services/subtitleQuality");
const { assertTranslationsPreserved, buildForcedAlignedCues, fetchWordTimestamps } = require("./services/forcedAlignment");
const { readMeta, transition } = require("./services/metadata");
const { inc } = require("./metrics");
const { assertSafeRemoteUrl, stableHash, safeChildPath } = require("./utils/security");
const { acquireTorrent, stopTorrent } = require("./services/qbittorrent");
const { validateLocalMedia } = require("./services/mediaValidation");
const { recoverCorruptMedia } = require("./services/mediaRecovery");
const { isCancelled } = require("./services/cancellationStore");
const { withGpuLock } = require("./services/gpuLock");
const { scheduleSeriesPrefetch } = require("./services/seriesPrefetch");
const { ensureEmbeddedPlayback } = require("./services/embeddedPlayback");
const { downloadRemoteMedia } = require("./services/remoteMedia");
const { canonicalLanguage, languageMatches, resolveSourceLanguage, selectOriginalAudio, selectTranscriptionAudio, speechRecognitionLanguage, translationRoute } = require("./services/languageStrategy");
const { enrichContentLanguageMetadata } = require("./services/contentMetadata");
const { nameAliasesForSource } = require("./services/nameAliases");
const { seriesDialogueCorrectionsForSource, seriesTerminologyForSource } = require("./services/seriesTerminology");
const { prepareSubtitleSource, selectSubtitleSource } = require("./services/subtitleSource");
const { publishSubtitle, readPublication, publishedFile } = require("./services/subtitlePublication");
const { translationResources } = require("./services/translationResources");
const { writeFileAtomic } = require("./utils/atomicFile");
const { getWebQueue, queueWebPreparation, processWebJob } = require("./services/webPreparation");
const { parsePgsPositions } = require("./services/pgs");
const { mediaIdentity } = require("./services/mediaIdentity");
const { createTranslationBudget } = require("./services/translationBudget");

function cancelledError() {
  const error = new Error("Job cancelado porque a fonte foi excluída");
  error.code = "SOURCE_CANCELLED";
  return error;
}

function assertJobActive(job) {
  if (isCancelled(job.data.sourceId, job.data.requestedAt) || !sourceStore.get(job.data.sourceId)) throw cancelledError();
}

function mediaFingerprint(mediaInput) {
  return mediaIdentity(mediaInput);
}

function cachedExtraction(sourceId, fingerprint) {
  const file = subtitlePath(sourceId, "original.vtt");
  const meta = readMeta(sourceId);
  if (!fs.existsSync(file) || !meta.origin || meta.extractionFingerprint !== fingerprint) return null;
  const content = fs.readFileSync(file, "utf8");
  const cues = parseVtt(content);
  if (!removeEmptyCues(cues).length) return null;
  if (meta.origin === "faster-whisper" && suspiciousTranscriptionArtifacts(cues).length) return null;
  return {
    content, lang: meta.languageDeclared || "und", name: meta.origin, trackIndex: meta.trackIndex ?? null, cached: true,
    supPath: Number.isInteger(meta.trackIndex) ? subtitlePath(sourceId, `track-${meta.trackIndex}.sup`) : null,
    sourceAudioIndex: meta.sourceAudioIndex ?? null,
    sourceAudioLanguage: meta.sourceAudioLanguage || "und",
    sourceAudioReason: meta.sourceAudioReason || "cached",
    sourceAudioConfidence: meta.sourceAudioConfidence || "unknown",
    translationRoute: meta.translationRoute || "source-language-unverified",
    transcriptionQuality: meta.sourceQuality?.transcription || null,
    transcriptionRecoveryReason: meta.sourceQuality?.transcriptionRecoveryReason || null,
    repairedTranscriptionSegments: Number(meta.sourceQuality?.repairedTranscriptionSegments || 0),
    speechIntervals: meta.sourceQuality?.speechIntervals || null,
  };
}

async function transcribeWithGpu(mediaInput, outputDir, source, job, originalAudio = null) {
  if (/^https?:/i.test(String(mediaInput))) throw new Error("Remote adaptive streams without a subtitle track cannot be transcribed safely; use a downloadable media URL or torrent source");
  return withGpuLock(`transcribe:${source.sourceId}`, async () => {
    assertJobActive(job);
    // Release filenames and add-on labels are not spoken dialogue. Passing
    // them as Whisper's initial prompt caused literal "85.mkv / 1080p" cues.
    try { return await transcribeSource(mediaInput, outputDir, source.sourceId, "", {
      audioStreamIndex: originalAudio?.ffIndex,
      language: speechRecognitionLanguage(originalAudio?.lang),
      reason: originalAudio?.reason,
      confidence: originalAudio?.confidence,
    }); } finally { await releaseTranscriptionModel(); }
  }, { priority: job.opts?.priority, assertActive: () => assertJobActive(job) });
}

function clearFailureMarker(sourceId) {
  fs.rmSync(subtitlePath(sourceId, "failed.json"), { force: true });
}

async function prepareLocalPlayback(sourceId, mediaInput, finalPath) {
  if (!mediaInput || !fs.existsSync(mediaInput)) return null;
  transition(sourceId, "packaging", { progress: 98 });
  return ensureEmbeddedPlayback(sourceId, mediaInput, publishedFile(sourceId, "pt-BR.srt") || ensureSrtSubtitle(sourceId, finalPath));
}

function cueMilliseconds(cue) {
  const match = String(cue.time || "").match(/^(\S+)\s+-->\s+(\S+)/);
  if (!match) return { startMs: null, endMs: null };
  const start = parseTimestamp(match[1]);
  const end = parseTimestamp(match[2]);
  return {
    startMs: Number.isFinite(start) ? start * 1000 : null,
    endMs: Number.isFinite(end) ? end * 1000 : null,
  };
}

function expectedDisplayedText(value) {
  return displayChunks(localizeBrazilianPortuguese(value)).join(" ");
}

async function auditEmbeddedCoverage(extraction, cues, mediaInput, packetTimings = new Map()) {
  if (extraction.trackIndex === null
    || extraction.trackIndex === undefined || !fs.existsSync(mediaInput)) return null;
  const positions = extraction.supPath && fs.existsSync(extraction.supPath) ? parsePgsPositions(fs.readFileSync(extraction.supPath)) : [];
  let intervals = positions.map((event) => ({ start: event.at, end: event.at + 0.01 }));
  if (!intervals.length) {
    if (!packetTimings.has(extraction.trackIndex)) packetTimings.set(extraction.trackIndex, await probeSubtitlePacketTimings(mediaInput, extraction.trackIndex));
    intervals = packetTimings.get(extraction.trackIndex);
  }
  const audit = analyzeReferenceCoverage(cues, intervals, {
    toleranceSeconds: config.transcriptionReferenceToleranceSeconds,
  });
  const authoritative = Boolean(positions.length) || (!extraction.name.startsWith("ocr-pgs") && intervals.length > 0 && intervals.every((interval) => interval.durationKnown));
  if (authoritative && audit.available && (audit.coverageRatio < config.transcriptionReferenceMinimumCoverage
    || audit.longestUncoveredRunSeconds > config.transcriptionReferenceMaxUncoveredSeconds)) {
    throw new Error(`Extração perdeu trechos da legenda embutida: cobertura ${(audit.coverageRatio * 100).toFixed(1)}%, lacuna ${audit.longestUncoveredRunSeconds.toFixed(1)}s`);
  }
  return { ...audit, authoritative, reference: positions.length ? "pgs-visible-compositions" : authoritative ? "same-track-packets" : "packets-advisory" };
}

async function processJob(job) {
  const { sourceId } = job.data;
  inc("jobs_total");
  let source = sourceStore.get(sourceId);
  if (!source || isCancelled(sourceId, job.data.requestedAt)) return { status: "cancelled" };
  logger.info("Worker started job", { jobId: job.id, sourceId });
  ensureSourceDir(sourceId);
  const outputDir = path.dirname(subtitlePath(sourceId, "pt-BR.vtt"));
  let mediaInput = source.localPath || null;
  const isWeb = () => job.data.playbackProfile === "web" || sourceStore.get(sourceId)?.playbackProfile === "web";
  try {
    let mediaDuration = null;
    if (mediaInput) {
      assertJobActive(job);
      const validation = await validateLocalMedia(mediaInput);
      if (!validation.valid) {
        source = await recoverCorruptMedia(source, validation, async (state) => {
          assertJobActive(job);
          transition(sourceId, "recovering", { ...state, mediaRecoveryAttempts: Number(require("./services/metadata").readMeta(sourceId).mediaRecoveryAttempts || 1) });
          await job.updateProgress(state);
        });
        mediaInput = source.localPath;
      } else mediaDuration = validation.duration;
    }
    if (!mediaInput && source.infoHash) {
      assertJobActive(job);
      transition(sourceId, "acquiring", { progress: 1, downloadProgress: 0 });
      let lastLoggedPercent = -1;
      let lastLoggedMessage = null;
      const acquired = await acquireTorrent(source, async (state) => {
        assertJobActive(job);
        transition(sourceId, state.stage, state);
        await job.updateProgress(state);
        const percent = Number.isFinite(state.downloadProgress) ? state.downloadProgress : null;
        if (percent !== null && percent !== lastLoggedPercent) {
          lastLoggedPercent = percent;
          logger.info("Torrent download progress", {
            sourceId,
            percent,
            downloadedMiB: Math.round((state.downloadedBytes || 0) / 1048576),
            totalMiB: Math.round((state.totalBytes || 0) / 1048576),
            speedMiBps: Number(((state.downloadSpeedBytes || 0) / 1048576).toFixed(2)),
            etaMinutes: Number.isFinite(state.etaSeconds) ? Math.ceil(state.etaSeconds / 60) : null,
          });
        } else if (state.message && state.message !== lastLoggedMessage) {
          lastLoggedMessage = state.message;
          logger.info("Torrent acquisition", { sourceId, message: state.message });
        }
      });
      mediaInput = acquired.localPath;
      assertJobActive(job);
      sourceStore.upsert({ ...source, ...acquired, acquisitionState: "ready" });
      logger.info("Torrent download completed", { sourceId, fileName: acquired.fileName, size: acquired.size });
      const validation = await validateLocalMedia(mediaInput);
      if (!validation.valid) {
        source = await recoverCorruptMedia({ ...source, ...acquired, localPath: mediaInput }, validation, async (state) => {
          assertJobActive(job);
          transition(sourceId, "recovering", state);
          await job.updateProgress(state);
        });
        mediaInput = source.localPath;
        mediaDuration = (await validateLocalMedia(mediaInput)).duration;
      } else mediaDuration = validation.duration;
    } else if (!mediaInput && source.url) {
      await assertSafeRemoteUrl(source.url);
      if (/\.(?:m3u8|mpd)(?:$|\?)/i.test(source.url)) mediaInput = source.url;
      else {
        mediaInput = await downloadRemoteMedia(source);
        source = sourceStore.upsert({ ...source, localPath: mediaInput, acquisitionState: "ready" });
      }
    }
    if (!mediaInput) throw new Error("Source cannot be acquired");
    if (source.url && fs.existsSync(mediaInput) && !mediaDuration) {
      const validation = await validateLocalMedia(mediaInput);
      if (!validation.valid) throw new Error(`Mídia adquirida inválida: ${validation.reason || validation.error || "falha de validação"}`);
      mediaDuration = validation.duration;
    }
    const enrichedSource = await enrichContentLanguageMetadata(source);
    if (enrichedSource !== source) source = sourceStore.upsert(enrichedSource);
    assertJobActive(job);
    transition(sourceId, "probing", { progress: 38, error: null });
    logger.info("Preparing subtitles", { sourceId, stage: "probing" });
    const mediaTracks = fs.existsSync(mediaInput) ? await probeMediaTracks(mediaInput) : null;
    if (mediaTracks) {
      mediaDuration = mediaTracks.duration || mediaDuration;
      if (!mediaDuration) throw new Error("Mídia local sem duração confirmada");
    }
    const fingerprint = mediaFingerprint(mediaInput);
    const extractionFingerprint = stableHash(JSON.stringify({ version: 3, media: fingerprint,
      originalAudio: mediaTracks ? selectOriginalAudio(mediaTracks.audioTracks, source) : null,
      preferred: config.preferredSubtitleLangs, target: config.targetLocale,
      originalLanguage: source.originalLanguage || source.original_language || null, country: source.country || null }), 48);
    const profile = stableHash(JSON.stringify({ version: 3, locale: config.targetLocale, model: config.contextualTranslatorModel,
      fallback: config.contextualTranslatorFallbackModel, alignment: config.forcedAlignmentEnabled, extractionFingerprint,
      readability: [config.subtitleMaxCps, config.subtitleMinCueSeconds], aliases: nameAliasesForSource(source),
      terminology: seriesTerminologyForSource(source), corrections: seriesDialogueCorrectionsForSource(source) }), 48);
    const publication = readPublication(sourceId);
    if (publication?.fingerprint === fingerprint && publication.profile === profile && !job.data.force && !job.data.retranslate) {
      inc("cache_hits");
      if (!isWeb()) await prepareLocalPlayback(sourceId, mediaInput, publishedFile(sourceId, "pt-BR.vtt"));
      if (isWeb()) await queueWebPreparation(sourceId, { priority: job.opts.priority });
      clearFailureMarker(sourceId);
      transition(sourceId, "ready", { progress: 100, error: null });
      return { status: "cached" };
    }
    const active = () => assertJobActive(job);
    const packetTimings = new Map();
    const prepare = (candidate) => prepareSubtitleSource(candidate, {
      duration: mediaDuration, assertActive: active,
      auditPgs: (value, sourceCues) => auditEmbeddedCoverage(value, sourceCues, mediaInput, packetTimings),
    });
    const excludedTracks = [];
    const embedded = async (allowIntermediateFallback) => {
      const adaptiveOptions = { preferredLangs: config.preferredSubtitleLangs, source, targetLocale: config.targetLocale, allowIntermediateFallback, validateCandidate: prepare, assertActive: active };
      if (/\.m3u8(?:$|\?)/i.test(mediaInput)) return extractHlsSubtitle(mediaInput, adaptiveOptions);
      if (/\.mpd(?:$|\?)/i.test(mediaInput)) return extractDashSubtitle(mediaInput, adaptiveOptions);
      return extractFileSubtitle(mediaInput, outputDir, config.preferredSubtitleLangs, {
        mediaTracks, source, targetLocale: config.targetLocale, allowIntermediateFallback,
        excludedTrackIndexes: excludedTracks, forceExtract: Boolean(job.data.reextract),
        validateCandidate: async (candidate) => {
          try { return await prepare(candidate); }
          catch (error) { excludedTracks.push(candidate.trackIndex); throw error; }
        },
      });
    };
    const extraction = await selectSubtitleSource({
      cached: job.data.reextract ? null : cachedExtraction(sourceId, extractionFingerprint),
      embedded, prepare, assertActive: active,
      transcribe: async () => {
        transition(sourceId, "transcribing", { progress: 42 });
        return prepare(await transcribeWithGpu(mediaInput, outputDir, source, job, mediaTracks ? selectTranscriptionAudio(mediaTracks.audioTracks, source) : null));
      },
    });
    const cues = extraction.cues.map((cue, sourceIndex) => ({ ...cue, sourceIndex }));
    const maxCueSeconds = extraction.maxCueSeconds;
    const sourceQuality = extraction.sourceQuality;
    if (extraction.name.startsWith("ocr-pgs") && !extraction.cached) writeFileAtomic(subtitlePath(sourceId, "original-raw.vtt"), extraction.rawContent);
    writeFileAtomic(subtitlePath(sourceId, "original.vtt"), extraction.content);
    transition(sourceId, "synchronizing", {
      progress: 50, origin: extraction.name, languageDeclared: extraction.lang, trackIndex: extraction.trackIndex ?? null,
      extractionFingerprint, extractionCached: Boolean(extraction.cached),
      sourceAudioIndex: extraction.sourceAudioIndex ?? null, sourceAudioLanguage: extraction.sourceAudioLanguage || "und",
      sourceAudioReason: extraction.sourceAudioReason || "unavailable", sourceAudioConfidence: extraction.sourceAudioConfidence || "unknown",
      translationRoute: extraction.translationRoute, sourceQuality, sourceSelectionFailures: extraction.sourceSelectionFailures,
    });
    if (extraction.name === "faster-whisper" && config.transcriptionReferenceAuditEnabled && mediaTracks) {
      const referenceTrack = selectTimingReferenceTrack(mediaTracks.subtitleTracks, selectOriginalAudio(mediaTracks.audioTracks, source));
      if (referenceTrack) {
        try {
          const intervals = await probeSubtitlePacketTimings(mediaInput, referenceTrack.ffIndex);
          const interiorStart = Math.min(180, mediaDuration * 0.125);
          const interiorEnd = mediaDuration - Math.min(120, mediaDuration * 0.08);
          const audit = analyzeReferenceCoverage(cues, intervals.filter((interval) => interval.start >= interiorStart && interval.end <= interiorEnd), { toleranceSeconds: config.transcriptionReferenceToleranceSeconds });
          sourceQuality.referenceAudit = { ...audit, trackIndex: referenceTrack.ffIndex, language: referenceTrack.lang, textUsed: false,
            authoritative: false, warning: audit.available && audit.coverageRatio < config.transcriptionReferenceMinimumCoverage ? "reference-may-include-signs-or-music" : null };
        } catch (error) { sourceQuality.referenceAudit = { available: false, reason: error.message }; }
      }
    }
    transition(sourceId, "contextualizing", { progress: 55 });
    const sample = [0.2, 0.5, 0.8].flatMap((ratio) => cues.slice(Math.floor(cues.length * ratio), Math.floor(cues.length * ratio) + 8)).map((cue) => cue.text).join("\n").slice(0, 4000);
    const detected = canonicalLanguage(await detectLanguage(sample, config.libreTranslateUrl));
    const declaredLanguage = canonicalLanguage(extraction.lang);
    const sourceLanguage = resolveSourceLanguage(detected, declaredLanguage, { audioTranscription: extraction.name === "faster-whisper" });
    const effectiveTranslationRoute = extraction.name === "faster-whisper"
      ? extraction.translationRoute || "direct-selected-audio-transcription"
      : translationRoute(sourceLanguage, extraction.sourceAudioLanguage && extraction.sourceAudioLanguage !== "und"
        ? { lang: extraction.sourceAudioLanguage } : null);
    const isPortuguese = languageMatches(sourceLanguage, "pt") || languageMatches(declaredLanguage, "pt");
    if (isPortuguese) {
      const finalized = finalizeCues(cues);
      const vtt = serializeVtt(finalized);
      const validatedCues = parseVtt(vtt);
      if (validatedCues.length !== finalized.length) throw new Error(`Final VTT validation failed: expected ${finalized.length} cues, parsed ${validatedCues.length}`);
      validateTargetScript(validatedCues.map((cue) => cue.text), config.targetLocale);
      assertTranslationsPreserved(cues, cues.map((cue) => expectedDisplayedText(cue.text)), finalized);
      const finalQuality = assertCueIntegrity(validatedCues, { maxCueSeconds, maxLineChars: 42, maxLines: 2, maxCps: config.subtitleMaxCps, minCueSeconds: config.subtitleMinCueSeconds });
      assertJobActive(job);
      publishSubtitle(sourceId, finalized, { fingerprint, profile, maxCueSeconds, assertActive: active });
      if (!isWeb()) await prepareLocalPlayback(sourceId, mediaInput, publishedFile(sourceId, "pt-BR.vtt"));
      assertJobActive(job);
      clearFailureMarker(sourceId);
      transition(sourceId, "ready", {
        progress: 100, translated: false, languageDetected: detected, translationSourceLanguage: sourceLanguage,
        translationRoute: effectiveTranslationRoute, cues: finalized.length, origin: extraction.name,
        sourceAudioIndex: extraction.sourceAudioIndex ?? null, sourceAudioLanguage: extraction.sourceAudioLanguage || "und",
        sourceAudioReason: extraction.sourceAudioReason || "unavailable", sourceAudioConfidence: extraction.sourceAudioConfidence || "unknown",
        sourceQuality, finalQuality,
      });
      scheduleSeriesPrefetch(sourceId, { force: true }).catch((error) => logger.warn("Post-processing prefetch failed", { sourceId, error: error.message }));
      if (isWeb()) await queueWebPreparation(sourceId, { priority: job.opts.priority });
      return { status: "ready", translated: false, cues: finalized.length };
    }

    transition(sourceId, "translating", { progress: 65, languageDetected: detected, translationSourceLanguage: sourceLanguage });
    logger.info("Preparing subtitles", { sourceId, stage: "translating", languageDetected: detected, translationSourceLanguage: sourceLanguage });
    const sourceTexts = cues.map((cue) => String(cue.text || "").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim());
    const nameAliases = nameAliasesForSource(source);
    const seriesTerminology = seriesTerminologyForSource(source);
    const seriesCorrections = seriesDialogueCorrectionsForSource(source);
    const contextualInput = cues.map((cue, index) => ({
      text: sourceTexts[index],
      sourceLang: looksRomanizedJapanese(sourceTexts[index]) ? "ja-Latn" : sourceLanguage,
      ...cueMilliseconds(cue),
    }));
    const protectedTerms = inferProtectedTerms(contextualInput, { includeSeriesTerms: String(source.videoId || "").split(":")[0] === "tt1528406" });
    let forcedAlignment = null;
    const alignmentLanguageCompatible = !extraction.sourceAudioLanguage || extraction.sourceAudioLanguage === "und"
      || languageMatches(sourceLanguage, extraction.sourceAudioLanguage);
    if (config.forcedAlignmentEnabled && config.intelligenceUrl && extraction.name !== "faster-whisper" && alignmentLanguageCompatible) {
      transition(sourceId, "aligning", { progress: 60 });
      const alignmentLanguage = extraction.sourceAudioLanguage && extraction.sourceAudioLanguage !== "und" ? extraction.sourceAudioLanguage : sourceLanguage;
      logger.info("Aligning official subtitles to spoken audio", { sourceId, language: alignmentLanguage, audioStream: extraction.sourceAudioIndex ?? null });
      try {
        forcedAlignment = await withGpuLock(`align:${sourceId}`, async () => {
          try { return await fetchWordTimestamps(mediaInput, outputDir, sourceId, {
            endpoint: config.intelligenceUrl,
            language: speechRecognitionLanguage(alignmentLanguage),
            audioStreamIndex: extraction.sourceAudioIndex,
            prompt: "",
            timeoutMs: config.forcedAlignmentTimeoutMs,
          }); } finally { await releaseTranscriptionModel(); }
        }, { priority: job.opts.priority, assertActive: active });
      } catch (error) {
        logger.warn("Forced alignment unavailable; preserving official cue timing", { sourceId, error: error.message });
      }
      transition(sourceId, "translating", { progress: 65, languageDetected: detected, translationSourceLanguage: sourceLanguage });
    } else if (extraction.name !== "faster-whisper" && !alignmentLanguageCompatible) {
      logger.info("Preserving official subtitle timing because subtitle and audio languages differ", {
        sourceId, subtitleLanguage: sourceLanguage, audioLanguage: extraction.sourceAudioLanguage,
      });
    }
    let texts;
    let translationProvider;
    let translationDetails;
    const episodeBudget = createTranslationBudget({ maxCalls: config.translationEpisodeMaxCalls, timeoutMs: config.translationEpisodeTimeoutMs });
    const resources = translationResources(sourceId, { priority: job.opts.priority || 5, assertActive: active });
    const assertTranslationActive = () => { active(); resources.assertOwned(); };
    const translationOptions = {
      endpoint: config.contextualTranslatorUrl, model: config.contextualTranslatorModel,
      gpuLayers: config.contextualTranslatorGpuLayers, fallbackModel: config.contextualTranslatorFallbackModel,
      fallbackGpuLayers: config.contextualTranslatorFallbackGpuLayers, cacheModels: config.contextualTranslatorCacheModels,
      sourceLang: sourceLanguage, targetLocale: config.targetLocale,
      contextTitle: String(source.title || "").slice(0, 200),
      protectedTerms, nameAliases, seriesTerminology, seriesCorrections,
      cachePath: subtitlePath(sourceId, "translation-chunks.json"), retranslate: Boolean(job.data.retranslate),
      maxChars: config.translateBatchChars, maxCues: config.contextualTranslatorMaxCues,
      contextCues: config.contextualTranslatorContextCues, timeoutMs: config.contextualTranslatorTimeoutMs,
      assertActive: assertTranslationActive, returnDetails: true, episodeBudget,
      runWithModel: (callback, modelOptions) => resources.run(callback, modelOptions),
      releaseModel: () => resources.release(), onBlockComplete: (block) => resources.blockComplete(block),
    };
    try {
      translationDetails = await translateContextual(contextualInput, translationOptions);
      texts = translationDetails.texts;
      translationProvider = [...new Set(translationDetails.blocks.map((block) => `ollama:${block.model}`))].join(" + ");
    } catch (error) {
      if (error.code || error.name === "AbortError" || !config.allowLiteralTranslationFallback) throw error;
      await resources.release();
      logger.warn("Using explicitly enabled literal translation fallback", { sourceId, error: error.message });
      translationProvider = "libretranslate-fallback";
      texts = await translateBatch(sourceTexts, config.libreTranslateUrl, config.targetLocale, sourceLanguage, config.translateBatchChars);
    } finally { await resources.release(); }
    if (texts.length !== cues.length) throw new Error("Translator changed cue count");
    validateTargetScript(texts, config.targetLocale);
    texts = texts.map((text, index) => preserveDialogueLayout(cues[index].text, text));
    let translated;
    let alignmentQuality = null;
    let finalQuality;
    for (let readabilityAttempt = 0; readabilityAttempt < 3; readabilityAttempt++) {
      if (forcedAlignment?.words?.length) {
        const aligned = buildForcedAlignedCues(cues, texts, forcedAlignment.words);
        translated = finalizeCues(aligned.cues, { keepTogetherTerms: protectedTerms });
        alignmentQuality = { ...aligned.stats, audioStream: forcedAlignment.audioStream, audioLanguage: forcedAlignment.audioLanguage, detectedWords: forcedAlignment.words.length };
      } else translated = finalizeCues(cues.map((cue, index) => ({ ...cue, text: texts[index] })), { keepTogetherTerms: protectedTerms });
      assertTranslationsPreserved(cues, texts.map(expectedDisplayedText), translated);
      try {
        finalQuality = assertCueIntegrity(translated, { maxCueSeconds, maxLineChars: 42, maxLines: 2, maxCps: config.subtitleMaxCps, minCueSeconds: config.subtitleMinCueSeconds });
        break;
      } catch (error) {
        if (error.code !== "SUBTITLE_READABILITY" || readabilityAttempt === 2 || translationProvider === "libretranslate-fallback") throw error;
        const indexes = [...new Set(error.issues.map((issue) => translated[issue.index].sourceIndex))];
        if (indexes.some((index) => !Number.isInteger(index))) throw error;
        const repairInput = indexes.map((index) => ({ ...contextualInput[index], maxTargetChars: Math.max(1, Math.floor((contextualInput[index].endMs - contextualInput[index].startMs) / 1000 * config.subtitleMaxCps)) }));
        try {
          const repaired = await translateContextual(repairInput, { ...translationOptions,
            drafts: indexes.map((index) => texts[index]), seriesCorrections: [], cachePath: null,
            contextItems: indexes.flatMap((index) => contextualInput.slice(Math.max(0, index - 2), index + 3)), retranslate: true, maxCalls: 24, totalTimeoutMs: 300000,
            repairReason: "Condense only where necessary for subtitle reading time. Preserve meaning, negation, names, quantities and register.",
          });
          indexes.forEach((index, offset) => { texts[index] = preserveDialogueLayout(cues[index].text, repaired.texts[offset]); });
          translationDetails = { ...translationDetails, readabilityRepairs: [...(translationDetails?.readabilityRepairs || []), repaired.metrics] };
          translationProvider = [...new Set([translationProvider, ...repaired.blocks.map((block) => `ollama:${block.model}`)])].join(" + ");
        } finally { await resources.release(); }
      }
    }
    transition(sourceId, "validating", { progress: 95 });
    if (translationDetails) {
      translationDetails.metrics.episodeCalls = episodeBudget.stats().calls;
      inc("translation_model_calls_total", episodeBudget.stats().calls);
      inc("translation_elapsed_milliseconds_total", episodeBudget.stats().elapsedMs);
    }
    active();
    publishSubtitle(sourceId, translated, { fingerprint, profile, maxCueSeconds, provenance: translationDetails?.blocks, assertActive: active });
    if (!isWeb()) await prepareLocalPlayback(sourceId, mediaInput, publishedFile(sourceId, "pt-BR.vtt"));
    active();
    clearFailureMarker(sourceId);
    inc("translations_total");
    transition(sourceId, "ready", {
      progress: 100,
      translated: true,
      from: sourceLanguage,
      to: mapTargetLocale(config.targetLocale),
      cues: translated.length,
      origin: extraction.name,
      translationProvider, translationDetails: translationDetails ? { blocks: translationDetails.blocks, metrics: translationDetails.metrics, readabilityRepairs: translationDetails.readabilityRepairs } : null,
      translationRoute: effectiveTranslationRoute,
      sourceAudioIndex: extraction.sourceAudioIndex ?? null,
      sourceAudioLanguage: extraction.sourceAudioLanguage || "und",
      sourceAudioReason: extraction.sourceAudioReason || "unavailable",
      sourceAudioConfidence: extraction.sourceAudioConfidence || "unknown",
      alignmentQuality,
      sourceQuality,
      finalQuality,
    });
    scheduleSeriesPrefetch(sourceId, { force: true }).catch((error) => logger.warn("Post-processing prefetch failed", { sourceId, error: error.message }));
    if (isWeb()) await queueWebPreparation(sourceId, { priority: job.opts.priority });
    return { status: "ready", translated: true, cues: translated.length };
  } catch (error) {
    if (error.code === "SOURCE_CANCELLED" || isCancelled(sourceId, job.data.requestedAt) || !sourceStore.get(sourceId)) {
      if (source?.infoHash) await stopTorrent(String(source.infoHash).toLowerCase()).catch(() => {});
      if (mediaInput && fs.existsSync(mediaInput)) {
        const resolved = path.resolve(mediaInput);
        const relative = path.relative(path.resolve(config.mediaDir), resolved);
        const referencedElsewhere = sourceStore.list({ limit: 5000 }).some((item) => item.localPath && path.resolve(item.localPath) === resolved);
        if (!referencedElsewhere && relative && !relative.startsWith("..") && !path.isAbsolute(relative)) fs.rmSync(resolved, { force: true });
      }
      fs.rmSync(safeChildPath(config.storageDir, "subtitles", sourceId), { recursive: true, force: true });
      fs.rmSync(safeChildPath(config.hlsDir, sourceId), { recursive: true, force: true });
      fs.rmSync(safeChildPath(config.playbackDir, sourceId), { recursive: true, force: true });
      logger.info("Worker cancelled deleted source", { jobId: job.id, sourceId });
      return { status: "cancelled" };
    }
    writeFileAtomic(subtitlePath(sourceId, "failed.json"), JSON.stringify({ message: error.message, at: new Date().toISOString() }));
    transition(sourceId, "failed", { error: error.message });
    if (["TRANSLATION_BUDGET_EXHAUSTED", "SUBTITLE_READABILITY"].includes(error.code)) throw new UnrecoverableError(error.message);
    throw error;
  }
}

const connection = getConnection();
const worker = new Worker("subtitle-jobs", processJob, {
  connection,
  concurrency: config.job.concurrency,
  limiter: { max: config.job.rateLimit, duration: 1000 },
  // PGS OCR can saturate the CPU for several minutes. A longer lease prevents
  // BullMQ from treating a healthy job as stalled while keeping lock renewal.
  lockDuration: config.job.lockDurationMs,
});
const webWorker = new Worker("web-preparation", processWebJob, { connection, concurrency: config.hls.maxConcurrent, lockDuration: config.job.lockDurationMs });
webWorker.on("failed", (job, error) => logger.warn("WEB preparation failed", { sourceId: job?.data.sourceId, error: error.message }));

worker.on("completed", (job, result) => logger.info("Worker completed", { jobId: job.id, result }));
worker.on("failed", (job, error) => { inc("jobs_failed"); logger.error("Worker failed", { jobId: job?.id, error: error.message }); });

async function shutdown() {
  await worker.close();
  await webWorker.close();
  await getWebQueue().close();
  await connection.quit();
}
process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));

module.exports = { processJob };
