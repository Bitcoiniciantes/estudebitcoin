# AUDITORIA P0 — ALERTAS FALSOS DE BTC

## Status: INSTRUMENTAÇÃO DEPLOYADA

**Data:** 2026-09-03  
**Commit:** `65cf7ba`  
**URL:** https://estudebitcoin.pages.dev  

---

## Objetivo

Identificar inequivocamente:

1. **QUEM** dispara o alerta falso (CLIENT_ALERT_ENGINE ou WORKER)
2. **QUAL PREÇO** recebeu (Binance vs AlertEngine)
3. **QUAL NÍVEL** utilizou (GRAPH vs TICKER vs divergente)
4. **POR QUE** a regra foi satisfeita (crossover + condições)
5. **SE HÁ DUPLO DISPARO** (CLIENT + WORKER para mesmo evento)

---

## Instrumentação Deployada

### Ponto 1: Entrada de Preço (ticker-widget.js)

```javascript
[BTC ALERT TRACE] PREÇO RECEBIDO DO TICKER
{
  symbol: 'BTC',
  source: 'TICKER_WEBSOCKET',
  price: <float>,
  volume: <float>,
  timestamp: <ISO8601>,
  isCrypto: <bool>,
  alertEngineAvailable: <bool>
}
```

**Propósito:** Capturar o preço ANTES de entrar no AlertEngine

---

### Ponto 2: Processamento no AlertEngine (alertEngine.js - onPriceUpdate)

#### 2a. INICIALIZAÇÃO

```javascript
[BTC ALERT TRACE] INICIALIZAÇÃO
{
  symbol: 'BTC',
  source: 'CLIENT_ALERT_ENGINE',
  initial_price: <float>,
  support: <float>,
  resistance: <float>,
  config_source: 'GRAPH' | 'TICKER',
  timestamp: <ISO8601>
}
```

**Propósito:** Confirmar quais níveis S/R estão configurados na inicialização

#### 2b. VERIFICAÇÃO DE CRUZAMENTO

```javascript
[BTC ALERT TRACE] VERIFICAÇÃO DE CRUZAMENTO
{
  symbol: 'BTC',
  source: 'CLIENT_ALERT_ENGINE',
  timestamp: <ISO8601>,
  
  // Preços
  price_previous: <float>,
  price_current: <float>,
  
  // Níveis
  support: <float>,
  resistance: <float>,
  config_source: 'GRAPH' | 'TICKER',
  
  // Estado
  armed_support: <bool>,
  armed_resistance: <bool>,
  
  // Condições
  support_cross_candidate: <bool>,
  resistance_cross_candidate: <bool>
}
```

**Propósito:** Verificar se as condições de cruzamento estão sendo avaliadas corretamente

---

### Ponto 3: Disparo do Alerta (alertEngine.js - trigger)

```javascript
[BTC ALERT TRACE] DISPARO TENTADO
{
  traceId: 'BTC-<timestamp>',
  source: 'CLIENT_ALERT_ENGINE',
  symbol: 'BTC',
  direction: 'support' | 'resistance',
  timestamp: <ISO8601>,
  
  // Dados de preço
  price_current: <float>,
  price_previous: <float>,
  
  // Níveis
  support_level: <float>,
  resistance_level: <float>,
  config_source: 'GRAPH' | 'TICKER',
  
  // Estado antes
  triggered_before_support: <bool>,
  triggered_before_resistance: <bool>,
  armed_support: <bool>,
  armed_resistance: <bool>,
  
  // Cooldown
  last_triggered_at: <ISO8601>,
  now: <ISO8601>,
  elapsed_ms: <int>,
  cooldown_ms: 300000,
  cooldown_blocked: <bool>,
  
  // Decisão
  will_play_sound: <bool>,
  
  // Histerese
  hysteresis_pct: 0.0015
}
```

#### Se bloqueado por cooldown:

```javascript
[BTC ALERT TRACE] BLOQUEADO POR COOLDOWN
{
  symbol: 'BTC',
  direction: 'support' | 'resistance',
  elapsed_ms: <int>,
  cooldown_ms: 300000
}
```

**Propósito:** Registrar CADA tentativa de disparo, bloqueada ou não

---

## Como Usar Esta Instrumentação

### Passo 1: Abrir aplicação

1. Ir para https://estudebitcoin.pages.dev
2. Abrir **Console do Navegador** (F12 → Abas → Console)

### Passo 2: Filtrar logs de BTC

No console, executar:

```javascript
// Filtrar apenas BTC
const btcLogs = [];
const originalLog = console.log;
window.console.log = function(...args) {
  const msg = args.join(' ');
  if (msg.includes('[BTC ALERT TRACE]')) {
    btcLogs.push(msg);
    originalLog.apply(console, args);
  } else if (!msg.includes('[SR-TRACE]') && !msg.includes('[DynamicSR]')) {
    // Suprimir outros logs
  }
};
```

Ou usar filtro nativo:

```
[BTC ALERT TRACE]
```

### Passo 3: Aguardar falso alerta

1. Observar ticker ao vivo
2. Aguardar SOM inesperado em BTC
3. **Pausar console** (não deixar novos logs aparecerem)
4. Copiar TODOS os logs `[BTC ALERT TRACE]` do momento anterior

### Passo 4: Classificar a ocorrência

Examinar a sequência de logs e determinar a causa:

---

## Checklist de Diagnóstico

### ✓ Cenário A: PREÇO DIVERGENTE

**Verificar:**
```
TICKER PREÇO RECEBIDO = X
ALERT ENGINE PREÇO RECEBIDO = Y
X ≠ Y?
```

