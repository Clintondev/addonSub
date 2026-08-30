const fs = require("fs");
const path = require("path");
const config = require("../config");
const { safeChildPath, safeRelativePath } = require("../utils/security");

const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".m4v", ".webm", ".ts", ".m2ts"]);
const torrentLocks = new Map();

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function request(endpoint, { method = "GET", body } = {}) {
  const response = await fetch(`${config.qbittorrentUrl}/api/v2${endpoint}`, {
    method,
    headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
    body: body ? new URLSearchParams(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`qBittorrent ${endpoint} returned ${response.status}`);
  return text;
}

async function getTorrent(hash) {
  const text = await request(`/torrents/info?hashes=${encodeURIComponent(hash)}`);
  return JSON.parse(text || "[]")[0] || null;
}

async function getFiles(hash) {
  const text = await request(`/torrents/files?hash=${encodeURIComponent(hash)}`);
  return JSON.parse(text || "[]");
}

async function addTorrent(sourceId, hash) {
  await request("/torrents/add", { method: "POST", body: {
    urls: `magnet:?xt=urn:btih:${hash}`,
    savepath: `/downloads/${sourceId}`,
    category: "pt-auto",
    sequentialDownload: "true",
    firstLastPiecePrio: "true",
    paused: "false",
  } });
}

function chooseFile(files, fileIdx) {
  const normalizedIndex = Number(fileIdx);
  if (fileIdx !== null && fileIdx !== undefined && fileIdx !== "" && Number.isInteger(normalizedIndex)) {
    const exact = files.find((file) => file.index === normalizedIndex);
    if (exact) return exact;
  }
  return files.filter((file) => VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())).sort((a, b) => b.size - a.size)[0] || null;
}

async function selectOnlyFile(hash, selected, files) {
  const skipped = files.filter((file) => file.index !== selected.index).map((file) => file.index);
  if (skipped.length) await request("/torrents/filePrio", { method: "POST", body: { hash, id: skipped.join("|"), priority: "0" } });
  await request("/torrents/filePrio", { method: "POST", body: { hash, id: String(selected.index), priority: "7" } });
}

function directorySize(root) {
  if (!fs.existsSync(root)) return 0;
  return fs.readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const child = path.join(root, entry.name);
    return total + (entry.isDirectory() ? directorySize(child) : entry.isFile() ? fs.statSync(child).size : 0);
  }, 0);
}

async function stopTorrent(hash) {
  try { await request("/torrents/stop", { method: "POST", body: { hashes: hash } }); }
  catch (_) { await request("/torrents/pause", { method: "POST", body: { hashes: hash } }); }
}

function isPausedState(state) {
  return /^(paused|stopped)/i.test(String(state || ""));
}

async function startTorrent(hash) {
  try { await request("/torrents/start", { method: "POST", body: { hashes: hash } }); }
  catch (_) { await request("/torrents/resume", { method: "POST", body: { hashes: hash } }); }
  await request("/torrents/setForceStart", { method: "POST", body: { hashes: hash, value: "true" } });
}

function torrentStorageRoot(torrent, sourceId) {
  const savePath = String(torrent?.save_path || "").replace(/\\/g, "/");
  const relative = savePath.startsWith("/downloads/") ? savePath.slice("/downloads/".length) : sourceId;
  return safeChildPath(config.mediaDir, relative || sourceId);
}

async function acquireTorrentUnlocked(source, onProgress = () => {}) {
  const hash = String(source.infoHash || "").toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error("Torrent source has an invalid infoHash");
  safeChildPath(config.mediaDir, source.sourceId);
  let torrentRecord = await getTorrent(hash);
  if (!torrentRecord) {
    await addTorrent(source.sourceId, hash);
    torrentRecord = await getTorrent(hash);
  }

  const metadataDeadline = Date.now() + config.torrentMetadataTimeoutMs;
  let files = [];
  while (Date.now() < metadataDeadline) {
    files = await getFiles(hash);
    if (files.length) break;
    await onProgress({ stage: "acquiring", progress: 3, message: "Obtendo metadados do torrent" });
    await delay(2000);
  }
  if (!files.length) throw new Error("Torrent metadata timeout");
  const selected = chooseFile(files, source.fileIdx);
  if (!selected) throw new Error("No video file found in torrent");
  const used = directorySize(config.mediaDir);
  const additionalBytes = Math.max(0, selected.size * (1 - Number(selected.progress || 0)));
  if (used + additionalBytes > config.maxStorageBytes) throw new Error("Storage limit would be exceeded by this download");
  await selectOnlyFile(hash, selected, files);
  await startTorrent(hash);

  const deadline = Date.now() + config.torrentDownloadTimeoutMs;
  let lastProgress = -1;
  let lastProgressAt = Date.now();
  while (Date.now() < deadline) {
    const current = (await getFiles(hash)).find((file) => file.index === selected.index);
    if (!current) throw new Error("Selected torrent file disappeared");
    const torrent = await getTorrent(hash);
    if (!torrent) throw new Error("Torrent disappeared from qBittorrent");
    if (isPausedState(torrent.state)) await startTorrent(hash);
    const percent = Math.floor(current.progress * 100);
    if (current.progress > lastProgress) {
      lastProgress = current.progress;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= config.torrentNoProgressTimeoutMs && torrent.num_seeds === 0 && Number(torrent.availability || 0) < 1) {
      await stopTorrent(hash);
      throw new Error("Torrent sem progresso e sem seed disponível; escolha outra fonte");
    }
    await onProgress({
      stage: "acquiring",
      progress: Math.min(35, 5 + Math.floor(percent * 0.3)),
      downloadProgress: percent,
      downloadedBytes: Math.floor(current.size * current.progress),
      totalBytes: current.size,
      downloadSpeedBytes: torrent?.dlspeed || 0,
      etaSeconds: Number.isFinite(torrent?.eta) ? torrent.eta : null,
    });
    if (current.progress >= 1) {
      await stopTorrent(hash);
      const sourceRoot = torrentStorageRoot(torrent, source.sourceId);
      const localPath = safeRelativePath(sourceRoot, current.name);
      if (!fs.existsSync(localPath)) throw new Error("Downloaded media file was not found in shared storage");
      return { localPath, fileName: current.name, size: current.size, fileIdx: current.index };
    }
    await delay(3000);
  }
  throw new Error("Torrent download timeout");
}

async function withTorrentLock(hash, callback) {
  const previous = torrentLocks.get(hash) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  torrentLocks.set(hash, tail);
  await previous;
  try { return await callback(); }
  finally {
    release();
    if (torrentLocks.get(hash) === tail) torrentLocks.delete(hash);
  }
}

async function acquireTorrent(source, onProgress = () => {}) {
  const hash = String(source.infoHash || "").toLowerCase();
  return withTorrentLock(hash, () => acquireTorrentUnlocked(source, onProgress));
}

module.exports = { request, getTorrent, getFiles, chooseFile, acquireTorrent, directorySize, isPausedState, torrentStorageRoot };
