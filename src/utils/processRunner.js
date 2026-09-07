const { spawn } = require("child_process");

function runProcess(command, args, { timeoutMs = 0, maxBuffer = 8 * 1024 * 1024, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let forceKillTimer = null;

    const append = (chunks, chunk, current) => {
      if (current >= maxBuffer) return current + chunk.length;
      chunks.push(chunk.subarray(0, Math.max(0, maxBuffer - current)));
      return current + chunk.length;
    };
    child.stdout.on("data", (chunk) => { stdoutBytes = append(stdout, chunk, stdoutBytes); });
    child.stderr.on("data", (chunk) => { stderrBytes = append(stderr, chunk, stderrBytes); });

    const terminate = () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 5000);
        forceKillTimer.unref?.();
      }
    };
    const abort = () => terminate();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; terminate(); }, timeoutMs) : null;
    timer?.unref?.();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, terminationSignal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      const output = {
        status: code,
        signal: terminationSignal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        truncated: stdoutBytes > maxBuffer || stderrBytes > maxBuffer,
      };
      if (timedOut && code !== 0) output.stderr = `${output.stderr}\n${command} timed out after ${timeoutMs}ms`.trim();
      resolve(output);
    });
  });
}

module.exports = { runProcess };
