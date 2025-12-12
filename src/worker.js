require("dotenv").config();
const { Worker, QueueScheduler } = require("bullmq");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const logger = require("./logger");
const { connection } = require("./jobs/queue");
const {
  savePlaceholderSubtitle,
  subtitlePath,
  ensureVideoDir,
} = require("./services/subtitleService");
const { sanitizeUrl } = require("./utils/security");
const { extractHlsSubtitle } = require("./services/hls");
const { extractDashSubtitle } = require("./services/dash");
const { extractFileSubtitle } = require("./services/ffextract");
const { parseVtt, serializeVtt } = require("./services/vtt");
const {
  detectLanguage,
  translateBatch,
  mapTargetLocale,
} = require("./services/translate");
const { mergeMeta, recordJob } = require("./services/metadata");
const { inc } = require("./metrics");

const queueName = "subtitle-jobs";

// Keeps delayed jobs moving.
const scheduler = new QueueScheduler(queueName, { connection });

const worker = new Worker(
  queueName,
  async (job) => {
    const { videoKey, targetUrl } = job.data;
    inc("jobs_total");
    logger.info("Worker started", {
      jobId: job.id,
      videoKey,
      target: sanitizeUrl(targetUrl),
    });

    // Skip if already translated.
    const translatedPath = subtitlePath(videoKey, "pt-auto.vtt");
    if (fs.existsSync(translatedPath)) {
      inc("cache_hits");
      return { status: "cached" };
    }

    ensureVideoDir(videoKey);

    let extraction;
    let sourceType = "unknown";

    try {
      if (typeof targetUrl === "string" && targetUrl.includes(".m3u8")) {
        sourceType = "hls";
        extraction = await extractHlsSubtitle(targetUrl, {
          preferredLangs: config.preferredSubtitleLangs,
        });
      } else if (typeof targetUrl === "string" && targetUrl.includes(".mpd")) {
        sourceType = "dash";
        extraction = await extractDashSubtitle(targetUrl, {
          preferredLangs: config.preferredSubtitleLangs,
        });
      } else {
        sourceType = "file";
        extraction = await extractFileSubtitle(
          targetUrl,
          path.dirname(translatedPath),
          config.preferredSubtitleLangs
        );
      }
    } catch (err) {
      inc("extraction_failed");
      await savePlaceholderSubtitle(videoKey);
      recordJob(videoKey, { status: "failed", reason: err.message });
      throw err;
    }

    recordJob(videoKey, { status: "extracted", sourceType });
    const originalPath = subtitlePath(videoKey, "original.vtt");
    fs.writeFileSync(originalPath, extraction.content, "utf8");

    // 2) Parsear cues
    const cues = parseVtt(extraction.content);
    if (!cues.length) {
      await savePlaceholderSubtitle(videoKey);
      throw new Error("Legenda vazia ou ilegível");
    }

    // 3) Detectar idioma
    const sampleText = cues
      .slice(0, 10)
      .map((c) => c.text)
      .join("\n")
      .slice(0, 4000);
    const detected = await detectLanguage(sampleText, config.libreTranslateUrl);
    logger.info("Idioma detectado", { detected, declared: extraction.lang });

    const isPortuguese =
      detected.startsWith("pt") || (extraction.lang || "").startsWith("pt");
    mergeMeta(videoKey, {
      sourceType,
      langDetected: detected,
      langDeclared: extraction.lang || "und",
    });

    if (isPortuguese) {
      // Apenas normaliza para pt-auto.
      fs.writeFileSync(translatedPath, extraction.content, "utf8");
      recordJob(videoKey, { status: "ready", translated: false });
      return { status: "pass-through", lang: detected };
    }

    // 4) Traduzir cue a cue
    const translatedTexts = await translateBatch(
      cues.map((c) => c.text),
      config.libreTranslateUrl,
      config.targetLocale,
      detected,
      config.translateBatchChars
    );

    const translatedCues = cues.map((cue, idx) => ({
      ...cue,
      text: translatedTexts[idx] || cue.text,
    }));

    const translatedVtt = serializeVtt(translatedCues);
    fs.writeFileSync(translatedPath, translatedVtt, "utf8");
    inc("translations_total");
    recordJob(videoKey, {
      status: "ready",
      translated: true,
      from: detected,
      to: mapTargetLocale(config.targetLocale),
    });

    return {
      status: "translated",
      from: detected,
      to: mapTargetLocale(config.targetLocale),
      cues: translatedCues.length,
    };
  },
  {
    connection,
    concurrency: config.job.concurrency,
  }
);

worker.on("completed", (job, result) => {
  logger.info("Worker completed", { jobId: job.id, result });
});

worker.on("failed", (job, err) => {
  logger.error("Worker failed", { jobId: job?.id, err: err.message });
  inc("jobs_failed");
});

process.on("SIGINT", async () => {
  await worker.close();
  await scheduler.close();
  await connection.quit();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await worker.close();
  await scheduler.close();
  await connection.quit();
  process.exit(0);
});
