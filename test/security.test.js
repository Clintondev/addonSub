const test = require("node:test");
const assert = require("node:assert/strict");
const { signPath, verifyPath, safeChildPath, redact, isPrivateAddress } = require("../src/utils/security");
const { safeRemoteFetch } = require("../src/services/safeRemoteFetch");

test("signed paths expire and cannot be reused for another asset", () => {
  const now = 1_700_000_000_000;
  const { token } = signPath(["source", "pt-BR.vtt"], "secret", 60, now);
  assert.equal(verifyPath(token, ["source", "pt-BR.vtt"], "secret", now + 59_000), true);
  assert.equal(verifyPath(token, ["source", "original.vtt"], "secret", now), false);
  assert.equal(verifyPath(token, ["source", "pt-BR.vtt"], "secret", now + 61_000), false);
});

test("remote fetch blocks private destinations before opening a connection", async () => {
  await assert.rejects(() => safeRemoteFetch("http://127.0.0.1/private"), /Private media destinations are blocked/);
  await assert.rejects(() => safeRemoteFetch("http://[::ffff:172.16.0.2]/private"), /Private media destinations are blocked/);
});

test("paths cannot escape storage", () => {
  assert.throws(() => safeChildPath("C:/storage", ".."));
  assert.throws(() => safeChildPath("C:/storage", "folder/name"));
});

test("secrets are redacted and private ranges are recognized", () => {
  assert.match(redact("https://x.test/a?token=abc&x=1"), /\[REDACTED\]/);
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("192.168.1.2"), true);
  assert.equal(isPrivateAddress("::ffff:172.16.1.2"), true);
  assert.equal(isPrivateAddress("100.64.0.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});
