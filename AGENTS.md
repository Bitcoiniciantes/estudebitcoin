# AGENTS.md — Contexto persistente para IA

> Este arquivo descreve a arquitetura REAL do sistema de alertas e push do EstudeBitcoin.
> Nao incluir chaves, tokens ou secrets — apenas a estrutura e decisoes tecnicas.

---

## 1. Arquitetura de alertas (arquivos reais)

### Client-side (browser)

| Arquivo | Responsabilidade |
|---|---|
| `assets/js/utils.js` | Utilidades compartilhadas incluindo `normalizeSymbol()` (trim + uppercase + remove USDT) |
| `assets/js/services/alertEngine.js` | Singleton global `window.AlertEngine`. Crossover S/R, cooldown 120s, beep (Web Audio), vibrate, CustomEvents `PriceAlertTriggered` / `PriceAlertDismissed`. Autoridade persistente por símbolo (config.source: GRAPH/TICKER). Normalização de símbolos em todos os métodos. Migração automática de dados antigos. |
| `assets/js/ticker-widget.js` | Alimenta AlertEngine com precos ao vivo via WebSocket Binance. Busca candles, calcula S/R via `window.DynamicSR`, renderiza sino e flash visual nos cards. Respeita autoridade USER_DEFINED (hasUserDefinedLevels). Normalização de símbolos. Push exclusivo para BTC. |
| `assets/js/chart/dynamicSR.js` | Calcula suporte/resistencia dinamicamente a partir de candles. Marca source=GRAPH ao ativar/recalcular. Normalização de símbolos. |
| `assets/js/conversor.js` | Gráfico de preços. getSRSymbol() retorna símbolo normalizado. |
| `assets/js/push-config.js` | Exporta `window.PushConfig` com `VAPID_PUBLIC_KEY` e `WORKER_URL` |
| `assets/js/push-subscribe.js` | Botao "Ativar alertas". `pushEnabled` = unica autoridade de ativacao/desativacao. Persiste em localStorage. `toggle()` liga/desliga. `subscribe()` cria push subscription + Worker ID. `unsubscribe()` chama `POST /unsubscribe?id=` no Worker. `syncToWorker()` sincroniza niveis S/R (throttle: dedup 0.1% + intervalo 5min por symbol). Exporta `window.PushSubscribe` |
| `sw.js` | Service Worker: recebe push, mostra notificacao, `notificationclick` foca ou abre janela |
| `manifest.json` | PWA manifest: `display: "standalone"` (obrigatorio para iOS push) |
| `index.html` | Registra SW, inclui scripts na ordem correta |

### Ordem de carregamento (index.html)

```
1. config.js → utils.js  (utils.js exporta normalizeSymbol)
2. services/alertEngine.js  (usa normalizeSymbol, deve ser antes do ticker)
3. chart/dynamicSR.js       (usa normalizeSymbol, deve ser antes do ticker)
4. ticker-widget.js          (usa normalizeSymbol, consome AlertEngine + DynamicSR)
5. push-config.js            (depois do ticker)
6. push-subscribe.js         (depois do config)
7. navigator.serviceWorker.register('/sw.js')
```

### Server-side (Cloudflare Worker)

| Arquivo | Responsabilidade |
|---|---|
| `alerta-worker/src/index.js` | Worker completo: HTTP API + Cron scheduled handler |
| `alerta-worker/wrangler.toml` | Config: KV binding, cron `* * * * *` (a cada 1 min), `nodejs_compat` flag |
| `alerta-worker/package.json` | Dependencia: `@block65/webcrypto-web-push` |

### Endpoints do Worker

| Rota | Metodo | Funcao |
|---|---|---|
| `/subscribe` | POST | Valida e salva subscription no KV (gera UUID) + atualiza `cron:index` |
| `/unsubscribe` | POST | Deleta subscription por `?id=` + remove de `cron:index` |
| `/alerts/sync` | POST | Salva alerta no KV + atualiza `cron:index` + atualiza `cron:states` se necessario |
| `/` | GET | Health check (retorna versao) |
| Cron `* * * * *` | scheduled | Le `cron:index` (1 GET), le alert configs + subs (N GETs), le `cron:states` (1 GET), busca preco MEXC, evalua crossover, envia push, escreve `cron:states` se mudou (0-1 PUT) |

### KV structure (Cloudflare `ALERTAS_KV`)

| Chave | Conteudo |
|---|---|
| `sub:{uuid}` | Subscription (endpoint + keys) — atualizado por `/subscribe` e `/unsubscribe` |
| `alert:{symbol}` | Config do alerta — **ID = symbol** (ex: `alert:BTC`, `alert:ETH`), nao UUID |
| `cron:index` | Indice de IDs: `{ alerts: ["BTC","ETH",...], subs: ["uuid1","uuid2",...] }` — atualizado SOMENTE em `/subscribe`, `/unsubscribe`, `/alerts/sync`. Cron faz GET direto (zero LIST) |
| `cron:states` | Estado consolidado de TODOS os alertas: `{ "BTC": { lastPrice, resistanceTriggered, ... }, "ETH": { ... } }` — 1 PUT condicional por ciclo (so se algo mudou) |

---

## 2. Decisoes tecnicas (Fases 0-5)

### Fase 0 — Conta Cloudflare
- Conta: `bitcoiniciantes@proton.me`
- Wrangler logado, Pages deployando `estudebitcoin.pages.dev`
- **Por que:** Workers para push, Pages para hosting estatica

### Fase 1 — Chaves VAPID
- Geradas com `npx web-push generate-vapid-keys`
- Publica em `assets/js/push-config.js` (seguro para cliente)
- Privada em `.env.vapid` (gitignored) e como Cloudflare Secret
- **Por que:** Chave privada nunca em codigo fonte, so via `wrangler secret put`

### Fase 2 — PWA
- `manifest.json` com `display: "standalone"` (obrigatorio iOS)
- `sw.js` com `skipWaiting()` + `clients.claim()` (ativacao imediata)
- Icones 192x192 e 512x512 gerados de `favicon.svg`
- **Por que:** iOS so suporta Web Push em PWA instalado (standalone)

