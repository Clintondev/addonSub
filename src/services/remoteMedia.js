const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const config = require("../config");
const { safeChildPath } = require("../utils/security");
const { safeRemoteFetch } = require("./safeRemoteFetch");
const { reserveStorage } = require("./storageQuota");
const { invalidateStorageUsage } = require("./storageUsage");

const MEDIA_EXTENSIONS = new Set([".mkv", ".mp4", ".m4v", ".webm", ".avi", ".mov", ".ts", ".m2ts"]);

function targetPath(source) {
  const extension = path.extname(new URL(source.url).pathname).toLowerCase();
  return safeChildPath(config.mediaDir, source.sourceId, `remote${MEDIA_EXTENSIONS.has(extension) ? extension : ".media"}`);
}

async function downloadRemoteMedia(source) {
  const target = targetPath(source);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) return target;
  const { response } = await safeRemoteFetch(source.url, { compress: false, size: config.maxStorageBytes });
  if (!response.ok) {
    response.body?.destroy();
    throw new Error(`Remote media returned HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    response.body?.destroy();
    throw new Error("Remote media must provide a valid Content-Length so storage can be reserved safely");
  }
  let releaseStorage;
  try { releaseStorage = await reserveStorage(contentLength, `remote:${source.sourceId}`); }
  catch (error) { response.body?.destroy(); throw error; }
  const dir = path.dirname(target);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  try {
    await pipeline(response.body, fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
    const actual = fs.statSync(temporary).size;
    if (actual !== contentLength) throw new Error(`Remote media size mismatch: expected ${contentLength}, received ${actual}`);
    fs.renameSync(temporary, target);
    invalidateStorageUsage();
    return target;
  } finally {
    fs.rmSync(temporary, { force: true });
    await releaseStorage();
  }
}

module.exports = { downloadRemoteMedia, targetPath };
