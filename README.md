# Bitcoiniciantes IA

Worker da Cloudflare que oferece a primeira API do Analista IA do EstudeBitcoin.

## Rotas

- `GET /health` confirma que o Worker esta ativo.
- `POST /v1/analyze` recebe `asset`, `period`, `marketData` e `question` e devolve uma analise educativa em portugues (EstudeBitcoin).
- `POST /api/ai-analysis` recebe o payload tecnico do Termometro (com `localPreview`) e devolve um JSON estruturado (`headline`, `scenario`, `summary`, `strategy`, `risks`, `invalidation`).
- `GET /v1/news` e `GET /api/asset-news?asset=BTC` devolvem as 3 noticias mais relevantes do ativo na janela configurada (`NEWS_MAX_AGE_MS`, padrao 7 dias).

O Worker usa Gemini como provedor principal e Groq como reserva. Nenhuma chave de IA e armazenada no navegador ou no Git.

## Pipeline de noticias

Pipeline em fases; dentro de cada fase as fontes rodam em paralelo (`Promise.allSettled`):

1. **Regionais**: CriptoFacil (RSS geral, sempre consultado) + Cointelegraph (RSS por tag, quando o ativo tem tag). Se ja houver 3 noticias relevantes, retorna.
2. **Feeds gerais frescos** (paralelos): The Block, Decrypt, CoinDesk, InfoMoney, LiveCoins, Exame.
3. **Fontes de nicho por ativo** (`NICHE_SOURCES`): World Nuclear News + Investing News Network (uranio), Silver Doctors + GoldSilver.com + INN (prata/ouro), INN (cobre).
4. **Google News Brasil + Internacional** como ultimo recurso (em paralelo, costuma estar bloqueado pelo Cloudflare com HTTP 503).

Regras de resiliencia:

- **Timeout de 8s por fonte confiavel** (`NEWS_FETCH_TIMEOUT_MS`) via `AbortController`; feeds lentos de streaming precisam de mais tempo que 3s para nao virem truncados.
- **Google News com timeout curto de 3s** (ele pendura ~6,5s para responder 503 — timeout maior so aumentaria a latencia).
- Sem retry por fonte: a redundancia vem das varias fontes em paralelo.
- No caminho da analise (`/api/ai-analysis`), as noticias sao limitadas a 5s (`Promise.race`) para a resposta nunca estourar o timeout do navegador.
- **Cache no Worker** (`caches.default`) por ativo, TTL de 5 minutos (`NEWS_CACHE_TTL_MS`), somente para resultados nao vazios, em `/api/asset-news` e `/v1/news`.
- Parse de ate 60 itens por feed (`parseRssItems`); filtro de relevancia por padrao do simbolo (com sinonimos em portugues: ouro/prata/cobre/uranio), janela maxima de 7 dias (`NEWS_MAX_AGE_MS`), bloqueio de noticias de baixa qualidade (casino, price prediction, betting etc.) e deduplicacao por titulo.

## Configuracao

- `GEMINI_MODEL` — modelo Gemini usado (atual: `gemini-3.5-flash-lite`).
- `GROQ_MODEL` — modelo Groq reserva (`llama-3.3-70b-versatile`).
- Segredos obrigatorios no painel da Cloudflare: `GEMINI_API_KEY` e `GROQ_API_KEY`.

## Publicacao

Depois de revisar e registrar o codigo no Git, publique este diretorio no Worker `bitcoiniciantes-ia`:

```bash
npx wrangler deploy
```

Atencao (Windows): o `wrangler deploy` pode publicar um bundle antigo se a pasta ja tiver sido usada antes (cache residual). Sempre copie `src/index.js` e `wrangler.toml` para uma pasta nova (ex.: `%TEMP%\opencode\bitcoiniciantes-ia-final`), remova o `.wrangler` local se houver, e rode o deploy de la. Confirme a "Current Version ID" depois.

No painel da Cloudflare, configure os segredos `GEMINI_API_KEY` e `GROQ_API_KEY`; eles nunca devem ser colocados no Git ou no codigo do site.