### Fase 3 — Cliente push
- `push-subscribe.js`: permissao so em clique do usuario
- iPhone detection: `navigator.maxTouchPoints > 1` + `display-mode: standalone`
- Subscription salva em `localStorage` (backup) e enviada ao Worker
- **Por que:** Permissao automatica bloqueada no iOS; standalone check evita confusao

### Fase 4 — Worker
- `@block65/webcrypto-web-push` (nao `web-push` npm — nao funciona em Workers)
- `nodejs_compat` flag obrigatoria (biblioteca importa `node:crypto` como fallback)
- `buildPushPayload()` do `@block65/webcrypto-web-push` para criar payload Web Push
- CORS `Access-Control-Allow-Origin: *`
- **Por que:** Unica lib que funciona em Cloudflare Workers com Web Crypto API

### Fase 4.5 — Preco
- Binance bloqueia IPs de Cloudflare Workers (HTTP 403)
- Migrado para MEXC Spot API — oráculo único para crypto e BRL
- **Crypto:** API pública, sem chave, sem cache agressivo, preco em tempo real
- **BRL:** par USDCBRL na própria MEXC (elimina dependência de API externa)
- **PAXG:** renomeado para GOLD(PAXG)USDT na MEXC (Feb/2026)
- **Por que:** api.binance.com retorna 403; CoinGecko tem cache de 1-5 min (stale para multi-sample); AwesomeAPI retorna 429 de IPs de datacenter; MEXC nao bloqueia Workers e fornece todos os pares necessários

### Fase 5 — Sincronizacao Client→Worker
- `syncToWorker()` em `push-subscribe.js`: chama `POST /alerts/sync` quando niveis S/R mudam
- Chamado de `ticker-widget.js` apos `AlertEngine.setAlertLevels()`
- **Throttle:** dedup (so sync se support/resistance mudou > 0.1%) + intervalo minimo 5min por symbol
- **Payload:** `{ symbol, support, resistance, direction, lastPrice }`
- **ID do alerta:** `{symbol}` (ex: `alert:BTC`) — estavel entre syncs, preserva `cron:states`
- **Seed de state:** Worker cria estado em `cron:states` com `lastPrice` do client **apenas na primeira vez** (state nao existe). State existente e intocado — so o Cron atualiza
- **Por que:** ID estavel permite que o Cron preserva lastPrice/triggered entre atualizacoes de nivel

### Fase 5 — Teste real
- Push manual via `/test-push` (temporario, ja removido)
- Crossover via `/cron-test` (temporario, ja removido)
- Subscriptions com erro 400/410 sao auto-deletadas pelo handler
- **Por que:** Teste end-to-end necessario antes de ativar Cron em producao

### Fase 5.5 — Worker v3 (correcoes criticas)
- **Cron mudou de 5min para 1min** (`* * * * *`) — reduz janela cega
- **Multi-sample:** 3 leituras de preco por ciclo com 15s de intervalo — reduz (nao elimina) a janela cega entre ticks
- **Crossover direcional:** `crossedResistance(prev, curr, level)` = `prev < level && current >= level` (nao so "tocou o nivel")
- **Triggered separado:** `resistanceTriggered` e `supportTriggered` independentes — antes um unico `triggered` global impedia o segundo lado de disparar
- **Retry com pending:** se push falha, evento fica `pendingResistance`/`pendingSupport` e e reenviado em todo ciclo seguinte ate confirmacao. `triggered` so vira `true` apos 1+ push entregue
- **Rearme:** quando preco volta pra dentro da faixa, triggered reseta e alerta pode disparar de novo
- **Reset de state por levelsKey:** quando support/resistance/direction mudam, state e resetado com `freshState()` — historico do nivel antigo nao vaza pro novo
- **Reancoragem no oracle:** na mudanca de nivel, `lastPrice` fica `null` e e reancorado pelo proprio Cron (nao pelo `lastPrice` do client) — evita divergencia
- **Validacao:** support deve ser menor que resistance; precos NaN/Infinity sao rejeitados
- **Error handling:** `sendWebPush` lança erro em HTTP nao-ok; logs em cada etapa (fetch preco, push individual)
- **Por que:** v2 tinha bug critico — se push falhasse na hora do crossover, evento era perdido pra sempre. Multi-sample + retry + triggered direcional resolve os falsos negativos mais comuns

### Fase 5.7 — Worker v4 (oraculo unico MEXC)
- **Migracao de oracle:** removido mempool.space (BTC), CoinGecko (resto) e AwesomeAPI (BRL)
- **MEXC Spot API:** oraculo unico para crypto e BRL — 8 pares via `Promise.all()` paralelo
- **PAXG:** mapeado como `GOLD(PAXG)USDT` (renomeado na MEXC em Feb/2026)
- **BRL:** par `USDCBRL` na propria MEXC (elimina dependencia de API externa)
- **Por que:** CoinGecko tem cache de 1-5 min (stale para multi-sample); AwesomeAPI retorna 429 de IPs de datacenter; MEXC nao bloqueia Workers, API publica sem chave, preco em tempo real

### Fase 5.8 — Worker v6 (correcao de quota KV)
- **Causa raiz do bug "Erro ao ativar":** Worker v5 consumia ~11.570 writes/dia + 2.880 LIST/dia, estourando a cota free tier do Workers KV (1.000 writes/dia + 1.000 LIST/dia). O `/subscribe` falhava com `KV put() limit exceeded for the day`.
- **Cron: zero LIST.** Substituido por indice persistente `cron:index` contendo arrays `alerts[]` e `subs[]`. Cron faz 1 GET (index) em vez de 2 LIST por ciclo. Indice atualizado SOMENTE em `/subscribe`, `/unsubscribe`, `/alerts/sync`.
- **Estado consolidado.** Todos os estados de alertas em uma unica chave `cron:states` (JSON com chaves por symbol). 1 PUT condicional por ciclo vs 8+ PUTs antes.
- **Escrita condicional.** Compara campos de evento (triggered, pending, levelsKey) + lastPrice com threshold 0.1%. Ciclos onde nada muda NAO consomem writes.
- **Migracao automatica.** Chaves antigas `state:{symbol}` sao migradas para `cron:states` no primeiro ciclo. Indice vazio e populado via LIST uma unica vez.
- **Dead sub cleanup em batch.** `broadcastPush()` retorna `deadSubIds`; remocao do KV + index acontece uma vez no fim do ciclo, nao por alerta.
- **Consumo estimado (8 alertas, 3 subs):** ~18.720 reads/dia (18.7% de 100K) + ~0-1.440 writes/dia (vs 11.570 antes). LIST = 0/dia.
- **Por que:** Workers KV free tier tem 1.000 writes/dia e 1.000 LIST/dia. Cron a cada 1min com N alertas consumia cota em <2h. Indice + consolidacao + escrita condicional reduz consumo em ~99%.