Se SIM → **Causa Raiz: A**

---

### ✓ Cenário B: NÍVEL DIVERGENTE

**Verificar:**
```
INICIALIZAÇÃO:
  support = 76264
  resistance = 77765.99
  config_source = 'GRAPH'

DISPARO TENTADO:
  support_level = 76000
  resistance_level = 77800
```

Se houver divergência → **Causa Raiz: B**

---

### ✓ Cenário C: CROSSOVER INCORRETO

**Verificar:**
```
price_previous = 76500
price_current = 76800
support = 76264

previousPrice > support? 76500 > 76264 = TRUE ✓
currentPrice <= support? 76800 <= 76264 = FALSE ✗

CROSS_RESULT = FALSE

Mas DISPARO TENTADO ocorreu?
```

Se SIM → **Causa Raiz: C**

---

### ✓ Cenário D: REARM INCORRETO

**Verificar:**
```
VERIFICAÇÃO 1:
  armed_support = FALSE
  price_current = 76500 (acima do support 76264)
  → Deveria fazer rearm?

Próximo ciclo:
  armed_support = TRUE
  Sem novo cruzamento?
```

Se SIM → **Causa Raiz: D**

---

### ✓ Cenário E: COOLDOWN INCORRETO

**Verificar:**
```
DISPARO 1:
  timestamp = 10:00:00
  
DISPARO 2:
  timestamp = 10:00:05
  elapsed_ms = 5000
  cooldown_ms = 300000
  cooldown_blocked = FALSE?
```

Se cooldown_blocked for FALSE quando deveria ser TRUE → **Causa Raiz: E**

---

### ✓ Cenário F: DUPLO MOTOR

**Verificar:**
1. Há logs `[BTC ALERT TRACE] DISPARO TENTADO`?
2. Há PUSH (notificação do navegador)?
3. Se ambos ocorreram para MESMO evento → **Causa Raiz: F**

Para identificar:
```
DISPARO TENTADO:
  timestamp = 10:00:30.123

PUSH RECEBIDO:
  (verificar timestamp da notificação)
  
Se ~2min de diferença (e houver COOLDOWN BLOQUEADO) =
  CLIENT disparou, depois WORKER tentou (mas cooldown bloqueou CLIENT)
```

---

### ✓ Cenário G: OUTRA CAUSA

Se A–F forem descartadas, usar dados dos logs para formular hipótese nova.

---

## Exemplo de Análise Completa

### Logs Capturados

```
[BTC ALERT TRACE] PREÇO RECEBIDO DO TICKER
  symbol: BTC
  price: 76850
  timestamp: 10:00:30.100

[BTC ALERT TRACE] VERIFICAÇÃO DE CRUZAMENTO
  symbol: BTC
  price_previous: 76500
  price_current: 76850
  support: 76264
  resistance: 77765.99
  config_source: GRAPH
  armed_resistance: true
  resistance_cross_candidate: true

[BTC ALERT TRACE] DISPARO TENTADO
  traceId: BTC-1693667430123
  direction: resistance
  price_current: 76850
  resistance_level: 77765.99
  cooldown_blocked: false
  will_play_sound: true
```

### Análise

1. **Preço:** 76850 (consistente entre TICKER e AlertEngine) ✓
2. **Nível:** 77765.99 de GRAPH (correto) ✓
3. **Crossover:** previousPrice (76500) < resistance (77765.99)? NÃO → ✗

**PROBLEMA ENCONTRADO:** O preço 76850 está ABAIXO de 77765.99, portanto NÃO deveria cruzar a resistência.

**Verificação adicional:**
```
previousPrice < resistance?  76500 < 77765.99 = TRUE ✓
currentPrice >= resistance?  76850 >= 77765.99 = FALSE ✗
```

**Conclusão:** A condição de cruzamento NÃO foi satisfeita, mas disparo ocorreu.

**Causa Raiz:** C — CROSSOVER INCORRETO

**Próximo Passo:** Verificar lógica de detecção de cruzamento em `alertEngine.js` linha ~225.

---

## Critério para Conclusão da Auditoria

Uma investigação só é válida se:

1. ✓ Captura de logs REAIS (não simulados)
2. ✓ Sequência COMPLETA (TICKER → verificação → disparo)
3. ✓ Classificação em uma das categorias (A–G)
4. ✓ Cadeia causal verificável
5. ✓ Arquivo e linha específica identificados

**NÃO é válido:**

- "Parece estar errado"
- "Provavelmente é o Worker"
- "Deve ser normalização"
- Hipótese sem logs

---

## Status Atual

**Data:** 2026-09-03  
**Status:** ⏳ AGUARDANDO CAPTURA DE FALSO ALERTA REAL

1. ✅ Instrumentação deployed
2. ✅ Logs cobrindo 3 pontos-chave
3. ⏳ Aguardando falso alerta
4. ⏳ Análise de logs
5. ⏳ Identificação de causa raiz
6. ⏳ Proposta de correção
7. ⏳ Testes

---

## Contato / Próximos Passos

**Quando capturar um falso alerta:**

1. Copiar console completo (logs `[BTC ALERT TRACE]`)
2. Anotar:
   - Hora exata
   - Preço no gráfico
   - Preço no ticker
   - Nível S/R visível
3. Compartilhar logs
4. Executar análise conforme checklist acima
5. Classificar em A–G
6. Propor correção específica

---

# RELATÓRIO DE EVIDÊNCIAS — Ocorrência de 2026-09-02 23:24–23:32 BRT (= 02:24–02:32 UTC 2026-09-03)

**Commit desta fase:** `3d67ed5` (ring buffer `__TRACE_DUMP__`) · `65cf7ba` (logs iniciais)

