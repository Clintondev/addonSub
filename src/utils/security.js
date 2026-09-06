const crypto = require("crypto");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

function stableHash(value, length = 32) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

function sanitizeUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch (_) {
    return "invalid-url";
  }
}

function redact(value) {
  if (typeof value === "string") {
    return value.replace(/([?&](?:token|key|api_key|apikey|auth|signature|sig)=)[^&\s]+/gi, "$1[REDACTED]").replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|secret|password|cookie|authorization/i.test(key) ? "[REDACTED]" : redact(item)]));
  }
  return value;
}

function signPath(parts, secret, ttlSeconds = 86400, now = Date.now()) {
  const expires = Math.floor(now / 1000) + ttlSeconds;
  const payload = `${parts.join(":")}:${expires}`;
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return { token: `${expires}.${signature}`, expires };
}

function verifyPath(token, parts, secret, now = Date.now()) {
  if (typeof token !== "string" || !/^\d+\.[a-f0-9]{64}$/.test(token)) return false;
  const [expiresRaw, supplied] = token.split(".");
  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(expires) || expires < Math.floor(now / 1000)) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${parts.join(":")}:${expires}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function safeChildPath(root, ...parts) {
  for (const part of parts) {
    if (!/^[a-zA-Z0-9._-]+$/.test(String(part)) || part === "." || part === "..") throw new Error("Unsafe path component");
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...parts);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Path escapes storage root");
  return resolved;
}

function safeRelativePath(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) throw new Error("Unsafe relative path");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath.replace(/\\/g, "/"));
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Path escapes storage root");
  return resolved;
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && [0, 2].includes(c))
      || (a === 198 && [18, 19].includes(b)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:") && net.isIPv4(normalized.slice(7))) return isPrivateAddress(normalized.slice(7));
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
    || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea")
    || normalized.startsWith("feb") || normalized.startsWith("ff");
}

async function assertSafeRemoteUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Unsafe media URL");
  if (parsed.hostname.toLowerCase() === "localhost" || parsed.hostname.toLowerCase().endsWith(".local")) throw new Error("Private media destinations are blocked");
  const addresses = net.isIP(parsed.hostname) ? [{ address: parsed.hostname }] : await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) throw new Error("Private media destinations are blocked");
  return parsed;
}

module.exports = { stableHash, sanitizeUrl, redact, signPath, verifyPath, safeChildPath, safeRelativePath, isPrivateAddress, assertSafeRemoteUrl };