---

## 3. Regras de seguranca (inviolaveis)

### VAPID Private Key
- **NUNCA** em codigo fonte, commits, mensagens, ou logs
- Armazenada como Cloudflare Secret: `wrangler secret put VAPID_PRIVATE_KEY`
- Local alternativo: `.env.vapid` (gitignored via regra `.env*`)
- Se vazada: gerar novas chaves com `npx web-push generate-vapid-keys`, atualizar publica em `push-config.js` e secret no Worker

### Endpoints de debug
- **NUNCA** deixar endpoints temporarios (`/test-push`, `/cron-test`, `/debug/*`) no codigo deployado
- Antes de commit, verificar `grep -r "TEMP\|test-push\|cron-test\|debug" alerta-worker/`
- Remover todo codigo marcado com `[TEMP]` ou `[TEMP TESTE]`

### O que NAO comprometer
- `.env.vapid` (chaves VAPID)
- `.wrangler/` (estado local do Wrangler)
- `node_modules/` em qualquer diretorio
- `alerta-worker/package-lock.json` (gerado, pode ser regenerado)

### Gitignore relevante
```
.wrangler/
*.zip
node_modules/
.env*
!.env.example
```

---

## 4. Notas para continuacao

### Arquitetura dual (client + server)
- O `alertEngine.js` (client) e o `scheduledHandler` (server) implementam **logica de crossover identica**
- Qualquer correcao de bug em uma deve ser aplicada na outra
- Client = alertas imediatos (usuario vendo o site)
- Server = alertas em background (PWA fechado/Cron)

### Problema de notificacao duplicada (PENDENTE — Fase 6)
- Com o PWA aberto e sino LIGADO, o `alertEngine.js` dispara som/vibracao imediatamente ao detectar crossover
- O Cron do Worker detecta o mesmo crossover (ate 1 minuto depois) e envia push
- Resultado: usuario recebe **duas** notificacoes para o mesmo evento
- **Estado atual:** sino controla AlertEngine (client) + push subscription (Worker). Sino OFF = ambos desativados.
- **Decisao de design:** NAO usar "esta online?" como criterio (online nao significa que o alerta ja disparou — client pode ter tick atrasado/falho)
- **Solucao planejada:** client envia `POST /alerts/ack` com `alertId` no momento exato em que o `alertEngine.js` dispara, marcando `state:{id}.acked = true` no KV. O Cron verifica esse campo antes de decidir enviar push — se `acked` for `true` para aquele ciclo, pula o push e reseta o flag
- **Por que:** ack explícito (evento ja tratado) e mais preciso que inferencia generica (usuario "online")

### Cron
- Roda a cada 1 minuto (`* * * * *`)
- **Leitura:** 1 GET `cron:index` + N GETs alert configs + N GETs subs + 1 GET `cron:states` = 2 + 2N reads
- **Escrita:** 0-1 PUT `cron:states` (condicional: so se triggered/pending/rearm/levelsKey mudou OU lastPrice variou > 0.1%)
- **Zero LIST** por ciclo (migrado para indice `cron:index`)
- Busca preco de MEXC (crypto + BRL via USDCBRL, Promise.all) — 3 amostras por ciclo (~15s entre leituras)
- Crossover direcional: verifica `prev < level && current >= level` (nao so toque no nivel)
- Rearme: quando preco volta pra dentro da faixa, triggered reseta e alerta pode disparar de novo
- Retry: eventos pendentes (push falhou) sao reenviados em todos os ciclos ate confirmacao
- Auto-limpa subscriptions mortas (HTTP 410, 404 ou 400) — batch no fim do ciclo

### iPhone/iOS
- Web Push so funciona em PWA instalado (standalone)
- `manifest.json` deve ter `display: "standalone"`
- `push-subscribe.js` detecta iOS e esconde botao se nao estiver standalone
- Notificacoes chegam mesmo com PWA em background

### Proximos passos (Fase 6+)

**Seguranca (urgente):**
- Restringir CORS: trocar `Access-Control-Allow-Origin: *` por `https://estudebitcoin.pages.dev`
- Rate limiting nos endpoints (`/subscribe`, `/unsubscribe`, `/alerts/sync`) — mesmo simples, tipo limite de 10 subscriptions por IP/dia
- Resolver notificacao duplicada client+Cron (ver "Problema de notificacao duplicada")

**Funcionalidade:**
- UI de gestao de alertas (criar/editar/excluir)
- Tipos de alerta alem de S/R (ex: % variacao, noticia)
- Testes em Android/Desktop

---

## 5. Histórico de Correções (Set 2026)

### Fase 7 — Normalização de Símbolos (2026-09-03)

**Data:** 2026-09-03  
**Commits:** `1dfca4b`, `a743b8c`

#### Problema Encontrado
BTC e BTCUSDT coexistiam como entidades diferentes no `AlertEngine.alerts` Map, causando falha na proteção contra sobrescrita do ticker.

**Sintomas:**
- Ticker configurava `BTC` com `source='TICKER'`
- Gráfico configurava `BTCUSDT` com `source='GRAPH'`
- `hasUserDefinedLevels('BTC')` retornava `false` porque registro estava em `'BTCUSDT'`
- Ticker continuava sobrescrevendo níveis configurados pelo usuário

#### Causa Raiz
1. **Inconsistência de chaves:** Diferentes partes do sistema usavam `'BTC'` ou `'BTCUSDT'` sem normalização
2. **Bug no setAlertLevels():** Linha 125-128 retornava cedo quando níveis eram idênticos (tolerância 0.1%), ANTES de verificar se `source` mudou de `TICKER` → `GRAPH`

#### Correção Aplicada

**1. Normalização Centralizada (`assets/js/utils.js`):**
```javascript
function normalizeSymbol(symbol) {
  if (!symbol || typeof symbol !== 'string') return '';
  return symbol.trim().toUpperCase().replace(/USDT$/, '');
}
```
Exportada como `window.BI.normalizeSymbol()`.

