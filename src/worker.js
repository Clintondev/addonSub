const fs = require("fs");
const path = require("path");
const { Worker } = require("bullmq");
const config = require("./config");
const logger = require("./logger");
const { getConnection } = require("./jobs/queue");
const sourceStore = require("./services/sourceStore");
const { subtitlePath, ensureSourceDir, ensureSrtSubtitle } = require("./services/subtitleService");
const { extractHlsSubtitle } = require("./services/hls");
const { extractDashSubtitle } = require("./services/dash");
const { extractFileSubtitle, probeMediaTracks } = require("./services/ffextract");
const { releaseTranscriptionModel, transcribeSource } = require("./services/transcribe");
const { parseVtt, serializeVtt } = require("./services/vtt");
const { detectLanguage, inferProtectedTerms, translateBatch, translateContextual, unloadContextualModel, mapTargetLocale, looksRomanizedJapanese, normalizeOcrSourceText } = require("./services/translate");
const { assertCueIntegrity, assertSubtitleCompleteness, displayChunks, mergeShortCues, finalizeCues, localizeBrazilianPortuguese, parseTimestamp, preserveDialogueLayout, removeEmptyCues } = require("./services/subtitleQuality");
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
const { canonicalLanguage, languageMatches, selectOriginalAudio, speechRecognitionLanguage, translationRoute } = require("./services/languageStrategy");
const { enrichContentLanguageMetadata } = require("./services/contentMetadata");

function cancelledError() {
  const error = new Error("Job cancelado porque a fonte foi excluída");
  error.code = "SOURCE_CANCELLED";
  return error;
}

function assertJobActive(job) {
  if (isCancelled(job.data.sourceId, job.data.requestedAt) || !sourceStore.get(job.data.sourceId)) throw cancelledError();
}

function mediaFingerprint(mediaInput) {
  try {
    const stat = fs.statSync(mediaInput);
    return stableHash(`${path.resolve(mediaInput)}|${stat.size}|${stat.mtimeMs}`, 32);
  } catch (_) { return stableHash(mediaInput, 32); }
}

function cachedExtraction(sourceId, fingerprint) {
  const file = subtitlePath(sourceId, "original.vtt");
  const meta = readMeta(sourceId);
  if (!fs.existsSync(file) || !meta.origin || meta.extractionFingerprint !== fingerprint) return null;
  const content = fs.readFileSync(file, "utf8");
  if (!removeEmptyCues(parseVtt(content)).length) return null;
  return {
    content, lang: meta.languageDeclared || "und", name: meta.origin, trackIndex: meta.trackIndex ?? null, cached: true,
    sourceAudioIndex: meta.sourceAudioIndex ?? null,
    sourceAudioLanguage: meta.sourceAudioLanguage || "und",
    sourceAudioReason: meta.sourceAudioReason || "cached",
    sourceAudioConfidence: meta.sourceAudioConfidence || "unknown",
    translationRoute: meta.translationRoute || "source-language-unverified",
  };
}

async function transcribeWithGpu(mediaInput, outputDir, source, job, originalAudio = null) {
  if (/^https?:/i.test(String(mediaInput))) throw new Error("Remote adaptive streams without a subtitle track cannot be transcribed safely; use a downloadable media URL or torrent source");
  return withGpuLock(`transcribe:${source.sourceId}`, async () => {
    assertJobActive(job);
    return transcribeSource(mediaInput, outputDir, source.sourceId, [source.filename, source.name].filter(Boolean).join(". "), {
      audioStreamIndex: originalAudio?.ffIndex,
      language: speechRecognitionLanguage(originalAudio?.lang),
      reason: originalAudio?.reason,
      confidence: originalAudio?.confidence,
    });
  });
}

function clearFailureMarker(sourceId) {
  fs.rmSync(subtitlePath(sourceId, "failed.json"), { force: true });
}

