# Gateway PT-AUTO para Stremio

Add-on local que agrega resultados de outros add-ons do Stremio, baixa torrents selecionados com qBittorrent e prepara legendas em português. Não exige Real-Debrid.

## Requisitos

- Windows com Docker Desktop aberto e usando contêineres Linux.
- Stremio instalado no mesmo computador.
- Espaço livre para armazenar os vídeos.

Use apenas conteúdos que você tem autorização para baixar e reproduzir.

## Iniciar

No PowerShell, dentro desta pasta:

```powershell
docker compose up -d --build
```

Confira se todos os serviços estão ativos:

```powershell
docker compose ps
```

Abra `http://localhost:7000/manifest.json` no navegador. Se aparecer um JSON, o gateway está respondendo.

No Stremio, instale o add-on usando:

```text
http://localhost:7000/manifest.json
```

## Usar no Stremio

1. Abra um filme ou episódio.
2. Escolha um resultado cujo nome começa com `PREPARAR`.
3. Esse primeiro clique inicia o download local. O Stremio pode mostrar uma falha temporária porque o arquivo ainda não está pronto.
4. Aguarde o download terminar e abra novamente a lista de streams.
5. No aplicativo para PC ou em aparelhos compatíveis, selecione `LOCAL` para reproduzir o arquivo original sem conversão.
6. No Stremio Web, iPhone ou aparelho que rejeite MKV/x265, selecione `WEB HLS`. O primeiro segmento é preparado pela GPU e a reprodução começa enquanto o restante é convertido.
7. Durante a preparação, o gateway prioriza legendas dentro do próprio arquivo: texto PT-BR, texto em outro idioma e PGS por OCR. Somente quando nenhuma delas existe ele transcreve o áudio com Whisper `large-v3`.
8. Ao escolher um episódio de série, o gateway prepara em segundo plano os quatro seguintes. Pacotes de temporada reutilizam exatamente o mesmo torrent; para torrents individuais, a busca mantém o mesmo add-on, grupo, resolução, codec e tipo de release sempre que possível.

O episódio escolhido usa prioridade alta. Os episódios antecipados usam prioridade baixa e não são enfileirados novamente quando vídeo e legenda já estão prontos. Quando você abre o episódio seguinte, a janela avança e um novo episódio é acrescentado ao final.

Os vídeos ficam em `storage/media`. O limite padrão de armazenamento é 100 GB e pode ser alterado com `MAX_STORAGE_GB` no `.env`.

## Acompanhar o progresso

```powershell
docker compose logs -f media-worker qbittorrent
```

Use `Ctrl+C` para sair dos logs; os serviços continuam ativos.

Para verificar somente o gateway:

```powershell
Invoke-RestMethod http://localhost:7000/healthz
```

## Gerenciador web

Abra `http://localhost:7000/manager/` no computador do servidor ou
`https://addon.asyncsystems.com.br/manager/` por meio do túnel Cloudflare.

O acesso usa o valor de `ADMIN_TOKEN` do arquivo `.env`. O token fica somente
na sessão do navegador e não é incluído no HTML nem salvo permanentemente.

No painel é possível:

- acompanhar séries, temporadas, episódios, downloads e espaço ocupado;
- escolher de 0 a 12 próximos episódios para preparação automática;
- baixar a legenda original ou a versão PT-BR;
- ver origem, idioma detectado, tradutor, alinhamento e validação da legenda;
- recriar uma legenda com falha ou que precise ser refeita;
- apagar um episódio ou um título, preservando arquivos ainda usados por outra fonte;
- filtrar e copiar logs do gateway e do worker.

## Parar e iniciar novamente

```powershell
docker compose stop
docker compose start
```

Para aplicar alterações no `.env` ou atualizar as imagens:

```powershell
docker compose up -d --build
```

## Configuração

As principais opções estão em `.env.example`:

- `UPSTREAM_ADDONS`: add-ons consultados para obter streams.
- `MAX_STORAGE_GB`: limite de espaço reservado aos downloads.
- `TORRENT_METADATA_TIMEOUT_SECONDS`: tempo máximo para obter os metadados do torrent.
- `TORRENT_DOWNLOAD_TIMEOUT_MINUTES`: tempo máximo de uma preparação.
- `SUBTITLE_TOKEN_SECRET` e `ADMIN_TOKEN`: segredos locais; gere valores diferentes e não os publique.
- `BASE_URL`: use `http://localhost:7000` quando o Stremio estiver no mesmo computador.
- `HLS_VIDEO_BITRATE_KBPS` e `HLS_MAX_HEIGHT`: qualidade máxima da opção compatível com navegador.
- `HLS_CACHE_MAX_AGE_HOURS`: tempo de retenção dos segmentos HLS gerados.
- `SERIES_PREFETCH_ENABLED`: ativa a preparação antecipada de séries.
- `SERIES_PREFETCH_AHEAD`: quantidade seguinte à atual; o padrão `4` mantém uma janela total de cinco episódios.
- `SERIES_PREFETCH_PRIORITY`: prioridade inferior usada pelos trabalhos antecipados.
- `CINEMETA_URL`: catálogo utilizado para atravessar corretamente episódios e finais de temporada.

O qBittorrent WebUI não é publicado para o Windows: ele fica acessível apenas entre os contêineres. A porta 6881 TCP/UDP é usada para os pares torrent.

## Componentes

- Gateway Node.js/Express na porta 7000.
- Worker BullMQ para download, extração, transcrição e tradução.
- qBittorrent-nox para armazenamento local.
- Redis para fila e estado.
- Ollama com Google TranslateGemma 12B para tradução especializada em PT-BR. As falas são enviadas em blocos contextuais com identificadores imutáveis, e qualquer omissão ou alteração estrutural rejeita o resultado antes da publicação.
- LibreTranslate permanece apenas como fallback opcional e vem desativado para impedir publicação silenciosa de tradução literal.
- Tesseract/Suptext para OCR de legendas PGS embutidas.
- faster-whisper `large-v3` na GPU para transcrição de último recurso.
- FFmpeg com NVENC para HLS H.264/AAC compatível com navegadores, com fallback para CPU.

O worker só publica uma legenda depois de validar quantidade de falas, IDs, marcações de tempo, sobreposições e durações anormais. Resultados parciais de OCR possuem marcador atômico de conclusão e nunca são reutilizados como se estivessem completos.

Consulte [PROJECT_DOCUMENTATION.md](./PROJECT_DOCUMENTATION.md) para a arquitetura e os requisitos completos.
