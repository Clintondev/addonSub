const crypto = require("crypto");
const config = require("../config");
const { getConnection } = require("../jobs/queue");

const KEY = "pt-auto:gpu-lock";
const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function acquireGpuLock(owner, { waitMs = config.gpu.lockWaitMs, leaseMs = config.gpu.lockLeaseMs } = {}) {
  const connection = getConnection();
  const token = `${owner}:${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await connection.set(KEY, token, "PX", leaseMs, "NX") === "OK") {
      const renewal = setInterval(() => {
        connection.eval(RENEW_SCRIPT, 1, KEY, token, String(leaseMs)).catch(() => {});
      }, Math.max(1000, Math.floor(leaseMs / 3)));
      renewal.unref();
      return async () => {
        clearInterval(renewal);
        await connection.eval(RELEASE_SCRIPT, 1, KEY, token).catch(() => {});
      };
    }
    await delay(500);
  }
  throw new Error("GPU ocupada por outra preparação; tente novamente em instantes");
}

async function withGpuLock(owner, callback, options) {
  const release = await acquireGpuLock(owner, options);
  try { return await callback(); }
  finally { await release(); }
}

module.exports = { acquireGpuLock, withGpuLock };
