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
5. No aplicativo para PC ou em aparelhos compatíveis, selecione `LOCAL`. Quando a legenda está pronta, o gateway cria sem recodificação um MKV de reprodução que preserva o vídeo e todas as faixas de áudio, incorpora uma única legenda SRT chamada `Português (Brasil)` e a marca como padrão. O índice de navegação fica no início do arquivo e a mídia usa blocos curtos, próprios para leitura remota por intervalos, evitando buscas até o final do MKV durante a troca das falas. A versão SRT externa continua disponível como alternativa.
6. No Stremio Web, iPhone ou aparelho que rejeite MKV/x265, selecione `WEB HLS`. O primeiro segmento é preparado pela GPU e a reprodução começa enquanto o restante é convertido. O áudio padrão permanece dentro do vídeo em AAC, evitando silêncio em navegadores que não carregam uma playlist de áudio separada; os outros idiomas aparecem como alternativas no seletor. Para não depender do suporte inconsistente dos players web a WebVTT HLS, o PT-BR é aplicado à imagem durante a conversão H.264. O SRT externo continua disponível, e o modo `LOCAL` mantém a legenda selecionável.
7. Durante a preparação, o gateway prioriza legendas dentro do próprio arquivo: texto PT-BR, texto em outro idioma e PGS por OCR. Somente quando nenhuma delas existe ele transcreve o áudio com Whisper `large-v3`.
8. Ao escolher um episódio de série, o gateway prepara em segundo plano a quantidade de episódios seguintes configurada no gerenciador (de 0 a 12; o padrão é 0). Pacotes de temporada reutilizam exatamente o mesmo torrent; para torrents individuais, a busca mantém o mesmo add-on, grupo, resolução, codec e tipo de release sempre que possível.

O episódio escolhido usa prioridade alta. Os episódios antecipados usam prioridade baixa e não são enfileirados novamente quando vídeo e legenda já estão prontos. Quando você abre o episódio seguinte, a janela avança e novos episódios são acrescentados até manter a quantidade configurada. Com o valor 0, nenhum download antecipado é feito.

O rótulo `Vídeo pronto · PT-BR em preparação` significa que a mídia já pode ser reproduzida, mas a legenda ainda não deve aparecer no seletor. Abrir esse resultado coloca automaticamente a legenda na fila. Uma legenda só é reutilizada entre duas entradas quando ambas apontam para o mesmo arquivo físico, garantindo a mesma linha do tempo.

Os vídeos originais ficam em `storage/media`. Os MKVs preparados para reprodução local ficam em `storage/playback`; eles não alteram o arquivo original, mas ocupam aproximadamente mais uma cópia da mídia enquanto estiverem em uso. O limite padrão de armazenamento é 100 GB e pode ser alterado com `MAX_STORAGE_GB` no `.env`.

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

### Restringir o acesso remoto por IP

Para permitir que somente o seu IP público acesse o gateway pelo túnel, defina
no `.env`:

```text
ALLOWED_CLIENT_IPS=SEU_IP_PUBLICO
```

Também são aceitos vários endereços separados por vírgula e redes CIDR:

```text
ALLOWED_CLIENT_IPS=203.0.113.25,2001:db8:1234::/64
```

Se o provedor alterar seu IP público, atualize o `.env` e execute
`docker compose up -d` novamente. A porta 7000 fica vinculada somente a
`127.0.0.1`; acessos remotos chegam pelo Cloudflare Tunnel e são validados por
`CF-Connecting-IP`. O Stremio no computador do servidor continua autorizado.

No painel é possível:

- navegar separadamente por filmes e séries, com temporadas e episódios recolhíveis;
- selecionar um episódio, uma temporada inteira ou vários títulos ao mesmo tempo;
- iniciar downloads e a preparação da legenda diretamente pelo painel, sem abrir o Stremio;
- acompanhar separadamente o download do vídeo e o processamento da legenda;
- escolher de 0 a 12 próximos episódios para preparação automática;
- baixar a legenda original ou a versão PT-BR;
- ver se a legenda veio de texto, HLS/DASH, OCR de PGS ou transcrição de áudio, além de idioma, tradutor, formatos gerados, alinhamento e validação;
- recriar uma legenda com falha ou que precise ser refeita;
- apagar em lote os itens selecionados, um episódio isolado ou um título inteiro, preservando os demais;
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
- `ALLOWED_CLIENT_IPS`: IPs públicos ou redes CIDR autorizados; vazio desativa a restrição.
- `BASE_URL`: use `http://localhost:7000` quando o Stremio estiver no mesmo computador.
- `HLS_VIDEO_BITRATE_KBPS` e `HLS_MAX_HEIGHT`: qualidade máxima da opção compatível com navegador.
- `HLS_CACHE_MAX_AGE_HOURS`: tempo de retenção dos segmentos HLS gerados.
- `REMOTE_FETCH_TIMEOUT_SECONDS` e `REMOTE_FETCH_MAX_MB`: limites para recursos e redirecionamentos remotos.
- `GPU_LOCK_WAIT_SECONDS` e `GPU_LOCK_LEASE_SECONDS`: coordenam Whisper, tradução e NVENC.
- `SERIES_PREFETCH_ENABLED`: permite a preparação antecipada configurada pelo gerenciador e atualizada a cada reprodução.
- `SERIES_PREFETCH_AHEAD`: quantidade escolhida no gerenciador; o padrão `0` não baixa episódios automaticamente.
- `SERIES_PREFETCH_PRIORITY`: prioridade inferior usada pelos trabalhos antecipados.
- `CINEMETA_URL`: catálogo utilizado para atravessar corretamente episódios e finais de temporada.

O qBittorrent WebUI não é publicado para o Windows: ele fica acessível apenas entre os contêineres. A porta 6881 TCP/UDP é usada para os pares torrent.

## Componentes

- Gateway Node.js/Express na porta 7000.
- Worker BullMQ para download, extração, transcrição e tradução.
- qBittorrent-nox para armazenamento local.
- Redis para fila e estado.
- Ollama com Google TranslateGemma 12B para tradução especializada em PT-BR. As falas são enviadas em blocos contextuais com identificadores imutáveis, e qualquer omissão ou alteração estrutural rejeita o resultado antes da publicação.
- LibreTranslate faz a detecção de idioma; seu fallback de tradução literal vem desativado para impedir publicação silenciosa de uma tradução inferior.
- Tesseract/Suptext, com dados de inglês e português, para OCR de legendas PGS embutidas.
- faster-whisper `large-v3` na GPU para transcrição de último recurso.
- FFmpeg com NVENC para HLS H.264/AAC compatível com navegadores, com fallback para CPU.

O worker só publica uma legenda depois de validar quantidade de falas, IDs, marcações de tempo, sobreposições e durações anormais. Resultados parciais de OCR possuem marcador atômico de conclusão e nunca são reutilizados como se estivessem completos.

Consulte [PROJECT_DOCUMENTATION.md](./PROJECT_DOCUMENTATION.md) para o histórico e os requisitos conceituais. Quando houver divergência, este README e o código atual são as fontes operacionais.
