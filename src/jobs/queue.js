const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const config = require("../config");
const logger = require("../logger");

let connection;
let subtitleQueue;

function getConnection() {
  if (!connection) {
    connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    connection.on("error", (error) => logger.warn("Redis connection error", { error: error.message }));
  }
  return connection;
}

function getQueue() {
  if (!subtitleQueue) {
    subtitleQueue = new Queue("subtitle-jobs", {
      connection: getConnection(),
      defaultJobOptions: { removeOnComplete: 100, removeOnFail: 100, attempts: 3, backoff: { type: "exponential", delay: 5000 } },
    });
  }
  return subtitleQueue;
}

async function enqueueSubtitleJob(payload, priority = 5) {
  const queue = getQueue();
  const existing = await queue.getJob(payload.sourceId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed") {
      await existing.retry();
      return existing;
    }
    if (state !== "completed") {
      const currentPriority = Number(existing.opts.priority || 0);
      if (["waiting", "prioritized"].includes(state) && priority > 0 && (currentPriority === 0 || priority < currentPriority)) {
        await existing.changePriority({ priority });
        logger.info("Raised queued subtitle priority", { jobId: existing.id, sourceId: payload.sourceId, from: currentPriority, to: priority });
      }
      return existing;
    }
    if (state === "completed") await existing.remove();
  }
  const job = await queue.add("process-subtitle", payload, { priority, jobId: payload.sourceId });
  logger.info("Queued subtitle job", { jobId: job.id, sourceId: payload.sourceId });
  return job;
}

async function close() {
  if (subtitleQueue) await subtitleQueue.close();
  if (connection) await connection.quit();
}

module.exports = { enqueueSubtitleJob, getConnection, getQueue, close };
