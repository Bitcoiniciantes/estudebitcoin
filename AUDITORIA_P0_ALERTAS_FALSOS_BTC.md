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


