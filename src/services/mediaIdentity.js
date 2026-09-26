const fs = require("fs");
const path = require("path");
const { stableHash } = require("../utils/security");
function mediaIdentity(input) {
  try {
    const stat = fs.statSync(input);
    return stableHash(JSON.stringify({ path: path.resolve(input), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }), 48);
  } catch (_) { return stableHash(String(input), 48); }
}
module.exports = { mediaIdentity };
