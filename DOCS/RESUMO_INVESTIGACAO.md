# RESUMO EXECUTIVO — INVESTIGAÇÃO DESSINCRONIZAÇÃO S/R

**Data:** 2026-09-02  
**Investigador:** Kiro AI  
**Status:** EVIDÊNCIAS DOCUMENTADAS — Aguardando confirmação em navegador

---

## OBJETIVO

Determinar com evidência qual componente define os níveis de suporte/resistência efetivamente usados pelo `AlertEngine` e se esses níveis são iguais aos exibidos no gráfico.

---

## DESCOBERTAS CRÍTICAS

### 1. DUPLA FONTE DE S/R CONFIRMADA ✅

Existem **2 componentes** escrevendo níveis S/R no `AlertEngine`:

| Componente | Frequência | Timeframe | Candles | Proteção |
|------------|------------|-----------|---------|----------|
| **Gráfico** (`dynamicSR.js`) | Clique manual no botão S/R | Selecionado pelo usuário (1D, 1W, 1M, etc.) | 20 velas FECHADAS | — |
| **Ticker** (`ticker-widget.js`) | A cada 5 segundos | Fixo: 1h (janela "24h") | 25 velas (inclui formação) | PATCH A: só pula símbolo ativo no gráfico |

**Implicação:**
- Níveis calculados em janelas temporais **completamente diferentes**
- Ticker sobrescreve todos os 7 símbolos que **NÃO** estão ativos no gráfico
- Quando usuário troca de ativo no gráfico, ticker passa a sobrescrever o ativo anterior

---

### 2. PROTEÇÃO "PATCH A" INSUFICIENTE ⚠️

**Código encontrado** (ticker-widget.js, linha 149-166):

```javascript
var srActive = window.DynamicSR.isActive() && window.DynamicSR.getSymbol() === symbol;
if (srActive) {
  console.log('[SR TRACE] TICKER SKIPPED symbol=' + symbol + ' reason=GRAPH_ACTIVE');
} else {
  // SOBRESCREVE S/R
  window.AlertEngine.setAlertLevels(symbol, srResult.support, srResult.resistance);
}
```

**Problema:**
- Proteção funciona **apenas para 1 símbolo por vez** (o ativo no gráfico)
- Outros 7 criptoativos são sobrescritos a cada 5 segundos
- Exemplo:
  1. Usuário ativa S/R para BTC no gráfico (timeframe 1D)
  2. Ticker sobrescreve ETH, SOL, LINK, AVAX, RENDER, PAXG, USDT-BRL a cada 5s (timeframe 1h)
  3. Usuário troca gráfico para ETH
  4. Ticker passa a sobrescrever BTC a cada 5s (timeframe 1h)
  5. Níveis S/R do gráfico (1D) são perdidos

---

### 3. DIVERGÊNCIA S/R CAUSA RESET DO ESTADO ✅

**AlertEngine.setAlertLevels()** (linha 67-88):

```javascript
// Se já existe alerta com mesmos níveis (tolerância 0.1%), não resetar estado
var existing = this.alerts.get(symbol);
if (existing && existing.active) {
  var sameSupport = Math.abs(existing.support - support) < support * 0.001;
  var sameResistance = Math.abs(existing.resistance - resistance) < resistance * 0.001;
  if (sameSupport && sameResistance) return; // ← SHORT-CIRCUIT
}

// Se níveis mudarem > 0.1%, RESETA TUDO:
this.alerts.set(symbol, {
  support: support,
  resistance: resistance,
  active: true,
  supportTriggered: false,
  resistanceTriggered: false,
  armedSupport: true,
  armedResistance: true,
  lastPrice: existing ? existing.lastPrice : null,
  visualAlert: false // ← ALERTA VISUAL SOME
});
```

**Consequência:**
- Ticker (1h) calcula níveis diferentes do gráfico (1D/1W)
- Divergência > 0.1% → estado resetado
- `visualAlert = false` → sino e label S/R somem dos cards

---

