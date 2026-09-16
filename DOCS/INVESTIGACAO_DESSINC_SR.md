# INVESTIGAÇÃO — DESSINCRONIZAÇÃO S/R

**Data:** 2026-09-02  
**Status:** EM ANDAMENTO — Logs de diagnóstico adicionados

---

## 1. RASTREAMENTO DE ESCRITAS EM `AlertEngine.setAlertLevels`

### Chamadores identificados:

#### A. `dynamicSR.js` — Gráfico (2 pontos)

**Linha 106** — `activate()`
```javascript
window.AlertEngine.setAlertLevels(symbol, result.support, result.resistance);
```

**Contexto:**
- Chamado quando usuário clica no botão S/R no gráfico
- Usa as últimas 20 velas **FECHADAS** (exclui vela em formação)
- Cálculo:
  - `resistance = Math.max(...recent.map(x => x.high))`
  - `support = Math.min(...recent.map(x => x.low))`
- Timeframe: conforme selecionado no gráfico (1D, 1W, 1M, 3M, 1Y, ALL)

**Linha 252** — `recalculate()`
```javascript
window.AlertEngine.setAlertLevels(symbol, result.support, result.resistance);
```

**Contexto:**
- Chamado quando usuário troca de ativo enquanto S/R Dinâmico está ativo
- Mesma lógica de cálculo que `activate()`
- Recalcula S/R para o novo símbolo

**Frequência:**
- `activate()`: 1x por clique no botão S/R
- `recalculate()`: 1x por troca de ativo com S/R ativo

---

#### B. `ticker-widget.js` — Cards de Cotação

**Linha 161** — `fetchCrypto()` → loop por símbolo
```javascript
window.AlertEngine.setAlertLevels(symbol, srResult.support, srResult.resistance);
```

**Contexto:**
- Chamado a cada **5 segundos** (linha 330: `window.setInterval(function () { refresh(true); }, 5000);`)
- Calcula S/R para **TODOS os 8 criptoativos** em paralelo:
  - BTC, ETH, SOL, LINK, AVAX, RENDER, PAXG, USDT-BRL
- Usa a mesma função `window.DynamicSR.calculateSR(candles)`
- Configuração de candles (linha 44-49):
  ```javascript
  var KLINE_CFG = {
    "1h": { interval: "1h", limit: 12, baseFromPrev: true },
    "24h": { interval: "1h", limit: 25 },
    "7d": { interval: "1d", limit: 8 },
    "30d": { interval: "1d", limit: 31 },
  };
  ```
- **Janela ativa padrão:** `"24h"` → 25 velas de 1h

**⚠️ POTENCIAL SOBRESCRITA DETECTADA:**

```javascript
// Linha 149-166
if (window.DynamicSR && window.AlertEngine && klines.length >= 3) {
  // PATCH A: se DynamicSR está ativo para ESTE símbolo, o gráfico é a fonte de verdade
  var srActive = window.DynamicSR.isActive() && window.DynamicSR.getSymbol() === symbol;
  if (srActive) {
    console.log('[SR TRACE] TICKER SKIPPED symbol=' + symbol + ' reason=GRAPH_ACTIVE');
  } else {
    var candles = klines.map(function (row) {
      return { high: Number(row[2]), low: Number(row[3]) };
    });
    var srResult = window.DynamicSR.calculateSR(candles);
    if (srResult) {
      console.log('[SR TRACE] TICKER UPDATE symbol=' + symbol + ' support=' + srResult.support + ' resistance=' + srResult.resistance);
      window.AlertEngine.unlockAudio();
      window.AlertEngine.setAlertLevels(symbol, srResult.support, srResult.resistance);
```

**Descoberta crítica:**
- **EXISTE proteção "PATCH A"** que verifica se o gráfico está ativo para aquele símbolo
- Se `DynamicSR.isActive() && DynamicSR.getSymbol() === symbol`, o ticker **NÃO sobrescreve**
- Se o gráfico estiver em outro símbolo ou desativado, o ticker **SOBRESCREVE A CADA 5s**

**Frequência:**
- A cada 5 segundos
- Para cada um dos 8 criptoativos (exceto o que está ativo no gráfico)

---

## 2. DIVERGÊNCIA ESPERADA ENTRE GRÁFICO E TICKER

### Configuração de candles:

| Fonte | Candles usados | Timeframe | Vela em formação |
|-------|----------------|-----------|------------------|
| **Gráfico** | 20 velas FECHADAS | Selecionado pelo usuário (1D, 1W, 1M, etc.) | EXCLUÍDA |
| **Ticker** | Depende da janela ativa | `"24h"` = 25 velas de 1h | INCLUÍDA (array completo) |

