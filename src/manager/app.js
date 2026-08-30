const state = { data: null, logs: [], view: "overview", filter: "all", level: "", search: "" };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
function token() { return sessionStorage.getItem("ptAutoAdminToken") || ""; }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  if (response.status === 401) { sessionStorage.removeItem("ptAutoAdminToken"); showAuth(); throw new Error("Token inválido"); }
  if (!response.ok) { let detail; try { detail = (await response.json()).error; } catch (_) {} throw new Error(detail || `Falha HTTP ${response.status}`); }
  return response.status === 204 ? null : response.json();
}
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const bytes = (value = 0) => { const units = ["B", "KB", "MB", "GB", "TB"]; let size = Number(value) || 0; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; } return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`; };
const ago = (value) => { if (!value) return "Nunca"; const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000); if (seconds < 60) return "agora"; if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`; if (seconds < 86400) return `há ${Math.floor(seconds / 3600)} h`; return `há ${Math.floor(seconds / 86400)} dias`; };
const episodeLabel = (episode) => episode.season == null ? "Filme" : `T${String(episode.season).padStart(2, "0")} E${String(episode.episode).padStart(2, "0")}`;
const statusText = { ready: "Pronto", acquiring: "Baixando", "prefetch-queued": "Na fila", translating: "Traduzindo", transcribing: "Transcrevendo", aligning: "Sincronizando", validating: "Validando", failed: "Falhou", pending: "Pendente", probing: "Analisando", contextualizing: "Contexto" };
function displayStatus(item) { return statusText[item.status] || item.status || "Descoberto"; }
function toast(message) { const element = $("#toast"); element.textContent = message; element.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove("show"), 2600); }
function showAuth() { $("#auth").hidden = false; $("#app").hidden = true; }
function showApp() { $("#auth").hidden = true; $("#app").hidden = false; }
async function load() {
  const [data, logData] = await Promise.all([api("/api/manager"), api("/api/logs?limit=500")]);
  state.data = data; state.logs = logData.logs; render();
}
function render() {
  const { shows, storage, recentErrors } = state.data;
  const episodes = shows.flatMap((show) => show.episodes.map((episode) => ({ ...episode, show })));
  const watching = shows.filter((show) => show.status === "watching");
  const ready = episodes.filter((episode) => episode.subtitle.status === "ready").length;
  const active = episodes.filter((episode) => !["ready", "failed", "pending"].includes(episode.status)).length;
  const usedPct = Math.min(100, Math.round(storage.usedBytes / storage.maxBytes * 100));
  $("#stats").innerHTML = [
    ["EM ANDAMENTO", watching.length, `${shows.length} títulos na biblioteca`, 100],
    ["EPISÓDIOS PRONTOS", ready, `${active} sendo preparados`, episodes.length ? ready / episodes.length * 100 : 0],
    ["ARMAZENAMENTO", bytes(storage.usedBytes), `${usedPct}% de ${bytes(storage.maxBytes)}`, usedPct],
    ["LEGENDAS", episodes.filter((e) => e.subtitle.hasFinal).length, "Português do Brasil", episodes.length ? ready / episodes.length * 100 : 0],
  ].map(([label, value, detail, percent]) => `<article class="stat"><p class="eyebrow">${label}</p><strong>${value}</strong><small>${detail}</small><div class="meter"><span style="width:${Math.max(2, percent)}%"></span></div></article>`).join("");
  $("#error-badge").textContent = recentErrors.length; $("#updated").textContent = `Atualizado ${ago(state.data.generatedAt)}`;
  renderContinue(watching.length ? watching : shows.slice(0, 3)); renderRecent(episodes); renderLibrary(); renderSubtitles(episodes); renderLogs();
}
function renderContinue(shows) {
  $("#continue-grid").innerHTML = shows.slice(0, 3).map((show) => {
    const current = show.episodes.find((episode) => episode.sourceId === show.currentSourceId) || show.episodes.at(-1);
    return `<article class="show-card" data-open-show="${esc(show.imdbId)}"><div class="poster" style="background-image:url('${esc(show.background || show.poster || "")}')"></div><p class="eyebrow">${esc(show.status === "watching" ? "ASSISTINDO" : "NA BIBLIOTECA")}</p><h3>${esc(show.title)}</h3><div class="show-meta"><span>${current ? episodeLabel(current) : "Sem episódio selecionado"}</span><span>·</span><span>${show.totals.ready} prontos</span><span class="pill ready">${show.prefetchAhead ?? 0} à frente</span></div></article>`;
  }).join("") || `<div class="empty">Abra uma série pelo Stremio para ela aparecer aqui.</div>`;
}
function renderRecent(episodes) {
  const recent = [...episodes].sort((a, b) => String(b.subtitle.updatedAt || b.refreshedAt || "").localeCompare(String(a.subtitle.updatedAt || a.refreshedAt || ""))).slice(0, 6);
  $("#recent-jobs").innerHTML = recent.map((item) => `<div class="job"><div><b>${esc(item.show.title)} · ${episodeLabel(item)}</b><small>${displayStatus(item)}${item.subtitle.provider ? ` · ${esc(item.subtitle.provider)}` : ""}</small></div><div class="progress"><span style="width:${item.progress || (item.subtitle.status === "ready" ? 100 : 2)}%"></span></div></div>`).join("") || `<div class="empty">Nenhuma preparação registrada.</div>`;
  $("#recent-errors").innerHTML = state.data.recentErrors.slice(0, 6).map((item) => `<div class="error-row"><div><b>${esc(item.message)}</b><small>${esc(item.meta?.error || item.meta?.sourceId || "")}</small></div><small>${ago(item.at)}</small></div>`).join("") || `<div class="empty">Nenhum erro recente.</div>`;
}
function mergedEpisodes(show) {
  const sources = new Map(show.episodes.map((item) => [item.videoId, item]));
  const catalog = (show.catalogEpisodes || []).map((item) => sources.get(item.id) || ({ ...item, videoId: item.id, sourceId: null, status: "not-downloaded", subtitle: { status: "pending" }, storage: { mediaBytes: 0, subtitleBytes: 0, hlsBytes: 0 } }));
  for (const item of show.episodes) if (!catalog.some((episode) => episode.videoId === item.videoId)) catalog.push(item);
  return catalog.sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
}
function renderLibrary() {
  const query = state.search.toLowerCase();
  const shows = state.data.shows.filter((show) => (state.filter === "all" || show.status === state.filter) && (!query || `${show.title} ${show.imdbId}`.toLowerCase().includes(query)));
  $("#library").innerHTML = shows.map((show) => {
    const episodes = mergedEpisodes(show); const seasons = [...new Set(episodes.map((episode) => episode.season).filter(Number.isFinite))];
    return `<article class="library-card" id="show-${esc(show.imdbId)}"><div class="show-row"><div class="cover" style="background-image:url('${esc(show.poster || "")}')"></div><div><p class="eyebrow">${show.type === "series" ? `${seasons.length} TEMPORADA${seasons.length === 1 ? "" : "S"}` : "FILME"}</p><h3>${esc(show.title)}</h3><span class="muted">${show.totals.ready} legendas prontas · ${bytes(show.totals.bytes)}</span></div><span class="pill ${show.status === "watching" ? "ready" : ""}">${esc(show.status || "biblioteca")}</span><div class="controls"><label>Baixar à frente<select data-prefetch="${esc(show.imdbId)}">${Array.from({ length: 13 }, (_, i) => `<option value="${i}" ${i === show.prefetchAhead ? "selected" : ""}>${i}</option>`).join("")}</select></label><button class="mini dangerous" data-delete-show="${esc(show.imdbId)}" data-title="${esc(show.title)}">Apagar título</button></div></div><div class="episodes">${episodes.map((episode) => episodeRow(show, episode)).join("")}</div></article>`;
  }).join("") || `<div class="empty">Nenhum título encontrado.</div>`;
}
function episodeRow(show, item) {
  const available = Boolean(item.sourceId); const total = (item.storage?.mediaBytes || 0) + (item.storage?.subtitleBytes || 0) + (item.storage?.hlsBytes || 0);
  return `<div class="episode-row"><span class="episode-id">${episodeLabel(item)}</span><div><b>${esc(item.title || item.filename || `Episódio ${item.episode || ""}`)}</b><small class="muted">${available ? esc(item.addonName || "Fonte encontrada") : "Ainda não preparado"}</small></div><span class="pill ${item.subtitle?.status === "ready" ? "ready" : ""}">${available ? displayStatus(item) : "Não baixado"}</span><span class="muted">${total ? bytes(total) : "—"}</span><div class="episode-actions">${available ? `<button class="mini" data-prepare="${item.sourceId}">${item.status === "failed" ? "Tentar de novo" : "Preparar"}</button><button class="mini dangerous" data-delete-source="${item.sourceId}" data-label="${episodeLabel(item)} de ${esc(show.title)}">Apagar</button>` : `<span class="muted">Será localizado automaticamente</span>`}</div></div>`;
}
function renderSubtitles(episodes) {
  const rows = episodes.filter((episode) => episode.subtitle.hasOriginal || episode.subtitle.hasFinal || episode.status === "failed");
  $("#subtitle-list").innerHTML = rows.map((item) => {
    const sub = item.subtitle; const quality = sub.finalQuality?.coverage ?? sub.finalQuality?.score ?? (sub.hasFinal ? "OK" : "—");
    return `<article class="subtitle-card"><div><p class="eyebrow">${episodeLabel(item)} · ${esc(item.show.title)}</p><h4>${esc(item.filename || item.videoId)}</h4><span class="pill ${sub.hasFinal ? "ready" : ""}">${sub.hasFinal ? "PT-BR pronta" : displayStatus(item)}</span></div><div><span class="detail-label">Origem</span><b>${esc(sub.origin || "Ainda não identificada")}</b><small class="muted">${esc(sub.languageDetected || sub.languageDeclared || "idioma pendente")}</small></div><div><span class="detail-label">Tradução</span><b>${esc(sub.translated === false ? "Original em português" : sub.provider || "Pendente")}</b><small class="muted">${sub.cues ? `${sub.cues} falas` : ""}</small></div><div><span class="detail-label">Sincronia e qualidade</span><b class="quality">${esc(quality)}</b><small class="muted">${sub.alignment ? `${sub.alignment.matchedCues ?? sub.alignment.coverage ?? ""} alinhados` : "Tempo original preservado"}</small></div><div class="episode-actions">${sub.hasOriginal ? `<button class="mini" data-download-sub="${item.sourceId}" data-kind="original">Original</button>` : ""}${sub.hasFinal ? `<button class="mini" data-download-sub="${item.sourceId}" data-kind="final">PT-BR</button>` : ""}<button class="mini" data-reprocess="${item.sourceId}">Recriar</button></div></article>`;
  }).join("") || `<div class="empty">Nenhuma legenda criada ainda.</div>`;
}
function renderLogs() {
  const logs = state.level ? state.logs.filter((item) => item.level === state.level) : state.logs;
  $("#logs").innerHTML = logs.map((item) => `<div class="log-row"><time>${new Date(item.at).toLocaleString("pt-BR")}</time><span class="level ${item.level}">${item.level.toUpperCase()}</span><div><b>${esc(item.message)}</b>${Object.keys(item.meta || {}).length ? `<div class="log-meta">${esc(JSON.stringify(item.meta, null, 2))}</div>` : ""}</div></div>`).join("") || `<div class="empty">Nenhum log neste filtro.</div>`;
}
function setView(view) { state.view = view; $$(".view").forEach((element) => element.classList.toggle("active", element.id === `${view}-view`)); $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view)); $("#view-title").textContent = { overview: "Visão geral", library: "Assistindo", subtitles: "Legendas", logs: "Erros e logs" }[view]; }
function confirmAction(title, text) { return new Promise((resolve) => { const dialog = $("#confirm-dialog"); $("#confirm-title").textContent = title; $("#confirm-text").textContent = text; dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }); dialog.showModal(); }); }
document.addEventListener("click", async (event) => {
  try {
    const nav = event.target.closest("[data-view]"); if (nav) return setView(nav.dataset.view);
    if (event.target.closest(".go-library")) return setView("library"); if (event.target.closest(".go-logs")) return setView("logs");
    const card = event.target.closest("[data-open-show]"); if (card) { setView("library"); setTimeout(() => $(`#show-${CSS.escape(card.dataset.openShow)}`)?.scrollIntoView({ behavior: "smooth" }), 20); return; }
    const prepare = event.target.closest("[data-prepare]"); if (prepare) { await api(`/api/sources/${prepare.dataset.prepare}/prepare`, { method: "POST" }); toast("Preparação colocada no início da fila"); return load(); }
    const reprocess = event.target.closest("[data-reprocess]"); if (reprocess) { if (!await confirmAction("Recriar esta legenda?", "A versão PT-BR atual será substituída por uma nova execução completa.")) return; await api(`/api/sources/${reprocess.dataset.reprocess}/reprocess`, { method: "POST" }); toast("Legenda enviada para recriação"); return load(); }
    const deleteSource = event.target.closest("[data-delete-source]"); if (deleteSource) { if (!await confirmAction("Apagar este episódio?", `${deleteSource.dataset.label}. O vídeo, HLS e legendas locais serão removidos. Outros episódios do mesmo pacote serão preservados.`)) return; await api(`/api/sources/${deleteSource.dataset.deleteSource}`, { method: "DELETE", body: "{}" }); toast("Episódio apagado"); return load(); }
    const deleteShow = event.target.closest("[data-delete-show]"); if (deleteShow) { if (!await confirmAction("Apagar todo o título?", `${deleteShow.dataset.title}: todos os vídeos, HLS e legendas locais deste título serão removidos.`)) return; await api(`/api/shows/${deleteShow.dataset.deleteShow}`, { method: "DELETE", body: "{}" }); toast("Conteúdo do título apagado"); return load(); }
    const download = event.target.closest("[data-download-sub]"); if (download) { const response = await fetch(`/api/sources/${download.dataset.downloadSub}/subtitles/${download.dataset.kind}`, { headers: { Authorization: `Bearer ${token()}` } }); if (!response.ok) return toast("Não foi possível baixar a legenda"); const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${download.dataset.downloadSub}-${download.dataset.kind}.vtt`; link.click(); URL.revokeObjectURL(link.href); }
  } catch (error) { toast(error.message); }
});
document.addEventListener("change", async (event) => { if (event.target.matches("[data-prefetch]")) { try { await api(`/api/shows/${event.target.dataset.prefetch}`, { method: "PATCH", body: JSON.stringify({ prefetchAhead: Number(event.target.value), status: "watching" }) }); toast(`${event.target.value} próximo(s) episódio(s) configurado(s)`); await load(); } catch (error) { toast(error.message); } } });
$("#login-form").addEventListener("submit", async (event) => { event.preventDefault(); sessionStorage.setItem("ptAutoAdminToken", $("#token").value.trim()); try { await load(); showApp(); } catch (error) { $("#login-error").textContent = error.message; } });
$("#logout").addEventListener("click", () => { sessionStorage.removeItem("ptAutoAdminToken"); showAuth(); });
$("#refresh").addEventListener("click", async () => { await load(); toast("Dados atualizados"); });
$("#search").addEventListener("input", (event) => { state.search = event.target.value; renderLibrary(); });
$$('[data-filter]').forEach((button) => button.addEventListener("click", () => { $$('[data-filter]').forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.filter = button.dataset.filter; renderLibrary(); }));
$$('[data-level]').forEach((button) => button.addEventListener("click", () => { $$('[data-level]').forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.level = button.dataset.level; renderLogs(); }));
$("#copy-logs").addEventListener("click", async () => { const visible = state.level ? state.logs.filter((item) => item.level === state.level) : state.logs; await navigator.clipboard.writeText(visible.map((item) => `${item.at} ${item.level.toUpperCase()} ${item.message} ${JSON.stringify(item.meta || {})}`).join("\n")); toast("Logs copiados"); });
if (token()) load().then(showApp).catch(showAuth); else showAuth();
