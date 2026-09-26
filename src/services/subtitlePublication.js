const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { safeChildPath } = require("../utils/security");
const { writeFileAtomic } = require("../utils/atomicFile");
const { writeJsonFileAtomic } = require("../utils/atomicJson");
const { parseVtt, serializeVtt } = require("./vtt");
const { vttCuesToAss } = require("./ass");
const { assertCueIntegrity } = require("./subtitleQuality");
const { validateTargetScript } = require("./translate");

const PUBLICATION_VERSION = 1;
const cache = new Map();
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const directory = (sourceId) => safeChildPath(config.storageDir, "subtitles", sourceId);

function publicationPath(sourceId) { return path.join(directory(sourceId), "publication.json"); }

function serializeSrt(cues) {
  return `${cues.map((cue, index) => `${index + 1}\n${cue.time.replace(/\.(\d{3})/g, ",$1").replace(/(\d{2}:\d{2}:\d{2},\d{3})\s+-->(\s+\d{2}:\d{2}:\d{2},\d{3}).*$/, "$1 -->$2")}\n${cue.text}`).join("\n\n")}\n`;
}

function publishSubtitle(sourceId, cues, { fingerprint = null, profile = null, provenance = null, maxCueSeconds = 60, assertActive } = {}) {
  const vtt = serializeVtt(cues);
  const reparsed = parseVtt(vtt);
  if (reparsed.length !== cues.length) throw new Error("Publicação alterou a quantidade de falas");
  validateTargetScript(reparsed.map((cue) => cue.text), config.targetLocale);
  const quality = assertCueIntegrity(reparsed, { maxCueSeconds, maxLineChars: 42, maxLines: 2, maxCps: config.subtitleMaxCps, minCueSeconds: config.subtitleMinCueSeconds });
  const contents = { "pt-BR.vtt": vtt, "pt-BR.srt": serializeSrt(reparsed), "pt-BR.ass": vttCuesToAss(reparsed) };
  const version = digest(JSON.stringify({ contents, fingerprint, profile, publicationVersion: PUBLICATION_VERSION }));
  const generation = safeChildPath(directory(sourceId), "versions", version);
  const files = {};
  assertActive?.();
  for (const [name, content] of Object.entries(contents)) {
    const file = path.join(generation, name);
    if (!fs.existsSync(file) || digest(fs.readFileSync(file)) !== digest(content)) writeFileAtomic(file, content);
    const stat = fs.statSync(file);
    files[name] = { hash: digest(content), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  }
  assertActive?.();
  const publication = { version: PUBLICATION_VERSION, generation: version, fingerprint, profile, provenance, files, quality, at: new Date().toISOString() };
  // Readers switch to this complete generation in one atomic operation.
  writeJsonFileAtomic(publicationPath(sourceId), publication);
  cache.delete(sourceId);
  // Compatibility exports for scripts; serving uses the immutable generation.
  for (const [name, content] of Object.entries(contents)) writeFileAtomic(path.join(directory(sourceId), name), content);
  return { publication, quality, cues: reparsed };
}

function readPublication(sourceId) {
  try {
    const marker = publicationPath(sourceId);
    const markerStat = fs.statSync(marker);
    const signature = `${markerStat.size}:${markerStat.mtimeMs}:${markerStat.ctimeMs}`;
    const cached = cache.get(sourceId);
    const publication = cached?.signature === signature ? cached.publication : JSON.parse(fs.readFileSync(marker, "utf8"));
    if (publication.version !== PUBLICATION_VERSION || !/^[a-f0-9]{64}$/.test(publication.generation)) return null;
    const generation = safeChildPath(directory(sourceId), "versions", publication.generation);
    for (const name of ["pt-BR.vtt", "pt-BR.srt", "pt-BR.ass"]) {
      const file = path.join(generation, name);
      const stat = fs.statSync(file);
      const entry = publication.files[name];
      if (!entry || stat.size !== entry.size) return null;
      if ((!cached || cached.signature !== signature || stat.mtimeMs !== entry.mtimeMs || stat.ctimeMs !== entry.ctimeMs) && digest(fs.readFileSync(file)) !== entry.hash) return null;
    }
    cache.set(sourceId, { signature, publication });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return { ...publication, directory: generation };
  } catch (_) { cache.delete(sourceId); return null; }
}

function publishedFile(sourceId, name) {
  if (!["pt-BR.vtt", "pt-BR.srt", "pt-BR.ass"].includes(name)) return null;
  const publication = readPublication(sourceId);
  return publication ? path.join(publication.directory, name) : null;
}

module.exports = { PUBLICATION_VERSION, publicationPath, publishSubtitle, publishedFile, readPublication, serializeSrt };
