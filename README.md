# Add-on RD + PT-AUTO (esqueleto)

Serviço inicial para um add-on do Stremio que faz proxy de streams do Real-Debrid e gera uma legenda externa "PT-AUTO". O worker extrai legendas de HLS (VTT), DASH simples (BaseURL) ou trilhas internas de MKV/MP4 via ffprobe/ffmpeg, traduz via LibreTranslate em batches e cacheia o VTT assinado.

## Stack
- Node.js + Express
- stremio-addon-sdk
- BullMQ + Redis (fila de jobs)
- LibreTranslate (tradução self-hosted, via Docker)
- ffprobe/ffmpeg (para extrair legendas de arquivos MKV/MP4)

## Como subir rápido (Docker Compose)
1. Copie o `.env.example` para `.env` e ajuste `BASE_URL` (endereço público do serviço) e `SUBTITLE_TOKEN_SECRET`.
2. `docker-compose up --build` (cria addon + Redis + LibreTranslate).
3. O serviço sobe em `http://localhost:7000/manifest.json`.

### Rodar sem Docker
- `npm install`
- `cp .env.example .env` e ajuste variáveis.
- `npm run start` (servidor) e, em outro terminal, `npm run worker` (worker da fila).

## Fluxo atual (esqueleto)
- `/manifest.json` expõe recursos `stream` e `subtitles` (tipos movie/series). Espera que o `id` venha com prefixo `rdpt` e que o `extra` da requisição contenha `rdUrl` (ou `url`) com o link real do RD.
- Handler de stream:
  - Deriva `videoKey` e enfileira um job de legenda.
  - Retorna um stream que aponta para `/proxy/stream?target=<url>`.
- Handler de legendas:
  - Enfileira o job (idempotente) e devolve um item `PT-AUTO` apontando para um arquivo VTT assinado.
  - Se ainda em processamento, devolve VTT placeholder; quando pronto, serve `pt-auto.vtt`.
- `/proxy/stream` faz pass-through com suporte a `Range` e sem logar a URL completa.
- `/assets/subtitles/:videoKey/:fileName?token=...` entrega o VTT se o token HMAC for válido.
- `/metrics` expõe contadores simples (jobs, falhas, cache hits, traduções).

## Variáveis de ambiente
Veja `.env.example`.
- `BASE_URL` precisa refletir o host público onde o Stremio acessa o add-on.
- `SUBTITLE_TOKEN_SECRET` deve ser um valor forte para assinar URLs de legendas.
- `TARGET_LOCALE` define `pt` ou `pt-BR`.
- `PREFERRED_SUB_LANGS` define prioridade de trilhas HLS (ex: `eng,en,spa,fra,ita`).
- `TRANSLATE_BATCH_CHARS` controla o tamanho máximo (chars) por batch de tradução para reduzir chamadas.

## Pontos pendentes (próximos passos sugeridos)
1. **DASH avançado**: suportar SegmentTemplate/SegmentBase em vez de apenas BaseURL simples.
2. **Metadados/cache**: mover hash/idioma para SQLite/Redis e evitar retradução entre reinícios.
3. **API do Stremio**: adaptar o `id`/`extra` para o formato real do Torrentio+RD (resolver `rdUrl` automaticamente).
4. **Observabilidade**: adicionar tempos (extração/tradução), gauge de filas e health de dependências.

## Exemplo de teste manual (placeholder)
Enquanto a extração/tradução real não está pronta, você pode testar o pipeline usando qualquer URL pública de vídeo:

```
curl "http://localhost:7000/proxy/stream?target=https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" -I
curl "http://localhost:7000/manifest.json"
```

Em produção, o Stremio deve chamar o handler com um `rdUrl` válido e então selecionar a legenda `PT-AUTO` no player.
