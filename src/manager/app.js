const state = { data: null, logs: [], view: "overview", filter: "all", kind: "all", level: "", search: "", selected: new Map(), batchBusy: false };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
function token() { return sessionStorage.getItem("ptAutoAdminToken") || ""; }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  if (response.status === 401) { sessionStorage.removeItem("ptAutoAdminToken"); showAuth(); throw new Error("Token inválido"); }
  if (!response.ok) { let body = {}; try { body = await response.json(); } catch (_) {} throw new Error(body.error || body.results?.find((item) => !item.ok)?.error || `Falha HTTP ${response.status}`); }
  return response.status === 204 ? null : response.json();
}
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const bytes = (value = 0) => { const units = ["B", "KB", "MB", "GB", "TB"]; let size = Number(value) || 0; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; } return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`; };
const ago = (value) => { if (!value) return "Nunca"; const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000); if (seconds < 60) return "agora"; if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`; if (seconds < 86400) return `há ${Math.floor(seconds / 3600)} h`; return `há ${Math.floor(seconds / 86400)} dias`; };
const episodeLabel = (episode) => episode.season == null ? "Filme" : `T${String(episode.season).padStart(2, "0")} E${String(episode.episode).padStart(2, "0")}`;
const statusText = { ready: "Pronto", recovered: "Recuperado", recovering: "Recuperando mídia", acquiring: "Baixando", downloading: "Baixando", queued: "Na fila", "prefetch-queued": "Na fila", translating: "Traduzindo", transcribing: "Transcrevendo", aligning: "Sincronizando", validating: "Validando", packaging: "Montando arquivo", failed: "Falhou", pending: "Aguardando", probing: "Analisando", contextualizing: "Analisando contexto", "not-started": "Não iniciado", "not-downloaded": "Não baixado" };
const routeText = { "already-target-language": "Legenda original já em português", "direct-original-language": "Tradução direta do idioma original", "direct-original-audio-transcription": "Tradução direta do áudio original", "intermediate-language-fallback": "Tradução por idioma intermediário", "source-language-unverified": "Idioma de origem não confirmado" };
const confidenceText = { high: "alta", medium: "média", low: "baixa", unknown: "não determinada" };
function displayStatus(item) { return statusText[item.status] || item.status || "Disponível"; }
function toast(message, duration = 3200) { const element = $("#toast"); element.textContent = message; element.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove("show"), duration); }
function showAuth() { $("#auth").hidden = false; $("#app").hidden = true; }
function showApp() { $("#auth").hidden = true; $("#app").hidden = false; }

