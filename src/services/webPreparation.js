const { Queue } = require("bullmq");
const { getConnection } = require("../jobs/queue");
const sourceStore = require("./sourceStore");
const { associatedTranslationStatus } = require("./subtitleAssociation");
const { cacheComplete, inputFingerprint, ensureHls, waitForHlsCompletion } = require("./hlsPlayback");
const { isCancelled } = require("./cancellationStore");

let queue;
function getWebQueue() {
  if (!queue) queue = new Queue("web-preparation", { connection: getConnection(), defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 10000 }, removeOnComplete: 100, removeOnFail: 100 } });
  return queue;
}
async function queueWebPreparation(sourceId, { priority = 5 } = {}) {
  const source = sourceStore.get(sourceId);
  if (!source?.localPath) return null;
  const status = associatedTranslationStatus(source);
  if (status.status !== "ready") return null;
  sourceId = status.subtitleSourceId || sourceId;
  const fingerprint = inputFingerprint(source.localPath, status.assPath || status.srtPath);
  if (cacheComplete(sourceId, fingerprint)) return null;
  const queue = getWebQueue();
  const existing = await queue.getJob(sourceId);
  if (existing) {
    const state = await existing.getState();
    if (!["completed", "failed"].includes(state)) {
      if (["waiting", "prioritized"].includes(state) && priority < (existing.opts.priority || 5)) await existing.changePriority({ priority });
      return existing;
    }
    await existing.remove();
  }
  return queue.add("prepare-web", { sourceId, requestedAt: Date.now() }, { jobId: sourceId, priority });
}
async function processWebJob(job) {
  const source = sourceStore.get(job.data.sourceId);
  if (!source?.localPath) return { status: "cancelled" };
  const assertActive = () => {
    if (!sourceStore.get(source.sourceId) || isCancelled(source.sourceId, job.data.requestedAt)) throw Object.assign(new Error("Preparação WEB cancelada"), { code: "SOURCE_CANCELLED" });
  };
  assertActive();
  const subtitle = associatedTranslationStatus(source);
  if (subtitle.status !== "ready") throw new Error("A legenda precisa estar publicada antes da preparação WEB");
  await ensureHls(source.sourceId, source.localPath, { subtitleFile: subtitle.assPath || subtitle.srtPath, priority: job.opts.priority, requestedAt: job.data.requestedAt, assertActive });
  await waitForHlsCompletion(source.sourceId);
  return { status: "ready" };
}
module.exports = { getWebQueue, queueWebPreparation, processWebJob };
