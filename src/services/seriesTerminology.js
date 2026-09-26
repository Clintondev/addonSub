// Terms with an established meaning in a particular series. Keep these
// rules scoped to the series so ordinary dialogue in other titles is free
// to use a different translation.
const SERIES_TERMINOLOGY = Object.freeze({
  tt1528406: Object.freeze([
    Object.freeze({
      sourcePattern: "\\bdragon slayers\\b",
      targetPattern: "\\b(?:dragon slayers|caçadores de drag(?:ões|oes))\\b",
      forbiddenTargetPattern: "(?:^|[^\\p{L}])(?:o|a|um|uma|do|da)\\s+dragon slayers\\b",
      guidance: "Dragon Slayers is a plural, indivisible title. Keep Dragon Slayers or translate the whole title as Caçadores de Dragões; never split the words or use a singular article.",
      label: "Dragon Slayers",
    }),
    Object.freeze({
      sourcePattern: "\\bdragon slayer\\b",
      targetPattern: "\\b(?:dragon slayer|caçador de drag(?:ões|oes|ão|ao))\\b",
      guidance: "Dragon Slayer is one indivisible title. Keep Dragon Slayer or translate the whole title as Caçador de Dragões; never split Dragon and Slayer.",
      label: "Dragon Slayer",
    }),
    Object.freeze({
      sourcePattern: "\\bthey(?:'re| are) with our guild\\b",
      targetPattern: "\\bguildas?\\b",
      guidance: "The people mentioned belong to the same guild. Preserve that relationship explicitly as membros da nossa guilda; do not weaken it to merely being on our side.",
      label: "membros da guilda",
    }),
    Object.freeze({
      sourcePattern: "\\bguilds?\\b",
      targetPattern: "\\bguildas?\\b",
      guidance: "In this series, guild means guilda; guild members are membros or companheiros da guilda, never sindicato.",
      label: "guilda",
    }),
    Object.freeze({
      sourcePattern: "\\bmajesty\\b",
      targetPattern: "\\bmajestade\\b",
      guidance: "Your Majesty is a form of address, not a character name. Translate it as Vossa Majestade or Sua Majestade; never leave Majesty in English.",
      label: "Majestade",
    }),
    Object.freeze({
      sourcePattern: "\\bcode etd\\b",
      targetPattern: "\\b(?:código|code)\\s+etd\\b",
      forbiddenTargetPattern: "\\b(?:código|code)\\s+code\\b",
      guidance: "Code ETD is one operation name. Use Código ETD or Code ETD; never Código Code or a duplicated code label.",
      label: "Código ETD",
    }),
    Object.freeze({
      sourcePattern: "\\bfallens\\b",
      targetPattern: "\\bfallens\\b",
      forbiddenTargetPattern: "(?:^|[^\\p{L}])(?:o|a|um|uma|do|da)\\s+fallens\\b",
      guidance: "Fallens is the plural name of the exiled Exceeds. Preserve Fallens and use plural agreement.",
      label: "Fallens",
    }),
    Object.freeze({
      sourcePattern: "\\bchagot\\b",
      targetPattern: "\\bshagotte\\b",
      guidance: "The queen named Chagot in this English subtitle is Shagotte in the established series spelling. Use Shagotte consistently.",
      label: "Shagotte",
    }),
    Object.freeze({
      sourcePattern: "\\btake hers from me instead\\b",
      targetPattern: "(?=.*\\b(?:mim|minha)\\b)(?=.*\\b(?:dela|wendy)\\b)(?=.*\\b(?:parte|magia)\\b)",
      forbiddenTargetPattern: "\\bpegue\\s+a\\s+dela\\b",
      guidance: "Preserve whose share is taken and from whom. Resolve the referent from the surrounding scene; do not invent a character or object absent from that context.",
      label: "parte da magia de Wendy",
      episode: "tt1528406:2:37",
    }),
  ]),
});