async function load() {
  const [data, logData] = await Promise.all([api("/api/manager"), api("/api/logs?limit=500")]);
  state.data = data; state.logs = logData.logs; render();
}
function allEpisodes() { return state.data.shows.flatMap((show) => show.episodes.map((episode) => ({ ...episode, show }))); }
function render() {
  const { shows, storage, recentErrors } = state.data; const episodes = allEpisodes();
  const watching = shows.filter((show) => show.status === "watching");
  const ready = episodes.filter((episode) => episode.subtitle.status === "ready").length;
  const active = episodes.filter((episode) => ["acquiring", "downloading", "queued", "prefetch-queued", "probing", "transcribing", "translating", "aligning", "validating", "packaging"].includes(episode.status)).length;
  const usedPct = Math.min(100, Math.round(storage.usedBytes / storage.maxBytes * 100));
  $("#stats").innerHTML = [
    ["TÍTULOS", shows.length, `${shows.filter((show) => show.type === "series").length} séries · ${shows.filter((show) => show.type === "movie").length} filmes`, 100],
    ["CONTEÚDO PRONTO", ready, `${active} em processamento`, episodes.length ? ready / episodes.length * 100 : 0],
    ["ARMAZENAMENTO", bytes(storage.usedBytes), `${usedPct}% de ${bytes(storage.maxBytes)}`, usedPct],
    ["LEGENDAS PT-BR", episodes.filter((episode) => episode.subtitle.hasFinal).length, "VTT, SRT e faixa interna", episodes.length ? ready / episodes.length * 100 : 0],
  ].map(([label, value, detail, percent]) => `<article class="stat"><p class="eyebrow">${label}</p><strong>${value}</strong><small>${detail}</small><div class="meter"><span style="width:${Math.max(2, percent)}%"></span></div></article>`).join("");
  $("#error-badge").textContent = recentErrors.length; $("#updated").textContent = `Atualizado ${ago(state.data.generatedAt)}`;
  renderContinue(watching.length ? watching : shows.slice(0, 3)); renderRecent(episodes); renderLibrary(); renderSubtitles(episodes); renderLogs();
}
function renderContinue(shows) {
  $("#continue-grid").innerHTML = shows.slice(0, 3).map((show) => { const current = show.episodes.find((episode) => episode.sourceId === show.currentSourceId) || show.episodes.at(-1); return `<article class="show-card" data-open-show="${esc(show.imdbId)}"><div class="poster" style="background-image:url('${esc(show.background || show.poster || "")}')"></div><p class="eyebrow">${esc(show.type === "movie" ? "FILME" : show.status === "watching" ? "ASSISTINDO" : "SÉRIE")}</p><h3>${esc(show.title)}</h3><div class="show-meta"><span>${current ? episodeLabel(current) : "Nenhum item preparado"}</span><span>·</span><span>${show.totals.ready} prontos</span></div></article>`; }).join("") || `<div class="empty">Prepare uma série ou filme para aparecer aqui.</div>`;
}
function renderRecent(episodes) {
  const recent = [...episodes].sort((a, b) => String(b.subtitle.updatedAt || b.refreshedAt || "").localeCompare(String(a.subtitle.updatedAt || a.refreshedAt || ""))).slice(0, 6);
  $("#recent-jobs").innerHTML = recent.map((item) => `<div class="job"><div><b>${esc(item.show.title)} · ${episodeLabel(item)}</b><small>${displayStatus(item)}${item.subtitle.provider ? ` · ${esc(item.subtitle.provider)}` : ""}</small></div><div class="progress"><span style="width:${item.progress || (item.subtitle.status === "ready" ? 100 : 2)}%"></span></div></div>`).join("") || `<div class="empty">Nenhuma preparação registrada.</div>`;
  $("#recent-errors").innerHTML = state.data.recentErrors.slice(0, 6).map((item) => `<div class="error-row"><div><b>${esc(item.message)}</b><small>${esc(item.meta?.error || item.meta?.sourceId || "")}</small></div><small>${ago(item.at)}</small></div>`).join("") || `<div class="empty">Nenhum erro recente.</div>`;
}
function mergedEpisodes(show) {
  const sources = new Map(show.episodes.map((item) => [item.videoId, item])); const blankStorage = { mediaBytes: 0, subtitleBytes: 0, hlsBytes: 0, playbackBytes: 0 };
  const catalog = (show.catalogEpisodes || []).map((item) => sources.get(item.id) || ({ ...item, videoId: item.id, sourceId: null, status: "not-downloaded", download: { status: "not-started", progress: 0 }, subtitle: { status: "pending", outputs: {} }, storage: blankStorage }));
  for (const item of show.episodes) if (!catalog.some((episode) => episode.videoId === item.videoId)) catalog.push(item);
  return catalog.sort((a, b) => (a.season || 0) - (b.season || 0) || (a.episode || 0) - (b.episode || 0));
}
function itemKey(show, item) { return `${show.type}|${item.videoId}`; }
function downloadView(item) {
  const download = item.download || { status: item.sourceId ? (item.storage?.mediaBytes ? "ready" : "not-started") : "not-started", progress: item.downloadProgress || 0 };
  const labels = { ready: "Vídeo pronto", downloading: `Baixando ${Math.round(download.progress || 0)}%`, queued: "Download na fila", failed: "Download falhou", "not-started": item.sourceId ? "Fonte disponível" : "Não baixado" };
  const tone = download.status === "ready" ? "ready" : download.status === "failed" ? "failed" : ["downloading", "queued"].includes(download.status) ? "working" : "";
  const detail = download.status === "downloading" ? `${bytes(download.downloadedBytes)} de ${bytes(download.totalBytes)}${download.speedBytes ? ` · ${bytes(download.speedBytes)}/s` : ""}` : item.storage?.mediaBytes ? bytes(item.storage.mediaBytes) : "Aguardando seleção";
  return { label: labels[download.status] || displayStatus(item), tone, detail, progress: download.progress || 0 };
}
function subtitleView(item) {
  const sub = item.subtitle || {};
  if (sub.status === "ready") { const outputs = [sub.outputs?.vtt && "VTT", sub.outputs?.srt && "SRT", sub.outputs?.embedded && "MKV interna"].filter(Boolean).join(" · "); return { label: "PT-BR pronta", tone: "ready", detail: `${sub.sourceMethod || sub.origin || "Legenda processada"}${outputs ? ` · ${outputs}` : ""}` }; }
  if (item.status === "failed") return { label: "Legenda falhou", tone: "failed", detail: item.error || "Consulte os logs" };
  if (["translating", "transcribing", "aligning", "validating", "probing", "contextualizing", "packaging"].includes(item.status)) return { label: displayStatus(item), tone: "working", detail: sub.sourceMethod || "Processamento em andamento" };
  return { label: "Legenda pendente", tone: "", detail: "Será extraída, transcrita ou traduzida" };
}
function renderLibrary() {
  const query = state.search.trim().toLowerCase();
  const shows = state.data.shows.filter((show) => { if (state.kind !== "all" && show.type !== state.kind) return false; if (state.filter !== "all" && show.status !== state.filter) return false; if (!query) return true; return `${show.title} ${show.imdbId} ${mergedEpisodes(show).map((item) => `${item.title || ""} ${item.filename || ""}`).join(" ")}`.toLowerCase().includes(query); });
  $("#library").innerHTML = shows.map(showBlock).join("") || `<div class="empty">Nenhum título encontrado com esses filtros.</div>`; updateBatchBar();
}
function showBlock(show) {
  const episodes = mergedEpisodes(show); const seasonNumbers = [...new Set(episodes.map((episode) => episode.season).filter(Number.isFinite))]; const current = episodes.find((episode) => episode.sourceId === show.currentSourceId);
  const groups = show.type === "movie" ? [[null, episodes]] : seasonNumbers.map((season) => [season, episodes.filter((episode) => episode.season === season)]); const selectedCount = episodes.filter((item) => state.selected.has(itemKey(show, item))).length;
  return `<details class="library-card" id="show-${esc(show.imdbId)}" ${state.search ? "open" : ""}><summary class="show-row"><label class="check-wrap" title="Selecionar todo o título"><input type="checkbox" data-select-scope="show" data-show="${esc(show.imdbId)}" ${selectedCount === episodes.length && episodes.length ? "checked" : ""}><span></span></label><div class="cover" style="background-image:url('${esc(show.poster || "")}')"></div><div class="show-title"><p class="eyebrow">${show.type === "series" ? `${seasonNumbers.length} TEMPORADA${seasonNumbers.length === 1 ? "" : "S"}` : "FILME"}</p><h3>${esc(show.title)}</h3><span class="muted">${episodes.length} ${show.type === "series" ? "episódios" : "item"} · ${show.totals.ready} legendas prontas · ${bytes(show.totals.bytes)}</span></div><div class="show-summary"><span class="summary-number">${episodes.filter((item) => item.download?.status === "ready").length}</span><small>vídeos prontos</small></div><span class="pill ${show.status === "watching" ? "ready" : ""}">${esc(show.status || "biblioteca")}</span><span class="chevron">⌄</span></summary><div class="show-body">${show.type === "series" ? `<div class="show-settings"><label>Preparação automática após o episódio atual<select data-prefetch="${esc(show.imdbId)}">${Array.from({ length: 13 }, (_, i) => `<option value="${i}" ${i === show.prefetchAhead ? "selected" : ""}>${i === 0 ? "Desativada" : `${i} à frente`}</option>`).join("")}</select></label><button class="mini dangerous" data-delete-show="${esc(show.imdbId)}" data-title="${esc(show.title)}">Apagar todo o título</button></div>` : `<div class="show-settings"><span class="muted">Gerencie o filme pelas ações abaixo.</span><button class="mini dangerous" data-delete-show="${esc(show.imdbId)}" data-title="${esc(show.title)}">Apagar filme</button></div>`}<div class="season-list">${groups.map(([season, items]) => seasonBlock(show, season, items, current)).join("")}</div></div></details>`;
}
function seasonBlock(show, season, items, current) {
  const ready = items.filter((item) => item.subtitle?.status === "ready").length; const active = items.filter((item) => ["acquiring", "queued", "translating", "transcribing", "aligning", "validating", "packaging"].includes(item.status)).length; const selected = items.filter((item) => state.selected.has(itemKey(show, item))).length; const open = show.type === "movie" || current?.season === season || state.search;
  return `<details class="season-block" ${open ? "open" : ""}><summary class="season-head"><label class="check-wrap"><input type="checkbox" data-select-scope="season" data-show="${esc(show.imdbId)}" data-season="${season ?? "movie"}" ${selected === items.length && items.length ? "checked" : ""}><span></span></label><div><b>${season == null ? "Filme" : `Temporada ${season}`}</b><small>${items.length} ${items.length === 1 ? "item" : "episódios"} · ${ready} prontos${active ? ` · ${active} em andamento` : ""}</small></div><span class="season-progress"><i style="width:${items.length ? ready / items.length * 100 : 0}%"></i></span><span class="chevron">⌄</span></summary><div class="episode-table"><div class="episode-columns"><span></span><span>Conteúdo</span><span>Download</span><span>Legenda</span><span>Ações</span></div>${items.map((item) => episodeRow(show, item)).join("")}</div></details>`;
}
function episodeRow(show, item) {
  const download = downloadView(item); const subtitle = subtitleView(item); const key = itemKey(show, item);
  return `<div class="episode-row"><label class="check-wrap"><input class="episode-select" type="checkbox" data-key="${esc(key)}" data-type="${esc(show.type)}" data-video-id="${esc(item.videoId)}" data-source-id="${esc(item.sourceId || "")}" data-show="${esc(show.imdbId)}" data-season="${item.season ?? "movie"}" ${state.selected.has(key) ? "checked" : ""}><span></span></label><div class="episode-main"><span class="episode-id">${episodeLabel(item)}</span><div><b>${esc(item.title || item.filename || (show.type === "movie" ? show.title : `Episódio ${item.episode || ""}`))}</b><small>${esc(item.filename || item.addonName || (item.sourceId ? "Fonte encontrada" : "Fonte será localizada ao preparar"))}</small></div></div><div class="state-cell"><span class="status-dot ${download.tone}"></span><div><b>${esc(download.label)}</b><small>${esc(download.detail)}</small>${download.progress > 0 && download.progress < 100 ? `<div class="row-progress"><i style="width:${download.progress}%"></i></div>` : ""}</div></div><div class="state-cell"><span class="status-dot ${subtitle.tone}"></span><div><b>${esc(subtitle.label)}</b><small title="${esc(subtitle.detail)}">${esc(subtitle.detail)}</small></div></div><div class="episode-actions"><button class="mini" data-prepare-item data-type="${esc(show.type)}" data-video-id="${esc(item.videoId)}" data-source-id="${esc(item.sourceId || "")}">${item.status === "failed" ? "Tentar novamente" : item.subtitle?.status === "ready" ? "Verificar" : "Preparar"}</button>${item.sourceId ? `<button class="mini dangerous" data-delete-source="${esc(item.sourceId)}" data-label="${episodeLabel(item)} de ${esc(show.title)}">Apagar</button>` : ""}</div></div>`;
}
function updateBatchBar() {
  const values = [...state.selected.values()]; const deletable = values.filter((item) => item.sourceId).length; $("#batch-bar").hidden = values.length === 0; $("#batch-count").textContent = `${values.length} ${values.length === 1 ? "item selecionado" : "itens selecionados"}`; $("#batch-detail").textContent = state.batchBusy ? "Localizando fontes e enviando para preparação…" : `${values.length} podem ser preparados · ${deletable} possuem arquivos ou tarefas para apagar`; $("#prepare-selected").disabled = state.batchBusy; $("#prepare-selected").textContent = state.batchBusy ? "Enviando…" : "Preparar selecionados"; $("#delete-selected").disabled = state.batchBusy || deletable === 0; $("#clear-selection").disabled = state.batchBusy;
}
function syncScopeCheckboxes(showId) {
  const showInputs = $$( `.episode-select[data-show="${CSS.escape(showId)}"]` );
  const showToggle = $(`[data-select-scope="show"][data-show="${CSS.escape(showId)}"]`);
  if (showToggle) { showToggle.checked = showInputs.length > 0 && showInputs.every((item) => item.checked); showToggle.indeterminate = showInputs.some((item) => item.checked) && !showToggle.checked; }
  const seasons = [...new Set(showInputs.map((item) => item.dataset.season))];
  seasons.forEach((season) => {
    const inputs = showInputs.filter((item) => item.dataset.season === season);
    const toggle = $(`[data-select-scope="season"][data-show="${CSS.escape(showId)}"][data-season="${CSS.escape(season)}"]`);
    if (toggle) { toggle.checked = inputs.length > 0 && inputs.every((item) => item.checked); toggle.indeterminate = inputs.some((item) => item.checked) && !toggle.checked; }
  });
}
function renderSubtitles(episodes) {
  const rows = episodes.filter((episode) => episode.subtitle.hasOriginal || episode.subtitle.hasFinal || episode.status === "failed");
  $("#subtitle-list").innerHTML = rows.map((item) => { const sub = item.subtitle; const quality = sub.finalQuality ? `${sub.finalQuality.cues || sub.cues || 0} falas · até ${sub.finalQuality.maxLineChars || 42} caracteres/linha` : (sub.hasFinal ? "Validada" : "Não concluída"); const alignment = sub.alignment ? `${sub.alignment.alignedCues || 0} falas alinhadas ao áudio` : "Tempos da fonte preservados"; const outputs = [sub.outputs?.vtt && "VTT", sub.outputs?.srt && "SRT", sub.outputs?.embedded && "Faixa interna no MKV"].filter(Boolean).join(" · ") || "Nenhuma saída final"; return `<article class="subtitle-card"><div><p class="eyebrow">${episodeLabel(item)} · ${esc(item.show.title)}</p><h4>${esc(item.filename || item.videoId)}</h4><span class="pill ${sub.hasFinal ? "ready" : "failed"}">${sub.hasFinal ? "PT-BR pronta" : displayStatus(item)}</span></div><div><span class="detail-label">Como foi obtida</span><b>${esc(sub.sourceMethod || sub.origin || "Não identificada")}</b><small class="muted">Legenda: ${esc(sub.translationSourceLanguage || sub.languageDetected || sub.languageDeclared || "pendente")} · Áudio de origem: ${esc(sub.sourceAudioLanguage || "não confirmado")} · confiança ${esc(confidenceText[sub.sourceAudioConfidence] || sub.sourceAudioConfidence || "não determinada")}</small></div><div><span class="detail-label">Como foi traduzida</span><b>${esc(sub.translated === false ? "Já estava em português" : sub.provider || "Pendente")}</b><small class="muted">${esc(routeText[sub.translationRoute] || sub.translationRoute || "Rota ainda não registrada")}${sub.cues ? ` · ${sub.cues} falas finais` : ""}</small></div><div><span class="detail-label">Formatos gerados</span><b>${esc(outputs)}</b><small class="muted">${esc(alignment)}</small></div><div><span class="detail-label">Validação</span><b class="quality">${esc(quality)}</b><small class="muted">Sincronia, fidelidade e até 2 linhas verificadas</small></div><div class="episode-actions">${sub.hasRawOriginal ? `<button class="mini" data-download-sub="${item.sourceId}" data-kind="raw">OCR bruto</button>` : ""}${sub.hasOriginal ? `<button class="mini" data-download-sub="${item.sourceId}" data-kind="original">Original saneado</button>` : ""}${sub.hasFinal ? `<button class="mini" data-download-sub="${item.sourceId}" data-kind="final">PT-BR</button>` : ""}<button class="mini" data-reprocess="${item.sourceId}">Recriar</button></div></article>`; }).join("") || `<div class="empty">Nenhuma legenda criada ainda.</div>`;
}
function renderLogs() { const logs = state.level ? state.logs.filter((item) => item.level === state.level) : state.logs; $("#logs").innerHTML = logs.map((item) => `<div class="log-row"><time>${new Date(item.at).toLocaleString("pt-BR")}</time><span class="level ${item.level}">${item.level.toUpperCase()}</span><div><b>${esc(item.message)}</b>${Object.keys(item.meta || {}).length ? `<div class="log-meta">${esc(JSON.stringify(item.meta, null, 2))}</div>` : ""}</div></div>`).join("") || `<div class="empty">Nenhum log neste filtro.</div>`; }
function setView(view) { state.view = view; $$(".view").forEach((element) => element.classList.toggle("active", element.id === `${view}-view`)); $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view)); $("#view-title").textContent = { overview: "Visão geral", library: "Biblioteca", subtitles: "Legendas", logs: "Erros e logs" }[view]; }
function confirmAction(title, text) { return new Promise((resolve) => { const dialog = $("#confirm-dialog"); $("#confirm-title").textContent = title; $("#confirm-text").textContent = text; dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }); dialog.showModal(); }); }
async function prepareItems(items) {
  if (state.batchBusy || !items.length) return;
  state.batchBusy = true; updateBatchBar(); toast("Localizando as melhores fontes…", 10000);
  try {
    const result = await api("/api/batch/prepare", { method: "POST", body: JSON.stringify({ items: items.map(({ type, videoId, sourceId }) => ({ type, videoId, sourceId })) }) });
    toast(`${result.prepared} ${result.prepared === 1 ? "item enviado" : "itens enviados"} para preparação${result.failed ? ` · ${result.failed} falharam` : ""}`, 5000); state.selected.clear(); await load();
  } finally { state.batchBusy = false; updateBatchBar(); }
}

