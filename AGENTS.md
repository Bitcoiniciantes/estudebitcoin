# AGENTS.md — Contexto persistente para IA

> Este arquivo descreve a arquitetura REAL do sistema de alertas e push do EstudeBitcoin.
> Nao incluir chaves, tokens ou secrets — apenas a estrutura e decisoes tecnicas.

---

## 1. Arquitetura de alertas (arquivos reais)

### Client-side (browser)

| Arquivo | Responsabilidade |
|---|---|
| `assets/js/services/alertEngine.js` | Singleton global `window.AlertEngine`. Crossover S/R, cooldown 120s, beep (Web Audio), vibrate, CustomEvents `PriceAlertTriggered` / `PriceAlertDismissed` |
| `assets/js/ticker-widget.js` | Alimenta AlertEngine com precos ao vivo (a cada 10s). Busca candles, calcula S/R via `window.DynamicSR`, renderiza sino e flash visual |
| `assets/js/chart/dynamicSR.js` | Calcula suporte/resistencia dinamicamente a partir de candles |
| `assets/js/push-config.js` | Exporta `window.PushConfig` com `VAPID_PUBLIC_KEY` e `WORKER_URL` |
| `assets/js/push-subscribe.js` | Botao "Ativar alertas". `Notification.requestPermission()` so em clique. `pushManager.subscribe()` com VAPID. Envia subscription ao Worker via `POST /subscribe`. **`syncToWorker()`** sincroniza niveis S/R com o Worker (throttle: dedup 0.1% + intervalo 5min por symbol). Exporta `window.PushSubscribe` |
| `sw.js` | Service Worker: recebe push, mostra notificacao, `notificationclick` foca ou abre janela |
| `manifest.json` | PWA manifest: `display: "standalone"` (obrigatorio para iOS push) |
| `index.html` | Registra SW, inclui scripts na ordem correta |

### Ordem de carregamento (index.html)

```
1. config.js → utils.js
2. services/alertEngine.js  (deve ser antes do ticker)
3. chart/dynamicSR.js       (deve ser antes do ticker)
4. ticker-widget.js          (consome AlertEngine + DynamicSR)
5. push-config.js            (depois do ticker)
6. push-subscribe.js         (depois do config)
7. navigator.serviceWorker.register('/sw.js')
```

### Server-side (Cloudflare Worker)

| Arquivo | Responsabilidade |
|---|---|
| `alerta-worker/src/index.js` | Worker completo: HTTP API + Cron scheduled handler |
| `alerta-worker/wrangler.toml` | Config: KV binding, cron `*/5 * * * *`, `nodejs_compat` flag |
| `alerta-worker/package.json` | Dependencia: `@block65/webcrypto-web-push` |

### Endpoints do Worker

| Rota | Metodo | Funcao |
|---|---|---|
| `/subscribe` | POST | Valida e salva subscription no KV (gera UUID) |
| `/unsubscribe` | POST | Deleta subscription por `?id=` |
| `/alerts/sync` | POST | Salva alerta (symbol, support, resistance, direction) no KV |
| `/` | GET | Health check |
| Cron `*/5 min` | scheduled | Itera alertas, busca preco, evalua crossover, envia push |

### KV structure (Cloudflare `ALERTAS_KV`)

| Prefixo | Conteudo |
|---|---|
| `sub:{uuid}` | Subscription (endpoint + keys) |
| `alert:{symbol}` | Config do alerta — **ID = symbol** (ex: `alert:BTC`, `alert:ETH`), nao UUID |
| `state:{symbol}` | Estado do alerta (lastPrice, triggered) — preservado entre syncs porque o ID e estavel |

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
- Migrado para `mempool.space/api/v1/prices` (primario para BTC) + CoinGecko (batch para todos os symbols)
- **Bug:** CoinGecko retorna 403 sem `User-Agent` — Workers nao enviam User-Agent por padrao. Corrigido com `headers: { 'User-Agent': 'EstudeBitcoin-AlertWorker/1.0' }`
- **BRL vs USD:** `USDT-BRL` usa `vs_currencies=brl`, demais usam `vs_currencies=usd`. Batch unico com `vs_currencies=usd,brl` e selecao por `SYMBOL_CURRENCY` map
- **Por que:** `api.binance.com` retorna 403 de datacenters; `mempool.space` funciona para BTC; CoinGecko funciona para todos com User-Agent

### Fase 5 — Sincronizacao Client→Worker
- `syncToWorker()` em `push-subscribe.js`: chama `POST /alerts/sync` quando niveis S/R mudam
- Chamado de `ticker-widget.js` apos `AlertEngine.setAlertLevels()`
- **Throttle:** dedup (so sync se support/resistance mudou > 0.1%) + intervalo minimo 5min por symbol
- **Payload:** `{ symbol, support, resistance, direction, lastPrice }`
- **ID do alerta:** `{symbol}` (ex: `alert:BTC`) — estavel entre syncs, preserva `state:{id}`
- **Seed de state:** Worker cria `state:{id}` com `lastPrice` do client **apenas na primeira vez** (state nao existe). State existente e intocado — so o Cron atualiza
- **Por que:** ID estavel permite que o Cron preserva lastPrice/triggered entre atualizacoes de nivel

### Fase 5 — Teste real
- Push manual via `/test-push` (temporario, ja removido)
- Crossover via `/cron-test` (temporario, ja removido)
- Subscriptions com erro 400/410 sao auto-deletadas pelo handler
- **Por que:** Teste end-to-end necessario antes de ativar Cron em producao

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
- Com o PWA aberto, o `alertEngine.js` dispara som/vibracao imediatamente ao detectar crossover
- O Cron do Worker detecta o mesmo crossover (ate 5 min depois) e envia push
- Resultado: usuario recebe **duas** notificacoes para o mesmo evento
- **Decisao de design:** NAO usar "esta online?" como criterio (online nao significa que o alerta ja disparou — client pode ter tick atrasado/falho)
- **Solucao planejada:** client envia `POST /alerts/ack` com `alertId` no momento exato em que o `alertEngine.js` dispara, marcando `state:{id}.acked = true` no KV. O Cron verifica esse campo antes de decidir enviar push — se `acked` for `true` para aquele ciclo, pula o push e reseta o flag
- **Por que:** ack explícito (evento ja tratado) e mais preciso que inferencia generica (usuario "online")

### Cron
- Roda a cada 5 minutos (`*/5 * * * *`)
- Busca preco de `mempool.space` (BTC) + CoinGecko batch (demais symbols) — uma unica chamada para todos
- Detecta crossover e envia push para todas as subscriptions ativas
- Auto-limpa subscriptions mortas (HTTP 410 ou 400)

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
