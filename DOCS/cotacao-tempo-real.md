# Cotação em tempo real — Minha Carteira (`portfolioLive`)

> Implantado em produção: commit `3626d76` (`feat(carteira): motor independente
> de precos ao vivo (portfolioLive)`), 4 arquivos, 573 inserções, 0 deleções.
> Verificado no ar em `https://estudebitcoin.pages.dev` (JS + `index.html`).

## 1. Problema resolvido

Na tabela Minha Carteira, só os ativos com cards no ticker atualizavam em
tempo real (bolinha verde). Ativos sem card (`SLV`, `ASST`, `POL`, `BNB`,
`GEMI` etc.) ficavam congelados no último snapshot.

Causa raiz: a carteira não tinha motor próprio de preços — era só consumidora
do evento `estudebitcoin:ticker-price` emitido pelo `ticker-widget.js`, que
cobre apenas 8 cryptos + 24 stocks fixos. Qualquer ticker fora dessas listas
nunca recebia tick (`onTickerPrice` descarta símbolo sem broadcast).

## 2. Arquivos implantados

| Arquivo | Mudança |
|---|---|
| `assets/js/portfolio/portfolioLive.js` (novo, ~430 linhas) | Motor independente da carteira (seção 3) |
| `test-portfolio-live.mjs` (novo) | 17 testes de contrato e aceite (seção 4) |
| `assets/js/portfolio/painel-ativos-ui.js` (+1 linha) | Expõe `getService` em `window.PainelAtivos` — fonte do universo de tickers |
| `index.html` (+1 linha) | Include `<script defer src="assets/js/portfolio/portfolioLive.js?v=1">` |

Nenhum outro arquivo foi alterado por este pacote. Worker intocado, sem
dependência nova, sem chave, sem custo (APIs públicas gratuitas).

## 3. Como funciona o motor

Universo dinâmico lido de `PainelAtivos.getService().query()` (tickers e
`type` reais da carteira; fallback: `data-ticker` do DOM).

- **Crypto (`type=CRYPTO`, exceto `USDT-BRL`)** — 1 WebSocket Binance
  (`wss://stream.binance.com:9443/stream?streams={base}usdt@ticker/...`),
  montado com os tickers da carteira (`BNB→BNBUSDT`, `POL→POLUSDT`).
  Tick-a-tick → `detail.source='websocket'`. Reconexão com backoff
  exponencial 1s→30s + jitter 50–100%, zerado na 1ª mensagem válida.
  Aba oculta fecha o WS e para o polling; ao voltar, 1 `resync` reabre
  exatamente 1 conexão (nunca duplica: mesma chave + WS vivo = mantém).
- **Stocks + `USDT-BRL`** — batch `GET /api/quotes?assets=…&window=24h`
  (mesmo Worker dos cards) a cada 60s, chunks de 20, match exato de símbolo.
  → `detail.source='snapshot'`.
- **Fallback crypto REST** — Binance `24hr?symbol={PAR}` quando o WS está
  fora (só então; prioridade WS>snapshot do leitor continua valendo).
- **Contrato de evento** (idêntico ao que `onTickerPrice` lê):
  `detail: { symbol, price, changePct, source }` — `symbol` em ticker puro
  (`BNB`, não `BNBUSDT`; o `normEv` do leitor faz strip de `USDT$`),
  chave **`changePct`** (nunca `change24h`), `source` conforme origem.
  Símbolo desconhecido/erro → não emite (linha mantém último preço, sem dot).
- **`resync()` com debounce ~1s** — rajada de add/edit/delete dispara 1
  `tick` (1 batch Worker), e todas as chamadas recebem o mesmo resultado.
- TTL do dot, pintura cirúrgica da linha, throttle de re-render (2,5s) e
  persistência do snapshot (60s + `pagehide`, só modo local): inalterados,
  herdados do pipeline existente.

## 4. Testes

`node tests/test-portfolio-live.mjs` → **17/17 PASS**:
contrato (`changePct`, symbol puro), `SLV`/`MSTR` via Worker, `BNB` via
Binance, `GEMI` ausente sem dispatch, `price>0`, backoff+jitter+teto 30s,
reset após mensagem válida, WS abre/fecha/reabre 1×, debounce
(5 `resync()` = 1 batch Worker).

Regressão na implantação: `test-price-provider.mjs` 5/5,
`test-live-prices.mjs` 13/13.

## 5. Fora do escopo (não implantado)

- Suporte Bovespa `.SA` e resumo multi-moeda (tirinha BRL/USD): apenas
  inspecionados, sem nenhuma alteração de código.