document.addEventListener("click", async (event) => {
  try {
    if (event.target.matches("input[type=checkbox]")) event.stopPropagation();
    const nav = event.target.closest("[data-view]"); if (nav) return setView(nav.dataset.view);
    if (event.target.closest(".go-library")) return setView("library"); if (event.target.closest(".go-logs")) return setView("logs");
    const card = event.target.closest("[data-open-show]"); if (card) { setView("library"); setTimeout(() => { const target = $(`#show-${CSS.escape(card.dataset.openShow)}`); if (target) { target.open = true; target.scrollIntoView({ behavior: "smooth" }); } }, 20); return; }
    const prepare = event.target.closest("[data-prepare-item]"); if (prepare) return prepareItems([{ type: prepare.dataset.type, videoId: prepare.dataset.videoId, sourceId: prepare.dataset.sourceId || null }]);
    const reprocess = event.target.closest("[data-reprocess]"); if (reprocess) { if (!await confirmAction("Recriar esta legenda?", "A versão PT-BR atual será substituída por uma nova execução completa.")) return; await api(`/api/sources/${reprocess.dataset.reprocess}/reprocess`, { method: "POST" }); toast("Legenda enviada para recriação"); return load(); }
    const deleteSource = event.target.closest("[data-delete-source]"); if (deleteSource) { if (!await confirmAction("Apagar este item?", `${deleteSource.dataset.label}. Vídeo, HLS, reprodução local e legendas serão removidos.`)) return; await api(`/api/sources/${deleteSource.dataset.deleteSource}`, { method: "DELETE", body: "{}" }); toast("Item apagado"); return load(); }
    const deleteShow = event.target.closest("[data-delete-show]"); if (deleteShow) { if (!await confirmAction("Apagar todo o título?", `${deleteShow.dataset.title}: todos os vídeos e legendas preparados deste título serão removidos.`)) return; await api(`/api/shows/${deleteShow.dataset.deleteShow}`, { method: "DELETE", body: "{}" }); toast("Conteúdo do título apagado"); return load(); }
    const download = event.target.closest("[data-download-sub]"); if (download) { const response = await fetch(`/api/sources/${download.dataset.downloadSub}/subtitles/${download.dataset.kind}`, { headers: { Authorization: `Bearer ${token()}` } }); if (!response.ok) return toast("Não foi possível baixar a legenda"); const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${download.dataset.downloadSub}-${download.dataset.kind}.vtt`; link.click(); URL.revokeObjectURL(link.href); }
  } catch (error) { toast(error.message, 6000); }
});
document.addEventListener("change", async (event) => {
  try {
    if (event.target.matches(".episode-select")) { const input = event.target; if (input.checked) state.selected.set(input.dataset.key, { type: input.dataset.type, videoId: input.dataset.videoId, sourceId: input.dataset.sourceId || null }); else state.selected.delete(input.dataset.key); syncScopeCheckboxes(input.dataset.show); updateBatchBar(); return; }
    if (event.target.matches("[data-select-scope]")) { const input = event.target; const selector = input.dataset.selectScope === "show" ? `.episode-select[data-show="${CSS.escape(input.dataset.show)}"]` : `.episode-select[data-show="${CSS.escape(input.dataset.show)}"][data-season="${CSS.escape(input.dataset.season)}"]`; $$(selector).forEach((episodeInput) => { episodeInput.checked = input.checked; if (input.checked) state.selected.set(episodeInput.dataset.key, { type: episodeInput.dataset.type, videoId: episodeInput.dataset.videoId, sourceId: episodeInput.dataset.sourceId || null }); else state.selected.delete(episodeInput.dataset.key); }); syncScopeCheckboxes(input.dataset.show); updateBatchBar(); return; }
    if (event.target.matches("[data-prefetch]")) { await api(`/api/shows/${event.target.dataset.prefetch}`, { method: "PATCH", body: JSON.stringify({ prefetchAhead: Number(event.target.value), status: "watching" }) }); toast(event.target.value === "0" ? "Preparação automática desativada" : `${event.target.value} próximo(s) episódio(s) serão preparados`); await load(); }
  } catch (error) { toast(error.message, 6000); }
});
$("#prepare-selected").addEventListener("click", async () => { try { await prepareItems([...state.selected.values()]); } catch (error) { toast(error.message, 6000); } });
$("#delete-selected").addEventListener("click", async () => { try { const sourceIds = [...new Set([...state.selected.values()].map((item) => item.sourceId).filter(Boolean))]; if (!sourceIds.length) return toast("Nenhum item preparado foi selecionado para apagar"); if (!await confirmAction("Apagar itens selecionados?", `${sourceIds.length} item(ns) terão vídeo, HLS e legendas removidos. Os demais permanecerão intactos.`)) return; const result = await api("/api/batch/delete", { method: "POST", body: JSON.stringify({ sourceIds }) }); toast(`${result.deleted} ${result.deleted === 1 ? "item apagado" : "itens apagados"}${result.failed ? ` · ${result.failed} falharam` : ""}`, 5000); state.selected.clear(); await load(); } catch (error) { toast(error.message, 6000); } });
$("#clear-selection").addEventListener("click", () => { state.selected.clear(); renderLibrary(); });
$("#login-form").addEventListener("submit", async (event) => { event.preventDefault(); sessionStorage.setItem("ptAutoAdminToken", $("#token").value.trim()); try { await load(); showApp(); } catch (error) { $("#login-error").textContent = error.message; } });
$("#logout").addEventListener("click", () => { sessionStorage.removeItem("ptAutoAdminToken"); showAuth(); });
$("#refresh").addEventListener("click", async () => { await load(); toast("Dados atualizados"); });
$("#search").addEventListener("input", (event) => { state.search = event.target.value; renderLibrary(); });
$$('[data-filter]').forEach((button) => button.addEventListener("click", () => { $$('[data-filter]').forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.filter = button.dataset.filter; renderLibrary(); }));
$$('[data-library-kind]').forEach((button) => button.addEventListener("click", () => { $$('[data-library-kind]').forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.kind = button.dataset.libraryKind; renderLibrary(); }));
$$('[data-level]').forEach((button) => button.addEventListener("click", () => { $$('[data-level]').forEach((item) => item.classList.remove("active")); button.classList.add("active"); state.level = button.dataset.level; renderLogs(); }));
$("#copy-logs").addEventListener("click", async () => { const visible = state.level ? state.logs.filter((item) => item.level === state.level) : state.logs; await navigator.clipboard.writeText(visible.map((item) => `${item.at} ${item.level.toUpperCase()} ${item.message} ${JSON.stringify(item.meta || {})}`).join("\n")); toast("Logs copiados"); });
if (token()) load().then(showApp).catch(showAuth); else showAuth();
