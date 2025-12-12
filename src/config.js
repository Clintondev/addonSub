const path = require("path");
require("dotenv").config();

const storageDir = path.resolve(
  process.env.STORAGE_DIR || path.join(process.cwd(), "storage")
);

module.exports = {
  port: Number(process.env.PORT) || 7000,
  baseUrl: process.env.BASE_URL || "http://localhost:7000",
  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  libreTranslateUrl:
    process.env.LIBRETRANSLATE_URL || "http://localhost:5000",
  storageDir,
  targetLocale: process.env.TARGET_LOCALE || "pt-BR",
  subtitleTokenSecret: process.env.SUBTITLE_TOKEN_SECRET || "change-me",
  preferredSubtitleLangs: (process.env.PREFERRED_SUB_LANGS || "eng,en,spa,fra,ita")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  translateBatchChars: Number(process.env.TRANSLATE_BATCH_CHARS) || 3500,
  job: {
    concurrency: Number(process.env.JOB_CONCURRENCY) || 2,
    rateLimit: Number(process.env.JOB_RATE_LIMIT) || 4,
  },
};
