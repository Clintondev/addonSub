const express = require("express");
const morgan = require("morgan");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const config = require("./config");
const logger = require("./logger");
const { getMetricsText, inc } = require("./metrics");
const {
  deriveVideoKey,
  translationStatus,
  queueTranslationJob,
  savePlaceholderSubtitle,
  subtitleUrl,
  subtitlePath,
} = require("./services/subtitleService");
const { verifySubtitleToken, sanitizeUrl } = require("./utils/security");

function buildManifest() {
  return {
    id: "org.stremio.pt-auto",
    version: "0.1.0",
    name: "RD Proxy + PT-AUTO",
    description:
      "Proxy RD streams e gera legendas PT-AUTO traduzidas a partir de HLS (VTT).",
    logo: "https://www.stremio.com/website/stremio-logo-small.png",
    catalogs: [],
    resources: ["stream", "subtitles"],
    types: ["movie", "series"],
    idPrefixes: ["rdpt"],
  };
}

function createAddonRouter() {
  const manifest = buildManifest();
  const builder = new addonBuilder(manifest);

  builder.defineStreamHandler(async (args) => {
    const targetUrl = args?.extra?.rdUrl || args?.extra?.url;
    if (!targetUrl) {
      logger.warn("Stream request missing rdUrl/url", { args });
      return { streams: [] };
    }

    const videoKey = deriveVideoKey({ type: args.type, id: args.id, targetUrl });

    // Kick off subtitle work asynchronously.
    queueTranslationJob({
      videoKey,
      targetUrl,
      streamType: args.type,
    }).catch((err) =>
      logger.error("Failed to enqueue job", { err: err.message })
    );

    const streamUrl = `${config.baseUrl}/proxy/stream?target=${encodeURIComponent(
      targetUrl
    )}&videoKey=${encodeURIComponent(videoKey)}`;

    return {
      streams: [
        {
          name: "RD + PT-AUTO",
          title: "RD pass-through with PT-AUTO subtitles",
          url: streamUrl,
          behaviorHints: {
            proxyHeaders: {
              request: ["range", "user-agent"],
            },
          },
        },
      ],
    };
  });

  builder.defineSubtitlesHandler(async (args) => {
    const targetUrl = args?.extra?.rdUrl || args?.extra?.url;
    if (!targetUrl) {
      return { subtitles: [] };
    }

    const videoKey = deriveVideoKey({ type: args.type, id: args.id, targetUrl });
    queueTranslationJob({
      videoKey,
      targetUrl,
      streamType: args.type,
    }).catch((err) =>
      logger.error("Failed to enqueue job from subtitles handler", {
        err: err.message,
      })
    );
    const status = translationStatus(videoKey);

    if (status.status === "pending") {
      // ensure placeholder so user can select PT-AUTO slot
      await savePlaceholderSubtitle(videoKey);
    }

    const subtitles = [
      {
        id: "pt-auto",
        lang: "por",
        name:
          status.status === "ready"
            ? "PT-AUTO (cache)"
            : "PT-AUTO (gerando...)",
        url: subtitleUrl(videoKey, "pt-auto.vtt"),
      },
    ];

    return { subtitles };
  });

  return getRouter(builder.getInterface());
}

function createApp() {
  const app = express();

  fs.mkdirSync(config.storageDir, { recursive: true });

  app.use(morgan("dev"));
  app.use(express.json());

  app.get("/healthz", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/metrics", (req, res) => {
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    res.send(getMetricsText());
  });

  // Proxy route with Range support.
  app.get("/proxy/stream", async (req, res) => {
    const target = req.query.target;
    if (!target) {
      return res.status(400).send("target query param is required");
    }

    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    if (req.headers["user-agent"]) headers["User-Agent"] = req.headers["user-agent"];

    logger.info("Proxying stream", { target: sanitizeUrl(target), headers });

    let upstream;
    try {
      upstream = await fetch(target, {
        headers,
        redirect: "follow",
      });
    } catch (err) {
      logger.error("Proxy fetch failed", { err: err.message });
      return res.status(502).send("Failed to reach origin");
    }

    res.status(upstream.status);

    // Pass through important headers.
    const passthroughHeaders = [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
      "cache-control",
    ];
    passthroughHeaders.forEach((header) => {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    upstream.body.pipe(res);
    upstream.body.on("error", (err) => {
      logger.error("Stream proxy error", { err: err.message });
      res.destroy(err);
    });
  });

  // Signed subtitle delivery.
  app.get("/assets/subtitles/:videoKey/:fileName", (req, res) => {
    const { videoKey, fileName } = req.params;
    const token = req.query.token;
    if (
      !verifySubtitleToken(
        token,
        videoKey,
        fileName,
        config.subtitleTokenSecret || "change-me"
      )
    ) {
      return res.status(403).send("Invalid token");
    }

    const filePath = subtitlePath(videoKey, fileName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send("Subtitle not found");
    }

    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    fs.createReadStream(filePath).pipe(res);
  });

  // Stremio addon router mounts manifest/stream/subtitles.
  app.use("/", createAddonRouter());

  return app;
}

const app = createApp();

app.listen(config.port, () => {
  logger.info(`Server running on ${config.port}`);
});