**⚠️ PROBLEMA IDENTIFICADO:**

1. **Timeframe diferente:**
   - Gráfico usa timeframe longo (ex: 1D, 1W)
   - Ticker usa 1h (janela "24h" ativa por padrão)
   - **Níveis S/R calculados em janelas temporais completamente diferentes**

2. **Quantidade de candles diferente:**
   - Gráfico: 20 velas FECHADAS
   - Ticker janela "24h": 25 velas de 1h

3. **Sobrescrita a cada 5s:**
   - Mesmo que o gráfico esteja ativo em BTC, ao trocar para ETH, o ticker sobrescreve ETH a cada 5s
   - Ao voltar para BTC, o ticker sobrescreve BTC a cada 5s (porque gráfico ficou em ETH)

---

## 3. ESTADO INTERNO DO ALERT ENGINE

### Implementação verificada:

```javascript
AlertEngine.prototype.setAlertLevels = function (symbol, support, resistance) {
  // Validação
  if (!Number.isFinite(support) || !Number.isFinite(resistance)) return;

  // Se já existe alerta com mesmos níveis (tolerância 0.1%), não resetar estado
  var existing = this.alerts.get(symbol);
  if (existing && existing.active) {
    var sameSupport = Math.abs(existing.support - support) < support * 0.001;
    var sameResistance = Math.abs(existing.resistance - resistance) < resistance * 0.001;
    if (sameSupport && sameResistance) return; // ← SHORT-CIRCUIT: não reseta estado
  }

  // Cria/reseta estado do alerta
  this.alerts.set(symbol, {
    support: support,
    resistance: resistance,
    active: true,
    supportTriggered: false,
    resistanceTriggered: false,
    armedSupport: true,
    armedResistance: true,
    lastPrice: existing ? existing.lastPrice : null, // ← preserva lastPrice
    visualAlert: false
  });
```

**Comportamento:**
- Se os níveis mudarem > 0.1%, o estado é **COMPLETAMENTE RESETADO**:
  - `supportTriggered = false`
  - `resistanceTriggered = false`
  - `armedSupport = true`
  - `armedResistance = true`
  - `visualAlert = false`
- `lastPrice` é preservado para evitar disparo imediato

**Implicação:**
- Se ticker sobrescrever com níveis diferentes > 0.1%, o alerta visual some dos cards

---

## 4. RELAÇÃO ENTRE PUSH E ALERTA LOCAL

### Integração verificada em `push-subscribe.js`:

```javascript
function activateAlertEngine() {
  if (window.AlertEngine && window.AlertEngine.unlockAudio) {
    window.AlertEngine.unlockAudio();
  }
}

function deactivateAlertEngine() {
  if (window.AlertEngine && window.AlertEngine.disableAll) {
    window.AlertEngine.disableAll();
  }
}
```

**Comportamento:**
- Sino ON → `activateAlertEngine()` → apenas desbloqueia áudio
- Sino OFF → `deactivateAlertEngine()` → **`AlertEngine.disableAll()`**

```javascript
AlertEngine.prototype.disableAll = function () {
  this.alerts.clear(); // ← LIMPA TODOS OS ALERTAS
  this.lastSoundAt = {};
};
```

**⚠️ PROBLEMA CONFIRMADO:**
- Sino OFF limpa **TODOS** os alertas de **TODOS** os símbolos
- Ticker não reativa alertas porque:
  ```javascript
  if (isCrypto(symbol) && window.AlertEngine && window.PushSubscribe && window.PushSubscribe.isEnabled()) {
    window.AlertEngine.onPriceUpdate(symbol, price);
  }
  ```
  Condição `window.PushSubscribe.isEnabled()` retorna `false` quando sino está OFF

---

## 5. SINO DOS CARDS — HANDLER AUSENTE

### Código do sino no `ticker-widget.js`:

```javascript
var bell = isCrypto(quote.symbol)
  ? '<button class="tq-bell" data-bell="' + esc(symbolKey(quote.symbol)) + '" aria-label="Dispensar alerta" title="Dispensar alerta">&#128276;</button>'
  : '';
```

### Busca por handler:

```bash
grep -r "addEventListener.*click.*bell" assets/js/
grep -r "click.*tq-bell" assets/js/
grep -r ".tq-bell" assets/js/ticker-widget.js
```

**Resultado:** NENHUM handler de clique registrado para `.tq-bell`

**⚠️ PROBLEMA CONFIRMADO:**
- Botão sino existe no HTML
- **NENHUM** event listener registrado
- Clique no sino não tem efeito (ou é capturado pelo handler do card pai)

