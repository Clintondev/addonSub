const fs = require("fs");
const path = require("path");
const config = require("../config");
const { fetchWithTimeout } = require("../utils/fetchWithTimeout");
const { parseVideoId } = require("./videoId");
const { canonicalLanguage } = require("./languageStrategy");

const OPEN_API = "https://api.opensubtitles.com/api/v1";
const SUBDL_API = "https://api.subdl.com/api/v2";
const USER_AGENT = "addonSub v1.0.0";
const LANGUAGE_NAMES = { "brazilian portuguese": "pt-br", "portuguese (brazil)": "pt-br", portuguese: "pt", english: "en", spanish: "es", french: "fr", japanese: "ja", korean: "ko", italian: "it", german: "de" };

function providerLanguage(value) {
  const language = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (/^brazi(?:l|ll)ian[ -]portuguese$/.test(language)) return "pt-br";
  return LANGUAGE_NAMES[language] || canonicalLanguage(["br", "br-pt", "pt-br"].includes(language) ? "pt-br" : language);
}

function releaseScore(filename, releases) {
  const tokens = (value) => new Set(path.basename(String(value || "")).toLowerCase().replace(/\.(mkv|mp4|srt|ass|vtt|zip)$/g, "").split(/[^a-z0-9]+/).filter(Boolean));
  const wanted = tokens(filename);
  if (!wanted.size) return 0;
  return Math.max(0, ...releases.map((release) => {
    const found = tokens(release);
    const intersection = [...wanted].filter((item) => found.has(item)).length;
    return intersection / Math.max(wanted.size, found.size, 1);
  }));
}

function episodeMatches(item, identity) {
  if (identity.type !== "series") return true;
  // A season pack is accepted only through an explicitly identified member.
  return Number(item.season) === identity.season && Number(item.episode) === identity.episode;
}

function safeDownloadUrl(value, provider) {
  const url = new URL(value, provider === "subdl" ? "https://dl.subdl.com" : undefined);
  const allowed = provider === "subdl" ? ["dl.subdl.com", "api.subdl.com"] : ["www.opensubtitles.com", "dl.opensubtitles.com", "api.opensubtitles.com", "vip-api.opensubtitles.com"];
  if (url.protocol !== "https:" || url.username || url.password || !allowed.includes(url.hostname)) throw new Error("Provedor retornou endereço de download não permitido");
  return url.toString();
}

// The OpenSubtitles moviehash is different from a torrent's infoHash.
function opensubtitlesHash(file) {
  const stat = fs.statSync(file);
  if (stat.size < 131072) return null;
  const descriptor = fs.openSync(file, "r");
  let hash = BigInt(stat.size);
  try {
    for (const position of [0, stat.size - 65536]) {
      const bytes = Buffer.alloc(65536);
      if (fs.readSync(descriptor, bytes, 0, bytes.length, position) !== bytes.length) throw new Error("Leitura incompleta do hash de vídeo");
      for (let offset = 0; offset < bytes.length; offset += 8) hash = BigInt.asUintN(64, hash + bytes.readBigUInt64LE(offset));
    }
  } finally { fs.closeSync(descriptor); }
  return hash.toString(16).padStart(16, "0");
}

function normalizeSubdl(data, identity, filename) {
  const titles = data.results || [];
  if (!titles.some((item) => item.imdb_id === identity.imdbId)) return [];
  const output = [];
  for (const item of data.subtitles || []) {
    const members = item.unpack_files?.length ? item.unpack_files.map((member) => ({ ...item, ...member, full_season: false })) : [item];
    for (const member of members) {
      if (member.full_season || !episodeMatches(member, identity)) continue;
      const releases = [member.release_name, ...(Array.isArray(member.releases) ? member.releases : []), member.name].filter(Boolean).map(String);
      if (member.forced || /\b(signs[ ._-]*(?:and|&|\+)?[ ._-]*songs|songs[ ._-]*(?:and|&|\+)?[ ._-]*signs|forced|foreign[ ._-]*parts[ ._-]*only)\b/i.test(releases.join(" "))) continue;
      const url = safeDownloadUrl(member.url, "subdl");
      output.push({ provider: "subdl", id: String(member.file_n_id || member.n_id || member.sd_id || url.split("/").pop()),
        lang: providerLanguage(member.language || member.lang), release: releases[0] || "", fileName: member.name || member.release_name || "subtitle.srt",
        url, score: releaseScore(filename, releases), hearingImpaired: Boolean(member.hi), machineTranslated: Number(member.production_type) === 3 });
    }
  }
  return output;
}

function normalizeOpen(data, identity, filename) {
  const output = [];
  for (const item of data.data || []) {
    const a = item.attributes || {};
    const feature = a.feature_details || {};
    const imdb = String(identity.type === "series" ? feature.parent_imdb_id : feature.imdb_id).replace(/^tt/, "");
    if (Number(imdb) !== Number(identity.imdbId.slice(2)) || (identity.type === "series" && !episodeMatches({ season: feature.season_number, episode: feature.episode_number }, identity))) continue;
    if (a.foreign_parts_only) continue;
    for (const file of a.files || []) {
      if (!Number.isInteger(Number(file.file_id)) || Number(file.file_id) <= 0) continue;
      output.push({ provider: "opensubtitles", id: String(file.file_id), lang: providerLanguage(a.language), release: a.release || file.file_name || "",
        fileName: file.file_name || "subtitle.srt", score: a.moviehash_match ? 1 : releaseScore(filename, [a.release, file.file_name]),
        hashMatch: Boolean(a.moviehash_match), hearingImpaired: Boolean(a.hearing_impaired), machineTranslated: Boolean(a.machine_translated), aiTranslated: Boolean(a.ai_translated) });
    }
  }
  return output;
}

