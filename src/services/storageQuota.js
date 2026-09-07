const crypto = require("crypto");
const config = require("../config");
const { getConnection } = require("../jobs/queue");
const { directorySize } = require("./storageUsage");

const RESERVATIONS = "pt-auto:storage-reservations";
const EXPIRATIONS = "pt-auto:storage-reservation-expirations";
const RESERVE = `
local expired = redis.call('zrangebyscore', KEYS[2], '-inf', ARGV[1])
for _, token in ipairs(expired) do
  redis.call('hdel', KEYS[1], token)
  redis.call('zrem', KEYS[2], token)
end
local total = 0
for _, value in ipairs(redis.call('hvals', KEYS[1])) do total = total + tonumber(value) end
if tonumber(ARGV[2]) + total + tonumber(ARGV[3]) > tonumber(ARGV[4]) then return {0, total} end
redis.call('hset', KEYS[1], ARGV[5], ARGV[3])
redis.call('zadd', KEYS[2], ARGV[6], ARGV[5])
return {1, total + tonumber(ARGV[3])}`;
const RENEW = `
if redis.call('hexists', KEYS[1], ARGV[1]) == 1 then
  redis.call('zadd', KEYS[2], ARGV[2], ARGV[1])
  return 1
end
return 0`;
const RELEASE = "redis.call('hdel', KEYS[1], ARGV[1]); return redis.call('zrem', KEYS[2], ARGV[1])";

async function reserveStorage(bytes, owner = "artifact", { leaseMs = config.storageReservationLeaseMs } = {}) {
  const requested = Math.max(0, Math.ceil(Number(bytes) || 0));
  if (!requested) return async () => {};
  const connection = getConnection();
  const token = `${owner}:${process.pid}:${crypto.randomUUID()}`;
  const now = Date.now();
  const used = await directorySize(config.storageDir);
  const result = await connection.eval(RESERVE, 2, RESERVATIONS, EXPIRATIONS,
    String(now), String(used), String(requested), String(config.maxStorageBytes), token, String(now + leaseMs));
  if (Number(result?.[0]) !== 1) {
    const reserved = Number(result?.[1] || 0);
    throw new Error(`Storage limit would be exceeded (used ${used}, reserved ${reserved}, requested ${requested}, maximum ${config.maxStorageBytes})`);
  }
  const renewal = setInterval(() => {
    connection.eval(RENEW, 2, RESERVATIONS, EXPIRATIONS, token, String(Date.now() + leaseMs)).catch(() => {});
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  renewal.unref();
  return async () => {
    clearInterval(renewal);
    await connection.eval(RELEASE, 2, RESERVATIONS, EXPIRATIONS, token).catch(() => {});
  };
}

async function withStorageReservation(bytes, owner, callback) {
  const release = await reserveStorage(bytes, owner);
  try { return await callback(); }
  finally { await release(); }
}

module.exports = { reserveStorage, withStorageReservation };