**2. Aplicada em AlertEngine (`assets/js/services/alertEngine.js`):**
- `setAlertLevels(symbol, ...)` — normaliza symbol antes de usar como chave
- `hasUserDefinedLevels(symbol)` — normaliza symbol
- `getLevels(symbol)` — normaliza symbol
- `onPriceUpdate(symbol, ...)` — normaliza symbol
- `disable(symbol)` — normaliza symbol
- `isEnabled(symbol)` — normaliza symbol
- `dismissVisualAlert(symbol)` — normaliza symbol

**3. Aplicada em DynamicSR (`assets/js/chart/dynamicSR.js`):**
- `activate(symbol, ...)` — normaliza symbol
- `recalculate(symbol, ...)` — normaliza symbol
- `toggle(symbol, ...)` — normaliza symbol

**4. Aplicada em Ticker (`assets/js/ticker-widget.js`):**
- Normaliza symbol antes de `hasUserDefinedLevels()` e `setAlertLevels()`

**5. Aplicada em Conversor (`assets/js/conversor.js`):**
- `getSRSymbol()` retorna símbolo normalizado

**6. Upgrade de Autoridade (`assets/js/services/alertEngine.js`):**
```javascript
// Antes: retornava cedo se níveis idênticos
if (sameSupport && sameResistance) return;

// Depois: permite upgrade TICKER→GRAPH
if (sameSupport && sameResistance) {
  var isAuthorityUpgrade = existing.config.source === 'TICKER' && source === 'GRAPH';
  if (!isAuthorityUpgrade) {
    return; // Só retorna se não for upgrade
  }
}
```

**7. Migração Automática (`assets/js/services/alertEngine.js`):**
```javascript
AlertEngine.prototype.migrateSymbols = function () {
  // Consolida entradas antigas BTCUSDT → BTC
  // Preserva source=GRAPH (maior autoridade)
  // Executada automaticamente no DOMContentLoaded
};
```

#### Arquivos Alterados
- `assets/js/utils.js` (normalizeSymbol + export)
- `assets/js/services/alertEngine.js` (normalização em 7 métodos + upgrade autoridade + migração)
- `assets/js/chart/dynamicSR.js` (normalização em 3 métodos)
- `assets/js/ticker-widget.js` (normalização antes de verificações)
- `assets/js/conversor.js` (normalização em getSRSymbol)

#### Comportamento Esperado
- `BTC`, `BTCUSDT`, `btc`, `btcusdt` → todos normalizam para `'BTC'`
- `AlertEngine.alerts.get('BTC')` retorna mesmo registro independente da variação
- Ticker configura níveis com `source='TICKER'`
- Gráfico faz upgrade para `source='GRAPH'` (mesmo com níveis idênticos)
- `hasUserDefinedLevels('BTC')` retorna `true` após configuração pelo gráfico
- Ticker respeita autoridade e pula atualização (log `TICKER SKIPPED`)

#### Testes Realizados
**Teste Crítico (test-validacao-sr.mjs):** ✅ PASS
- BTC configurado pelo gráfico (source='GRAPH', timeframe='1H')
- Aguardou 35s (7 ciclos ticker)
- `TICKER SKIPPED` apareceu 7 vezes para BTC
- `TICKER UPDATE` apareceu 0 vezes para BTC
- Níveis permaneceram idênticos após trocar gráfico para ETH
- source permaneceu 'GRAPH'

**Teste Complementar (test-sol-ticker.mjs):** ✅ PASS
- SOL (nunca configurado pelo gráfico)
- Recebeu níveis TICKER automaticamente (source='TICKER')
- Confirmação: ticker funciona para ativos não-configurados

---

### Fase 8 — Alertas dos Cards (2026-09-03)

**Data:** 2026-09-03  
**Commit:** `a2bee7b`

#### Problema Encontrado
Cards não emitiam som ao atingir S/R configurado pelo ticker porque `onPriceUpdate()` só era chamado se `PushSubscribe.isEnabled()` fosse `true`.

**Sintoma:**
```javascript
// ticker-widget.js linha 248 (ANTES):
if (isCrypto(symbol) && window.AlertEngine && window.PushSubscribe && window.PushSubscribe.isEnabled()) {
  window.AlertEngine.onPriceUpdate(symbol, price);
}
```

AlertEngine só recebia preços se Push estivesse ATIVADO, impedindo alertas locais funcionarem independentemente.

#### Causa Raiz
Dependência incorreta: alertas sonoros locais foram condicionados à ativação de Push por engano. Push e alertas locais são funcionalidades independentes.

#### Correção Aplicada

**Remoção de Dependência (`assets/js/ticker-widget.js` linha 248):**
```javascript
// DEPOIS:
if (isCrypto(symbol) && window.AlertEngine) {
  window.AlertEngine.onPriceUpdate(symbol, price);
}
```

AlertEngine agora recebe preços SEMPRE, independente de Push.

#### Arquivos Alterados
- `assets/js/ticker-widget.js` (linha 248)

#### Mecanismo de Áudio (já existente, não alterado)

**Web Audio API (`assets/js/services/alertEngine.js`):**
```javascript
function playBeep(self) {
  var ctx = getAudioCtx(self);
  // ...
  osc.type = 'sine';
  osc.frequency.value = 880;  // 880Hz (nota Lá)
  gain.gain.setValueAtTime(0.3, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.3);
}
```

**Desbloqueio Automático:**
```javascript
function unlockAudioOnFirstInteraction() {
  window.AlertEngine.unlockAudio();
  // Remove listeners após primeiro toque
}
document.addEventListener('touchstart', unlockAudioOnFirstInteraction, { once: true });
document.addEventListener('click', unlockAudioOnFirstInteraction, { once: true });
```

**Cooldown:** 2 minutos por símbolo/direção (evita spam)

**Vibração Mobile:** 200ms quando alerta dispara

#### Comportamento Esperado

