const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { fetchWithTimeout } = require("../src/utils/fetchWithTimeout");

test("times out while a service stalls after sending response headers", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("partial");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const response = await fetchWithTimeout(`http://127.0.0.1:${address.port}`, {}, 50);
    await assert.rejects(() => response.text(), /aborted|timeout/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
