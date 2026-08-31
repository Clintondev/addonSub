const fs = require("fs");
const path = require("path");
const config = require("../config");
const logger = require("../logger");
const sourceStore = require("./sourceStore");
const { aggregateStreams } = require("./upstreams");
const { acquireTorrent, forceRecheck, getTorrent } = require("./qbittorrent");
const { validateLocalMedia } = require("./mediaValidation");
const { readMeta, transition } = require("./metadata");
const { safeChildPath } = require("../utils/security");

function seedCount(record) {
  const match = String(record.title || "").match(/👤\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

function recoveryCandidates(items, source, limit = config.mediaRecoveryMaxSources) {
  const seen = new Set([String(source.infoHash || "").toLowerCase()]);
  return items.filter(({ record }) => {
    const hash = String(record.infoHash || "").toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash) || seen.has(hash)) return false;
    seen.add(hash);
    return true;
  }).sort((a, b) => seedCount(b.record) - seedCount(a.record)
    || Number(b.record.videoSize || 0) - Number(a.record.videoSize || 0)).slice(0, limit);
}

function currentRecoveryCandidate(source) {
  const infoHash = String(source.infoHash || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(infoHash)) return null;
  return { record: { ...source, infoHash }, recheck: true, sameSource: true };
}

function removeRecoveryArtifacts(sourceId, mediaPath) {
  if (mediaPath) {
    const resolved = path.resolve(mediaPath);
    const relative = path.relative(path.resolve(config.mediaDir), resolved);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) fs.rmSync(resolved, { force: true });
  }
  fs.rmSync(safeChildPath(config.hlsDir, sourceId), { recursive: true, force: true });
  const subtitlesDir = safeChildPath(config.storageDir, "subtitles", sourceId);
  for (const fileName of ["pt-BR.vtt", "pt-BR.ass", "original.vtt", "pending.vtt", "failed.json", "processing-audio.flac", "transcribed.vtt", "layout-complete.json", "validation-debug.vtt"]) {
    fs.rmSync(path.join(subtitlesDir, fileName), { force: true });
  }
  try {
    for (const fileName of fs.readdirSync(subtitlesDir)) {
      if (/^track-\d+.*\.(?:sup|srt|vtt|json)$/.test(fileName)) fs.rmSync(path.join(subtitlesDir, fileName), { force: true });
    }
  } catch (_) {}
}

async function recoverCorruptMedia(source, validation, onProgress = async () => {}) {
  const previousAttempts = Number(readMeta(source.sourceId).mediaRecoveryAttempts || 0);
  if (previousAttempts >= config.mediaRecoveryMaxAttempts) throw new Error(`Recuperação automática esgotada após ${previousAttempts} tentativa(s): ${validation.reason}`);
  const recoveryAttempt = previousAttempts + 1;
  transition(source.sourceId, "recovering", { progress: 2, mediaRecoveryAttempts: recoveryAttempt, corruptionReason: validation.reason });
  logger.warn("Corrupt media detected; starting automatic recovery", { sourceId: source.sourceId, reason: validation.reason, recoveryAttempt });
  removeRecoveryArtifacts(source.sourceId, source.localPath);
  source = sourceStore.upsert({ ...source, localPath: null, acquisitionState: "recovering", corruptionReason: validation.reason });

  const candidates = [];
  const currentCandidate = currentRecoveryCandidate(source);
  if (currentCandidate) {
    candidates.push(currentCandidate);
    logger.info("Trying the same torrent before alternate releases", { sourceId: source.sourceId, infoHash: currentCandidate.record.infoHash });
    try {
      const torrent = await getTorrent(currentCandidate.record.infoHash);
      logger.info("Same torrent recovery availability", {
        sourceId: source.sourceId,
        availability: torrent?.availability,
        completePeers: torrent?.num_complete,
      });
    } catch (error) {
      logger.warn("Could not inspect the same torrent; it will still be rechecked first", { sourceId: source.sourceId, error: error.message });
    }
  }
  try { candidates.push(...recoveryCandidates(await aggregateStreams(source.type, source.videoId), source)); }
  catch (error) { logger.warn("Could not discover alternate media sources", { sourceId: source.sourceId, error: error.message }); }

  const errors = [];
  for (let index = 0; index < Math.min(candidates.length, config.mediaRecoveryMaxSources); index++) {
    const candidate = candidates[index];
    const record = { ...candidate.record, sourceId: source.sourceId };
    transition(source.sourceId, "recovering", { progress: 3, mediaRecoveryAttempts: recoveryAttempt, recoverySource: index + 1, recoverySources: Math.min(candidates.length, config.mediaRecoveryMaxSources) });
    try {
      if (candidate.recheck) await forceRecheck(record.infoHash, config.mediaRecoveryRecheckTimeoutMs);
      const acquired = await acquireTorrent(record, onProgress);
      const checked = validateLocalMedia(acquired.localPath);
      if (!checked.valid) {
        removeRecoveryArtifacts(source.sourceId, acquired.localPath);
        throw new Error(checked.reason);
      }
      const recovered = sourceStore.upsert({
        ...source,
        ...candidate.record,
        ...acquired,
        sourceId: source.sourceId,
        acquisitionState: "ready",
        recoveredFromSourceId: candidate.record.sourceId,
        recoveredAt: Date.now(),
        corruptionReason: null,
      });
      transition(source.sourceId, "recovered", { progress: 36, mediaRecoveryAttempts: recoveryAttempt, recoverySourceId: candidate.record.sourceId, mediaValidation: checked });
      logger.info("Automatic media recovery completed", { sourceId: source.sourceId, recoverySourceId: candidate.record.sourceId, fileName: acquired.fileName });
      return recovered;
    } catch (error) {
      errors.push(error.message);
      logger.warn("Automatic recovery source failed", { sourceId: source.sourceId, recoverySourceId: candidate.record.sourceId, error: error.message });
    }
  }
  throw new Error(`Não foi possível recuperar a mídia automaticamente em ${Math.min(candidates.length, config.mediaRecoveryMaxSources)} fonte(s): ${errors.join(" | ") || "nenhuma fonte alternativa disponível"}`);
}

module.exports = { currentRecoveryCandidate, recoverCorruptMedia, recoveryCandidates, removeRecoveryArtifacts, seedCount };