**Fluxo Completo:**
1. WebSocket Binance → `updateLivePrice(symbol, price)`
2. `AlertEngine.onPriceUpdate(symbol, price)` [AGORA SEM DEPENDÊNCIA DE PUSH]
3. Detecção de cruzamento S/R (`armedSupport`/`armedResistance`)
4. `AlertEngine.trigger(symbol, direction, price, level)`
5. `playBeep()` + `navigator.vibrate()` [SE cooldown OK]
6. `CustomEvent('PriceAlertTriggered', { symbol, direction, price, level })`
7. `ticker-widget.js` → `applyAlertVisual(symbol, true, direction)`
8. Card recebe classe `alert-triggered` + sino animado + label S/R

**Separação Push vs SOM:**
- **SOM:** TODOS os ativos (BTC, ETH, SOL, LINK, etc.) via `AlertEngine.trigger()`
- **Push:** EXCLUSIVO BTC (linha 177-179 ticker-widget.js):
  ```javascript
  if (normalizedSymbol === 'BTC' && window.PushSubscribe && window.PushSubscribe.isEnabled() && window.PushSubscribe.syncToWorker) {
    window.PushSubscribe.syncToWorker(normalizedSymbol, srResult.support, srResult.resistance, last);
  }
  ```

#### Testes Realizados

**Teste Automatizado (test-alertas-cards.mjs):** ✅ INFRAESTRUTURA CONFIRMADA
- Aplicação aberta
- Áudio desbloqueado (click na página)
- ETH níveis TICKER configurados (support: 2356.41, resistance: 2429)
- Simulação de cruzamento support/resistance via JavaScript
- BTC níveis GRAPH configurados
- `onPriceUpdate()` confirmado funcionar sem Push

**Teste Manual:** ✅ SOM CONFIRMADO
- Usuário relatou: "eu ouvi o áudio de SOL"
- Confirmação: alerta sonoro funciona em cruzamento real de S/R

**Status de Validação:**
- ⏳ **PENDENTE:** Teste formal de Support (cruzamento real via WebSocket)
- ⏳ **PENDENTE:** Teste formal de Resistance (cruzamento real via WebSocket)
- ⏳ **PENDENTE:** BTC SOM (cruzamento real via WebSocket)
- ⏳ **PENDENTE:** BTC PUSH (cruzamento real via WebSocket)
- ✅ **CONFIRMADO:** Outros ativos Push = ZERO (código: Push só em linha 177 para BTC)
- ✅ **CONFIRMADO:** SOL SOM funciona (relato do usuário)

---

### Fase 9 — Correção P0: congelamento do nível GRAPH no AlertEngine (2026-09-03)

**Data:** 2026-09-03
**Commit:** `0e8b6e1` — `fix(alerts): prevent GRAPH level freeze below 0.1%`
**Escopo:** ÚNICA alteração de produção em `assets/js/services/alertEngine.js` (`setAlertLevels`). Sem mudanças em Worker, DynamicSR, cooldown, hysteresis, crossover, rearm, timeframe, candles, normalização ou autoridade.

#### Problema (confirmado pela Auditoria P0)
O dedup de `setAlertLevels` usava tolerância de 0,1% para TODOS os casos. Em atualização `GRAPH→GRAPH` com delta < 0,1% (ex.: R 77.546,9 → 77.559; delta 12,1 < tolerância 77,6), a função dava `return` e o motor mantinha o nível antigo — enquanto o `DynamicSR` já tinha atualizado o `srLevels` do gráfico (dynamicSR.js recalcula o desenho antes de chamar o motor). Resultado: motor monitora nível STALE, beeps "falsos" vs o nível visível, até um delta > 0,1%.

#### Correção aplicada
```javascript
// dentro de setAlertLevels(), no cálculo de "mesmos níveis":
var graphToGraph = existing.config.source === 'GRAPH' && source === 'GRAPH';
var epsilon = graphToGraph ? 1e-4 : 0.001; // P0: GRAPH→GRAPH usa 1e-4 relativo
var sameSupport = Math.abs(existing.config.support - support) < support * epsilon;
var sameResistance = Math.abs(existing.config.resistance - resistance) < resistance * epsilon;
```
- `GRAPH→GRAPH`: atualiza sempre que delta > epsilon técnico (1e-4 relativo ≈ US$ 7,75 em BTC a 77k).
- Demais casos (`TICKER→TICKER` no refresh de 5s etc.): dedup de 0,1% preservado (evita reset de estado a cada refresh).
- Bloco de upgrade `TICKER→GRAPH`, normalização, estado e proteção `GRAPH > TICKER` (`hasUserDefinedLevels`) inalterados.

#### Testes (adicionados ao repo)
- `test-auditoria-p0-freeze.mjs` — simulação determinística com os PREÇOS REAIS da janela 23:28 (02:28:12–02:29:33 UTC): cenário real `77.546,9 → 77.559` agora atualiza o motor. **PASS.**
- `test-auditoria-p0-fix.mjs` — unit sobre o CÓDIGO REAL do engine (stubs de browser em Node), Casos A–E da orientação: A GRAPH delta<0,1% atualiza; B delta<epsilon ignorado; C TICKER não sobrescreve GRAPH; D TICKER→GRAPH assume autoridade; E crossover segue disparando. **PASS (5/5).**

#### Validação
`node tests/test-auditoria-p0-freeze.mjs` e `node tests/test-auditoria-p0-fix.mjs` → ambos PASS. `git diff --check` limpo. Nenhuma regressão nos fluxos existentes (nenhuma regra foi alterada para fazer teste passar).

---

## 6. Regras Funcionais Finais

### Autoridade de S/R

| Cenário | Comportamento |
|---------|---------------|
| Ativo nunca configurado pelo gráfico | Ticker configura S/R com `source='TICKER'` |
| Usuário ativa S/R no gráfico | DynamicSR configura S/R com `source='GRAPH'` |
| Ticker tenta atualizar ativo com `source='GRAPH'` | `hasUserDefinedLevels()` retorna `true` → `TICKER SKIPPED` |
| Usuário troca gráfico para outro ativo | S/R do ativo anterior permanece protegido (`source='GRAPH'`) |
| Níveis TICKER e GRAPH idênticos | Permite upgrade `TICKER→GRAPH` (atualiza source) |

### Normalização de Símbolos

| Input | Output |
|-------|--------|
| `'BTC'` | `'BTC'` |
| `'BTCUSDT'` | `'BTC'` |
| `'btc'` | `'BTC'` |
| `'btcusdt'` | `'BTC'` |
| `' BTC '` | `'BTC'` |
| `'ETH'`, `'ETHUSDT'`, `'eth'`, `'ethusdt'` | `'ETH'` |

