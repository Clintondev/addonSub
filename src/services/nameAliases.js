// Confirmed spellings for names whose Japanese audio transcription has produced
// inconsistent Kana. Keep these scoped to the title so an ordinary word in
// another show cannot be changed accidentally.
const SERIES_ALIASES = Object.freeze({
  tt1528406: Object.freeze({
    "シャルル": "Charle",
    "シャレル": "Charle",
    "ウェンディー": "Wendy",
    "ウェンディ": "Wendy",
    "エルザ": "Erza",
    "ハッピー": "Happy",
    "ルーシー": "Lucy",
    "ルシー": "Lucy",
    "アースランド": "Earth Land",
    "エクスタリア": "Extalia",
    "エドラス": "Edolas",
    "シャゴット": "Shagotte",
    "フェアリーテイル": "Fairy Tail",
    "ラクリマ": "Lacrima",
    "ラクレマ": "Lacrima",
    "パンサーリリー": "Panther Lily",
    "シュガーボーイ": "Sugar Boy",
    "ナツ": "Natsu",
  }),
});

function nameAliasesForSource(source) {
  const seriesId = String(source?.videoId || "").split(":", 1)[0];
  return SERIES_ALIASES[seriesId] || {};
}

function applyNameAliases(value, aliases = {}) {
  return Object.entries(aliases)
    .sort(([left], [right]) => right.length - left.length)
    .reduce((text, [source, target]) => {
      const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Kana particles are valid neighbours; another Katakana character means
      // this is part of a longer name, not the confirmed entity.
      const boundary = /[\u30A0-\u30FF]/u.test(source) ? "[\\u30A0-\\u30FF]" : "[\\p{L}\\p{N}_]";
      return text.replace(new RegExp(`(?<!${boundary})${escaped}(?!${boundary})`, "gu"), () => target);
    }, String(value || ""));
}

module.exports = { applyNameAliases, nameAliasesForSource };
