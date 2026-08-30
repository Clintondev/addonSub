const test = require("node:test");
const assert = require("node:assert/strict");
const { cuePosition, vttCuesToAss } = require("../src/services/ass");

test("converts the original top PGS position into an absolute ASS position", () => {
  assert.equal(cuePosition("line:10% position:50% align:center"), "{\\an8\\pos(960,108)}");
});

test("keeps dialogue line breaks and emits timed ASS events", () => {
  const ass = vttCuesToAss([{
    time: "00:03:44.191 --> 00:03:47.365 line:10% position:50% align:center",
    text: "- Ele não vai levar isso bem.\n- Você pode culpá-lo? Ele é seu sobrinho.",
  }]);
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /Dialogue: 0,0:03:44\.19,0:03:47\.37/);
  assert.match(ass, /\{\\an8\\pos\(960,108\)\}- Ele não vai levar isso bem\.\\N- Você/);
});

test("leaves ordinary bottom captions on the default bottom-centre style", () => {
  assert.equal(cuePosition(""), "");
});
