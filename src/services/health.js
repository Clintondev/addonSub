const fetch = require("node-fetch");
const config = require("../config");
const { getConnection } = require("../jobs/queue");

async function checkHttp(url, { method = "GET", timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    response.body?.destroy();
    return true;
  } finally { clearTimeout(timer); }
}

async function healthReport() {
  const checks = {
    redis: () => getConnection().ping(),
    qbittorrent: () => checkHttp(`${config.qbittorrentUrl}/api/v2/app/version`),
    intelligence: () => config.intelligenceUrl ? checkHttp(`${config.intelligenceUrl}/healthz`) : Promise.resolve(true),
    contextualTranslator: () => checkHttp(`${config.contextualTranslatorUrl}/api/tags`),
    languageService: () => checkHttp(`${config.libreTranslateUrl}/languages`),
  };
  const results = await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    try { await check(); return [name, { ok: true }]; }
    catch (error) { return [name, { ok: false, error: String(error.message || error).slice(0, 200) }]; }
  }));
  const services = Object.fromEntries(results);
  return { status: Object.values(services).every((item) => item.ok) ? "ok" : "degraded", upstreams: config.upstreamAddons.length, services };
}

module.exports = { checkHttp, healthReport };