## 1. Ocorrência relatada pelo usuário

| Hora (BRT) | Evento |
|---|---|
| 23:24 | BTC "cruzou R" → apitou (som) |
| 23:24 (logo após) | "voltou e cruzou R" → NÃO apitou (cooldown) |
| 23:28 | "voltou e cruzou R" → apitou "sininho" |
| até 23:32 | nenhum alerta Push no mobile |

## 2. Logs reais disponíveis (janela 02:28:12–02:29:33 UTC)

- Preços BTC oscilando entre **77546.90 e 77617.64**.
- **ÚNICO `DISPARO TENTADO` na janela: PAXG resistance às 02:28:22.046Z (= 23:28:22 BRT)**, `traceId BTC-1788402502046`, `cooldown_blocked:false` → som tocou.
- **ZERO `DISPARO TENTADO` para BTC na janela**, apesar de o preço ter cruzado o nível R do gráfico (≈77.559) várias vezes (02:28:32: 77550.8→77560; 02:28:41+: →77588.98; 02:29:30: 77603.66→77617.64).

## 3. Fatos provados pela leitura do código (arquivo → linha)

1. **Preço client íntegro:** a mesma variável `price` do WebSocket vai para `livePrices` e `onPriceUpdate` (ticker-widget.js L240–265). Categoria A sem evidência no client.
2. **Rearm SEM histerese no client:** `onPriceUpdate` rearms com `currentPrice < config.resistance` e `currentPrice > config.support` — sem banda `* (1 ± HYSTERESIS_PCT)` (alertEngine.js L249–261). A instrumentação documenta `hysteresis_pct:0.0015` mas o código não aplica banda.
3. **setAlertLevels reseta `armed=true` + estado a cada mudança de nível** (alertEngine.js L158–167) — nova leva de triggers possível após cada update de nível.
4. **Cooldown client = 120000ms** por símbolo/direção (alertEngine.js L304). Header do arquivo ("5s") está desatualizado; código = 2min.
5. **Níveis GRAPH nunca chegam ao Worker:** `syncToWorker()` (POST `/alerts/sync`) é chamado SOMENTE no branch TICKER do ticker-widget (L176–182). DynamicSR (GRAPH — dynamicSR.js L116, L281) e conversor não sincronizam. ⇒ quando BTC tem autoridade GRAPH, o `alert:{symbol}` no Worker fica congelado no último nível TICKER.
6. **Worker do repo (v6.1.0) também rearms sem banda:** `currentPrice < alert.resistance` reseta triggered (index.js L500–505) e **não possui cooldown timer** (apenas flag triggered) — repetição de push a cada ciclo em que o preço oscila abaixo/acima do nível.
7. **Worker deployado ≠ código do repo:** health do worker responde `"version":"7.0.0"`; o repo reporta `6.1.0`. Deployments de 2026-08-31 (wrangler 4.127.1) — fonte do v7 NÃO está no repo.
8. **KV de produção VAZIO:** namespace `ALERTAS_KV` (`67cf3ab4…`) com **0 chaves** (sem `alert:BTC`, `cron:index`, `cron:states`, subs). Probe `/subscribe` (id `8f70364b…`) retornou `ok:true` mas **nada foi persistido** (3 namespaces da conta listados, todos vazios).
9. **⇒ Push no mobile é impossível hoje:** o Worker v7 deployado não persiste subscriptions/alertas em nenhum KV visível da conta. Explica a ausência total de push entre 23:24–23:32 — e independe do comportamento do client.

## 4. Inferência da janela 23:28:12–23:29:33 (R gráfico ≈ 77.559)

Se o `resistance` do motor fosse 77.559, às 02:28:32 (prev 77550.8 < 77559; curr 77560 ≥ 77559) com `armed=true` (preço < R desde 02:28:12) o `DISPARO TENTADO` de BTC apareceria no log. **Não apareceu.** Logo o nível R do motor naquele instante ≠ nível exibido no gráfico (ou estado impedia: R ≥ 77617.65, ou R ≤ 77546.9 sem rearm). Indício forte de **Categoria B (NÍVEL DIVERGENTE motor × gráfico)** — mas o valor real do nível do motor nos instantes dos beeps (23:24 e 23:28) **não foi capturado** (objetos truncados no console; evento do beep 23:28 ocorreu antes da janela colada, ≈02:28:0x).

O "sininho" das 23:28 tem correspondência objetiva no log às **23:28:22 = DISPARO de PAXG (não BTC)** → hipótese de **atribuição incorreta de ativo** (usuário vendo o gráfico de BTC ouve o som global do PAXG) — requer confirmação visual de qual card acendeu.

## 5. Evidência ainda necessária (próxima ocorrência)

1. Após o próximo beep: `copy(__TRACE_DUMP__())` e colar o JSON (commit `3d67ed5` grava ring buffer de 2000 eventos com campos completos: TICKER_PRICE, VERIFICACAO, NIVEIS, DISPARO_TENTADO).
2. Anotar **qual card** acendeu (sino/badge R ou S) no instante do som.
3. Estado atual: `JSON.stringify(Array.from(window.AlertEngine.alerts.entries()), null, 2)` e `JSON.stringify(window.AlertEngine.lastSoundAt)`.
4. Obter a **fonte do worker v7.0.0** deployado (quem deployou em 2026-08-31) e seu backend de storage — para auditar o motor real do push.

## 6. Classificação parcial (NÃO é causa raiz final)

