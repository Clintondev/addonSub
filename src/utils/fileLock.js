const fs = require("fs");
const path = require("path");

const sleeper = new Int32Array(new SharedArrayBuffer(4));

function pause(milliseconds) {
  Atomics.wait(sleeper, 0, 0, milliseconds);
}

function withFileLock(lockFile, callback, { timeoutMs = 10000, staleMs = 30000 } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const started = Date.now();
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch (_) {}
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out acquiring file lock ${path.basename(lockFile)}`);
      pause(20);
    }
  }
  try {
    return callback();
  } finally {
    try { fs.closeSync(descriptor); } catch (_) {}
    fs.rmSync(lockFile, { force: true });
  }
}

module.exports = { withFileLock };
