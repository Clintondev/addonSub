const fs = require("fs");
const path = require("path");
const { Worker } = require("bullmq");
const config = require("./config");
const logger = require("./logger");
const { getConnection } = require("./jobs/queue");
const sourceStore = require("./services/sourceStore");
const { subtitlePath, ensureSourceDir } = require("./services/subtitleService");
const { extractHlsSubtitle } = require("./services/hls");
const { extractDashSubtitle } = require("./services/dash");
const { extractFileSubtitle } = require("./services/ffextract");
const { releaseTranscriptionModel, transcribeSource } = require("./services/transcribe");
const { parseVtt, serializeVtt } = require("./services/vtt");
const { detectLanguage, translateBatch, translateContextual, unloadContextualModel, mapTargetLocale } = require("./services/translate");
const { assertCueIntegrity, assertSubtitleCompleteness, mergeShortCues, finalizeCues, parseTimestamp, preserveDialogueLayout, removeEmptyCues } = require("./services/subtitleQuality");
const { buildForcedAlignedCues, fetchWordTimestamps } = require("./services/forcedAlignment");
const { transition } = require("./services/metadata");
const { inc } = require("./metrics");
const { assertSafeRemoteUrl } = require("./utils/security");
const { acquireTorrent } = require("./services/qbittorrent");
const { validateLocalMedia } = require("./services/mediaValidation");
const { recoverCorruptMedia } = require("./services/mediaRecovery");

