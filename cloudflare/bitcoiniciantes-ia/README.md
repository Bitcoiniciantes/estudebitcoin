# Bitcoiniciantes IA

Worker da Cloudflare que oferece a primeira API do Analista IA do EstudeBitcoin.

## Rotas

- `GET /health` confirma que o Worker esta ativo.
- `POST /v1/analyze` recebe `asset`, `period`, `marketData` e `question` e devolve uma analise educativa em portugues (EstudeBitcoin).
- `POST /api/ai-analysis` recebe o payload tecnico do Termometro (com `localPreview`) e devolve um JSON estruturado (`headline`, `scenario`, `summary`, `strategy`, `risks`, `invalidation`).
- `GET /v1/news` e `GET /api/asset-news?asset=BTC` devolvem as 3 noticias mais relevantes do ativo nas ultimas 48 horas.

O Worker usa Gemini como provedor principal e Groq como reserva. Nenhuma chave de IA e armazenada no navegador ou no Git.

## Pipeline de noticias

Ordem das fontes (as mais confiaveis primeiro):

1. **CriptoFacil** (RSS geral, sempre consultado) + **Cointelegraph** (RSS por tag, quando o ativo tem tag).
2. **Google News Brasil** como fallback.
3. **Google News Internacional** como ultimo recurso.

Regras de resiliencia:

- **Timeout de 4s por fonte** (`NEWS_FETCH_TIMEOUT_MS`) via `AbortController`: fonte lenta (ex.: Google News) nao trava a resposta.
- Falhas de fonte sao ignoradas (`Promise.allSettled`); a resposta segue com o que tiver.
- **Cache no Worker** (`caches.default`) por ativo, TTL de 5 minutos (`NEWS_CACHE_TTL_MS`), para `/api/asset-news` e `/v1/news`.
- Filtro de relevancia por padrao do simbolo + bloqueio de noticias de baixa qualidade (casino, price prediction, betting etc.) e deduplicacao por titulo.

## Configuracao

- `GEMINI_MODEL` — modelo Gemini usado (atual: `gemini-3.5-flash-lite`).
- `GROQ_MODEL` — modelo Groq reserva (`llama-3.3-70b-versatile`).
- Segredos obrigatorios no painel da Cloudflare: `GEMINI_API_KEY` e `GROQ_API_KEY`.

## Publicacao

Depois de revisar e registrar o codigo no Git, publique este diretorio no Worker `bitcoiniciantes-ia`:

```bash
npx wrangler deploy
```

No painel da Cloudflare, configure os segredos `GEMINI_API_KEY` e `GROQ_API_KEY`; eles nunca devem ser colocados no Git ou no codigo do site.