**Handler do card:**
```javascript
grid.addEventListener("click", function (event) {
  var cardEl = event.target.closest(".tq");
  if (!cardEl) return;
  // ... lógica de clique no card (carrega ativo no gráfico)
```

**Provável causa:**
- Clique no sino propaga para o card
- Card interpreta como "carregar ativo no gráfico"
- Sino não tem `event.stopPropagation()`

---

## 6. WORKER E SINCRONIZAÇÃO

### Verificado em `ticker-widget.js` (linha 162-164):

```javascript
if (symbol === 'BTC' && window.PushSubscribe && window.PushSubscribe.isEnabled() && window.PushSubscribe.syncToWorker) {
  window.PushSubscribe.syncToWorker(symbol, srResult.support, srResult.resistance, last);
}
```

**Confirmado:**
- Sincronização restrita a `symbol === 'BTC'`
- Outros ativos (ETH, SOL, LINK, etc.) **NÃO sincronizam** com Worker
- Apenas BTC envia níveis S/R para o backend

---

## 7. LOGS DE DIAGNÓSTICO ADICIONADOS

Para prova factual da sobrescrita, foram adicionados logs temporários:

### `alertEngine.js` (linha 72-80):
```javascript
console.log('[SR-TRACE] ALERT_ENGINE setAlertLevels', {
  source: 'ALERT_ENGINE',
  symbol: symbol,
  support: support,
  resistance: resistance,
  timestamp: Date.now()
});
```

### `dynamicSR.js` (linhas 95-103 e 248-256):
```javascript
console.log('[SR-TRACE] GRAPH activate/recalculate', {
  source: 'GRAPH',
  symbol: symbol,
  support: result.support,
  resistance: result.resistance,
  timeframe: timeframe,
  timestamp: Date.now()
});
```

### `ticker-widget.js` (linha 160 — JÁ EXISTIA):
```javascript
console.log('[SR TRACE] TICKER UPDATE symbol=' + symbol + ' support=' + srResult.support + ' resistance=' + srResult.resistance);
```

**Logs também existentes:**
- Linha 154: `console.log('[SR TRACE] TICKER SKIPPED symbol=' + symbol + ' reason=GRAPH_ACTIVE');`

### `ticker-widget.js` (linhas 383-399 — HANDLER TEMPORÁRIO DO SINO):
```javascript
// [TEMP DIAGNÓSTICO] Handler do sino para confirmar propagação de evento
grid.addEventListener("click", function (event) {
  var bellEl = event.target.closest(".tq-bell");
  if (bellEl) {
    event.stopPropagation(); // Evitar clique no card pai
    var symbol = bellEl.getAttribute("data-bell");
    console.log('[DIAGNÓSTICO] Clique no sino detectado:', symbol);
    if (window.AlertEngine && window.AlertEngine.dismissVisualAlert) {
      window.AlertEngine.dismissVisualAlert(symbol);
      console.log('[DIAGNÓSTICO] AlertEngine.dismissVisualAlert() chamado para:', symbol);
    } else {
      console.error('[DIAGNÓSTICO] AlertEngine.dismissVisualAlert NÃO disponível');
    }
    return;
  }
});
```

**Objetivo:**
- Confirmar se clique no sino é capturado
- Testar se `dismissVisualAlert()` funciona corretamente
- Evitar propagação para card pai com `stopPropagation()`

---

## 8. PRÓXIMOS PASSOS

1. **Deploy local + observação em navegador:**
   - Abrir console do navegador
   - Ativar S/R no gráfico para BTC
   - Observar sequência de logs `[SR-TRACE]` durante 30-60 segundos
   - Trocar para ETH e observar se BTC continua sendo sobrescrito pelo ticker

2. **Confirmar sobrescrita:**
   - Verificar se níveis do gráfico (20 velas fechadas, timeframe selecionado) diferem dos níveis do ticker (25 velas 1h)
   - Verificar timestamp dos logs para confirmar que ticker sobrescreve a cada 5s

3. **Confirmar handler do sino:**
   - Clicar no sino de um card com alerta ativo
   - Verificar se evento propaga para o card pai
   - Confirmar ausência de chamada a `AlertEngine.dismissVisualAlert()`

4. **Documentar divergência S/R:**
   - Capturar valores reais:
     ```
     GRÁFICO BTC (1D, 20 velas):
     support = X
     resistance = Y
     
     TICKER BTC (1h, 25 velas):
     support = A
     resistance = B
     
     ALERT ENGINE (após 10s):
     support = ?
     resistance = ?
     ```

---

## 9. HIPÓTESES A CONFIRMAR

### Hipótese 1: Sobrescrita do ticker
**Status:** PARCIALMENTE CONFIRMADO (proteção "PATCH A" existe, mas só protege símbolo ativo no gráfico)

