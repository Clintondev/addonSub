const config = require("../src/config");
const { translateContextual, unloadContextualModel } = require("../src/services/translate");

const lines = [
  { text: "What's the second commandment? See commandment Number 1.", startMs: 357074, endMs: 359827 },
  { text: "Got you.", startMs: 360619, endMs: 361787 },
  { text: "You talking out the side of your neck?", startMs: 362371, endMs: 364456 },
  { text: "Come again? I said, are you being a smart ass?", startMs: 364540, endMs: 368043 },
  { text: "I'm just trying to fly low, avoid the radar, boss.", startMs: 368502, endMs: 370963 },
  { text: "Do my time and get out.", startMs: 371046, endMs: 373090 },
  { text: "There isn't any flying under my radar.", startMs: 374300, endMs: 376427 },
  { text: "Good to know.", startMs: 377011, endMs: 378470 },
  { text: "Hey, can a brother get some air-conditioning up here, cuz?", startMs: 399200, endMs: 401702 },
  { text: "It's hotter than a crack ho's mouth, man.", startMs: 401785, endMs: 403662 },
  { text: "Shit, to hell with the a.c., man. Give me the crack ho.", startMs: 403746, endMs: 407041 },
  { text: "Yo, Fish, what you looking at?", startMs: 414131, endMs: 416175 },
  { text: "You look kind of pretty to be up in here, man.", startMs: 416675, endMs: 418969 },
  { text: "Fish!", startMs: 419762, endMs: 420930 },
  { text: "Suggest you take a seat, Fish.", startMs: 422473, endMs: 424808 },
  { text: "Ain't nothing to do up in here but serve time.", startMs: 425559, endMs: 428103 },
  { text: "Ain't nobody gonna serve it for you.", startMs: 428187, endMs: 430022 },
];

async function main() {
  try {
    const translated = await translateContextual(lines, {
      endpoint: config.contextualTranslatorUrl,
      model: config.contextualTranslatorModel,
      sourceLang: "en",
      targetLocale: "pt-BR",
      contextTitle: "Prison Break - Pilot",
      maxChars: config.translateBatchChars,
      maxCues: config.contextualTranslatorMaxCues,
      timeoutMs: config.contextualTranslatorTimeoutMs,
    });
    translated.forEach((text, index) => process.stdout.write(`${index + 1}. ${text}\n`));
  } finally {
    await unloadContextualModel(config.contextualTranslatorUrl, config.contextualTranslatorModel);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