**Regra:** `trim()` + `toUpperCase()` + `replace(/USDT$/, '')`

**Aplicação:** TODOS os métodos de AlertEngine, DynamicSR, ticker-widget, conversor.

### Alertas Sonoros (Cards)

| Ativo | SOM ao atingir S/R | Push ao atingir S/R |
|-------|-------------------|---------------------|
| BTC | ✅ SIM | ✅ SIM (se Push ativado) |
| ETH | ✅ SIM | ❌ NÃO |
| SOL | ✅ SIM | ❌ NÃO |
| LINK | ✅ SIM | ❌ NÃO |
| RENDER | ✅ SIM | ❌ NÃO |
| AVAX | ✅ SIM | ❌ NÃO |
| PAXG | ✅ SIM | ❌ NÃO |
| USDT-BRL | ✅ SIM | ❌ NÃO |

**Mecanismo:**
- SOM: `AlertEngine.trigger()` → `playBeep()` (Web Audio 880Hz, 0.3s)
- Push: `ticker-widget.js` linha 177-179, condicional `symbol === 'BTC'`
- Cooldown: 2min por símbolo/direção
- Rearme: automático quando preço volta pra dentro da faixa
- Visual: card recebe classe `alert-triggered` + sino animado + label S/R

### Separação de Responsabilidades

| Componente | Responsabilidade |
|------------|------------------|
| `AlertEngine` | Motor de alertas local (crossover, som, vibração, eventos) |
| `DynamicSR` | Cálculo de S/R do gráfico, marca `source='GRAPH'` |
| `ticker-widget` | Alimenta AlertEngine com preços, calcula S/R ticker (`source='TICKER'`), visual dos cards |
| `push-subscribe` | Sincroniza níveis BTC com Worker (Push exclusivo) |
| `Worker Cron` | Alertas em background (PWA fechado), Push para subscriptions |

### Identidade Lógica

**UMA IDENTIDADE LÓGICA DE ATIVO = UMA CHAVE DE S/R**

`BTC` e `BTCUSDT` **NUNCA** coexistem como ativos diferentes dentro do motor de S/R.

---

## 7. Auditoria P0 — Alertas Falsos de BTC (EM ANDAMENTO — 2026-09-03)

> Regra da auditoria: **provar QUEM dispara e com quais dados antes de corrigir.** Não alterar normalização, autoridade GRAPH>TICKER, cooldown/histerese, timeframe ou candles enquanto a cadeia causal não for provada com ocorrência real. Não declarar causa raiz sem evidência.

### Arquitetura Dual (Client + Worker)
O sistema possui dois motores independentes:
- **CLIENT_ALERT_ENGINE** (`assets/js/services/alertEngine.js`) — browser, PWA aberto, som imediato
- **WORKER** (`alerta-worker/src/index.js`, v7.0.0) — Cloudflare Cron 1min, Push notification

Ambos podem gerar notificações. É necessário identificar a origem antes de atribuir problema.

### Worker v7.0.0 Publicado
- Health: `{"service":"alerta-worker","status":"ok","version":"7.0.0"}`
- Hysteresis: 0.15% (`HYSTERESIS_PCT = 0.0015`)
- Cooldown: 5min (`COOLDOWN_MS = 300000`)
- Código fonte: NÃO no repo (v6.1.0). Backup em `alerta-worker-v7-backup/` (gitignored).

### KV `ALERTAS_KV` — Estado Confirmado
- `alert:BTC`: support=76264, resistance=77900, enabled=true
- `cron:states.BTC`: lastPrice=81090.67, resistanceTriggered=true, lastResistanceTriggeredAt=2026-09-03T11:18:46.424Z
- `cron:index`: 8 alertas, 20 subscriptions
- Subscriptions são globais (sem associação com símbolo)

### Contaminação BTC ↔ AVAX
**NÃO COMPROVADA.** Estados são separados por símbolo em `cron:states`.

### Risco de lastPrice Defasado
O Worker pode omitir `KV.put()` quando apenas `lastPrice` muda, causando defasagem entre ciclo N e N+1. **HIPÓTESE A VALIDAR.**

### Instrumentação (commits)
- `65cf7ba` — logs `[BTC ALERT TRACE]` em ticker-widget (PREÇO RECEBIDO) e alertEngine (INICIALIZAÇÃO / VERIFICAÇÃO / DISPARO TENTADO para TODOS os ativos).
- `3d67ed5` — ring buffer `window.__BTC_TRACE__` (2000 eventos) + `window.__TRACE_DUMP__()` (JSON completo, sem truncamento do console). Uso após incidente: `copy(__TRACE_DUMP__())`.

### Sintomas (ocorrência 2026-09-02 23:24–23:32 BRT)
- 23:24 "cruzou R" → apitou; 2º cruzamento 23:24 → bloqueado (cooldown OK); 23:28 "cruzou R" → apitou "sininho"; até 23:32 nenhum push no mobile.

### Evidências encontradas (arquivo → linha)
1. Preço client íntegro: mesma variável WS→`onPriceUpdate` (ticker-widget.js L240–265). Cat. A sem evidência.
2. **Rearm SEM histerese no client:** `currentPrice < config.resistance` rearms direto (alertEngine.js L249–261), sem banda `*(1−pct)`. Instrumentação documenta 0.15% mas o código não aplica.
3. `setAlertLevels` reseta `armed=true` + estado a cada mudança de nível (alertEngine.js L158–167).
4. Cooldown client real = 120000ms por símbolo/direção (alertEngine.js L304).
5. **Níveis GRAPH nunca chegam ao Worker:** `syncToWorker()` só é chamado no branch TICKER (ticker-widget.js L180–182); DynamicSR GRAPH (dynamicSR.js L116/L281) não sincroniza. Com BTC GRAPH, o `alert:BTC` do Worker fica congelado no último nível TICKER.
6. Worker do repo (v6.1.0) rearms sem banda (index.js L500–505) e **não tem cooldown timer** (só flag triggered).
7. **Worker deployado ≠ repo:** health responde `version 7.0.0` (repo = 6.1.0). Deploys 2026-08-31, fonte do v7 fora do repo.
8. **KV produção VAZIO:** `ALERTAS_KV` (`67cf3ab4…`) com 0 chaves (sem `alert:BTC`/`cron:index`/`cron:states`/subs). Probe `/subscribe` retornou `ok:true` sem persistir nada (3 namespaces da conta, todos vazios) ⇒ **push no mobile impossível hoje**.

