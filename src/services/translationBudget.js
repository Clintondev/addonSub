function budgetError(message, code = "TRANSLATION_BUDGET_EXHAUSTED") {
  return Object.assign(new Error(message), { code });
}

function createTranslationBudget({ maxCalls = 16, timeoutMs = 600000, now = Date.now } = {}) {
  const started = now();
  let calls = 0;
  return {
    remainingMs() {
      const remaining = timeoutMs - (now() - started);
      if (remaining <= 0) throw budgetError("Prazo total da tradução esgotado");
      return remaining;
    },
    take() {
      this.remainingMs();
      if (calls >= maxCalls) throw budgetError(`Limite de ${maxCalls} chamadas de tradução atingido`);
      calls++;
    },
    stats() { return { calls, elapsedMs: now() - started, maxCalls, timeoutMs }; },
  };
}

// Conservative planning estimate; actual counts returned by Ollama are logged.
// It deliberately includes UTF-8 bytes, markers, instructions and response.
function estimateTokens(value) { return Math.ceil(Buffer.byteLength(String(value), "utf8") / 2); }

function fitPromptSections(required, optional, contextTokens, outputTokens) {
  const sections = [...required];
  let estimated = estimateTokens(sections.join("\n")) + outputTokens + 64;
  if (estimated > contextTokens) throw budgetError("Falas e rascunho excedem o contexto; dividir o bloco", "TRANSLATION_CONTEXT_LIMIT");
  for (const section of optional.filter(Boolean)) {
    const size = estimateTokens(`\n${section}`);
    if (estimated + size > contextTokens) continue;
    sections.splice(sections.length - 1, 0, section);
    estimated += size;
  }
  return sections.join("\n");
}

function isTranslationControlError(error) {
  return error?.name === "AbortError" || ["TRANSLATION_BUDGET_EXHAUSTED", "SOURCE_CANCELLED", "ABORT_ERR", "GPU_LEASE_LOST", "RESOURCE_LEASE_LOST"].includes(error?.code);
}

function watchTranslationRequest(controller, { assertActive, budget, episodeBudget, intervalMs = 1000 } = {}) {
  let interruption = null;
  const timer = setInterval(() => {
    try { assertActive?.(); budget?.remainingMs(); episodeBudget?.remainingMs(); }
    catch (error) { interruption = error; controller.abort(); }
  }, intervalMs);
  timer.unref();
  return { error: () => interruption, stop: () => clearInterval(timer) };
}

module.exports = { createTranslationBudget, estimateTokens, fitPromptSections, isTranslationControlError, watchTranslationRequest };
