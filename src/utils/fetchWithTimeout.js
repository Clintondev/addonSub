const fetch = require("node-fetch");

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  let handedOff = false;
  const cleanup = () => {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
  };
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    handedOff = true;
    if (response.body) {
      response.body.once("end", cleanup);
      response.body.once("close", cleanup);
      response.body.once("error", cleanup);
    } else cleanup();
    return response;
  } finally {
    if (!handedOff) cleanup();
  }
}

module.exports = { fetchWithTimeout };
