const net = require("net");
const { isPrivateAddress } = require("./security");

function normalizeAddress(value) {
  const address = String(value || "").trim().split(",")[0].trim();
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address)) return address.slice(7);
  return address;
}

function createIpAllowlist(entries) {
  const blockList = new net.BlockList();
  for (const raw of entries || []) {
    const value = normalizeAddress(raw);
    const [address, prefixRaw] = value.split("/");
    const family = net.isIP(address);
    if (!family) throw new Error(`ALLOWED_CLIENT_IPS contains an invalid address: ${raw}`);
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefixRaw === undefined) blockList.addAddress(address, type);
    else {
      const prefix = Number(prefixRaw);
      const maximum = family === 4 ? 32 : 128;
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) throw new Error(`ALLOWED_CLIENT_IPS contains an invalid subnet: ${raw}`);
      blockList.addSubnet(address, prefix, type);
    }
  }
  return blockList;
}

function addressAllowed(blockList, address) {
  const normalized = normalizeAddress(address);
  const family = net.isIP(normalized);
  return Boolean(family && blockList.check(normalized, family === 4 ? "ipv4" : "ipv6"));
}

function createClientAccessMiddleware(entries) {
  if (!entries?.length) return (_req, _res, next) => next();
  const blockList = createIpAllowlist(entries);
  return (req, res, next) => {
    const cloudflareAddress = normalizeAddress(req.headers["cf-connecting-ip"]);
    const socketAddress = normalizeAddress(req.socket?.remoteAddress);
    // Container health checks and the host-only published port remain usable.
    // Public Cloudflare requests are authorized by the original client IP.
    if ((!cloudflareAddress && socketAddress && isPrivateAddress(socketAddress))
      || addressAllowed(blockList, cloudflareAddress || socketAddress)) return next();
    return res.status(403).json({ error: "Client IP is not allowed" });
  };
}

module.exports = { addressAllowed, createClientAccessMiddleware, createIpAllowlist, normalizeAddress };