async function prepareLocalPlayback(sourceId, mediaInput, finalPath) {
  if (!mediaInput || !fs.existsSync(mediaInput)) return null;
  transition(sourceId, "packaging", { progress: 98 });
  return ensureEmbeddedPlayback(sourceId, mediaInput, ensureSrtSubtitle(sourceId, finalPath));
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

async function extract(mediaInput, source, outputDir, job) {
  let originalAudio = null;
  try {
    if (/\.m3u8(?:$|\?)/i.test(mediaInput)) return await extractHlsSubtitle(mediaInput, { preferredLangs: config.preferredSubtitleLangs, source, targetLocale: config.targetLocale });
    if (/\.mpd(?:$|\?)/i.test(mediaInput)) return await extractDashSubtitle(mediaInput, { preferredLangs: config.preferredSubtitleLangs, source, targetLocale: config.targetLocale });
    const mediaTracks = await probeMediaTracks(mediaInput);
    originalAudio = selectOriginalAudio(mediaTracks.audioTracks, source);
    return await extractFileSubtitle(mediaInput, outputDir, config.preferredSubtitleLangs, {
      mediaTracks, source, targetLocale: config.targetLocale,
    });
  } catch (error) {
    if (error.code === "SOURCE_CANCELLED") throw error;
    transition(source.sourceId, "transcribing", { extractionError: error.message });
    logger.info("Preparing subtitles", { sourceId: source.sourceId, stage: "transcribing", reason: error.message });
    return transcribeWithGpu(mediaInput, outputDir, source, job, originalAudio);
  }
}

async function processJob(job) {
  const { sourceId } = job.data;
  inc("jobs_total");
  let source = sourceStore.get(sourceId);
  if (!source || isCancelled(sourceId, job.data.requestedAt)) return { status: "cancelled" };
  logger.info("Worker started job", { jobId: job.id, sourceId });
  ensureSourceDir(sourceId);
  const outputDir = path.dirname(subtitlePath(sourceId, "pt-BR.vtt"));
  const finalPath = subtitlePath(sourceId, "pt-BR.vtt");
  let mediaInput = source.localPath || null;
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
    if (fs.existsSync(finalPath)) {
      await prepareLocalPlayback(sourceId, mediaInput, finalPath);
      assertJobActive(job);
      return { status: "cached" };
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
    const enrichedSource = await enrichContentLanguageMetadata(source);
    if (enrichedSource !== source) source = sourceStore.upsert(enrichedSource);
    assertJobActive(job);
    transition(sourceId, "probing", { progress: 38, error: null });
    logger.info("Preparing subtitles", { sourceId, stage: "probing" });
    const fingerprint = mediaFingerprint(mediaInput);
    let extraction = cachedExtraction(sourceId, fingerprint) || await extract(mediaInput, source, outputDir, job);
    let parsedCues;
    const excludedTrackIndexes = [];
    while (true) {
      assertJobActive(job);
      parsedCues = removeEmptyCues(parseVtt(extraction.content));
      if (extraction.name.startsWith("ocr-pgs")) {
        if (!extraction.cached) fs.writeFileSync(subtitlePath(sourceId, "original-raw.vtt"), extraction.content, "utf8");
        parsedCues = parsedCues.map((cue) => ({ ...cue, text: normalizeOcrSourceText(cue.text) }));
        extraction = { ...extraction, content: serializeVtt(parsedCues) };
      }
      fs.writeFileSync(subtitlePath(sourceId, "original.vtt"), extraction.content, "utf8");
      transition(sourceId, "synchronizing", {
        progress: 50, origin: extraction.name, languageDeclared: extraction.lang, trackIndex: extraction.trackIndex ?? null,
        extractionFingerprint: fingerprint, extractionCached: Boolean(extraction.cached), sourceAudioIndex: extraction.sourceAudioIndex ?? null,
        sourceAudioLanguage: extraction.sourceAudioLanguage || "und", sourceAudioReason: extraction.sourceAudioReason || "unavailable",
        sourceAudioConfidence: extraction.sourceAudioConfidence || "unknown", translationRoute: extraction.translationRoute || "source-language-unverified",
      });
      if (extraction.name === "faster-whisper") break;
      try {
        assertSubtitleCompleteness(parsedCues, mediaDuration);
        break;
      } catch (error) {
        if (extraction.trackIndex !== null && extraction.trackIndex !== undefined && fs.existsSync(mediaInput)) {
          excludedTrackIndexes.push(extraction.trackIndex);
          try {
            logger.warn("Embedded subtitle is incomplete; trying the next embedded track", { sourceId, trackIndex: extraction.trackIndex, error: error.message });
            extraction = await extractFileSubtitle(mediaInput, outputDir, config.preferredSubtitleLangs, { excludedTrackIndexes, source, targetLocale: config.targetLocale });
            continue;
          } catch (nextError) {
            logger.warn("No complete embedded subtitle remains; transcribing full audio", { sourceId, error: nextError.message });
          }
        } else logger.warn("Embedded subtitle is incomplete; transcribing full audio instead", { sourceId, error: error.message });
        transition(sourceId, "transcribing", { progress: 42, extractionError: error.message });
        const mediaTracks = fs.existsSync(mediaInput) ? await probeMediaTracks(mediaInput) : null;
        extraction = await transcribeWithGpu(mediaInput, outputDir, source, job, mediaTracks ? selectOriginalAudio(mediaTracks.audioTracks, source) : null);
      }
    }
    let cues = extraction.name === "faster-whisper" ? mergeShortCues(parsedCues) : parsedCues;
    if (!cues.length) throw new Error("Subtitle contains no valid cues");
    // OCR/text tracks can legitimately keep an on-screen sign for longer.
    // Audio transcription must stay strict because long cues usually mean
    // Whisper swallowed dialogue and produced a timing hole.
    let maxCueSeconds = extraction.name === "faster-whisper" ? 20 : 60;
    let sourceQuality;
    try {
      sourceQuality = assertCueIntegrity(cues, { maxCueSeconds });
    } catch (transcriptionError) {
      if (extraction.name !== "faster-whisper" || !fs.existsSync(mediaInput)) throw transcriptionError;
      logger.warn("Original-audio transcription failed structural validation; using a complete intermediate subtitle as a verified fallback", {
        sourceId, language: extraction.sourceAudioLanguage, error: transcriptionError.message,
      });
      const mediaTracks = await probeMediaTracks(mediaInput);
      extraction = await extractFileSubtitle(mediaInput, outputDir, config.preferredSubtitleLangs, {
        mediaTracks, source, targetLocale: config.targetLocale, allowIntermediateFallback: true,
      });
      parsedCues = removeEmptyCues(parseVtt(extraction.content));
      if (extraction.name.startsWith("ocr-pgs")) {
        fs.writeFileSync(subtitlePath(sourceId, "original-raw.vtt"), extraction.content, "utf8");
        parsedCues = parsedCues.map((cue) => ({ ...cue, text: normalizeOcrSourceText(cue.text) }));
        extraction = { ...extraction, content: serializeVtt(parsedCues) };
      }
      assertSubtitleCompleteness(parsedCues, mediaDuration);
      fs.writeFileSync(subtitlePath(sourceId, "original.vtt"), extraction.content, "utf8");
      transition(sourceId, "synchronizing", {
        progress: 50, origin: extraction.name, languageDeclared: extraction.lang, trackIndex: extraction.trackIndex ?? null,
        extractionFingerprint: fingerprint, extractionCached: false, sourceAudioIndex: extraction.sourceAudioIndex ?? null,
        sourceAudioLanguage: extraction.sourceAudioLanguage || "und", sourceAudioReason: extraction.sourceAudioReason || "unavailable",
        sourceAudioConfidence: extraction.sourceAudioConfidence || "unknown", translationRoute: extraction.translationRoute || "intermediate-language-fallback",
        transcriptionFallbackReason: transcriptionError.message,
      });
      cues = parsedCues;
      maxCueSeconds = 60;
      sourceQuality = assertCueIntegrity(cues, { maxCueSeconds });
    }

    transition(sourceId, "contextualizing", { progress: 55 });
    const sample = cues.slice(0, 20).map((cue) => cue.text).join("\n").slice(0, 4000);
    const detected = canonicalLanguage(await detectLanguage(sample, config.libreTranslateUrl));
    const declaredLanguage = canonicalLanguage(extraction.lang);
    const sourceLanguage = detected !== "und" ? detected : declaredLanguage;
    const effectiveTranslationRoute = extraction.name === "faster-whisper"
      ? "direct-original-audio-transcription"
      : translationRoute(sourceLanguage, extraction.sourceAudioLanguage && extraction.sourceAudioLanguage !== "und"
        ? { lang: extraction.sourceAudioLanguage } : null);
    const isPortuguese = languageMatches(sourceLanguage, "pt") || languageMatches(declaredLanguage, "pt");
    if (isPortuguese) {
      const finalized = finalizeCues(cues);
      const vtt = serializeVtt(finalized);
      const validatedCues = parseVtt(vtt);
      if (validatedCues.length !== finalized.length) throw new Error(`Final VTT validation failed: expected ${finalized.length} cues, parsed ${validatedCues.length}`);
      assertTranslationsPreserved(cues, cues.map((cue) => expectedDisplayedText(cue.text)), finalized);
      const finalQuality = assertCueIntegrity(validatedCues, { maxCueSeconds, maxLineChars: 42, maxLines: 2 });
      assertJobActive(job);
      fs.writeFileSync(finalPath, vtt, "utf8");
      await prepareLocalPlayback(sourceId, mediaInput, finalPath);
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
      return { status: "ready", translated: false, cues: finalized.length };
    }

    transition(sourceId, "translating", { progress: 65, languageDetected: detected, translationSourceLanguage: sourceLanguage });
    logger.info("Preparing subtitles", { sourceId, stage: "translating", languageDetected: detected, translationSourceLanguage: sourceLanguage });
    const sourceTexts = cues.map((cue) => String(cue.text || "").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim());
    const contextualInput = cues.map((cue, index) => ({
      text: sourceTexts[index],
      sourceLang: looksRomanizedJapanese(sourceTexts[index]) ? "ja-Latn" : sourceLanguage,
      ...cueMilliseconds(cue),
    }));
    const protectedTerms = inferProtectedTerms(contextualInput);
    let forcedAlignment = null;
    const alignmentLanguageCompatible = !extraction.sourceAudioLanguage || extraction.sourceAudioLanguage === "und"
      || languageMatches(sourceLanguage, extraction.sourceAudioLanguage);
    if (config.forcedAlignmentEnabled && config.intelligenceUrl && extraction.name !== "faster-whisper" && alignmentLanguageCompatible) {
      transition(sourceId, "aligning", { progress: 60 });
      const alignmentLanguage = extraction.sourceAudioLanguage && extraction.sourceAudioLanguage !== "und" ? extraction.sourceAudioLanguage : sourceLanguage;
      logger.info("Aligning official subtitles to spoken audio", { sourceId, language: alignmentLanguage, audioStream: extraction.sourceAudioIndex ?? null });
      try {
        forcedAlignment = await withGpuLock(`align:${sourceId}`, () => fetchWordTimestamps(mediaInput, outputDir, sourceId, {
            endpoint: config.intelligenceUrl,
            language: speechRecognitionLanguage(alignmentLanguage),
            audioStreamIndex: extraction.sourceAudioIndex,
            prompt: [source.filename, source.title, source.name].filter(Boolean).join(". "),
            timeoutMs: config.forcedAlignmentTimeoutMs,
          }));
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
    let translationProvider = `ollama:${config.contextualTranslatorModel}`;
    await withGpuLock(`translate:${sourceId}`, async () => {
      assertJobActive(job);
      await releaseTranscriptionModel();
      try {
        texts = await translateContextual(contextualInput, {
          endpoint: config.contextualTranslatorUrl,
          model: config.contextualTranslatorModel,
          sourceLang: sourceLanguage,
          targetLocale: config.targetLocale,
          contextTitle: [source.filename, source.title, source.name].filter(Boolean).join(" · ").slice(0, 1000),
          protectedTerms,
          maxChars: config.translateBatchChars,
          maxCues: config.contextualTranslatorMaxCues,
          contextCues: config.contextualTranslatorContextCues,
          timeoutMs: config.contextualTranslatorTimeoutMs,
        });
      } catch (error) {
        if (!config.allowLiteralTranslationFallback) throw new Error(`Tradução contextual falhou; legenda literal não será publicada: ${error.message}`);
        logger.warn("Using explicitly enabled literal translation fallback", { sourceId, error: error.message });
        translationProvider = "libretranslate-fallback";
        texts = await translateBatch(sourceTexts, config.libreTranslateUrl, config.targetLocale, sourceLanguage, config.translateBatchChars);
      } finally {
        await unloadContextualModel(config.contextualTranslatorUrl, config.contextualTranslatorModel);
      }
    });
    if (texts.length !== cues.length) throw new Error("Translator changed cue count");
    texts = texts.map((text, index) => preserveDialogueLayout(cues[index].text, text));
    let translated;
    let alignmentQuality = null;
    if (forcedAlignment?.words?.length) {
      const aligned = buildForcedAlignedCues(cues, texts, forcedAlignment.words);
      // Alignment chooses the spoken phrase boundaries. Finalization only
      // subdivides visually dense phrases inside those ranges, preserving all
      // translated text while enforcing readable two-line captions.
      translated = finalizeCues(aligned.cues, { keepTogetherTerms: protectedTerms });
      alignmentQuality = {
        ...aligned.stats,
        audioStream: forcedAlignment.audioStream,
        audioLanguage: forcedAlignment.audioLanguage,
        detectedWords: forcedAlignment.words.length,
      };
    } else {
      translated = finalizeCues(cues.map((cue, index) => ({ ...cue, text: texts[index] })), { keepTogetherTerms: protectedTerms });
    }
    assertTranslationsPreserved(cues, texts.map(expectedDisplayedText), translated);
    transition(sourceId, "validating", { progress: 95 });
    const vtt = serializeVtt(translated);
    const validatedCues = parseVtt(vtt);
    if (validatedCues.length !== translated.length) {
      fs.writeFileSync(subtitlePath(sourceId, "validation-debug.vtt"), vtt, "utf8");
      throw new Error(`Final VTT validation failed: expected ${translated.length} cues, parsed ${validatedCues.length}`);
    }
    const finalQuality = assertCueIntegrity(validatedCues, { maxCueSeconds, maxLineChars: 42, maxLines: 2 });
    assertJobActive(job);
    fs.writeFileSync(finalPath, vtt, "utf8");
    await prepareLocalPlayback(sourceId, mediaInput, finalPath);
    assertJobActive(job);
    clearFailureMarker(sourceId);
    inc("translations_total");
    transition(sourceId, "ready", {
      progress: 100,
      translated: true,
      from: sourceLanguage,
      to: mapTargetLocale(config.targetLocale),
      cues: translated.length,
      origin: extraction.name,
      translationProvider,
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
    fs.writeFileSync(subtitlePath(sourceId, "failed.json"), JSON.stringify({ message: error.message, at: new Date().toISOString() }), "utf8");
    transition(sourceId, "failed", { error: error.message });
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

worker.on("completed", (job, result) => logger.info("Worker completed", { jobId: job.id, result }));
worker.on("failed", (job, error) => { inc("jobs_failed"); logger.error("Worker failed", { jobId: job?.id, error: error.message }); });

async function shutdown() {
  await worker.close();
  await connection.quit();
}
process.once("SIGINT", () => shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => shutdown().finally(() => process.exit(0)));

module.exports = { processJob };
