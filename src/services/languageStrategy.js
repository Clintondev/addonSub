const LANGUAGE_ALIASES = new Map(Object.entries({
  ara: "ar", chi: "zh", zho: "zh", cze: "cs", ces: "cs", dan: "da", dut: "nl", nld: "nl",
  eng: "en", fin: "fi", fre: "fr", fra: "fr", ger: "de", deu: "de", gre: "el", ell: "el",
  heb: "he", hin: "hi", hun: "hu", ind: "id", ita: "it", jpn: "ja", kor: "ko", may: "ms",
  msa: "ms", nor: "no", per: "fa", fas: "fa", pol: "pl", pob: "pt-br", por: "pt", pb: "pt-br",
  rum: "ro", ron: "ro", rus: "ru", spa: "es", swe: "sv", tha: "th", tur: "tr", ukr: "uk",
  vie: "vi",
}));

const COUNTRY_LANGUAGES = new Map(Object.entries({
  argentina: ["es"], austria: ["de"], brazil: ["pt"], chile: ["es"], china: ["zh"], colombia: ["es"],
  "czech republic": ["cs"], czechia: ["cs"], denmark: ["da"], egypt: ["ar"], finland: ["fi"], france: ["fr"],
  germany: ["de"], greece: ["el"], "hong kong": ["zh"], hungary: ["hu"], indonesia: ["id"], iran: ["fa"],
  israel: ["he"], italy: ["it"], japan: ["ja"], mexico: ["es"], netherlands: ["nl"], norway: ["no"],
  poland: ["pl"], portugal: ["pt"], romania: ["ro"], russia: ["ru"], "saudi arabia": ["ar"],
  "south korea": ["ko"], spain: ["es"], sweden: ["sv"], taiwan: ["zh"], thailand: ["th"], turkey: ["tr"],
  ukraine: ["uk"], "united kingdom": ["en"], uk: ["en"], "united states": ["en"], usa: ["en"], vietnam: ["vi"],
}));

function canonicalLanguage(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (!normalized || normalized === "und" || normalized === "unknown") return "und";
  const [base, ...rest] = normalized.split("-");
  const canonicalBase = LANGUAGE_ALIASES.get(base) || base;
  if (canonicalBase.includes("-") || !rest.length) return canonicalBase;
  return `${canonicalBase}-${rest.join("-")}`;
}

function languageMatches(left, right) {
  const a = canonicalLanguage(left);
  const b = canonicalLanguage(right);
  if (a === "und" || b === "und") return false;
  return a === b || a.split("-")[0] === b.split("-")[0];
}

function speechRecognitionLanguage(value) {
  const language = canonicalLanguage(value);
  return language === "und" ? null : language.split("-")[0];
}

function explicitOriginalLanguage(source = {}) {
  const candidates = [source.originalLanguage, source.original_language, source.originalLang];
  const found = candidates.map(canonicalLanguage).find((language) => language !== "und");
  return found || null;
}

function countryLanguageCandidates(country) {
  const output = [];
  for (const name of String(country || "").toLowerCase().split(/[,;/]/).map((item) => item.trim()).filter(Boolean)) {
    for (const language of COUNTRY_LANGUAGES.get(name) || []) if (!output.includes(language)) output.push(language);
  }
  return output;
}

function unsuitableAudio(track) {
  const title = String(track.title || "").toLowerCase();
  return Boolean(track.disposition?.comment || track.disposition?.visual_impaired)
    || /commentary|coment[aá]rio|audio description|descriptive|described/.test(title);
}

function dubbedAudio(track) {
  const title = String(track.title || "").toLowerCase();
  return Boolean(track.disposition?.dub) || /\bdub(?:bed)?\b|dublado|doublage/.test(title);
}

function selectOriginalAudio(audioTracks = [], source = {}) {
  const usable = audioTracks.filter((track) => !unsuitableAudio(track));
  const explicit = explicitOriginalLanguage(source);
  if (explicit) {
    const match = usable.find((track) => languageMatches(track.lang, explicit));
    if (match) return { ...match, lang: canonicalLanguage(match.lang), reason: "source-metadata", confidence: "high" };
    return { ffIndex: null, lang: explicit, title: "", disposition: {}, reason: "source-metadata-without-matching-audio", confidence: "high" };
  }
  if (!usable.length) return null;
  const marked = usable.find((track) => track.disposition?.original || /\boriginal\b|\bnative\b|idioma original/.test(String(track.title || "").toLowerCase()));
  if (marked) return { ...marked, lang: canonicalLanguage(marked.lang), reason: "track-marked-original", confidence: "high" };
  const countryMatches = countryLanguageCandidates(source.country)
    .filter((language) => usable.some((track) => languageMatches(track.lang, language)));
  if (countryMatches.length === 1) {
    const match = usable.find((track) => languageMatches(track.lang, countryMatches[0]));
    return { ...match, lang: canonicalLanguage(match.lang), reason: "content-country-matched-audio", confidence: "medium" };
  }
  const nonDubbed = usable.filter((track) => !dubbedAudio(track));
  const declaredLanguages = [...new Set(nonDubbed.map((track) => canonicalLanguage(track.lang)).filter((lang) => lang !== "und"))];
  if (declaredLanguages.length === 1) {
    const match = nonDubbed.find((track) => languageMatches(track.lang, declaredLanguages[0]));
    return { ...match, lang: declaredLanguages[0], reason: "single-non-dub-language", confidence: "medium" };
  }
  const candidate = nonDubbed[0] || usable[0];
  return { ...candidate, lang: canonicalLanguage(candidate.lang), reason: "first-usable-audio", confidence: "low" };
}

function uniqueLanguages(values) {
  const output = [];
  for (const value of values) {
    const language = canonicalLanguage(value);
    if (language !== "und" && !output.some((item) => languageMatches(item, language))) output.push(language);
  }
  return output;
}

function subtitleLanguageOrder({ source = {}, audioTracks = [], preferredLangs = [], targetLocale = "pt-BR" } = {}) {
  const originalAudio = selectOriginalAudio(audioTracks, source);
  const otherAudio = audioTracks.filter((track) => !unsuitableAudio(track)).map((track) => track.lang);
  return {
    originalAudio,
    languages: uniqueLanguages([targetLocale, originalAudio?.lang, ...otherAudio, ...preferredLangs]),
  };
}

function translationRoute(subtitleLanguage, originalAudio) {
  const language = canonicalLanguage(subtitleLanguage);
  if (languageMatches(language, "pt")) return "already-target-language";
  if (originalAudio && languageMatches(language, originalAudio.lang)) return "direct-original-language";
  return originalAudio ? "intermediate-language-fallback" : "source-language-unverified";
}

module.exports = {
  canonicalLanguage,
  countryLanguageCandidates,
  explicitOriginalLanguage,
  languageMatches,
  speechRecognitionLanguage,
  selectOriginalAudio,
  subtitleLanguageOrder,
  translationRoute,
  unsuitableAudio,
};