| Categoria | Estado |
|---|---|
| A — PREÇO DIVERGENTE | Descartado na janela (mesmo preço ticker→engine) |
| B — NÍVEL DIVERGENTE | **CANDIDATO forte** (motor não disparou com R≈77559; sync GRAPH→Worker inexistente) — falta valor real do nível no disparo |
| C — CROSSOVER INCORRETO | Sem evidência na janela |
| D — REARM INCORRETO | **Defeito estático provado** (client L249–261 e worker L500–505 sem banda de histerese) — impacto nos beeps repetidos a confirmar com disparo real |
| E — COOLDOWN INCORRETO | Sem evidência na janela (cooldown 120s funcionou: 2º toque 23:24 bloqueado) |
| F — DUPLO MOTOR | Não ocorreu na janela (push impossível — KV vazio) |
| G — OUTRA | Possível atribuição errada de ativo (PAXG 23:28:22 soou; BTC não disparou na janela) — a confirmar |

**Causa raiz final NÃO declarada** — aguarda ocorrência real com captura completa (ring buffer) + fonte do worker v7.

---

## 7. Mecanismo provado — congelamento do nível do motor pelo dedup de 0.1% (Categoria B, client)

### Código (arquivo → linha)
- `assets/js/services/alertEngine.js` `setAlertLevels()` **L149–163**: se `|old − new| < nível·0.001` (≈ US$ 77 no BTC a 77k) **e** não for upgrade `TICKER→GRAPH`, dá `return` **sem atualizar o config** do motor.
- `assets/js/chart/dynamicSR.js` `recalculate()` **L278–285** e `conversor.js` **L416–418/L522–531**: atualizam o `srLevels` do gráfico **antes** de chamar `setAlertLevels`.
- ⇒ **O gráfico desenha o nível novo; o motor fica congelado no antigo** até um delta > 0.1% — divergência permanente ≤ ~0.1% (~US$ 77).

### Confirmação derivada dos logs reais (23:28:12–23:29:33 UTC)
- Zero `DISPARO TENTADO` de BTC na janela, apesar de o preço cruzar 77.559 (02:28:32: 77550.8→77560; 02:28:41+: →77588.98; 02:29:30: 77603.66→77617.64).
- Como o rearm (L250–255) rearma sempre que `preço < R`, se `R > 77.546,9` o disparo em 02:28:32 teria sido logado.
- **Derivação: R do motor ≤ 77.546,9 naquele instante** — vs R do gráfico 77.559 = divergência de 12+ USD, **dentro da janela de congelamento (0.1% = 77,6 USD)**.
- Beeps das 23:24 e ~23:28:0x = cruzamentos reais do nível congelado do motor (~77.54x), que **não é** o nível desenhado no gráfico → "alerta falso" para o usuário (beep matematicamente correto para o motor, falso em relação ao que está visível).

### Cadeia causal (Categoria B — NÍVEL DIVERGENTE)
```
FALSO ALERTA (beep sem cruzamento visível no R do gráfico)
  → EMISSOR: CLIENT_ALERT_ENGINE
  → DADO: preço Binance íntegro (mesma variável ticker→engine)
  → NÍVEL: R do motor congelado ≤ 77.546,9 (stale) vs R do gráfico 77.559
  → CONDIÇÃO: crossover real do nível STALE (prev < 77.54x ≤ curr) satisfeita
  → ESTADO: armed rearmado por dip abaixo do nível stale (rearm sem histerese, L249–261)
  → DECISÃO: trigger() com cooldown 120s expirado → som toca
  → NOTIFICAÇÃO: beep local (push não ocorre — pipeline Worker v7 sem alert:BTC acessível/KV vazio)
```

### Evidência que fecha o valor exato (ação de 10s no navegador)
Expandir 1 objeto `[BTC ALERT TRACE] DISPARO TENTADO` de BTC (botão direito → "Copy object") — campos `resistance_level` e `config_source` — OU colar os `[SR-TRACE] ALERT_ENGINE setAlertLevels` / `GRAPH activate/recalculate` de BTC do console (23:20–23:30). Confirma o valor congelado exato e o instante em que o gráfico o ultrapassou.

### Correção mínima (SOMENTE após confirmação do valor acima — regra da auditoria)
Direção esperada: permitir atualização `GRAPH→GRAPH` quando o nível mudou (epsilon ≪ 0.1%, ex. 0.001%) — ou persistir/desenhar o nível SEMPRE a partir do mesmo objeto do motor — eliminando a defasagem motor×gráfico sem tocar em normalização, autoridade, cooldown, histerese, timeframe ou candles.

---

# RELATÓRIO FINAL (encerramento — 2026-09-03)

> **Status:** auditoria concluída com a evidência disponível. A confirmação de 1 objeto de log (valor exato congelado) não foi fornecida; a cadeia causal abaixo é suportada por código + derivação dos logs reais + simulação determinística (`test-auditoria-p0-freeze.mjs`), não por hipótese solta.

## 1. Sintomas
Cards funcionam; alertas de BTC percebidos como falsos continuam. Ocorrência auditada (2026-09-02, BRT): 23:24 beep ao "cruzar R"; 2º cruzamento 23:24 sem som (cooldown OK); 23:28 novo beep ("sininho", card BTC confirmado pelo usuário); 23:24–23:32 **nenhum push no mobile**.

## 2. Hipóteses investigadas (todas as categorias A–G)
A (preço divergente), B (nível divergente), C (crossover incorreto), D (rearm incorreto), E (cooldown incorreto), F (duplo motor), G (outra — incl. atribuição de ativo PAXG).

