const { languageMatches } = require("./languageStrategy");
async function tryAdaptiveCandidates(tracks, strategy, options, load) {
  const rank = (track) => { const index = strategy.languages.findIndex((lang) => languageMatches(track.lang, lang)); return index < 0 ? strategy.languages.length : index; };
  const errors = [];
  const candidates = tracks.filter((track) => !track.forced && !/songs?|signs?|forced|karaoke/i.test(track.name || ""))
    .filter((track) => options.allowIntermediateFallback !== false || !strategy.originalAudio || strategy.originalAudio.lang === "und"
      || languageMatches(track.lang, options.targetLocale || "pt-BR") || languageMatches(track.lang, strategy.originalAudio.lang))
    .sort((left, right) => rank(left) - rank(right));
  for (const track of candidates) {
    options.assertActive?.();
    try {
      const result = await load(track);
      return options.validateCandidate ? await options.validateCandidate(result) : result;
    } catch (error) {
      if (error.code === "SOURCE_CANCELLED") throw error;
      errors.push(`${track.lang}: ${error.message}`);
    }
  }
  throw new Error(`Nenhuma legenda adaptativa foi aprovada: ${errors.join(" | ") || "nenhuma faixa completa elegível"}`);
}
module.exports = { tryAdaptiveCandidates };
