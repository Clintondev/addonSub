const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const config = require("../config");
const logger = require("../logger");

const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

const subtitleQueue = new Queue("subtitle-jobs", {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
    attempts: 3,
  },
});

async function enqueueSubtitleJob(payload) {
  const job = await subtitleQueue.add(
    "process-subtitle",
    payload,
    {
      priority: 5,
      jobId: payload.videoKey,
    }
  );
  logger.info("Queued subtitle job", { jobId: job.id, videoKey: payload.videoKey });
  return job;
}

async function close() {
  await subtitleQueue.close();
  await connection.quit();
}

module.exports = {
  enqueueSubtitleJob,
  connection,
  subtitleQueue,
  close,
};
