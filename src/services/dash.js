const fetch = require("node-fetch");
const { XMLParser } = require("fast-xml-parser");
const logger = require("../logger");
const { sanitizeUrl } = require("../utils/security");

function resolveUrl(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch (err) {
    return ref;
  }
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar MPD ${sanitizeUrl(url)} (${res.status})`);
  return res.text();
}

function listSubtitleReps(manifest, baseUrl) {
  const lists = [];
  const adaptations =
    manifest?.MPD?.Period?.AdaptationSet ||
    manifest?.MPD?.Period?.[0]?.AdaptationSet ||
    [];
  const arr = Array.isArray(adaptations) ? adaptations : [adaptations];
  arr.forEach((adp) => {
    const type = adp["@_contentType"] || adp["@_mimeType"] || "";
    const mime = (adp["@_mimeType"] || "").toLowerCase();
    const lang = (adp["@_lang"] || "").toLowerCase();
    if (
      type === "text" ||
      mime.includes("vtt") ||
      mime.includes("ttml") ||
      mime.includes("mp4")
    ) {
      const reps = adp.Representation || [];
      const repsArr = Array.isArray(reps) ? reps : [reps];
      repsArr.forEach((rep) => {
        const repLang = (rep["@_lang"] || lang || "").toLowerCase();
        const repMime = (rep["@_mimeType"] || mime || "").toLowerCase();
        let url = null;
        if (rep.BaseURL) {
          const base = Array.isArray(rep.BaseURL) ? rep.BaseURL[0] : rep.BaseURL;
          url = resolveUrl(baseUrl, base);
        } else if (adp.BaseURL) {
          const base = Array.isArray(adp.BaseURL) ? adp.BaseURL[0] : adp.BaseURL;
          url = resolveUrl(baseUrl, base);
        }
        lists.push({
          lang: repLang,
          mime: repMime,
          url,
        });
      });
    }
  });
  return lists.filter((l) => l.url);
}

function pickTrack(tracks, preferredLangs) {
  if (!tracks.length) return null;
  for (const pref of preferredLangs) {
    const found = tracks.find((t) => t.lang === pref);
    if (found) return found;
  }
  return tracks[0];
}

async function extractDashSubtitle(mpdUrl, options = {}) {
  const preferredLangs = options.preferredLangs || ["eng", "en", "spa", "fra", "ita"];
  const xmlText = await fetchText(mpdUrl);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const manifest = parser.parse(xmlText);
  const tracks = listSubtitleReps(manifest, mpdUrl);
  if (!tracks.length) {
    throw new Error("Nenhuma legenda encontrada no MPD");
  }
  const track = pickTrack(tracks, preferredLangs);
  logger.info("Selecionada trilha DASH", {
    lang: track.lang,
    mime: track.mime,
    target: sanitizeUrl(mpdUrl),
  });
  const res = await fetch(track.url);
  if (!res.ok) throw new Error(`Falha ao baixar legenda DASH ${sanitizeUrl(track.url)}`);
  const content = await res.text();
  return {
    lang: track.lang || "und",
    name: track.mime || "dash-sub",
    content,
  };
}

module.exports = {
  extractDashSubtitle,
};
