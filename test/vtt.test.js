const test = require("node:test");
const assert = require("node:assert/strict");
const { parseVtt, serializeVtt } = require("../src/services/vtt");

test("VTT round-trip preserves timestamps and cue count", () => {
  const input = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\nHello\nworld\n\n2\n00:00:03.000 --> 00:00:04.000 align:start\nAgain\n";
  const cues = parseVtt(input);
  assert.equal(cues.length, 2);
  const output = serializeVtt(cues.map((cue) => ({ ...cue, text: `PT:${cue.text}` })));
  const reparsed = parseVtt(output);
  assert.deepEqual(reparsed.map((cue) => cue.time), cues.map((cue) => cue.time));
  assert.equal(reparsed.length, cues.length);
});

test("does not mistake arrows in subtitle text for timestamps", () => {
  const input = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nPlano A --> Plano B\n\n2\n00:00:04.000 --> 00:00:05.000\nFim\n";
  const cues = parseVtt(input);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, "Plano A --> Plano B");
});