function clearFailureMarker(sourceId) {
  fs.rmSync(subtitlePath(sourceId, "failed.json"), { force: true });
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

async function extract(mediaInput, source, outputDir) {
  try {
    if (/\.m3u8(?:$|\?)/i.test(mediaInput)) return await extractHlsSubtitle(mediaInput, { preferredLangs: config.preferredSubtitleLangs });
    if (/\.mpd(?:$|\?)/i.test(mediaInput)) return await extractDashSubtitle(mediaInput, { preferredLangs: config.preferredSubtitleLangs });
    return await extractFileSubtitle(mediaInput, outputDir, config.preferredSubtitleLangs);
  } catch (error) {
    transition(source.sourceId, "transcribing", { extractionError: error.message });
    logger.info("Preparing subtitles", { sourceId: source.sourceId, stage: "transcribing", reason: error.message });
    return transcribeSource(mediaInput, outputDir, source.sourceId, [source.filename, source.name].filter(Boolean).join(". "));
  }
}

async function processJob(job) {
  const { sourceId } = job.data;
  inc("jobs_total");
  let source = sourceStore.get(sourceId);
  if (!source) throw new Error("Source no longer exists");
  logger.info("Worker started job", { jobId: job.id, sourceId });
  ensureSourceDir(sourceId);
  const outputDir = path.dirname(subtitlePath(sourceId, "pt-BR.vtt"));
  const finalPath = subtitlePath(sourceId, "pt-BR.vtt");
  try {
    let mediaInput = source.localPath || null;
    let mediaDuration = null;
    if (mediaInput) {
      const validation = validateLocalMedia(mediaInput);
      if (!validation.valid) {
        source = await recoverCorruptMedia(source, validation, async (state) => {
          transition(sourceId, "recovering", { ...state, mediaRecoveryAttempts: Number(require("./services/metadata").readMeta(sourceId).mediaRecoveryAttempts || 1) });
          await job.updateProgress(state);
        });
        mediaInput = source.localPath;
      } else mediaDuration = validation.duration;
    }
    if (fs.existsSync(finalPath)) return { status: "cached" };
    if (!mediaInput && source.infoHash) {
      transition(sourceId, "acquiring", { progress: 1, downloadProgress: 0 });
      let lastLoggedPercent = -1;
      let lastLoggedMessage = null;
      const acquired = await acquireTorrent(source, async (state) => {
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
      sourceStore.upsert({ ...source, ...acquired, acquisitionState: "ready" });
      logger.info("Torrent download completed", { sourceId, fileName: acquired.fileName, size: acquired.size });
      const validation = validateLocalMedia(mediaInput);
      if (!validation.valid) {
        source = await recoverCorruptMedia({ ...source, ...acquired, localPath: mediaInput }, validation, async (state) => {
          transition(sourceId, "recovering", state);
          await job.updateProgress(state);
        });
        mediaInput = source.localPath;
        mediaDuration = validateLocalMedia(mediaInput).duration;
      } else mediaDuration = validation.duration;
    } else if (!mediaInput && source.url) {
      await assertSafeRemoteUrl(source.url);
      mediaInput = source.url;
    }
    if (!mediaInput) throw new Error("Source cannot be acquired");
    transition(sourceId, "probing", { progress: 38 });
    logger.info("Preparing subtitles", { sourceId, stage: "probing" });
    let extraction = await extract(mediaInput, source, outputDir);
    fs.writeFileSync(subtitlePath(sourceId, "original.vtt"), extraction.content, "utf8");
    transition(sourceId, "synchronizing", { progress: 50, origin: extraction.name, languageDeclared: extraction.lang });
    let parsedCues = removeEmptyCues(parseVtt(extraction.content));
    if (extraction.name !== "faster-whisper") {
      try {
        assertSubtitleCompleteness(parsedCues, mediaDuration);
      } catch (error) {
        logger.warn("Embedded subtitle is incomplete; transcribing full audio instead", { sourceId, error: error.message });
        transition(sourceId, "transcribing", { progress: 42, extractionError: error.message });
        extraction = await transcribeSource(mediaInput, outputDir, source.sourceId, [source.filename, source.name].filter(Boolean).join(". "));
        fs.writeFileSync(subtitlePath(sourceId, "original.vtt"), extraction.content, "utf8");
        parsedCues = removeEmptyCues(parseVtt(extraction.content));
        transition(sourceId, "synchronizing", { progress: 50, origin: extraction.name, languageDeclared: extraction.lang });
      }
    }
    const cues = extraction.name === "faster-whisper" ? mergeShortCues(parsedCues) : parsedCues;
    if (!cues.length) throw new Error("Subtitle contains no valid cues");
    // OCR/text tracks can legitimately keep an on-screen sign for longer.
    // Audio transcription must stay strict because long cues usually mean
    // Whisper swallowed dialogue and produced a timing hole.
    const maxCueSeconds = extraction.name === "faster-whisper" ? 20 : 60;
    const sourceQuality = assertCueIntegrity(cues, { maxCueSeconds });

    transition(sourceId, "contextualizing", { progress: 55 });
    const sample = cues.slice(0, 20).map((cue) => cue.text).join("\n").slice(0, 4000);
    const detected = await detectLanguage(sample, config.libreTranslateUrl);
    const isPortuguese = detected.startsWith("pt") || detected === "pb" || /^(pt|pb)/i.test(String(extraction.lang || ""));
    if (isPortuguese) {
      const finalized = finalizeCues(cues);
      fs.writeFileSync(finalPath, serializeVtt(finalized), "utf8");
      clearFailureMarker(sourceId);
      transition(sourceId, "ready", { progress: 100, translated: false, languageDetected: detected, cues: finalized.length, origin: extraction.name, sourceQuality });
      return { status: "ready", translated: false, cues: finalized.length };
    }

    transition(sourceId, "translating", { progress: 65, languageDetected: detected });
    logger.info("Preparing subtitles", { sourceId, stage: "translating", languageDetected: detected });
    const sourceTexts = cues.map((cue) => String(cue.text || "").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim());
    const contextualInput = cues.map((cue, index) => ({ text: sourceTexts[index], ...cueMilliseconds(cue) }));
    let forcedAlignment = null;
    if (config.forcedAlignmentEnabled && config.intelligenceUrl && extraction.name !== "faster-whisper") {
      transition(sourceId, "aligning", { progress: 60 });
      logger.info("Aligning official subtitles to spoken audio", { sourceId, language: detected });
      try {
        forcedAlignment = await fetchWordTimestamps(mediaInput, outputDir, sourceId, {
          endpoint: config.intelligenceUrl,
          language: detected.startsWith("en") ? "en" : detected,
          prompt: [source.filename, source.title, source.name].filter(Boolean).join(". "),
          timeoutMs: config.forcedAlignmentTimeoutMs,
        });
      } catch (error) {
        logger.warn("Forced alignment unavailable; preserving official cue timing", { sourceId, error: error.message });
      }
      transition(sourceId, "translating", { progress: 65, languageDetected: detected });
    }
    await releaseTranscriptionModel();
    let texts;
    let translationProvider = `ollama:${config.contextualTranslatorModel}`;
    try {
      texts = await translateContextual(contextualInput, {
        endpoint: config.contextualTranslatorUrl,
        model: config.contextualTranslatorModel,
        sourceLang: detected,
        targetLocale: config.targetLocale,
        contextTitle: [source.filename, source.title, source.name].filter(Boolean).join(" · ").slice(0, 1000),
        maxChars: config.translateBatchChars,
        maxCues: config.contextualTranslatorMaxCues,
        timeoutMs: config.contextualTranslatorTimeoutMs,
      });
    } catch (error) {
      if (!config.allowLiteralTranslationFallback) throw new Error(`Tradução contextual falhou; legenda literal não será publicada: ${error.message}`);
      logger.warn("Using explicitly enabled literal translation fallback", { sourceId, error: error.message });
      translationProvider = "libretranslate-fallback";
      texts = await translateBatch(sourceTexts, config.libreTranslateUrl, config.targetLocale, detected, config.translateBatchChars);
    } finally {
      await unloadContextualModel(config.contextualTranslatorUrl, config.contextualTranslatorModel);
    }
    if (texts.length !== cues.length) throw new Error("Translator changed cue count");
    texts = texts.map((text, index) => preserveDialogueLayout(cues[index].text, text));
    let translated;
    let alignmentQuality = null;
    if (forcedAlignment?.words?.length) {
      const aligned = buildForcedAlignedCues(cues, texts, forcedAlignment.words);
      // Alignment chooses the spoken phrase boundaries. Finalization only
      // subdivides visually dense phrases inside those ranges, preserving all
      // translated text while enforcing readable two-line captions.
      translated = finalizeCues(aligned.cues);
      alignmentQuality = {
        ...aligned.stats,
        audioStream: forcedAlignment.audioStream,
        audioLanguage: forcedAlignment.audioLanguage,
        detectedWords: forcedAlignment.words.length,
      };
    } else {
      translated = finalizeCues(cues.map((cue, index) => ({ ...cue, text: texts[index] })));
    }
    transition(sourceId, "validating", { progress: 95 });
    const vtt = serializeVtt(translated);
    const validatedCues = parseVtt(vtt);
    if (validatedCues.length !== translated.length) {
      fs.writeFileSync(subtitlePath(sourceId, "validation-debug.vtt"), vtt, "utf8");
      throw new Error(`Final VTT validation failed: expected ${translated.length} cues, parsed ${validatedCues.length}`);
    }
    const finalQuality = assertCueIntegrity(validatedCues, { maxCueSeconds, maxLineChars: 42 });
    fs.writeFileSync(finalPath, vtt, "utf8");
    clearFailureMarker(sourceId);
    inc("translations_total");
    transition(sourceId, "ready", {
      progress: 100,
      translated: true,
      from: detected,
      to: mapTargetLocale(config.targetLocale),
      cues: translated.length,
      origin: extraction.name,
      translationProvider,
      alignmentQuality,
      sourceQuality,
      finalQuality,
    });
    return { status: "ready", translated: true, cues: translated.length };
  } catch (error) {
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
