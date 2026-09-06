const test = require("node:test");
const assert = require("node:assert/strict");
const { addressAllowed, createIpAllowlist, normalizeAddress } = require("../src/utils/clientAccess");

test("normalizes IPv4-mapped addresses and checks exact allowlist entries", () => {
  const allowlist = createIpAllowlist(["203.0.113.25"]);
  assert.equal(normalizeAddress("::ffff:203.0.113.25"), "203.0.113.25");
  assert.equal(addressAllowed(allowlist, "203.0.113.25"), true);
  assert.equal(addressAllowed(allowlist, "203.0.113.26"), false);
});

test("supports IPv4 CIDR ranges", () => {
  const allowlist = createIpAllowlist(["198.51.100.0/24"]);
  assert.equal(addressAllowed(allowlist, "198.51.100.42"), true);
  assert.equal(addressAllowed(allowlist, "198.51.101.42"), false);
});

test("rejects invalid allowlist entries", () => {
  assert.throws(() => createIpAllowlist(["not-an-ip"]), /invalid address/);
  assert.throws(() => createIpAllowlist(["192.0.2.1/99"]), /invalid subnet/);
});