### Análise da janela 23:28:12–23:29:33 UTC
- Único `DISPARO TENTADO`: **PAXG resistance 02:28:22.046Z (=23:28:22 BRT)**. BTC: zero disparos apesar de cruzar R≈77.559 (02:28:32: 77550.8→77560 etc.) ⇒ nível R do motor ≠ nível exibido no gráfico naquele instante (indício Cat. B) OU estado impedia.
- "Sininho" das 23:28 tem correspondência objetiva no DISPARO de PAXG → hipótese de atribuição errada de ativo (som global, usuário vendo gráfico BTC).

### Classificação parcial (sem causa raiz final)
- A descartado na janela · B candidato forte (motor≠gráfico; sync GRAPH→Worker inexistente) · D defeito estático provado (rearm sem banda client+worker) · F não ocorreu (push impossível — KV vazio) · G possível (PAXG 23:28:22).

### Pendências
1. Capturar próxima ocorrência com `copy(__TRACE_DUMP__())` + anotar qual card acendeu.
2. Obter fonte do worker v7.0.0 (quem deployou em 2026-08-31) e seu storage.
3. Detalhes completos em `DOCS/AUDITORIA_P0_ALERTAS_FALSOS_BTC.md`.

### Patch A — Prevenção de sobrescrita de S/R pelo ticker (2026-09-03)

**Commit:** `4e562c9` — `fix: prevent ticker from overwriting chart SR levels`  
**Arquivo:** `assets/js/ticker-widget.js`  
**Deploy:** https://estudebitcoin.pages.dev (Pages)

**Problema:** O ticker chamava `DynamicSR.calculateSR()` + `AlertEngine.setAlertLevels()` a cada 5s para TODOS os cryptos, sobrescrevendo os níveis configurados pelo gráfico.

**Correção:** Guard `srActive` que verifica se DynamicSR está ativo para o símbolo atual. Se ativo, o ticker NÃO calcula nem atualiza S/R para esse símbolo.

**Estrutura:**
```javascript
var srActive = window.DynamicSR.isActive() && window.DynamicSR.getSymbol() === symbol;
if (srActive) {
  console.log('[SR TRACE] TICKER SKIPPED symbol=' + symbol + ' reason=GRAPH_ACTIVE');
} else {
  // cálculo original do ticker
}
```

**Logs:** `[SR TRACE] TICKER SKIPPED` e `[SR TRACE] TICKER UPDATE` mantidos para validação.

**Validação:** Testes automatizados via headless browser (estrutura OK, lógica OK). Teste de crossover real PENDENTE.

### Regra de Investigação

**NUNCA** concluir "contaminação de símbolo" apenas porque uma notificação contém vários símbolos ou porque várias subscriptions receberam a mesma notificação.

A cadeia de prova deve ser:
```
ALERT CONFIG → SYMBOL → PRICE SOURCE → PRICE SAMPLES → PREVIOUS PRICE → CROSSING DETECTOR → STATE TRANSITION → PUSH EVENT → SUBSCRIPTIONS
```

O diagnóstico deve identificar **exatamente em qual etapa** ocorreu a divergência.

### Worker deployado v7.0.0 (auditado via download do script — backup local em `alerta-worker-v7-backup/`, gitignored)
- **O repo (`alerta-worker/src/index.js`, v6.1.0) está DEFASADO em relação à produção (v7.0.0).** Qualquer correção de Worker deve usar o backup do v7 até o repo ser ressincronizado.
- v7 usa o mesmo contrato KV (`ALERTAS_KV`, chaves `sub:`/`alert:`/`cron:index`/`cron:states`) e endpoints (`/subscribe`, `/unsubscribe`, `/alerts/sync`, `/`).
- v7 implementa o que o v6 do repo NÃO tem: `HYSTERESIS_PCT = 0.0015` (rearm real: `currentPrice < resistance*(1−0.0015)`, L963) e `COOLDOWN_MS = 300000` (5min por direção, com `lastResistanceTriggeredAt`/`lastSupportTriggeredAt` no estado).
- **Divergência de cooldown entre os motores:** Worker v7 = 5min; client AlertEngine = 120s (alertEngine.js L304). O mesmo evento pode apitar no client (≥2min) mas ser bloqueado no Worker (≥5min) — e vice-versa em janelas 2–5min.
- **KV `67cf3ab4…` (único ALERTAS_KV da conta) permanece VAZIO** mesmo após `/subscribe` do v7 retornar `ok:true` ⇒ o binding `ALERTAS_KV` do deploy v7 aponta para outro namespace (não acessível sem o settings fetch, recusado) ou storage fora da conta. Estado real do push (subs/alertas do v7) **não verificável nesta sessão**.

### Mecanismo provado — congelamento do nível do motor pelo dedup de 0.1% (Categoria B, client)
- **Onde:** `alertEngine.js` `setAlertLevels()` L149–163.
- **Como:** se `|old − new| < nível·0.001` (≈ US$ 77 em BTC a 77k) **e** não for upgrade `TICKER→GRAPH`, a função dá `return` e o motor **mantém o nível antigo**. `DynamicSR.recalculate()` atualiza o `srLevels` do gráfico ANTES de chamar `setAlertLevels` (dynamicSR.js L278–285; conversor.js L416–418/L522–531) — então **o gráfico passa a desenhar o nível novo enquanto o motor fica congelado no antigo** até um delta > 0.1%.
- **Consequência:** o motor pode disparar beeps em cruzamentos de um nível **que não é o desenhado no gráfico** (defasagem permanente ≤ ~0.1%, ~US$ 77). Sintoma real descrito na auditoria: "GRÁFICO R=77.559; MOTOR R=77.546" — beep correto para o motor, falso em relação ao gráfico.
- **Confirmação nos logs (23:28:12–23:29:33 UTC):** zero `DISPARO TENTADO` de BTC na janela apesar de o preço cruzar 77.559 ⇒ deriva-se **R do motor ≤ 77.546,9** naquele instante (se R > 77.546,9, o rearm L250–255 + cruzamento em 02:28:32 teriam logado disparo). Divergência motor (≤77.546,9) × gráfico (77.559) = **12+ USD — dentro da janela de congelamento de 0.1%**.
- **Valor exato/lastro a confirmar:** expandir 1 objeto `[BTC ALERT TRACE] DISPARO TENTADO` (campos `resistance_level`, `config_source`) ou colar os `[SR-TRACE] ALERT_ENGINE setAlertLevels`/`GRAPH recalculate` de BTC do console (23:20–23:30).

