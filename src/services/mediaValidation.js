const fs = require("fs");
const { runProcess } = require("../utils/processRunner");

function sampleOffsets(size, sampleBytes = 4096) {
  if (size <= sampleBytes) return [0];
  return [...new Set([0, Math.max(0, Math.floor(size / 2) - Math.floor(sampleBytes / 2)), Math.max(0, size - sampleBytes)])];
}

function samplesAreAllZero(file, size, sampleBytes = 4096) {
  const fd = fs.openSync(file, "r");
  try {
    return sampleOffsets(size, sampleBytes).every((offset) => {
      const buffer = Buffer.alloc(Math.min(sampleBytes, size - offset));
      const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
      return read > 0 && buffer.subarray(0, read).every((value) => value === 0);
    });
  } finally { fs.closeSync(fd); }
}

async function validateLocalMedia(file, { probe = true } = {}) {
  if (!file || !fs.existsSync(file)) return { valid: false, reason: "Arquivo local não existe" };
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 1024 * 1024) return { valid: false, reason: "Arquivo local está vazio ou incompleto", size: stat.size };
  if (samplesAreAllZero(file, stat.size)) return { valid: false, reason: "Arquivo local contém somente bytes zerados", size: stat.size };
  if (!probe) return { valid: true, size: stat.size };
  const result = await runProcess("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration", "-of", "json", file], {
    timeoutMs: 30000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return { valid: false, reason: `FFprobe rejeitou o arquivo: ${(result.stderr || "formato inválido").trim().slice(0, 1000)}`, size: stat.size };
  const probeErrors = String(result.stderr || "").trim();
  // ffprobe may still exit with status 0 after detecting damaged/truncated
  // Matroska structures. Accepting that output previously published a
  // one-line subtitle from an incomplete PGS stream.
  if (/invalid as first byte of an EBML number|file ended prematurely|truncat(?:ed|ion)|corrupt(?:ed|ion)|error reading header/i.test(probeErrors)) {
    return { valid: false, reason: `FFprobe detectou corrupção: ${probeErrors.slice(0, 1000)}`, size: stat.size };
  }
  try {
    const format = JSON.parse(result.stdout || "{}").format || {};
    const duration = Number(format.duration);
    if (!format.format_name || !Number.isFinite(duration) || duration <= 0) return { valid: false, reason: "Arquivo não possui formato ou duração válidos", size: stat.size };
    return { valid: true, size: stat.size, duration, format: format.format_name };
  } catch (_) { return { valid: false, reason: "FFprobe retornou metadados inválidos", size: stat.size }; }
}

module.exports = { sampleOffsets, samplesAreAllZero, validateLocalMedia };
