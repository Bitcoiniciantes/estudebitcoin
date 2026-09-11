# painelativos.md — Memória do Painel de Carteira (EstudeBitcoin)

> FASE 1: painel LOCAL, sem backend, sem login, sem cotação automática.
> Implantado SOMENTE em `index.html`, acima do `<!-- FOOTER -->`.
> Não alterar `indexsemalavancagem.html` nem módulos existentes.

## 1. Objetivo

Painel pessoal de acompanhamento de patrimônio (CRYPTO + STOCK):
QUANTO TENHO? → ONDE ESTÁ ALOCADO? → COMO ESTÁ O DESEMPENHO?
Não é trading, não é corretora. É acompanhamento de alocação e desempenho.

## 2. Arquitetura (FASE 1)

```
UI (painel-ativos-ui.js)
  ↓ chama apenas
PortfolioService (CRUD, validação, sort, filter)
  ↓ usa
PortfolioCalculator (PURO — não conhece type, storage, DOM ou API)
PriceProvider (stub FASE 1 → null; futuro: getCurrentPrice/getDailyVariation)
  ↓ persiste via
StorageAdapter → portfolioStorage (ÚNICO ponto com localStorage)
```

Regras invioláveis da FASE 1:

- `portfolioCalculator.js` NÃO conhece `type`, `ticker`, storage, DOM ou API.
  Entrada: `{ quantity, averagePrice, currentPrice, dailyVariation }` e arrays numéricos.
- UI NÃO toca `localStorage` diretamente. Só via `PortfolioService` → `portfolioStorage`.
- `PortfolioService` NÃO toca `localStorage` diretamente. Só via adapter injetado.
- Sem backend, sem login, sem Firebase, sem fetch obrigatório. Offline-first.
- Donut em SVG vanilla, zero dependências.

## 3. Estrutura de arquivos

```
assets/css/painel-ativos.css                  # dark escopado em #painel-ativos
assets/js/portfolio/portfolioCalculator.js    # puro, UMD (browser + Node)
assets/js/portfolio/portfolioStorage.js       # LocalPortfolioStorage, chave eb_portfolio_v2 (USD)
assets/js/portfolio/priceProvider.js          # stub FASE 1
assets/js/portfolio/portfolioService.js       # regras + validação + sort/filter
assets/js/portfolio/portfolioDemo.js          # demo USD BTC/ETH/AAPL/NVDA/MSFT, flag demo
assets/js/portfolio/painel-ativos-ui.js       # render + eventos + SVG donut
test-portfolio-calculator.mjs                 # 8 casos §22 (node --test)
```

Padrão UMD dos módulos: IIFE simples sem parâmetros; acesso a globais
somente via `globalThis` direto no ponto de uso (nunca via closure sobre
parâmetro do wrapper) + guarda `module.exports` para Node. Motivo: o
Chromium headless de QA não resolve parâmetro do wrapper dentro de função
aninhada (`global is not defined`, provado com página mínima isolada);
`globalThis` direto funciona em todos os ambientes. O service recebe o
storage por injeção (parâmetro próprio `createService(storage)`).

Donut: rótulos % no anel (fatias ≥ 4%), top 6 + agrupamento "Outros"
(cinza), legenda ponto + ticker + % à direita, centro N ATIVOS.

Merge DCA (sem bloqueio): adicionar ticker existente soma a quantidade e
recalcula o médio ponderado (`(qtd*e*médio_e + qtd*n*médio_n)/qtdTotal`);
preço atual e variação do dia sobrescrevem (cotação, não custo). Prévia ao
digitar + botão "Atualizar posição". `Editar` continua sobrescrevendo
(correção de digitação). Testes em `test-portfolio-merge.mjs`.

Includes em `index.html` (depois de `utils.js`, antes/depois dos demais, com `defer`
para os de UI; calculator/storage/service sem defer para garantir ordem):

```
assets/js/portfolio/portfolioCalculator.js
assets/js/portfolio/portfolioStorage.js
assets/js/portfolio/priceProvider.js
assets/js/portfolio/portfolioService.js
assets/js/portfolio/portfolioDemo.js
assets/js/portfolio/painel-ativos-ui.js (defer)
```

## 4. Modelo de dados (armazenado)

