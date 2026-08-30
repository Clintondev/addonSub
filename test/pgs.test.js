const test = require("node:test");
const assert = require("node:assert/strict");
const { applyPgsPositions, parsePgsPositions } = require("../src/services/pgs");

function pcsPacket({ pts = 90000, width = 1920, height = 1080, x = 400, y = 80 } = {}) {
  const data = Buffer.alloc(19);
  data.writeUInt16BE(width, 0); data.writeUInt16BE(height, 2); data[4] = 0x10;
  data.writeUInt16BE(1, 5); data[7] = 0x80; data[10] = 1;
  data.writeUInt16BE(1, 11); data[13] = 0; data[14] = 0; data.writeUInt16BE(x, 15); data.writeUInt16BE(y, 17);
  const packet = Buffer.alloc(13 + data.length);
  packet.write("PG", 0, "ascii"); packet.writeUInt32BE(pts, 2); packet.writeUInt32BE(pts, 6); packet[10] = 0x16; packet.writeUInt16BE(data.length, 11); data.copy(packet, 13);
  return packet;
}

test("reads PGS bitmap coordinates and moves top-positioned cues", () => {
  const events = parsePgsPositions(pcsPacket());
  assert.deepEqual(events, [{ at: 1, width: 1920, height: 1080, x: 400, y: 80 }]);
  const result = applyPgsPositions([{ time: "00:00:01.000 --> 00:00:03.000", text: "Credit-safe" }], events);
  assert.match(result[0].time, /line:7% position:50% align:center/);
});

test("leaves ordinary bottom subtitles at the player default", () => {
  const result = applyPgsPositions([{ time: "00:00:01.000 --> 00:00:03.000", text: "Bottom" }], parsePgsPositions(pcsPacket({ y: 900 })));
  assert.equal(result[0].time, "00:00:01.000 --> 00:00:03.000");
});
