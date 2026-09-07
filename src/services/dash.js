const { XMLParser } = require("fast-xml-parser");
const logger = require("../logger");
const { sanitizeUrl } = require("../utils/security");
const { safeRemoteFetch, safeRemoteText } = require("./safeRemoteFetch");
const { canonicalLanguage, languageMatches, subtitleLanguageOrder, translationRoute } = require("./languageStrategy");

function resolveUrl(base, ref) {
  try {
    return new URL(ref, base).toString();
  } catch (_err) {
    return ref;
  }
}

async function fetchText(url) {
  try { return (await safeRemoteText(url)).text; }
  catch (error) { throw new Error(`Falha ao baixar MPD ${sanitizeUrl(url)}: ${error.message}`); }
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
    const lang = canonicalLanguage(adp["@_lang"]);
    if (
      type === "text" ||
      mime.includes("vtt") ||
      mime.includes("ttml") ||
      mime.includes("mp4")
    ) {
      const reps = adp.Representation || [];
      const repsArr = Array.isArray(reps) ? reps : [reps];
      repsArr.forEach((rep) => {
        const repLang = canonicalLanguage(rep["@_lang"] || lang);
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

function listAudioTracks(manifest) {
  const adaptations = manifest?.MPD?.Period?.AdaptationSet || manifest?.MPD?.Period?.[0]?.AdaptationSet || [];
  const list = Array.isArray(adaptations) ? adaptations : [adaptations];
  return list.filter((adaptation) => String(adaptation?.["@_contentType"] || adaptation?.["@_mimeType"] || "").toLowerCase().includes("audio"))
    .map((adaptation, index) => {
      const title = adaptation["@_label"] || "";
      return {
        ffIndex: index,
        lang: canonicalLanguage(adaptation["@_lang"]),
        title,
        disposition: {
          original: /\boriginal\b|\bnative\b|idioma original/i.test(title),
          dub: /\bdub(?:bed)?\b|dublado/i.test(title),
        },
      };
    });
}

function pickTrack(tracks, preferredLangs) {
  if (!tracks.length) return null;
  for (const pref of preferredLangs) {
    const found = tracks.find((t) => languageMatches(t.lang, pref));
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
  const audioTracks = listAudioTracks(manifest);
  if (!tracks.length) {
    throw new Error("Nenhuma legenda encontrada no MPD");
  }
  const strategy = subtitleLanguageOrder({ source: options.source, audioTracks, preferredLangs, targetLocale: options.targetLocale });
  const track = pickTrack(tracks, strategy.languages);
  logger.info("Selecionada trilha DASH", {
    lang: track.lang,
    mime: track.mime,
    target: sanitizeUrl(mpdUrl),
  });
  const { response: res } = await safeRemoteFetch(track.url);
  if (!res.ok) throw new Error(`Falha ao baixar legenda DASH ${sanitizeUrl(track.url)}`);
  const content = await res.text();
  return {
    lang: track.lang || "und",
    name: track.mime || "dash-sub",
    content,
    sourceAudioIndex: null,
    sourceAudioLanguage: strategy.originalAudio?.lang || "und",
    sourceAudioReason: strategy.originalAudio?.reason || "unavailable",
    sourceAudioConfidence: strategy.originalAudio?.confidence || "unknown",
    translationRoute: translationRoute(track.lang, strategy.originalAudio),
  };
}

module.exports = {
  extractDashSubtitle,
  listAudioTracks,
  listSubtitleReps,
  pickTrack,
};