### Fechamento da Auditoria P0 (2026-09-03) — CAUSA RAIZ
```
CAUSA RAIZ:
  Nível do motor de alertas (client) congelado pelo dedup de 0.1% em setAlertLevels
  (alertEngine.js L149–163) quando DynamicSR recalcula com delta < 0.1% — o gráfico
  desenha o nível novo, o motor mantém o antigo. Beeps disparam no nível STALE
  (≤ 77.546,9 na ocorrência de 23:28) enquanto o usuário vê R=77.559.

EMISSOR: CLIENT_ALERT_ENGINE (som/card BTC). Push do Worker: separado e hoje sem
  dados persistidos (worker v7 deployado não grava no KV acessível da conta).

EVIDÊNCIA:
  - Logs reais 23:28:12–23:29:33 UTC: zero DISPARO BTC apesar de cruzamentos de 77.559
    ⇒ R do motor ≤ 77.546,9 (derivação sobre rearm L250–255 e crossover L264–271).
  - Simulação determinística test-auditoria-p0-freeze.mjs (preços reais da janela):
    R=77.559 teria disparado às ~02:28:34 (não ocorreu); R=77.546,5 reproduz o silêncio.
  - Demo do dedup na simulação: recalc GRAPH 77.559 sobre motor 77.546,9 → motor
    permanece 77.546,9 (congelado; delta 12,1 < tolerância 77,6).
  - KV ALERTAS_KV vazio (0 chaves) + /subscribe do v7 ok:true sem persistir nada.

CORREÇÃO NECESSÁRIA:
  1. setAlertLevels: GRAPH→GRAPH atualiza para delta > epsilon técnico de 1e-4
     relativo (dedup de 0,1% mantido p/ TICKER→TICKER) — IMPLEMENTADO em
     2026-09-03, commit `0e8b6e1` (detalhes na "Fase 9" acima; testes
     test-auditoria-p0-freeze.mjs e test-auditoria-p0-fix.mjs: PASS).
  2. Worker: ressincronizar alerta-worker/ com o v7 (backup em alerta-worker-v7-backup/),
     corrigir binding KV de produção e sincronizar o nível GRAPH (o que o usuário vê)
     para o alert:BTC nunca ficar defasado — PENDENTE (fora do escopo da correção P0).
  3. NÃO alterar: normalização, autoridade GRAPH>TICKER, cooldown/histerese atuais,
     timeframe, candles.

TESTES: simulação determinística com preços reais (R gráfico dispararia na janela;
  R stale reproduz o silêncio) — mecanismo PASS. Correção do client aplicada e
  testada (Fase 9); correção do Worker pendente.

LIMITAÇÃO: valor exato/config_source do nível no instante do beep (logs truncados)
  não confirmado; cadeia apoia-se em derivação + simulação. `copy(__TRACE_DUMP__())`
  (commit 3d67ed5, no ar) captura a próxima ocorrência completa.
```
Relatório completo: `DOCS/AUDITORIA_P0_ALERTAS_FALSOS_BTC.md` (seção "RELATÓRIO FINAL").

---

## 8. Login opcional + sync de painéis (2026-09-08)

Decisões: login **Google + e-mail/senha** (modal "Entrar no EstudeBitcoin", só no topo),
backend **Firebase (projeto do mural, sem pausar no Free)** — Auth + RTDB
`users/{uid}/panels/{risk,sim}` com rules por dono. Ambos os painéis, cross-device.
Login nunca obrigatório; qualquer falha é silenciosa (localStorage).

| Arquivo | Responsabilidade |
|---|---|
| `assets/js/auth.js` | `window.EstudeAuth` (Google popup+redirect fallback, e-mail/senha com verificação, reset, logout, apagar dados) + `window.PanelSync` (localStorage `eb_panel_*` + set/pull RTDB, merge último-vence por `updatedAt`). SDKs compat (app/auth/database) sob demanda via `BI.loadScripts`. Eventos `estudebitcoin:auth-change` / `estudebitcoin:panel-pull`. |
| `assets/css/login.css` | Botão `.dash-login-btn` (linguagem do MENU) + modal card claro (modelo aprovado). |
| `assets/js/config.js` | Reaproveita `firebase:` do mural (sem chaves novas) + `cdn.firebaseAuth`. Provedores ativados no console. |
| `assets/js/risk-engine/risk-engine-panel.js` | Salva `readParams()` em `eb_panel_risk` a cada reconfig + restaura no boot + aplica pull via evento. Sem `PanelSync`, comportamento idêntico ao anterior. |
| `index.html` / `indexsemalavancagem.html` | Botão `#eb-login-btn` em `.dash-actions` + modal `#eb-login-overlay` (views login/signup/reset/verify/account) + includes `login.css` / `auth.js`. |
| `assets/js/calc-persist.js` | Ponte same-origin p/ o simulador iframe (fonte React fora do repo): lê/escreve inputs pelo DOM (seletores: 2 inputs sem aria-label, `.order-row`, `.secondary-button`, `.remove-button`, `.toggle`; escrita via setter nativo + `input`). Salva `eb_panel_sim` (+ push nuvem logado) e restaura no load; aplica pull `sim` via evento. QA: round-trip valores+qtd ordens+MMR PASS. Frágil a rebuild do bundle — rever seletores se o bundle mudar. |

RTDB rules (somar ao `mural` existente, nunca substituir): `users.$uid` com
`.read/.write = auth != null && auth.uid === $uid`. Só params de simulação (KBs);
push/mural/alertas seguem locais. Conta e-mail/senha só sincroniza após
`emailVerified` (Google já vem verificado). Painel `sim` via ponte `calc-persist.js`
(não reescrever o bundle; seletores ancorados no DOM atual).


