const fetch = require("node-fetch");
const logger = require("../logger");
const { sanitizeUrl } = require("../utils/security");

function parseAttributes(line) {
  const attrs = {};
  const [, raw] = line.split(":");
  if (!raw) return attrs;
  const regex = /([A-Z0-9-]+)=(".*?"|[^,]*)/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const key = match[1];
    let value = match[2];
    if (value && value.startsWith("\"") && value.endsWith("\"")) {
      value = value.slice(1, -1);
    }
    attrs[key] = value;
  }
  return attrs;
}

function resolveUrl(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch (err) {
    return ref;
  }
}

function parseSubtitlesFromMaster(text) {
  const lines = text.split(/\r?\n/);
  const tracks = [];
  for (const line of lines) {
    if (!line.startsWith("#EXT-X-MEDIA") || !line.includes("TYPE=SUBTITLES")) {
      continue;
    }
    const attrs = parseAttributes(line);
    if (!attrs.URI) continue;
    tracks.push({
      uri: attrs.URI,
      lang: (attrs.LANGUAGE || attrs.LANG || "").toLowerCase(),
      name: attrs.NAME || attrs.LANGUAGE || "sub",
      forced: attrs.FORCED === "YES",
      autoselect: attrs.AUTOSELECT === "YES",
    });
  }
  return tracks;
}

function pickTrack(tracks, preferredLangs) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const avoidForced = tracks.some((t) => t.forced === true);
  const normalized = tracks.map((t) => ({ ...t, lang: (t.lang || "").toLowerCase() }));

  // Priorize explicit languages.
  for (const pref of preferredLangs) {
    const found = normalized.find(
      (t) => t.lang === pref && (!avoidForced ? true : t.forced === false)
    );
    if (found) return found;
  }

  // Fallback to first non-forced, then any.
  const nonForced = normalized.find((t) => t.forced === false);
  if (nonForced) return nonForced;
  return normalized[0];
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${sanitizeUrl(url)} (${res.status})`);
  }
  return res.text();
}

async function downloadVttFromM3u8(uri, baseUrl, maxSegments = 300) {
  const playlistUrl = resolveUrl(baseUrl, uri);
  const playlistText = await fetchText(playlistUrl);
  const lines = playlistText.split(/\r?\n/);
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    segments.push(resolveUrl(playlistUrl, line));
    if (segments.length >= maxSegments) break;
  }

  if (segments.length === 0) {
    throw new Error("No subtitle segments found in playlist");
  }

  let output = "WEBVTT\n\n";
  for (const seg of segments) {
    try {
      const segText = await fetchText(seg);
      // Ensure spacing between segments.
      output += `${segText.trim()}\n\n`;
    } catch (err) {
      logger.warn("Failed to fetch subtitle segment", {
        segment: sanitizeUrl(seg),
        err: err.message,
      });
    }
  }
  return output;
}

async function downloadSubtitle(track, masterUrl) {
  const resolved = resolveUrl(masterUrl, track.uri);
  const res = await fetch(resolved);
  if (!res.ok) {
    throw new Error(`Subtitle fetch failed ${sanitizeUrl(resolved)} (${res.status})`);
  }
  const contentType = res.headers.get("content-type") || "";
  const isVtt = contentType.includes("vtt") || resolved.endsWith(".vtt");
  const isM3u8 = contentType.includes("mpegurl") || resolved.endsWith(".m3u8");

  if (isVtt) {
    return res.text();
  }
  if (isM3u8) {
    return downloadVttFromM3u8(track.uri, masterUrl);
  }

  // Last resort: treat as text.
  return res.text();
}

async function extractHlsSubtitle(masterUrl, options = {}) {
  const preferredLangs = options.preferredLangs || ["eng", "en", "spa", "fra", "ita"];
  const playlistText = await fetchText(masterUrl);
  const tracks = parseSubtitlesFromMaster(playlistText);
  if (!tracks.length) {
    throw new Error("Nenhuma trilha de legenda HLS encontrada");
  }
  const track = pickTrack(tracks, preferredLangs);
  if (!track) throw new Error("Falha ao selecionar trilha de legenda");

  logger.info("Selecionada trilha HLS", {
    lang: track.lang,
    name: track.name,
    forced: track.forced,
    target: sanitizeUrl(masterUrl),
  });

  const vttText = await downloadSubtitle(track, masterUrl);
  return {
    lang: track.lang || "und",
    name: track.name,
    content: vttText,
  };
}

module.exports = {
  extractHlsSubtitle,
};
