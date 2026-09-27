const { createSubtitleProviders } = require("../src/services/subtitleProviders");

async function main() {
  const providers = createSubtitleProviders();
  for (const provider of providers.configured()) {
    try {
      const result = await providers.account(provider);
      console.log(JSON.stringify({ provider, ok: result.ok,
        searchRemaining: result.usage?.search?.remaining ?? null,
        downloadsRemaining: result.usage?.downloads?.remaining ?? result.remainingDownloads ?? null,
        allowedDownloads: result.allowedDownloads ?? null }));
      if (process.argv.includes("--search") || process.argv.includes("--download")) {
        const candidates = await providers.search(provider, { type: "movie", videoId: "tt0133093" }, { language: "pt-br" });
        console.log(JSON.stringify({ provider, searchOk: true, candidates: candidates.length, sample: candidates.slice(0, 2).map(({ lang, release, score }) => ({ lang, release, score })) }));
        if (process.argv.includes("--download") && candidates.length) {
          const bytes = await providers.download(candidates[0]);
          console.log(JSON.stringify({ provider, downloadOk: true, bytes: bytes.length }));
        }
      }
    } catch (error) { console.log(JSON.stringify({ provider, ok: false, error: error.message })); process.exitCode = 1; }
  }
}
main().catch(() => { console.error("Falha ao verificar provedores de legendas"); process.exitCode = 1; });
