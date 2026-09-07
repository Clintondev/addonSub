const crypto = require("crypto");
const { getConnection } = require("../jobs/queue");

const ACQUIRE = `
redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[1])
if redis.call('zcard', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('zadd', KEYS[1], ARGV[3], ARGV[4])
return 1`;
const RENEW = `
if redis.call('zscore', KEYS[1], ARGV[1]) then
  redis.call('zadd', KEYS[1], ARGV[2], ARGV[1])
  return 1
end
return 0`;
const RELEASE = "return redis.call('zrem', KEYS[1], ARGV[1])";

async function acquireSemaphoreSlot(name, limit, { waitMs = 0, leaseMs = 120000, owner = "process" } = {}) {
  const connection = getConnection();
  const key = `pt-auto:semaphore:${name}`;
  const token = `${owner}:${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + Math.max(0, waitMs);
  while (true) {
    const now = Date.now();
    const acquired = await connection.eval(ACQUIRE, 1, key, String(now), String(limit), String(now + leaseMs), token);
    if (Number(acquired) === 1) {
      const renewal = setInterval(() => {
        connection.eval(RENEW, 1, key, token, String(Date.now() + leaseMs)).catch(() => {});
      }, Math.max(1000, Math.floor(leaseMs / 3)));
      renewal.unref();
      return async () => {
        clearInterval(renewal);
        await connection.eval(RELEASE, 1, key, token).catch(() => {});
      };
    }
    if (Date.now() >= deadline) throw new Error(`${name} capacity is currently exhausted`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
}

module.exports = { acquireSemaphoreSlot };