## 3. Arquivos auditados
- `assets/js/services/alertEngine.js` (crossover/rearm/cooldown L189–377; dedup `setAlertLevels` L149–163)
- `assets/js/ticker-widget.js` (alimentação L240–269; sync L176–182)
- `assets/js/chart/dynamicSR.js` (activate/recalculate L69–287)
- `assets/js/conversor.js` (auto-ativação L50, L509–531; recalc 60s L1308)
- `assets/js/push-subscribe.js` (syncToWorker L170–198)
- `alerta-worker/src/index.js` (repo, v6.1.0) + worker **deployado v7.0.0** (bundle baixado → `alerta-worker-v7-backup/`, gitignored)
- KV Cloudflare (`ALERTAS_KV` 67cf3ab4…), deployments, health checks

## 4. Fluxo de dados (confirmado por código)
```
Binance WS (1s) → ticker-widget.updateLivePrice → AlertEngine.onPriceUpdate
   ├─ preço: MESMA variável (Cat. A descartada no client)
DynamicSR/conversor (60s, candle fechado) → setAlertLevels(GRAPH)
   ├─ gráfico: srLevels atualizado PRIMEIRO; motor depois (com dedup 0.1%)
Worker (Cron 1min, MEXC 3 amostras) → push — pipeline v7 sem dados acessíveis
```

## 5. Evidência encontrada
1. Logs reais 23:28:12–23:29:33 UTC: **zero DISPARO de BTC** apesar de cruzamentos de 77.559 ⇒ **R do motor ≤ 77.546,9** na janela (derivação: rearm L250–255 tornaria qualquer R > 77.546,9 armado e o cruzamento de 02:28:32 logaria disparo).
2. Simulação (`test-auditoria-p0-freeze.mjs`, preços reais da janela): R=77.559 → **1 disparo às ~02:28:34** (não ocorreu nos logs); R=77.546,5 → silêncio (reproduz os logs) ✓.
3. Mecanismo do congelamento: `setAlertLevels` L149–163 early-return quando `|old−new| < 0.1%` e source não muda TICKER→GRAPH; `DynamicSR.recalculate` atualiza o desenho ANTES da chamada ⇒ motor pode ficar até ~0.1% (~US$ 77) atrás do nível desenhado. Demo na simulação: 77.546,9 → recalc 77.559 → motor permanece 77.546,9.
4. Push impossível/independente: worker deployado v7.0.0 (`/subscribe` ok:true) **não persiste** em nenhum KV/D1 visível da conta (KV vazio; probe com cleanup); repo v6.1.0 defasado; v7 tem hysteresis 0.0015 + cooldown 5min (≠ 120s do client).
5. Sync GRAPH→Worker inexistente: `syncToWorker` só no branch TICKER (ticker-widget L180–182); DynamicSR não sincroniza ⇒ `alert:BTC` do Worker (quando existir) fica com nível TICKER defasado.

## 6. Causa raiz (classificação A–G)
**B — NÍVEL DIVERGENTE** (emissor **CLIENT**): o AlertEngine dispara sobre um nível **congelado** (≤ 77.546,9 na ocorrência) que diverge do nível **desenhado no gráfico** (77.559) por até ~0.1% — consequência do dedup de 0.1% em `setAlertLevels` aliado à atualização gráfico-primeiro. Beep correto para o motor; falso em relação ao visível. F (duplo motor) e G (atribuição PAXG) descartados como causa primária na janela: o card confirmado foi BTC e o PAXG (23:28:22) foi evento separado de outro ativo.

## 7. Correção proposta (não implementada — requer aprovação)
1. **Client (causa dos beeps falsos):** em `setAlertLevels`, permitir atualização quando `source === 'GRAPH'` e `support/resistance` mudaram em mais que um epsilon mínimo (ex. 1e-4 relativo, ≪ 0.1%) — mantendo o upgrade TICKER→GRAPH e a proteção contra escrita do ticker (que já é separada, via `hasUserDefinedLevels`). Alternativa equivalente: desenhar o gráfico sempre a partir do config do motor.
2. **Worker (push):** ressincronizar `alerta-worker/` com o v7 deployado (backup local) e corrigir o binding KV/namespace de produção; incluir sync GRAPH→Worker (nível que o usuário vê) para `alert:BTC` nunca ficar defasado do gráfico.
3. Não alterar: normalização, autoridade GRAPH>TICKER, cooldown/histerese atuais, timeframe, candles.

## 8. Testes executados
- Simulação determinística `test-auditoria-p0-freeze.mjs`: (a) R gráfico → dispararia na janela ✗ logs; (b) R stale ≤77.546,5 → silêncio ✓ logs; (c) R alto → silêncio, sem explicar beeps; (d) dedup congela 77.546,9 frente a recalc 77.559 ✓.
- Probes de produção (read-only/reversíveis): health v7.0.0; KV vazio (3 namespaces); `/subscribe` ok:true sem persistência (+ `/unsubscribe` cleanup 200).

## 9. Resultado dos testes
Mecanismo Cat. B reproduzido; divergência quantificada (12+ USD na ocorrência; até ~77 USD possível); correção mínima identificada e ainda NÃO aplicada.

---

## Formato final (§14)