```json
{
  "version": 1,
  "portfolio": { "name": "Minha Carteira", "currency": "USD", "updatedAt": "ISO" },
  "assets": [
    { "id": "btc-001", "ticker": "BTC", "name": "Bitcoin", "type": "CRYPTO",
      "quantity": 0.5, "averagePrice": 300000, "currentPrice": 350000, "dailyVariation": 2.31 }
  ]
}
```

- `type`: `CRYPTO` | `STOCK` (normaliza `CRIPTO→CRYPTO`, `STOCKS→STOCK`).
- `ticker`: `trim().toUpperCase()`; unicidade case-insensitive (editar, não duplicar).
- Derivados (`valorInvestido`, `valorAtual`, `lucro`, `rent%`, `alocação%`) NUNCA
  persistidos — sempre recalculados.
- Chave atual: `eb_portfolio_v2` em USD (v1 era BRL, sem migração por
  magnitudes incompatíveis). Futura nuvem: `users/{uid}/panels/portfolio`.

## 5. Fórmulas (portfolioCalculator — sem arredondar dentro)

```
valorInvestido = qtd × precoMedio
valorAtual     = qtd × precoAtual
lucro          = valorAtual − valorInvestido
rent%          = investido>0 ? (atual/investido − 1)×100 : 0
alocação%_i    = totalAtual>0 ? atual_i/totalAtual×100 : 0   // Σ = 100%
varDia$        = Σ (atual_i × varDia%_i/100)
```

Rentabilidade total é ponderada (totais), NUNCA média de percentuais.
Formatação só na UI (`$ ` + pt-BR, `+x,xx%`). Guardas `Number.isFinite`.

## 6. Fluxo

Boot → `storage.load()` → vazio? demo + badge "exemplo" → `service.recalc()` →
render (cards, donut SVG, resumo, tabela). Formulário COLAPSADO por padrão
(botão "+ Adicionar ativo" no header); expande ao clicar, via CTA de vazio ou
via Editar; fecha em ✕/Cancelar/salvar-edição (após adicionar, permanece
aberto com campos limpos para lançamentos em sequência).
CRUD → valida → recalc → save → re-render + `updatedAt`. Filtros Todos/Cripto/Stocks refiltram tudo do mesmo estado.
Donut: segmentos por `valorAtual`; centro `N ATIVOS`/`$ TOTAL`; toggle
`Por ativo | Por categoria` (categoria = agregação por `type`).

Cotação automática (sem backend): `priceProvider` (Binance p/ crypto,
Stooq p/ stocks, com timeout + fallback silencioso). Ao digitar o ticker,
preenche preço atual + variação (médio é custo, sempre manual); edição
manual prevalece; botão ↻ força nova busca. Falha de rede = segue manual.

Regra anti-apagamento: entrar no modo remoto NUNCA substitui a visão local
por nuvem vazia — migração roda antes do primeiro load, e `refreshFromRemote`
recusa trocar estado com dados por vazio quando há `eb_portfolio_v2` pendente.

Sessão anônima sem duplicatas: `EstudeAuth.ensureAnonymous()` espera a
restauração da sessão (`awaitAuthReady`, primeiro `onAuthStateChanged`) antes
de decidir criar; trava entre abas via `eb_anon_claim`; UI só decide
remoto/local após `whenReady()`. `currentUid()` do adapter lê a sessão viva
do SDK, nunca só cache (evita writes em UID velho → permission-denied).

Identidade única por TICKER (não id interno): ids locais (`eth-xyz`) morrem
na transição local→nuvem e quebravam edit/del ("Ativo não encontrado").
Botões usam `data-ticker`, `findByTicker`/`update` aceitam id ou ticker,
exclusão de si mesmo considera ambos. Edição remota trava quantidade e
preço médio (derivados dos lots) com aviso; botão volta a "Salvar
alterações" em erro (nunca trava em "Salvando…").
Em modo VENDER a quantidade reabre (só o médio segue travado); o submit
vende mesmo dentro da edição, com prévia do saldo resultante.

Troca de conta com modo remoto recarrega sempre: o UID remoto vigente
(`remoteUid`) é comparado a cada `auth-change`; UID diferente refaz
migração-check + load (antes, tabela do UID velho + escritas no UID novo
davam "não existe"). Badge NUVEM mostra UID curto em tooltip.