### 4. SINO OFF DESTRUTIVO ✅

**push-subscribe.js** (linha 103-107):

```javascript
function deactivateAlertEngine() {
  if (window.AlertEngine && window.AlertEngine.disableAll) {
    window.AlertEngine.disableAll();
  }
}
```

**AlertEngine.disableAll()** (linha 197-200):

```javascript
AlertEngine.prototype.disableAll = function () {
  this.alerts.clear(); // ← LIMPA TODOS OS ALERTAS
  this.lastSoundAt = {};
};
```

**Problema:**
- Sino OFF → `disableAll()` → **limpa alertas de TODOS os 8 símbolos**
- Ticker não reativa alertas porque:
  ```javascript
  if (isCrypto(symbol) && window.AlertEngine && window.PushSubscribe && window.PushSubscribe.isEnabled()) {
    window.AlertEngine.onPriceUpdate(symbol, price);
  }
  ```
  Condição `PushSubscribe.isEnabled()` retorna `false` quando sino está OFF

**Consequência:**
- Usuário desliga sino → todos os alertas desaparecem
- Usuário religar sino → alertas não voltam automaticamente
- Única forma de reativar: clicar no botão S/R do gráfico novamente

---

### 5. HANDLER DO SINO AUSENTE ✅

**Busca realizada:**
```bash
grep -r "addEventListener.*click.*bell" assets/js/
grep -r "click.*tq-bell" assets/js/
```

**Resultado:** ZERO handlers registrados

**Código do sino** (ticker-widget.js, linha 119):
```javascript
var bell = isCrypto(quote.symbol)
  ? '<button class="tq-bell" data-bell="' + esc(symbolKey(quote.symbol)) + '" aria-label="Dispensar alerta" title="Dispensar alerta">&#128276;</button>'
  : '';
```

**Handler do card pai** (ticker-widget.js, linha 262-284):
```javascript
grid.addEventListener("click", function (event) {
  var cardEl = event.target.closest(".tq");
  if (!cardEl) return;
  // ... carrega ativo no gráfico
  window.dispatchEvent(new CustomEvent("estudebitcoin:load-asset", { detail: detail }));
});
```

**Problema confirmado:**
- Clique no sino propaga para o card pai
- Card interpreta como "carregar ativo no gráfico"
- Sino não tem `stopPropagation()`

**Correção temporária adicionada** (ticker-widget.js, linha 383-399):
```javascript
grid.addEventListener("click", function (event) {
  var bellEl = event.target.closest(".tq-bell");
  if (bellEl) {
    event.stopPropagation();
    var symbol = bellEl.getAttribute("data-bell");
    console.log('[DIAGNÓSTICO] Clique no sino detectado:', symbol);
    window.AlertEngine.dismissVisualAlert(symbol);
    return;
  }
});
```

---

### 6. SINCRONIZAÇÃO WORKER RESTRITA A BTC ✅

**ticker-widget.js** (linha 162-164):

```javascript
if (symbol === 'BTC' && window.PushSubscribe && window.PushSubscribe.isEnabled() && window.PushSubscribe.syncToWorker) {
  window.PushSubscribe.syncToWorker(symbol, srResult.support, srResult.resistance, last);
}
```

**Confirmado:**
- Apenas BTC sincroniza níveis S/R com Worker
- ETH, SOL, LINK, AVAX, RENDER, PAXG, USDT-BRL **não sincronizam**
- Push em background só funciona para BTC

---

## CADEIA DE EVENTOS DOCUMENTADA

### Cenário A: Gráfico ativo em BTC