// Human-reviewed corrections for ambiguous or demonstrably mistranslated
// source lines. These are matched against the complete normalized source
// sentence and scoped to the series, so they cannot change unrelated titles
// or a different sentence that merely shares one word.
const SERIES_DIALOGUE_CORRECTIONS = Object.freeze({
  "tt1528406:2:37": Object.freeze([
    ["Previously, on Fairy Tail!", "Anteriormente, em Fairy Tail!"],
    ["Meanwhile, a battle between Fairy Tail wizards from Earth Land", "Enquanto isso, começa uma batalha entre os magos da Fairy Tail de Earth Land"],
    ["and Edolas' Magic Warfare Units begins.", "e as Unidades de Guerra Mágica de Edolas."],
    ["It's completely different from our world of Earth Land, huh?", "É completamente diferente do nosso mundo, Earth Land, não é?"],
    ["And Mystogan sent Gajeel here.", "E Mystogan enviou Gajeel para cá."],
    ["than they are in Earth Land, then I have no clue whatsoever.", "dos de Earth Land, então não faço ideia."],
    ["Between us, our reasons for living are absolutely no different at all", "No fundo, nossas razões para viver não são nada diferentes."],
    ["Then killing her would be like a total waste!", "Então, matá-la seria um desperdício total!"],
    ["You're actually a member of Fairy Tail in our world, you know!", "Na verdade, você faz parte da Fairy Tail no nosso mundo!"],
    ["As my nickname of Fairy Hunter suggests, I've killed many a Fairy Tail wizard.", "Como sugere meu apelido de Caçadora de Fadas, já matei muitos magos da Fairy Tail."],
    ["I don't think so! I haven't seen any big Exceeds like him before!", "Acho que não! Nunca vi um Exceed tão grande quanto ele!"],
    ["Thanks, you guys!", "Obrigada, pessoal!"],
    ["But never mind that! I'm more shocked that you're the queen's daughter!", "Mas deixa isso para lá! Estou mais chocada por você ser filha da rainha!"],
    ["It was obviously just a bluff.", "Era obviamente só um blefe."],
    ["Oh, I just felt like you're back to your usual self!", "Ah, senti que você voltou ao normal!"],
    ["It seems the Extalian Royal Guard has invaded us in pursuit of the Fallens!", "Parece que a Guarda Real de Extalia nos invadiu para perseguir os Fallens!"],
    ["The Exceeds turned into a lacrima!", "Os Exceeds se transformaram em uma lacrima!"],
    ["Are you ready, you two?", "Vocês dois estão prontos?"],
    ["Neither one matters to us.", "Nenhum dos dois importa para nós."],
    ["You're not going any further.", "Você não vai passar daqui."],
    ["What sore losers the both of you are.", "Vocês dois são péssimos perdedores."],
    ["I won't, Mr. Natsu!", "Não vou, Sr. Natsu!"],
    ["Stop! Take hers from me instead!", "Pare! Tire de mim também a parte da magia da Wendy!"],
    ["Wengy...", "Wendy..."],
    ["Don't falter! It's just flour!", "Não se deixem enganar! É só farinha!"],
    ["You better escape, Happy!", "É melhor você fugir, Happy!"],
    ["I won't let you do away with Charle!", "Não vou deixar vocês machucarem a Charle!"],
    ["I won't!", "Não vou!"],
    ["Then I'll start with you.", "Então vou começar por você."],
    ["I long to hear your voice right now", "Quero ouvir sua voz agora."],
    ["I wish I was in your arms right now", "Queria estar nos seus braços agora."],
    ["If the days I can't see you are going to continue", "Se os dias sem poder ver você continuarem,"],
    ["maybe I should just say goodbye for good", "talvez eu devesse me despedir para sempre."],
    ["The fact it's such a long journey without any answers", "Essa jornada tão longa e sem respostas"],
    ["is why I need firm reassurance now", "é por isso que preciso de uma certeza agora."],
    ["Please, at least just for a little bit", "Por favor, nem que seja só por um instante,"],
    ["hold me tight now", "abrace-me forte agora,"],
    ["because I'm about to freeze", "porque estou prestes a congelar."],
    ["Alone in loneliness on this cold night,", "Nesta noite fria, em completa solidão,"],
    ["all I can think about is you", "só consigo pensar em você."],
    ["My heart can't bear the pain of saying goodbye yet", "Meu coração ainda não suporta a dor da despedida,"],
    ["so I'll try to forget how much I miss you and go to sleep", "então vou tentar esquecer a saudade e dormir."],
    ["Th-This world's done for!", "E-Este mundo está acabado!"],
  ].map(([source, target]) => Object.freeze({ source, target }))),
});

const GENERIC_DIALOGUE_CORRECTIONS = Object.freeze([
  Object.freeze({ source: "Hell if I know!", target: "Sei lá!" }),
]);

function seriesTerminologyForSource(source) {
  const seriesId = String(source?.videoId || "").split(":", 1)[0];
  return (SERIES_TERMINOLOGY[seriesId] || []).filter((rule) => !rule.episode || rule.episode === source?.videoId);
}

function seriesDialogueCorrectionsForSource(source) {
  return [...GENERIC_DIALOGUE_CORRECTIONS, ...(SERIES_DIALOGUE_CORRECTIONS[String(source?.videoId || "")] || [])];
}

module.exports = { seriesDialogueCorrectionsForSource, seriesTerminologyForSource };
