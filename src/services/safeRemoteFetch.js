const fetch = require("node-fetch");
const http = require("http");
const https = require("https");
const config = require("../config");
const { resolveSafeRemoteUrl } = require("../utils/security");

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function safeRemoteFetch(value, options = {}) {
  let current = new URL(value).toString();
  const maximumRedirects = options.maximumRedirects ?? 5;
  for (let redirect = 0; redirect <= maximumRedirects; redirect++) {
    const resolved = await resolveSafeRemoteUrl(current);
    const Agent = resolved.url.protocol === "https:" ? https.Agent : http.Agent;
    const agent = new Agent({
      keepAlive: false,
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions?.all) return callback(null, [{ address: resolved.address, family: resolved.family }]);
        return callback(null, resolved.address, resolved.family);
      },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || config.remoteFetchTimeoutMs);
    try {
      const response = await fetch(current, {
        ...options,
        maximumRedirects: undefined,
        timeoutMs: undefined,
        redirect: "manual",
        agent,
        signal: controller.signal,
        timeout: options.timeoutMs || config.remoteFetchTimeoutMs,
        size: options.size || config.remoteFetchMaxBytes,
      });
      if (!REDIRECTS.has(response.status)) return { response, url: current };
      const location = response.headers.get("location");
      response.body?.destroy();
      if (!location) throw new Error(`Remote redirect ${response.status} did not include a location`);
      if (redirect === maximumRedirects) throw new Error("Remote resource exceeded the redirect limit");
      current = new URL(location, current).toString();
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Remote resource exceeded the redirect limit");
}

async function safeRemoteText(value, options = {}) {
  const { response, url } = await safeRemoteFetch(value, options);
  if (!response.ok) throw new Error(`Remote resource returned HTTP ${response.status}`);
  return { text: await response.text(), response, url };
}

module.exports = { safeRemoteFetch, safeRemoteText };
