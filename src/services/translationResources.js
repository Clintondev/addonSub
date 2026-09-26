const config = require("../config");
const { acquireGpuLock } = require("./gpuLock");
const { releaseTranscriptionModel } = require("./transcribe");
const { unloadContextualModel } = require("./translate");
const { acquireSemaphoreSlot } = require("./distributedSemaphore");

function translationResources(sourceId, { priority = 5, assertActive, endpoint = config.contextualTranslatorUrl } = {}) {
  let releaseGpu = null;
  let releaseModelSlot = null;
  let currentModel = null;
  let blocks = 0;
  async function release() {
    if (currentModel) await unloadContextualModel(endpoint, currentModel);
    currentModel = null;
    blocks = 0;
    if (releaseGpu) await releaseGpu();
    releaseGpu = null;
    if (releaseModelSlot) await releaseModelSlot();
    releaseModelSlot = null;
  }
  return {
    assertOwned() { releaseGpu?.assertOwned(); releaseModelSlot?.assertOwned(); },
    async run(callback, { model, gpuLayers = config.contextualTranslatorGpuLayers }) {
      assertActive?.();
      if (currentModel !== model || (gpuLayers === 0 && releaseGpu)) await release();
      if (gpuLayers > 0 && !releaseGpu) {
        releaseGpu = await acquireGpuLock(`translate:${sourceId}`, { priority, assertActive });
        await releaseTranscriptionModel();
      }
      if (!releaseModelSlot) releaseModelSlot = await acquireSemaphoreSlot("ollama-model", 1, { waitMs: config.translationBlockTimeoutMs, leaseMs: config.gpu.lockLeaseMs, owner: `translate:${sourceId}`, assertActive });
      currentModel = model;
      releaseGpu?.assertOwned();
      releaseModelSlot.assertOwned();
      const result = await callback();
      releaseGpu?.assertOwned();
      releaseModelSlot.assertOwned();
      return result;
    },
    async blockComplete(block) {
      if (block.cached || !currentModel) return;
      if (++blocks >= config.translationGpuBatchBlocks) await release();
    },
    release,
  };
}

module.exports = { translationResources };