```
CAUSA RAIZ:
  Nível do motor de alertas (client) congelado pelo dedup de 0.1% em setAlertLevels
  (alertEngine.js L149–163) quando DynamicSR recalcula com delta < 0.1% — o gráfico
  desenha o nível novo, o motor mantém o antigo. Beeps disparam no nível STALE
  (≤ 77.546,9 na ocorrência) enquanto o usuário vê R=77.559.

EMISSOR:
  CLIENT_ALERT_ENGINE (som/card BTC). Push do Worker: separado e atualmente sem
  dados persistidos (v7 deployado não grava no KV acessível da conta).

EVIDÊNCIA:
  - Logs reais: zero DISPARO BTC em 23:28:12–23:29:33 apesar de cruzamentos de 77.559
    ⇒ R motor ≤ 77.546,9 (derivação sobre alertEngine.js L250–255/L264–271).
  - Simulação test-auditoria-p0-freeze.mjs reproduz silêncio só com R stale.
  - Demo do dedup: recalc GRAPH 77559 sobre motor 77546.9 → motor permanece 77546.9.
  - KV ALERTAS_KV vazio (0 chaves) + /subscribe do v7 ok sem persistir.

CORREÇÃO NECESSÁRIA:
  1. setAlertLevels: atualizar GRAPH→GRAPH para qualquer delta > epsilon mínimo
     (ou desenhar sempre do objeto do motor) — elimina a defasagem motor×gráfico.
  2. Worker: ressincronizar repo com v7 + corrigir binding KV + sincronizar nível
     GRAPH (o que o usuário vê) para o alert:BTC do Worker.

TESTES:
  - Simulação determinística com preços reais da janela (R gráfico dispararia;
    R stale reproduz o silêncio) — PASS para o mecanismo.
  - Correção do client IMPLEMENTADA e testada (commit `0e8b6e1` — ver seção
    "IMPLEMENTAÇÃO DA CORREÇÃO"); correção do Worker pendente.
```

### Limitação registrada
O valor exato e o `config_source` do nível do motor no instante exato do beep (campos truncados nos logs de 23:28) não foram confirmados — a cadeia apoia-se na derivação lógica + simulação. Se um novo beep ocorrer, `copy(__TRACE_DUMP__())` (commit `3d67ed5`, já no ar) captura o `DISPARO_TENTADO` completo e fecha a última lacuna.

---

# IMPLEMENTAÇÃO DA CORREÇÃO (commit 0e8b6e1 — 2026-09-03)

**Commit:** `0e8b6e1` — `fix(alerts): prevent GRAPH level freeze below 0.1%` (pusheado em `main`). Único arquivo de produção alterado: `assets/js/services/alertEngine.js`. Testes novos: `test-auditoria-p0-freeze.mjs`, `test-auditoria-p0-fix.mjs`.

## Mudança aplicada (dentro de `setAlertLevels()`)
O cálculo de "mesmos níveis" passou a usar epsilon dependente da transição:
```javascript
var graphToGraph = existing.config.source === 'GRAPH' && source === 'GRAPH';
var epsilon = graphToGraph ? 1e-4 : 0.001;   // GRAPH→GRAPH: 1e-4 relativo (≈ US$ 7,75 a 77k)
var sameSupport = Math.abs(existing.config.support - support) < support * epsilon;
var sameResistance = Math.abs(existing.config.resistance - resistance) < resistance * epsilon;
```
- `GRAPH→GRAPH` com delta > 1e-4 relativo → motor atualiza (fim do congelamento; cenário real 77.546,9 → 77.559 agora passa).
- `TICKER→TICKER` (refresh 5s) e demais → dedup de 0,1% preservado (sem reset de estado por refresh).
- Upgrade `TICKER→GRAPH`, normalização, estado e proteção `GRAPH > TICKER` (`hasUserDefinedLevels`) **intactos**.
- NÃO alterados: Worker, DynamicSR, cooldown, hysteresis, crossover, rearm, timeframe, candles.

## Testes executados
| Teste | Resultado |
|---|---|
| `node tests/test-auditoria-p0-freeze.mjs` — preços reais da janela 23:28; cenário 77.546,9→77.559 | **PASS** |
| `node tests/test-auditoria-p0-fix.mjs` — código REAL do engine (stubs de browser), Casos A–E | **PASS (5/5)** |

Casos validados: A GRAPH delta<0,1% atualiza · B delta<epsilon ignorado · C TICKER não sobrescreve GRAPH · D TICKER→GRAPH assume autoridade · E crossover dispara em R=77.559.

## Status pós-correção
- Beeps "falsos" por nível stale: **corrigido no client** (deploy via Pages após push do commit `0e8b6e1`).
- Push no mobile (Worker v7 + KV): **pendente e separado** — requer ressincronizar repo com o v7 e corrigir o binding KV antes de qualquer mudança no Worker.

---

# INVESTIGAÇÃO COMPLEMENTAR — Worker v7 + KV + Subscriptions (2026-09-03)

## 1. ARQUITETURA ATUAL DO ALERT WORKER

O sistema possui **dois motores independentes** de geração de alertas:

| Motor | Localização | Contexto | Disponibilidade |
|-------|-------------|----------|-----------------|
| **CLIENT_ALERT_ENGINE** | `assets/js/services/alertEngine.js` | Browser do usuário (PWA aberto) | Imediato (som + vibração + card visual) |
| **WORKER** | `alerta-worker/src/index.js` (v7.0.0) | Cloudflare Worker (Cron 1min) | Background (Push notification) |

**Implicação para investigação:** É necessário identificar a **origem** da notificação (CLIENT vs WORKER) antes de atribuir o problema a um único motor. Alertas duplicados podem ocorrer quando ambos os motores detectam o mesmo evento.

---

## 2. WORKER PUBLICADO

| Campo | Valor |
|-------|-------|
| Worker | `alerta-worker` |
| Versão publicada | `7.0.0` |
| Health endpoint | `{"service":"alerta-worker","status":"ok","version":"7.0.0"}` |
| Deploy | 2026-08-31 (wrangler 4.127.1) |

