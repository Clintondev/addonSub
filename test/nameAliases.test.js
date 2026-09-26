const test = require("node:test");
const assert = require("node:assert/strict");
const { applyNameAliases, nameAliasesForSource } = require("../src/services/nameAliases");

test("uses confirmed Latin spellings for the title's Kana name variants", () => {
  const aliases = nameAliasesForSource({ videoId: "tt1528406:2:37" });
  assert.equal(applyNameAliases("待って、シャレル! シャルルも来た", aliases), "待って、Charle! Charleも来た");
  assert.equal(applyNameAliases("ウェンディーとエルザ", aliases), "WendyとErza");
});

test("does not apply title-specific names to unrelated content", () => {
  const aliases = nameAliasesForSource({ videoId: "tt0000000:1:1" });
  assert.equal(applyNameAliases("シャルル", aliases), "シャルル");
});

test("confirmed Kana alias does not replace a substring of a longer name", () => {
  const aliases = nameAliasesForSource({ videoId: "tt1528406:2:37" });
  assert.equal(applyNameAliases("シャルルマンとシャルルが来た", aliases), "シャルルマンとCharleが来た");
});
