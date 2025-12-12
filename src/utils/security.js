const crypto = require("crypto");

function hashUrl(url) {
  return crypto.createHash("sha256").update(url || "").digest("hex").slice(0, 12);
}

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch (err) {
    return "invalid-url";
  }
}

function signSubtitlePath(videoKey, fileName, secret) {
  const payload = `${videoKey}:${fileName}`;
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function verifySubtitleToken(token, videoKey, fileName, secret) {
  if (!token) return false;
  const expected = signSubtitlePath(videoKey, fileName, secret);
  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (tokenBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(tokenBuffer, expectedBuffer);
}

module.exports = {
  hashUrl,
  sanitizeUrl,
  signSubtitlePath,
  verifySubtitleToken,
};
