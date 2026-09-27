const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSubtitleProviders, normalizeSubdl, normalizeOpen, providerLanguage, safeDownloadUrl, opensubtitlesHash } = require("../src/services/subtitleProviders");
const settings = { enabled: true, subdlKey: "private-subdl", opensubtitlesKey: "private-open", opensubtitlesUsername: "user", opensubtitlesPassword: "private-password" };
const response = (data, status = 200, location = null) => ({ ok: status < 300, status, headers: { get: () => location }, body: { destroy() {} }, json: async () => data });

test("normalizes real SubDL Brazilian Portuguese spellings and codes", () => {
  for (const language of ["BR_PT", "pt-br", "brazillian portuguese", "brazillian-portuguese", "Brazilian Portuguese"]) assert.equal(providerLanguage(language), "pt-br");
});

test("SubDL season packs select only explicitly matching members", () => {
  const identity = { type: "series", imdbId: "tt1234", season: 2, episode: 3 };
  const data = { results: [{ imdb_id: "tt1234" }], subtitles: [{ full_season: true, lang: "English", unpack_files: [
    { season: 2, episode: 2, name: "Show.S02E02.srt", url: "/subtitle/wrong" },
    { season: 2, episode: 3, name: "Show.S02E03.srt", url: "/subtitle/right", file_n_id: "right" },
  ] }] };
  assert.deepEqual(normalizeSubdl(data, identity, "Show.S02E03.mkv").map((candidate) => candidate.id), ["right"]);
  assert.equal(normalizeSubdl({ ...data, results: [{ imdb_id: "tt9999" }] }, identity, "").length, 0);
});

test("OpenSubtitles verifies numeric IMDb ids, episode identity and full dialogue", () => {
  const identity = { type: "series", imdbId: "tt01234", season: 2, episode: 3 };
  const attributes = { language: "pt-br", feature_details: { parent_imdb_id: 1234, season_number: 2, episode_number: 3 }, files: [{ file_id: 123, file_name: "Show.srt" }] };
  assert.equal(normalizeOpen({ data: [{ attributes }] }, identity, "").length, 1);
  assert.equal(normalizeOpen({ data: [{ attributes: { ...attributes, foreign_parts_only: true } }] }, identity, "").length, 0);
  assert.equal(normalizeOpen({ data: [{ attributes }] }, { ...identity, episode: 4 }, "").length, 0);
});

test("provider errors redact secrets and quota failures stop repeat calls", async () => {
  let calls = 0;
  const client = createSubtitleProviders({ settings, request: async () => { calls++; return response({}, 429); } });
  await assert.rejects(client.account("subdl"), /HTTP 429/);
  await assert.rejects(client.account("subdl"), /temporariamente suspensas/);
  assert.equal(calls, 1);
  const broken = createSubtitleProviders({ settings, request: async () => { throw new Error(settings.subdlKey); } });
  await assert.rejects(broken.account("subdl"), (error) => !error.message.includes(settings.subdlKey));
});

test("API redirects never forward credentials to a different origin", async () => {
  let calls = 0;
  const client = createSubtitleProviders({ settings, request: async () => { calls++; return response({}, 301, "https://attacker.example/steal"); } });
  await assert.rejects(client.account("subdl"), /falha de comunicação/);
  assert.equal(calls, 1);
  assert.throws(() => safeDownloadUrl("http://127.0.0.1/", "subdl"));
  assert.throws(() => safeDownloadUrl("https://dl.subdl.com.attacker.example/file", "subdl"));
});

test("OpenSubtitles sends a consumer key plus a user token and coalesces login", async () => {
  let logins = 0;
  const client = createSubtitleProviders({ settings, request: async (url, options) => {
    assert.equal(options.headers["Api-Key"], settings.opensubtitlesKey);
    if (url.endsWith("/login")) { logins++; return response({ token: "user-token" }); }
    assert.equal(options.headers.Authorization, "Bearer user-token");
    return response({ data: { allowed_downloads: 20, remaining_downloads: 19 } });
  } });
  const results = await Promise.all([client.account("opensubtitles"), client.account("opensubtitles")]);
  assert.equal(logins, 1);
  assert.equal(results[0].remainingDownloads, 19);
});

test("moviehash uses first and last 64 KiB and file size, never torrent hash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subtitle-hash-"));
  try {
    const file = path.join(root, "video.mkv");
    fs.writeFileSync(file, Buffer.alloc(131072));
    assert.equal(opensubtitlesHash(file), "0000000000020000");
    fs.writeFileSync(file, Buffer.alloc(100));
    assert.equal(opensubtitlesHash(file), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