Cache quente RTDB (bug vender/excluir): sem listener ativo, a 1ª invocação
do callback de `transaction()` recebe `current = null` e o abort vira
definitivo — venda/exclusão falhavam com "inexistente" mesmo com o dado no
servidor (compra funcionava por criar do zero). `warmup(uid)` anexa
`on('value')` noop ao entrar em remoto; `coolDown()` desanexa ao sair/
trocar de UID. `needsSync`: nuvem vazia + local com dados bloqueia
escritas com "Sincronizando carteira…" e retenta a migração (badge nunca
mente sobre a origem dos dados).

Retentativa real (2026-09-11): o `catch` de `maybeMigrate()` não resetava
nada — a flag `migratedThisSession` ficava `true` após a 1ª falha e a
"retentativa" do needsSync virava no-op até reload. Fix de 1 linha
(`= false` no catch, `painel-ativos-ui.js`) + hook `PainelAtivos.maybeMigrate`
(export mínimo só para testes) + `test-maybe-migrate-retry.mjs` (2 testes:
falha→2ª tentativa real; 5 falhas = 5 tentativas 1:1, sem loop).
Prova: com o fix desativado o teste 1 falha (`1 !== 2`); com o fix, passa.

Revisão de lifecycle (2026-09-11, sem alterações): concorrência goRemote ×
refresh é segura (flag setada de forma síncrona = mutex acidental — NÃO mover
o `= true` para dentro do `.then` sem guarda in-flight, senão duplica
`window.confirm` no `remote_exists`); leitura duplicada pós-migração existe
(2× `once`) mas foi aceita (barata, idempotente, remover exigiria mexer nos
3 chamadores); warmup verificado nos 4 pontos (aquece, desanexa em troca de
UID e ao sair, sem duplicatas, permission-denied async não quebra a UI);
needsSync cobre compra/venda/edição/exclusão e libera via refresh interno.

MELHORIA FUTURA: `migratedThisSession` é global, não vinculada ao UID. Uma
troca de conta (anônimo→Google) durante migração pendente pode correr com a
flag do UID anterior — condição rara, sem correção por ora.

FECHAMENTO (2026-09-11): 6 suítes verdes, 0 falhas — 2 retry + 15 RTDB +
6 merge + 9 calculator + 12 functions + 11 handlers. Painel funcional de
ponta a ponta (local + remoto RTDB custo zero). Pendente só do lado do
console: apagar anônimos órfãos + teste manual de 2 abas / troca de conta.

PREÇOS AO VIVO (2026-09-11, mesmo motor dos cards): o painel assina o evento
`estudebitcoin:ticker-price` que o ticker já despachava por tick do WebSocket
Binance. `ticker-widget.js` passou a incluir `changePct` (campo `P` do stream,
aditivo — 3 linhas, sem mudar comportamento do ticker). No painel
(`painel-ativos-ui.js`): listener normaliza o símbolo e casa com posições
CRYPTO; atualiza a linha cirurgicamente por tick (PREÇO ATUAL, VALOR, LUCRO,
%, HOJE) + re-render com throttle 2,5s para patrimônio/totais/donut/alocação.
Overlay em cópia (nunca muta o service); sem tick por 30s volta ao snapshot;
dot verde `.pa-live` marca linhas ao vivo. STOCKS agora atualizam também: o
refresh do ticker (5s) despacha `broadcastQuotes()` com o MESMO evento para
cryptos (preço inicial + fallback sem WS). Stocks: `fetchStocks()` só rodava
com a aba stocks ativa — loop próprio `refreshStocksBroadcast()` a cada 60s
(+ disparo no boot) emite as cotações independente da aba; só broadcast, sem
mexer nos cards (1 chamada ao Worker/min). `?v=20` no ticker. Ao vivo é VISÃO em
memória; o snapshot LOCAL acompanha via `persistLiveLocal()` (throttle 60s +
`pagehide`, só modo local) usando `replaceAllSilent`/`saveSnapshot`, que
PRESERVAM `portfolio.updatedAt` (carimbo é do usuário, não do preço). No modo
REMOTO não grava por tick — o RTDB sincroniza na próxima escrita.
Testes `test-live-prices.mjs` (5/5 no caminho real `window.dispatchEvent`:
tick crypto, tick stock, updatedAt preservado com storage real, remoto pula,
lixo não quebra). Total: 8 suítes, 61 testes, 0 falhas.

