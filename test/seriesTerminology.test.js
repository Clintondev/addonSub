const test = require("node:test");
const assert = require("node:assert/strict");
const { seriesDialogueCorrectionsForSource, seriesTerminologyForSource } = require("../src/services/seriesTerminology");
const { applySeriesDialogueCorrections, contextualChunks, validateSemanticFidelity } = require("../src/services/translate");

test("Fairy Tail terminology catches broken Dragon Slayer and guild translations", () => {
  const terminology = seriesTerminologyForSource({ videoId: "tt1528406:2:37" });
  const dragon = contextualChunks([{ text: "Dragon Slayers are impressive.", sourceLang: "en" }], 1000, 20)[0];
  const guild = contextualChunks([{ text: "They're members of our guild.", sourceLang: "en" }], 1000, 20)[0];
  assert.throws(() => validateSemanticFidelity(dragon, ["Os Dragon e os Slayers são impressionantes."], [], "pt-BR", terminology), /Dragon Slayer/);
  assert.deepEqual(validateSemanticFidelity(dragon, ["Os Dragon Slayers são impressionantes."], [], "pt-BR", terminology), ["Os Dragon Slayers são impressionantes."]);
  assert.deepEqual(validateSemanticFidelity(dragon, ["Os Caçadores de Dragões são impressionantes."], [], "pt-BR", terminology), ["Os Caçadores de Dragões são impressionantes."]);
  assert.throws(() => validateSemanticFidelity(dragon, ["O Dragon Slayers chegou."], [], "pt-BR", terminology), /Dragon Slayer/);
  assert.throws(() => validateSemanticFidelity(guild, ["São membros do nosso sindicato."], [], "pt-BR", terminology), /guilda/);
  assert.deepEqual(validateSemanticFidelity(guild, ["São membros da nossa guilda."], [], "pt-BR", terminology), ["São membros da nossa guilda."]);
  const guildRelationship = terminology.find((rule) => rule.label === "membros da guilda");
  assert.equal(guildRelationship.sourceRewrite, undefined);
  const majesty = contextualChunks([{ text: "Yes, Your Majesty.", sourceLang: "en" }], 1000, 20)[0];
  assert.throws(() => validateSemanticFidelity(majesty, ["Sim, Sua Majesty."], [], "pt-BR", terminology), /Majestade/);
  assert.deepEqual(validateSemanticFidelity(majesty, ["Sim, Vossa Majestade."], [], "pt-BR", terminology), ["Sim, Vossa Majestade."]);
  const fallens = contextualChunks([{ text: "Those Exceeds are Fallens!", sourceLang: "en" }], 1000, 20)[0];
  assert.deepEqual(validateSemanticFidelity(fallens, ["Esses Exceeds são Fallens!"], [], "pt-BR", terminology), ["Esses Exceeds são Fallens!"]);
  assert.throws(() => validateSemanticFidelity(fallens, ["Ela persegue a Fallens."], [], "pt-BR", terminology), /Fallens/);
  const wendyShare = contextualChunks([{ text: "Stop! Take hers from me instead!", sourceLang: "en" }], 1000, 20)[0];
  assert.throws(() => validateSemanticFidelity(wendyShare, ["Pare! Pegue a dela em vez!"], [], "pt-BR", terminology), /parte da magia de Wendy/);
  assert.deepEqual(validateSemanticFidelity(wendyShare, ["Pare! Tire de mim a parte dela também!"], [], "pt-BR", terminology), ["Pare! Tire de mim a parte dela também!"]);
});

test("series terminology does not constrain an unrelated title", () => {
  const terminology = seriesTerminologyForSource({ videoId: "tt0000001:1:1" });
  assert.deepEqual(terminology, []);
  const chunk = contextualChunks([{ text: "Hell if I know!", sourceLang: "en" }], 1000, 20)[0];
  const corrections = seriesDialogueCorrectionsForSource({ videoId: "tt0000001:1:1" });
  assert.deepEqual(applySeriesDialogueCorrections(chunk, ["To hell with it!"], corrections), ["Sei lá!"]);
});

test("reviewed Fairy Tail dialogue corrections are exact and series scoped", () => {
  const chunk = contextualChunks([
    { text: "It was obviously just a bluff.", sourceLang: "en" },
    { text: "Then I'll start with you.", sourceLang: "en" },
    { text: "Previously, on Fairy Tail!", sourceLang: "en" },
    { text: "It's completely different from our world of Earth Land, huh?", sourceLang: "en" },
    { text: "Meanwhile, a battle between Fairy Tail wizards from Earth Land", sourceLang: "en" },
    { text: "and Edolas' Magic Warfare Units begins.", sourceLang: "en" },
  ], 1000, 20)[0];
  const corrections = seriesDialogueCorrectionsForSource({ videoId: "tt1528406:2:37" });
  const drafts = ["Era chantagem.", "Vou começar com vocês.", "Anteriormente.", "É outro mundo.", "Começa uma batalha.", "As unidades atacam."];
  assert.deepEqual(applySeriesDialogueCorrections(chunk, drafts, corrections), [
    "Era obviamente só um blefe.",
    "Então vou começar por você.",
    "Anteriormente, em Fairy Tail!",
    "É completamente diferente do nosso mundo, Earth Land, não é?",
    "Enquanto isso, começa uma batalha entre os magos da Fairy Tail de Earth Land",
    "e as Unidades de Guerra Mágica de Edolas.",
  ]);
  assert.deepEqual(applySeriesDialogueCorrections(chunk, drafts, []), drafts);
  assert.deepEqual(applySeriesDialogueCorrections(chunk, drafts, seriesDialogueCorrectionsForSource({ videoId: "tt1528406:2:38" })), drafts);
});
