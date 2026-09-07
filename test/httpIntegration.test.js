const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp } = require("../src/index");

function requestJson(server, pathname) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: pathname }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
  });
}

test("serves a valid Stremio manifest through the HTTP stack", async (t) => {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await requestJson(server, "/manifest.json");
  assert.equal(response.status, 200);
  assert.equal(response.body.id, "org.stremio.pt-auto.gateway");
  assert.deepEqual(response.body.idPrefixes, ["tt"]);
  assert.ok(response.body.resources.includes("stream"));
  assert.ok(response.body.resources.includes("subtitles"));
});