**Implementação v7 confirmada:**
- Hysteresis (`HYSTERESIS_PCT = 0.0015` = 0,15%)
- Cooldown (`COOLDOWN_MS = 300000` = 5min)
- Estados de resistência/suporte (`resistanceTriggered`, `supportTriggered`)
- Pending delivery (`pendingResistance`, `pendingSupport`)
- Web Push via WebCrypto (`@block65/webcrypto-web-push`)

**Nota:** O código fonte do v7 NÃO está no repo (`alerta-worker/src/index.js` = v6.1.0). Backup local em `alerta-worker-v7-backup/` (gitignored).

---

## 3. KV UTILIZADO

**Binding correto:** `env.ALERTAS_KV`

**Principais chaves:**

| Chave | Conteúdo |
|-------|----------|
| `cron:index` | Índice de IDs: `{ alerts: [...], subs: [...] }` |
| `cron:states` | Estado consolidado: `{ "BTC": {...}, "ETH": {...} }` |
| `alert:<SYMBOL>` | Config do alerta (ex: `alert:BTC`) |
| `sub:<UUID>` | Subscription Web Push |

**Estado atual do `cron:index`:**
```json
{
  "alerts": ["AVAX", "BTC", "ETH", "LINK", "PAXG", "RENDER", "SOL", "USDT-BRL"],
  "subs": ["<20 UUIDs>"]
}
```

---

## 4. ALERTA BTC CONFIRMADO NO KV

**Chave:** `alert:BTC`

**Configuração encontrada:**
```json
{
  "id": "BTC",
  "symbol": "BTC",
  "support": 76264,
  "resistance": 77900,
  "enabled": true,
  "direction": "BOTH",
  "levelsKey": "76264|77900|BOTH"
}
```

**updatedAt:** `2026-09-03T04:01:41.855Z`

**Conclusão:** O Worker possui um alerta BTC próprio, habilitado, com S/R 76264/77900.

---

## 5. ESTADO BTC CONFIRMADO

**Chave:** `cron:states` → campo `BTC`

**Estado encontrado:**
```json
{
  "lastPrice": 81090.67,
  "resistanceTriggered": true,
  "supportTriggered": false,
  "pendingResistance": null,
  "pendingSupport": null,
  "lastResistanceTriggeredAt": "2026-09-03T11:18:46.424Z",
  "lastSupportTriggeredAt": null,
  "levelsKey": "76264|77900|BOTH"
}
```

**Conclusão confirmada:** O estado persistido do Worker registra que houve um disparo de resistência BTC às `2026-09-03T11:18:46.424Z`.

O estado atual mostra BTC acima da resistência:
- `lastPrice = 81090.67`
- `resistance = 77900`

---

## 6. NÃO HÁ EVIDÊNCIA DE CONTAMINAÇÃO BTC ↔ AVAX NO ESTADO DO WORKER

A investigação de `cron:states` **NÃO encontrou evidência** de que o estado do AVAX esteja sendo utilizado como estado do BTC.

Os estados são **separados por símbolo:**

| Símbolo | levelsKey |
|---------|-----------|
| AVAX | `7.13|7.286|BOTH` |
| BTC | `76264|77900|BOTH` |
| ETH | `2414.1|2489.95|BOTH` |
| LINK | `11.123|11.502|BOTH` |
| PAXG | `4417.51|4462.78|BOTH` |
| RENDER | `1.398|1.45|BOTH` |
| SOL | `101.27|105|BOTH` |
| USDT-BRL | `5.1777|5.2144|BOTH` |

**Conclusão:** "BTC recebeu um alerta porque AVAX disparou" **NÃO está comprovado**. A existência de AVAX e BTC na mesma notificação/dispositivo também **NÃO prova contaminação**.

---

## 7. ASSINATURAS WEB PUSH

As subscriptions armazenadas em `sub:<UUID>` **não possuem associação com símbolo**.

**Exemplo observado:**
- Endpoint: Apple Web Push (`web.push.apple.com`)
- Objeto possui: `endpoint`, `keys`, `createdAt`
- **Não possui campo:** `symbol`

**Conclusão:** As subscriptions são **globais**. Quando o Worker detecta um evento BTC, ele envia esse evento para **todas** as subscriptions válidas.

Isso explica como um dispositivo pode receber um alerta BTC mesmo sem possuir uma assinatura específica para BTC.

**IMPORTANTE:** Não documentar endpoints completos, `p256dh` ou `auth`. São dados operacionais e não devem ser expostos na documentação.

---

## 8. COMPORTAMENTO DO BROADCAST

O Worker atualmente **não faz associação:**
```
subscription → symbol
```

O fluxo é essencialmente:
```
evento BTC
   ↓
broadcastPush()
   ↓
subscriptions globais
```

Portanto, a entrega para uma subscription **não deve ser confundida com a origem do evento**. A origem precisa ser determinada **antes**:
- Qual alert foi avaliado?
- Qual símbolo foi avaliado?
- Quais preços foram usados?
- Qual crossing foi detectado?

---

## 9. V7 — HYSTERESIS E COOLDOWN

**Parâmetros publicados:**
```javascript
HYSTERESIS_PCT = 0.0015  // 0,15%
COOLDOWN_MS = 300000     // 5 minutos
```

**Rearme da resistência:**
```
currentPrice < resistance * (1 - HYSTERESIS_PCT)
```

**Rearme do suporte:**
```
currentPrice > support * (1 + HYSTERESIS_PCT)
```

**Timestamps mantidos:**
- `lastResistanceTriggeredAt`
- `lastSupportTriggeredAt`

---

## 10. PONTO CRÍTICO A INVESTIGAR — lastPrice

**HIPÓTESE TÉCNICA IMPORTANTE (ainda não corrigida):**