AUTOFILL STOCK NO FORMULÁRIO (2026-09-11): digitar o ticker preenchia preço+
variação para crypto (Binance) mas nada para STOCK (Stooq direto falhava no
navegador). `priceProvider` agora busca STOCK no Worker próprio
(`/api/quotes` — A MESMA fonte dos cards, inclui `name`), com fallback Stooq;
`getQuote` retorna `name` e a UI preenche o campo Nome quando vazio (nunca
sobrescreve o digitado). Testes `test-price-provider.mjs` (4/4: Worker+name,
fallback Stooq, falha total→null, crypto intacto). `?v=2` no priceProvider.
Total: 9 suítes, 65 testes, 0 falhas.

NOME EXATO NO AUTOFILL (2026-09-11): o Worker devolveu "Agilent" (ticker A)
para busca MSTR e o fallback `list[0]` aceitou quote de símbolo divergente.
`stockQuoteWorker` agora só aceita match EXATO (sem match → Stooq/manual).
Nome auto rastreado (`quoteAutoName`): trocar de ticker substitui o nome
anterior; nome digitado trava e nunca é sobrescrito. `?v=3` provider, `?v=4`
UI. Total: 9 suítes, 66 testes, 0 falhas.

SEED PADRÃO (2026-09-11, pedido do Joel): carteira vazia abre com 9 ativos
qtd 1 — BTC, ETH, LINK, AVAX (crypto) + MSTR, SI=F/PRATA, HG=F/COBRE,
BZ=F/BRENT, URNM (stocks, tickers iguais aos cards). Médio = atual (neutro;
o ao vivo assume em segundos com dot verde). Só afeta carteiras vazias
(`seedIfEmpty`); carteiras com dados não mudam. `?v=2` no demo.

DEPLOY PRODUÇÃO (2026-09-11, commit `33a8a85`): push main → Pages rebuildou;
conferido via fetch — UI `?v=4`, demo `?v=2`, ticker `?v=20`, provider `?v=3`
no ar. Validado em produção pelo Joel: seed planta os 9, dots verdes em
crypto e stocks, patrimônio acompanha. Escopo do commit: só painel
(portfolio + ticker broadcast + CSS + testes + bumps); auth/worker/docs de
outros workstreams ficaram fora, intocados.

PRIORIDADE WS > SNAPSHOT (2026-09-11, review Manus): o refresh HTTP de 5s
re-despachava candles e revertia tick WS mais novo (patrimônio flickerava,
persist podia carimbar valor velho). Evento agora carrega `source` —
`'websocket'` no `updateLivePrice`, `'snapshot'` no `broadcastQuotes` (mesmo
evento). Regra: WS válido sempre vence; snapshot ignorado se houver WS fresco
do ticker dentro do TTL (price+change juntos, sem tocar `at`); sem source =
snapshot (conservador). `live` agora `{price, change, at, source}`.
`clearLiveState()` em transição local↔remoto e troca de UID (nunca em refresh
da mesma carteira). Bind idempotente (`__PainelAtivosBound`: 1 listener, 1
interval, 1 pagehide). `replaceAllSilent` SEM fallback para `persist()` —
adapter sem `saveSnapshot` recebe erro `unsupported` (storage real tem).
Testes A–J no caminho real (`test-live-prices.mjs`, 11 testes). Total geral:
71 testes, 0 falhas. Sem commit/deploy.
FIM DO CAPÍTULO — painel funcional de ponta a ponta.
Correções pós-review (alvo do evento era `document` × `window`; updatedAt era
carimbado pelo snapshot): listener em `window`, `saveSnapshot`, `?v=19/3`.
Limitação conhecida: USDT-BRL exibe com `$` (moeda da linha é USD); validar
no navegador real (harness sem internet não executa os scripts da página).
## 7. Futura migração (NÃO implementar agora)

```
FASE 1: UI → Service → LocalPortfolioStorage (eb_portfolio_v1)
FUTURO: UI → Service → FirebasePortfolioStorage (users/{uid}/panels/portfolio)
```

Para migrar: criar adapter com mesma interface `load/save/clear` e injetar no
service. UI, calculator, filtros, ordenação, gráfico e tabela não mudam.
Seguir padrão existente `eb_panel_*` + eventos `estudebitcoin:panel-pull`.

## 8. Checklist de aceite (§23)

CRUD crypto/stock, editar, excluir, donut correto, Σ alocação 100%,
preço médio/atual, lucro, rent%, var. dia separada, totais, persistência
pós-refresh, offline, desktop/mobile, sem backend, storage substituível.