**Evidência:**
- Código linha 149-166 do `ticker-widget.js`
- Proteção só funciona se `DynamicSR.getSymbol() === symbol`
- Se gráfico está em BTC, ticker sobrescreve ETH/SOL/LINK/etc. a cada 5s
- Se usuário troca gráfico para ETH, ticker passa a sobrescrever BTC a cada 5s

**Teste necessário:**
- Ativar S/R para BTC no gráfico
- Aguardar 10s
- Trocar gráfico para ETH
- Verificar se níveis BTC mudam nos logs

---

### Hipótese 2: Timeframe divergente causa níveis diferentes
**Status:** CONFIRMADO (por análise de código)

**Evidência:**
- Gráfico: timeframe configurável (1D, 1W, 1M, etc.)
- Ticker: sempre 1h (janela "24h" padrão)
- Cálculo idêntico (min/max de low/high), mas sobre janelas temporais diferentes

**Teste necessário:**
- Comparar níveis reais em ambiente de produção
- Confirmar que divergência é > 0.1% (suficiente para resetar estado)

---

### Hipótese 3: Handler do sino ausente
**Status:** CONFIRMADO (por análise de código + grep)

**Evidência:**
- Botão HTML existe
- Zero event listeners registrados
- Clique provavelmente propaga para card pai

**Teste necessário:**
- Clicar no sino com DevTools aberto
- Verificar se `estudebitcoin:load-asset` dispara (evento do card pai)

---

### Hipótese 4: disableAll() excessivamente destrutivo
**Status:** CONFIRMADO (por análise de código)

**Evidência:**
- Sino OFF chama `AlertEngine.disableAll()`
- Limpa alertas de **TODOS** os símbolos
- Ticker não reativa porque `PushSubscribe.isEnabled()` retorna `false`

**Teste necessário:**
- Ativar S/R no gráfico
- Desligar sino
- Verificar se alertas visuais desaparecem de todos os cards

---

## 10. CAUSA RAIZ PRELIMINAR

**Múltiplas causas inter-relacionadas:**

1. **Sobrescrita ticker vs gráfico:**
   - Proteção "PATCH A" só protege símbolo atualmente ativo no gráfico
   - Outros 7 símbolos são sobrescritos a cada 5s
   - Timeframe diferente (1h vs 1D/1W/etc.) causa níveis divergentes > 0.1%
   - Divergência > 0.1% reseta estado do AlertEngine (apaga `visualAlert`)

2. **Sino OFF destrutivo:**
   - `disableAll()` limpa alertas de todos os símbolos
   - Ticker não reativa porque condição `PushSubscribe.isEnabled()` falha
   - Alertas só reativam se usuário clicar no botão S/R do gráfico novamente

3. **Handler do sino ausente:**
   - Clique no sino não tem efeito
   - Usuário não consegue dispensar alerta manualmente
   - Clique provavelmente carrega ativo no gráfico (evento do card pai)

---

## 11. CORREÇÕES NECESSÁRIAS (A IMPLEMENTAR APÓS CONFIRMAÇÃO)

**Não implementar agora. Aguardar confirmação dos testes.**

Possíveis correções:

1. **Unificar fonte de S/R:**
   - Opção A: Gráfico é única fonte de verdade (ticker não calcula S/R)
   - Opção B: Ticker protege todos os símbolos que têm alerta ativo

2. **Separar Push de AlertEngine:**
   - Sino controla apenas Push (Worker)
   - AlertEngine local permanece ativo independentemente

3. **Adicionar handler do sino:**
   - `event.stopPropagation()` para evitar clique no card
   - Chamar `AlertEngine.dismissVisualAlert(symbol)`

4. **Throttle inteligente no ticker:**
   - Só atualizar S/R se divergência > 1% (em vez de 0.1%)
   - Ou: só atualizar se alerta não estiver `visualAlert: true`

---

## CONCLUSÃO PRELIMINAR

**Status da investigação:** EVIDÊNCIAS DOCUMENTADAS, AGUARDANDO CONFIRMAÇÃO EM NAVEGADOR

**Causa mais provável da dessincronização:**
- Ticker sobrescreve níveis S/R a cada 5s com timeframe diferente (1h vs 1D/1W)
- Divergência > 0.1% reseta estado do AlertEngine
- Alerta visual desaparece dos cards

**Causa mais provável do sino não funcionar:**
- Handler de clique não está registrado
- Clique propaga para card pai

**Próximo passo crítico:**
- Fazer deploy local
- Abrir console do navegador
- Observar logs `[SR-TRACE]` durante 60 segundos
- Confirmar sequência temporal e valores de support/resistance