```
00:00:00 — Usuário clica botão S/R no gráfico (BTC, timeframe 1D)
         ↓
         DynamicSR.activate() → calculateSR(20 velas FECHADAS)
         ↓
         support = 95.000,00 | resistance = 102.000,00
         ↓
         AlertEngine.setAlertLevels('BTC', 95000, 102000)
         ↓
         Estado criado: { active: true, armedSupport: true, armedResistance: true, visualAlert: false }

00:00:05 — Ticker refresh (intervalo de 5s)
         ↓
         fetchCrypto() → para cada símbolo
         ↓
         BTC: DynamicSR.isActive() && DynamicSR.getSymbol() === 'BTC' → TRUE
         ↓
         [SR TRACE] TICKER SKIPPED symbol=BTC reason=GRAPH_ACTIVE ← PROTEÇÃO FUNCIONA

00:00:05 — ETH não está no gráfico
         ↓
         DynamicSR.isActive() && DynamicSR.getSymbol() === 'ETH' → FALSE
         ↓
         calculateSR(25 velas 1h) → support = 3.100,00 | resistance = 3.300,00
         ↓
         [SR TRACE] TICKER UPDATE symbol=ETH support=3100 resistance=3300
         ↓
         AlertEngine.setAlertLevels('ETH', 3100, 3300) ← SOBRESCREVE

00:00:10 — Ticker refresh novamente (intervalo de 5s)
         ↓
         Mesma lógica: BTC protegido, outros 7 símbolos sobrescritos
```

### Cenário B: Usuário troca gráfico para ETH

```
00:01:00 — Usuário clica em ETH no ticker
         ↓
         estudebitcoin:load-asset → ETH carregado no gráfico
         ↓
         DynamicSR.recalculate('ETH', timeframe 1D)
         ↓
         support = 3.050,00 | resistance = 3.350,00
         ↓
         [SR-TRACE] GRAPH recalculate symbol=ETH support=3050 resistance=3350
         ↓
         AlertEngine.setAlertLevels('ETH', 3050, 3350)

00:01:05 — Ticker refresh (intervalo de 5s)
         ↓
         BTC: DynamicSR.getSymbol() === 'BTC' → FALSE (gráfico agora é ETH)
         ↓
         [SR TRACE] TICKER UPDATE symbol=BTC support=95500 resistance=101500 ← SOBRESCREVE
         ↓
         AlertEngine.setAlertLevels('BTC', 95500, 101500)
         ↓
         Divergência > 0.1%: (95500 - 95000) / 95000 = 0.52% > 0.1%
         ↓
         Estado BTC RESETADO: { visualAlert: false } ← ALERTA VISUAL SOME
```

---

## LOGS DE DIAGNÓSTICO INSTALADOS

Para confirmar a cadeia de eventos acima em ambiente real, foram adicionados logs temporários:

### Console logs esperados:

```javascript
[SR-TRACE] GRAPH activate { source: 'GRAPH', symbol: 'BTC', support: 95000, resistance: 102000, timeframe: '1D', timestamp: 1725302400000 }
[SR-TRACE] ALERT_ENGINE setAlertLevels { source: 'ALERT_ENGINE', symbol: 'BTC', support: 95000, resistance: 102000, timestamp: 1725302400000 }

[SR TRACE] TICKER SKIPPED symbol=BTC reason=GRAPH_ACTIVE

[SR TRACE] TICKER UPDATE symbol=ETH support=3100 resistance=3300
[SR-TRACE] ALERT_ENGINE setAlertLevels { source: 'ALERT_ENGINE', symbol: 'ETH', support: 3100, resistance: 3300, timestamp: 1725302405000 }

// ... 5 segundos depois ...

[SR TRACE] TICKER UPDATE symbol=BTC support=95500 resistance=101500
[SR-TRACE] ALERT_ENGINE setAlertLevels { source: 'ALERT_ENGINE', symbol: 'BTC', support: 95500, resistance: 101500, timestamp: 1725302410000 }
```

---

## CONCLUSÃO

### CAUSA RAIZ CONFIRMADA (POR ANÁLISE DE CÓDIGO)

**3 problemas inter-relacionados:**

1. **Sobrescrita ticker vs gráfico:**
   - Proteção "PATCH A" só protege 1 símbolo por vez
   - Timeframe divergente (1h vs 1D/1W) causa níveis diferentes
   - Divergência > 0.1% reseta estado e apaga `visualAlert`