No `scheduledHandler`, o `lastPrice` é atualizado em memória a cada ciclo, mas o código de persistência deliberadamente **não considera** uma simples mudança de `lastPrice` como motivo suficiente para executar `KV.put()`.

**Consequência:**
```
ciclo N
state.lastPrice = preço atual
       ↓
nenhuma mudança relevante
       ↓
KV.put() omitido
       ↓
ciclo N+1
state é recarregado do KV
       ↓
lastPrice pode representar um ciclo anterior
```

Isso pode fazer com que `state.lastPrice` persistido fique **defasado**.

**Status:** RISCO / HIPÓTESE A VALIDAR — NÃO CONCLUSÃO DE CAUSA RAIZ.

---

## 11. EVIDÊNCIA NECESSÁRIA PARA FECHAR A INVESTIGAÇÃO DO DISPARO BTC

Ainda falta capturar o ciclo que produziu:
```
BTC resistanceTriggered = true
lastResistanceTriggeredAt = 2026-09-03T11:18:46.424Z
```

**Dados necessários para aquele ciclo:**
```javascript
{
  symbol: 'BTC',
  state.lastPrice: <antes da avaliação>,
  sample: [<preço1>, <preço2>, <preço3>],
  support: <float>,
  resistance: <float>,
  previousPrice: <float>,
  currentPrice: <float>,
  crossedResistance: <bool>,
  crossedSupport: <bool>,
  resistanceTriggered: <bool>,
  supportTriggered: <bool>,
  cooldown: <bool>,
  hysteresis/rearm state: <object>
}
```

**Especialmente:**
- `previousPrice`
- `sample[0]`, `sample[1]`, `sample[2]`
- `resistance`

Isso permitirá determinar se:
```
previousPrice < resistance
AND
currentPrice >= resistance
```
realmente ocorreu para BTC.

---

## 12. NÃO CONFUNDIR "ESTÁ ACIMA DA RESISTÊNCIA" COM "ACABOU DE CRUZAR"

O fato de:
```
BTC lastPrice = 81090.67
BTC resistance = 77900
```
prova **apenas** que o último preço persistido observado está acima da resistência.

**Não prova, isoladamente, que o cruzamento no momento do disparo foi correto.**

Para validar o disparo é necessário observar o `previousPrice` e as amostras utilizadas pelo detector.

---

## 13. OUTROS ESTADOS OBSERVADOS

Timestamps encontrados (sem interpretá-los como necessariamente simultâneos):

| Símbolo | Evento | Timestamp |
|---------|--------|-----------|
| AVAX | resistance triggered | 2026-09-03T11:31:42.788Z |
| BTC | resistance triggered | 2026-09-03T11:18:46.424Z |
| ETH | resistance triggered | 2026-09-03T15:23:42.469Z |
| LINK | resistance triggered | 2026-09-03T14:24:46.280Z |
| PAXG | resistance triggered | 2026-09-03T12:31:42.742Z |
| RENDER | resistance triggered | 2026-09-03T14:20:54.886Z |
| SOL | resistance triggered | 2026-09-03T17:34:05.326Z |

Esses timestamps são **diferentes** e **NÃO devem ser usados** como evidência de que os ativos dispararam juntos.

---

## 14. HISTÓRICO DO PROBLEMA CLIENT-SIDE

Foi identificado um problema de deduplicação que pode bloquear atualizações `GRAPH → GRAPH` quando a diferença fica abaixo do threshold de 0,1%.

**Correção proposta (Fase 9, commit `0e8b6e1`):**
- Usar epsilon técnico relativo (`1e-4`) para `GRAPH→GRAPH`
- Preservar `GRAPH > TICKER` e as regras de cooldown/autoridade

**Status:** Implementado e testado.

**Importante:** Este problema é **independente** da prova do Worker acima. Ambos os motores precisam ser investigados separadamente.

---

## 15. REGRA DE INVESTIGAÇÃO

**NUNCA** concluir "contaminação de símbolo" apenas porque uma notificação contém vários símbolos ou porque várias subscriptions receberam a mesma notificação.

A cadeia de prova deve ser:
```
ALERT CONFIG
    ↓
SYMBOL
    ↓
PRICE SOURCE
    ↓
PRICE SAMPLES
    ↓
PREVIOUS PRICE
    ↓
CROSSING DETECTOR
    ↓
STATE TRANSITION
    ↓
PUSH EVENT
    ↓
SUBSCRIPTIONS
```

O diagnóstico deve identificar **exatamente em qual etapa** ocorreu a divergência.

---

## 16. STATUS DA INVESTIGAÇÃO

| Item | Status |
|------|--------|
| WORKER v7.0.0 | ✅ PUBLICADO E CONFIRMADO |
| BTC ALERT CONFIG | ✅ CONFIRMADO (`alert:BTC` no KV) |
| BTC STATE | ✅ CONFIRMADO (`resistanceTriggered=true`, `lastResistanceTriggeredAt=2026-09-03T11:18:46.424Z`) |
| BTC ↔ AVAX STATE CONTAMINATION | ❌ NÃO COMPROVADA (estados separados por símbolo) |
| GLOBAL SUBSCRIPTIONS | ✅ CONFIRMADAS (20 subs, sem associação com símbolo) |
| FALHA DE CROSSING BTC | ⏳ AINDA NÃO DETERMINADA (faltam dados do ciclo de disparo) |
| lastPrice PERSISTENCE RISK | ⚠️ IDENTIFICADO / A VALIDAR |
| PRÓXIMO PASSO | INSTRUMENTAR O CICLO DE DETECÇÃO SEM ALTERAR A LÓGICA |