function createSubtitleProviders({ settings = config.externalSubtitles, request = fetchWithTimeout, downloadRequest = fetchWithTimeout, now = Date.now } = {}) {
  let token = null;
  let tokenExpires = 0;
  let loginPromise = null;
  const cooldowns = new Map();
  async function json(provider, url, options = {}) {
    if ((cooldowns.get(provider) || 0) > now()) throw new Error(`${provider}: consultas temporariamente suspensas`);
    try {
      let current = url;
      let response;
      for (let redirect = 0; redirect <= 3; redirect++) {
        response = await request(current, { ...options, redirect: "manual", size: 4 * 1024 * 1024 }, config.remoteFetchTimeoutMs);
        if (![301, 302, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        response.body?.destroy();
        if (redirect === 3 || !location || (options.method && options.method !== "GET")) throw new Error("redirect recusado");
        const target = new URL(location, current);
        if (target.origin !== new URL(url).origin || target.username || target.password) throw new Error("redirect recusado");
        current = target.toString();
      }
      if (!response.ok) {
        response.body?.destroy();
        if ([401, 403, 402, 429].includes(response.status)) cooldowns.set(provider, now() + (response.status === 429 ? 3600000 : 600000));
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      // Never propagate a node-fetch error or response body containing credentials.
      const status = /^HTTP \d+$/.test(error.message) ? error.message : "falha de comunicação ou resposta inválida";
      throw new Error(`${provider}: ${status}`);
    }
  }
  const subdlHeaders = () => ({ Authorization: `Bearer ${settings.subdlKey}`, Accept: "application/json" });
  const openHeaders = (authenticated = false) => ({ "Api-Key": settings.opensubtitlesKey, "User-Agent": USER_AGENT, Accept: "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) });
  async function login() {
    if (token && tokenExpires > now()) return;
    if (!settings.opensubtitlesUsername || !settings.opensubtitlesPassword) throw new Error("opensubtitles: usuário e senha não configurados");
    if (!loginPromise) loginPromise = (async () => {
      const data = await json("opensubtitles", `${OPEN_API}/login`, { method: "POST", headers: { ...openHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ username: settings.opensubtitlesUsername, password: settings.opensubtitlesPassword }) });
      if (typeof data.token !== "string" || !data.token) throw new Error("opensubtitles: login sem token");
      token = data.token;
      tokenExpires = now() + 12 * 3600000;
    })().finally(() => { loginPromise = null; });
    return loginPromise;
  }
  async function search(provider, source, { language, mediaPath } = {}) {
    const identity = parseVideoId(source.type, source.videoId);
    const filename = source.fileName || source.filename || path.basename(mediaPath || "");
    if (provider === "subdl") {
      const query = new URLSearchParams({ imdb_id: identity.imdbId, type: identity.type === "series" ? "tv" : "movie", languages: language, unpack: "1", subs_per_page: "30" });
      if (identity.type === "series") { query.set("season", String(identity.season)); query.set("episode", String(identity.episode)); }
      return normalizeSubdl(await json(provider, `${SUBDL_API}/subtitles/search?${query}`, { headers: subdlHeaders() }), identity, filename);
    }
    await login();
    const query = new URLSearchParams({ imdb_id: identity.imdbId.slice(2), languages: language, foreign_parts_only: "exclude", machine_translated: "exclude", ai_translated: "exclude", order_by: "download_count" });
    if (identity.type === "series") { query.set("parent_imdb_id", identity.imdbId.slice(2)); query.delete("imdb_id"); query.set("season_number", String(identity.season)); query.set("episode_number", String(identity.episode)); }
    if (mediaPath && fs.existsSync(mediaPath)) {
      const hash = opensubtitlesHash(mediaPath);
      if (hash) { query.set("moviehash", hash); query.set("moviehash_match", "include"); }
    }
    query.sort();
    return normalizeOpen(await json(provider, `${OPEN_API}/subtitles?${query}`, { headers: openHeaders(true) }), identity, filename);
  }
  async function download(candidate) {
    let url = candidate.url;
    if (candidate.provider === "opensubtitles") {
      await login();
      const data = await json("opensubtitles", `${OPEN_API}/download`, { method: "POST", headers: { ...openHeaders(true), "Content-Type": "application/json" }, body: JSON.stringify({ file_id: Number(candidate.id), sub_format: "srt" }) });
      url = data.link;
    }
    try {
      const response = await downloadRequest(safeDownloadUrl(url, candidate.provider), { redirect: "error", size: config.remoteFetchMaxBytes }, config.remoteFetchTimeoutMs);
      if (!response.ok) { response.body?.destroy(); throw new Error("download indisponível"); }
      return await response.buffer();
    } catch (_) { throw new Error(`${candidate.provider}: falha ao baixar a legenda`); }
  }
  async function account(provider) {
    if (provider === "subdl") {
      const data = await json(provider, `${SUBDL_API}/me`, { headers: subdlHeaders() });
      return { ok: true, usage: data.usage || null };
    }
    await login();
    const data = await json(provider, `${OPEN_API}/infos/user`, { headers: openHeaders(true) });
    const user = data.data || data;
    return { ok: true, allowedDownloads: user.allowed_downloads ?? null, remainingDownloads: user.remaining_downloads ?? null };
  }
  const configured = () => settings.enabled ? [settings.subdlKey && "subdl", settings.opensubtitlesKey && settings.opensubtitlesUsername && settings.opensubtitlesPassword && "opensubtitles"].filter(Boolean) : [];
  return { configured, search, download, account };
}

module.exports = { createSubtitleProviders, providerLanguage, releaseScore, episodeMatches, normalizeSubdl, normalizeOpen, opensubtitlesHash, safeDownloadUrl };
