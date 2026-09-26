const crypto = require("crypto");
const config = require("../config");
const { getConnection } = require("../jobs/queue");
const { inc } = require("../metrics");

const KEY = "pt-auto:gpu-lock";
const RELEASE_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_SCRIPT = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
// Remove abandoned waiters and atomically grant the highest-priority oldest request.
const ACQUIRE_SCRIPT = `
local stale = redis.call('zrangebyscore', KEYS[3], '-inf', ARGV[4])
for _, token in ipairs(stale) do redis.call('zrem', KEYS[2], token) end
redis.call('zremrangebyscore', KEYS[3], '-inf', ARGV[4])
redis.call('zadd', KEYS[2], 'NX', ARGV[3], ARGV[1])
redis.call('zadd', KEYS[3], ARGV[5], ARGV[1])
redis.call('pexpire', KEYS[2], 30000); redis.call('pexpire', KEYS[3], 30000)
local head = redis.call('zrange', KEYS[2], 0, 0)
if head[1] == ARGV[1] and redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
redis.call('zrem', KEYS[2], ARGV[1]); redis.call('zrem', KEYS[3], ARGV[1]); return 1 end
return 0`;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function acquireGpuLock(owner, { waitMs = config.gpu.lockWaitMs, leaseMs = config.gpu.lockLeaseMs, priority = 5, assertActive } = {}) {
  const connection = getConnection();
  const token = `${owner}:${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + waitMs;
  const startedAt = Date.now();
  const score = Math.max(1, Number(priority) || 5) * 1e13 + Date.now();
  try { while (Date.now() < deadline) {
    assertActive?.();
    const now = Date.now();
    if (await connection.eval(ACQUIRE_SCRIPT, 3, KEY, `${KEY}:waiting`, `${KEY}:heartbeat`, token, String(leaseMs), String(score), String(now - 10000), String(now)) === 1) {
      let lost = false;
      const renewal = setInterval(() => {
        connection.eval(RENEW_SCRIPT, 1, KEY, token, String(leaseMs)).then((renewed) => { if (!renewed) lost = true; }).catch(() => { lost = true; });
      }, Math.max(1000, Math.floor(leaseMs / 3)));
      renewal.unref();
      inc("gpu_acquisitions_total");
      inc("gpu_wait_milliseconds_total", Date.now() - startedAt);
      const release = async () => {
        clearInterval(renewal);
        await connection.eval(RELEASE_SCRIPT, 1, KEY, token).catch(() => {});
      };
      release.assertOwned = () => { if (lost) { const error = new Error("Reserva de GPU perdida"); error.code = "GPU_LEASE_LOST"; throw error; } };
      return release;
    }
    await delay(500);
  } } finally {
    await connection.zrem(`${KEY}:waiting`, token).catch(() => {});
    await connection.zrem(`${KEY}:heartbeat`, token).catch(() => {});
  }
  throw Object.assign(new Error("GPU ocupada por outra preparação; tente novamente em instantes"), { code: "GPU_RESOURCE_BUSY" });
}

async function withGpuLock(owner, callback, options) {
  const release = await acquireGpuLock(owner, options);
  try { release.assertOwned(); const result = await callback(); release.assertOwned(); return result; }
  finally { await release(); }
}

module.exports = { acquireGpuLock, withGpuLock };