2. **Sino OFF destrutivo:**
   - `disableAll()` limpa alertas de todos os símbolos
   - Ticker não reativa porque `PushSubscribe.isEnabled()` retorna `false`

3. **Handler do sino ausente:**
   - Clique propaga para card pai
   - Usuário não consegue dispensar alerta manualmente

---

## PRÓXIMOS PASSOS

### 1. TESTE EM NAVEGADOR (CRÍTICO)

**Objetivo:** Confirmar sobrescrita em ambiente real

**Procedimento:**
1. Deploy local ou acesso a produção
2. Abrir console do navegador (F12)
3. Ativar S/R no gráfico para BTC (timeframe 1D ou 1W)
4. Observar logs `[SR-TRACE]` durante 30-60 segundos
5. Trocar gráfico para ETH
6. Verificar se BTC passa a ser sobrescrito pelo ticker a cada 5s
7. Clicar no sino de um card com alerta ativo
8. Verificar se `[DIAGNÓSTICO] Clique no sino detectado` aparece no console

**Evidências esperadas:**
- Logs `[SR-TRACE]` mostram sequência: GRAPH → TICKER → ALERT_ENGINE
- Valores de support/resistance do TICKER diferem do GRAPH
- Clique no sino é capturado e chama `dismissVisualAlert()`

---

### 2. CAPTURA DE VALORES REAIS

Documentar divergência factual:

```
GRÁFICO BTC (1D, 20 velas fechadas):
support = [valor real]
resistance = [valor real]

TICKER BTC (1h, 25 velas):
support = [valor real]
resistance = [valor real]

DIVERGÊNCIA PERCENTUAL:
support: [%]
resistance: [%]

ESTADO ALERT ENGINE APÓS 10s:
support = [valor real]
resistance = [valor real]
source = [GRAPH ou TICKER]
```

---

### 3. IMPLEMENTAÇÃO DE CORREÇÃO (APÓS CONFIRMAÇÃO)

**Não implementar antes de confirmar em navegador.**

Correções planejadas:

1. **Unificar fonte de S/R:**
   - Opção A: Gráfico é única fonte de verdade (ticker não calcula S/R)
   - Opção B: Ticker protege **todos** os símbolos que têm alerta ativo

2. **Separar Push de AlertEngine:**
   - Sino controla apenas Push (Worker)
   - AlertEngine local permanece ativo independentemente

3. **Handler do sino permanente:**
   - Manter handler com `stopPropagation()`
   - Remover `[TEMP DIAGNÓSTICO]` dos logs

4. **Throttle inteligente:**
   - Só atualizar S/R se divergência > 1% (em vez de 0.1%)
   - Ou: só atualizar se `visualAlert: false`

---

## ARQUIVOS MODIFICADOS (DIAGNÓSTICO)

### Logs adicionados:
- `assets/js/services/alertEngine.js` (linha 72-80)
- `assets/js/chart/dynamicSR.js` (linhas 95-103, 248-256)

### Handler temporário adicionado:
- `assets/js/ticker-widget.js` (linhas 383-399)

### Documentação criada:
- `INVESTIGACAO_DESSINC_SR.md` (relatório completo)
- `RESUMO_INVESTIGACAO.md` (este arquivo)

---

## STATUS FINAL

✅ **Rastreamento de escritas:** COMPLETO  
✅ **Origem dos níveis do gráfico:** COMPLETO  
✅ **Estado interno do AlertEngine:** COMPLETO  
✅ **Relação Push/AlertEngine:** COMPLETO  
✅ **Handler do sino:** CONFIRMADO AUSENTE, temporário adicionado  
✅ **Sincronização Worker:** CONFIRMADO (só BTC)  
⏳ **Prova de sobrescrita:** AGUARDANDO TESTE EM NAVEGADOR  
⏳ **Captura de valores reais:** AGUARDANDO TESTE EM NAVEGADOR  

**Investigação concluída. Aguardando confirmação factual em navegador antes de implementar correção.**
