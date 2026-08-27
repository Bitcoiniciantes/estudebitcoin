# Bitcoin Iniciantes — Registro de Alterações

> Gerado em 27/08/2026. Documenta todas as features criadas/alteradas por IA
> neste projeto (vanilla JS + Canvas customizado).

---

## 1. AlertEngine — Motor de Alertas S/R

**Arquivo:** `assets/js/services/alertEngine.js` (CRIADO — 190 linhas)

IIFE exposta em `window.AlertEngine`. Motor de detecção de rompimento de Suporte/Resistência.

### Funcionalidades

| Método | Descrição |
|--------|-----------|
| `setAlertLevels(symbol, support, resistance)` | Registra níveis S/R para um símbolo. Cria estado de alerta com arming inicial. |
| `onPriceUpdate(symbol, price)` | Chamado a cada tick do WebSocket. Detecta crossover (cruzamento) de resistência ou suporte. |
| `trigger(symbol, direction, price, level)` | Dispara alerta: toca beep, emite CustomEvent `PriceAlertTriggered`. |
| `dismissVisualAlert(symbol)` | Remove apenas o visual (classe CSS), mantém monitoramento ativo. Emite `PriceAlertDismissed`. |
| `disable(symbol)` | Remove completamente o alerta do símbolo. |
| `isEnabled(symbol)` | Verifica se o símbolo tem alerta ativo. |
| `unlockAudio()` | Desbloqueia AudioContext na primeira interação do usuário (política de autoplay). |

### Detecção de Crossover

```
Resistência: previousPrice < resistance AND currentPrice >= resistance
Suporte:     previousPrice > support     AND currentPrice <= support
```

- Primeiro preço após ativação NÃO dispara (proteção contra falso positivo — Seção 9)
- Rearme automático: se preço retorna para o outro lado do nível, rearmou (Seção 8/10)
- Cooldown de 5s por símbolo/direção (Seção 14)

### Áudio

- **Web Audio API** (synthetic beep 880Hz/300ms)
- AudioContext criado lazy na primeira interação do usuário
- OscillatorNode + GainNode com fade exponencial
- Zero dependência de arquivos .mp3

### Comunicação com UI

```
CustomEvent('PriceAlertTriggered', { detail: { symbol, direction, price, level } })
CustomEvent('PriceAlertDismissed', { detail: { symbol } })
```

---

## 2. DynamicSR — Cálculo e Desenho de S/R

**Arquivo:** `assets/js/chart/dynamicSR.js` (CRIADO — 267 linhas)

IIFE exposta em `window.DynamicSR`. Calcula S/R e desenha no Canvas do gráfico.

### Fórmula (idêntica ao gráfico Preditivo — `page.tsx:98`)

```javascript
const closed = candlesHistory.slice(0, -1);     // exclui vela em formação
const recent = closed.slice(-20);                // últimas 20 velas fechadas
resistance = Math.max(...recent.map(x => x.high));
support    = Math.min(...recent.map(x => x.low));
```

**NÃO usa Pivot Point.** Usa maior HIGH e menor LOW das últimas 20 velas fechadas.

### Métodos

| Método | Descrição |
|--------|-----------|
| `toggle(symbol, candlesHistory, timeframe)` | Alterna S/R on/off para o símbolo. |
| `activate(symbol, candlesHistory, timeframe)` | Calcula e registra S/R. Desbloqueia áudio. Registra no AlertEngine. |
| `deactivate()` | Remove S/R e desativa AlertEngine para o símbolo. |
| `recalculate(symbol, candlesHistory, timeframe)` | Recalcula S/R para novo ativo (mantém ativo ao trocar no ticker). |
| `draw(ctx, chartState, displayCurrency)` | Desenha linhas tracejadas no canvas. Chamado após `renderBaseChart()`. |

### Desenho Canvas

- **Linha Resistência:** vermelho `#ff4343`, tracejada `[8,5]`, label `R <preço>` à esquerda
- **Linha Suporte:** verde `#4caf50`, tracejada `[8,5]`, label `S <preço>` à esquerda
- Labels com fundo semi-transparente (`rgba` com alpha 0.2)
- Fonte: bold 10px monospace
- Recorte ao plot (exclui eixo de preços)

### Logs Temporários

Ao ativar/recalcular, imprime no console:
```
[DynamicSR] ATIVADO
  TIMEFRAME, CANDLES_USADOS (20), PRIMEIRA_VELA, ULTIMA_VELA,
  HIGH_MAXIMO, LOW_MINIMO, RESISTENCIA, SUPORTE
```

> **TODO:** Remover logs após validação em produção.

---

## 3. Ticker Widget — Cards com Alertas

**Arquivo:** `assets/js/ticker-widget.js` (MODIFICADO — 373 linhas)

### Alterações

#### 3.1 Botão Sino (`.tq-bell`)

- Adicionado `<button class="tq-bell">` nos cards de criptomoedas apenas
- Posicionado no canto inferior esquerdo do card (`position: absolute; bottom: 2px; left: 2px`)
- **Oculto por padrão** (`opacity: 0`, `pointer-events: none`)
- **Visível no hover** do card (`.tq:hover .tq-bell`)
- **Visível quando alerta dispara** (`.tq.alert-triggered .tq-bell`)
- Animação de chacoalhar: `bellShake` 0.45s infinite

#### 3.2 Injeção de Preço no Motor

```javascript
// Linha 207 — Fase C: alimentar motor de alertas
if (isCrypto(symbol) && window.AlertEngine) {
  window.AlertEngine.onPriceUpdate(symbol, price);
}
```

Chamado em `updateLivePrice()` a cada tick do WebSocket Binance.

#### 3.3 Indicador de Nível Rompido

Quando alerta dispara, insere `<span class="tq-sr-label">` no card:
- `R` = vermelho (`sr-res`) — resistência rompida
- `S` = verde (`sr-sup`) — suporte rompido

#### 3.4 Restauração de Estado após Re-render

```javascript
function restoreAlertVisuals() {
  // Reaplica estado de alerta após grid.innerHTML = ...
  // O render() a cada 5s destrói e recria os cards
}
```

**Bug corrigido:** O `refresh(true)` a cada 5s fazia `grid.innerHTML = ...`, destruindo os cards e perdendo a classe `alert-triggered`. Agora `restoreAlertVisuals()` reaplica o estado após cada render.

#### 3.5 Ordem de Execução

`alertDirection` e `applyAlertVisual` são declarados ANTES do primeiro `refresh(true)` para evitar que `render()` acesse variáveis não inicializadas (hoisting de `var`).

---

## 4. Conversor — Integrações

**Arquivo:** `assets/js/conversor.js` (MODIFICADO — 1242 linhas)

### 4.1 Botão S/R no Toolbar do Gráfico

```html
<button id="preev-sr-toggle" class="preev__chart-type-btn" type="button"
  aria-pressed="false" title="S/R Dinâmico">S/R</button>
```

Handler (`conversor.js:1209`):
```javascript
srToggleBtn.addEventListener('click', () => {
  const symbol = getSRSymbol();
  if (!symbol) { alert('S/R disponível apenas para criptos.'); return; }
  const levels = window.DynamicSR.toggle(symbol, candlesHistory, activeTimeframe);
  drawActiveChart();
});
```

### 4.2 Hooks de Desenho no Canvas

```javascript
// Linha 807 (modo linha) e 839 (modo candles):
if (window.DynamicSR) window.DynamicSR.draw(ctx, chartState, displayCurrency());
```

Chamado no final de `renderCandles()` e `renderBaseChart()` (modo linha).

### 4.3 Desativação no Troca de Timeframe

```javascript
// Linha 1140 — tfBtns click handler
if (window.DynamicSR && window.DynamicSR.isActive()) {
  window.DynamicSR.deactivate();
  srBtn.setAttribute('aria-pressed', 'false');
}
```

**Seção 23:** S/R desativa ao trocar timeframe (1H → 1D etc.).

### 4.4 Recálculo no Troca de Ativo

```javascript
// Linha 499 — fetchHistoricalTrends()
if (window.DynamicSR && window.DynamicSR.isActive()) {
  window.DynamicSR.recalculate(config.symbol, candlesHistory, activeTimeframe);
  drawActiveChart();
}
```

**Não desativa mais ao trocar de ativo.** Em vez disso, recalcula S/R para o novo ativo.

### 4.5 Escala Y Manual do Gráfico

**Variáveis de estado:**
```javascript
let yScaleManual = null; // { min, max } ou null (auto)
let yScaleDrag = null;   // { startY, startMin, startMax } durante drag
```

**Cálculo do range (em `drawCandlestickChart`):**
```javascript
const rawMin = Math.min(...candles.map(c => c.low));
const rawMax = Math.max(...candles.map(c => c.high));
const pad = rawRange * 0.07;  // 7% de padding

if (yScaleManual) {
  // Escala manual (drag)
  min = yScaleManual.min;
  max = yScaleManual.max;
} else {
  // Auto-scale com padding
  min = rawMin - pad;
  max = rawMax + pad;
}
```

**Interações no eixo Y:**

| Ação | Comportamento |
|------|---------------|
| Clique + arraste no eixo Y | Estica/comprime a escala (drag vertical) |
| Duplo clique no eixo Y | Reseta para auto-scale |
| Cursor | Muda para `ns-resize` durante drag |
| Fator de escala | 1.5× a velocidade do arraste |

**Limites:** Range mínimo = 15% do original, máximo = 500% do original.

---

## 5. CSS — Estilos

**Arquivo:** `index.html` (inline `<style>`) + `assets/css/widgets.css`

### 5.1 Card `.tq` — Position Relative

```css
.tq { position: relative; /* ... */ }
```

Adicionado para permitir posicionamento absoluto do sino.

### 5.2 Botão Sino `.tq-bell`

```css
.tq-bell {
  position: absolute;
  bottom: 2px;
  left: 2px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease-in-out;
}
.tq:hover .tq-bell { opacity: 1; pointer-events: auto; }
.tq.alert-triggered .tq-bell { opacity: 1; pointer-events: auto; }
```

### 5.3 Label S/R `.tq-sr-label`

```css
.tq-sr-label { font-size: .65rem; font-weight: 800; padding: 1px 5px; border-radius: 4px; }
.tq-sr-label.sr-res { background: rgba(255, 67, 67, 0.25); color: #ff6b6b; }
.tq-sr-label.sr-sup { background: rgba(76, 175, 80, 0.25); color: #66bb6a; }
```

### 5.4 Animações

```css
@keyframes alertFlash { 0%,100% { opacity:1 } 50% { opacity:0.55 } }
@keyframes bellShake { 0%,100% { rotate(0) } 25% { rotate(-12deg) } 75% { rotate(12deg) } }

.tq.alert-triggered {
  animation: alertFlash 0.8s infinite;
  border-color: rgba(255,193,7,0.6);
  box-shadow: 0 0 12px rgba(255,193,7,0.25);
}
.tq-bell.alert-bell-active { animation: bellShake 0.45s infinite; }
```

### 5.5 Botão S/R no Toolbar

```css
#preev-sr-toggle {
  position: absolute; bottom: 10px; left: 80px; z-index: 4;
  background: rgba(255,255,255,.94); border-radius: 5px;
  font-size: 10px; font-weight: 700; cursor: pointer;
}
#preev-sr-toggle[aria-pressed="true"] {
  background: #F7931A; color: #fff;
}
```

---

## 6. HTML — Estrutura

**Arquivo:** `index.html` (MODIFICADO — 1352 linhas)

### 6.1 Script Tags (antes de `</body>`)

```html
<script src="assets/js/services/alertEngine.js"></script>
<script src="assets/js/chart/dynamicSR.js"></script>
```

Carregados ANTES de `conversor.js` e `ticker-widget.js` (sem `defer`).

### 6.2 Botão S/R no Toolbar

```html
<button id="preev-sr-toggle" class="preev__chart-type-btn" ...>S/R</button>
```

Inserido na barra de ferramentas do gráfico (`.preev__chart-type`).

---

## 7. Fluxo Completo

```
1. Usuário clica "S/R" no toolbar
     ↓
2. DynamicSR.toggle() → calculateSR() → 20 velas fechadas
     ↓
3. AlertEngine.setAlertLevels(symbol, support, resistance)
     ↓
4. WebSocket tick → updateLivePrice() → AlertEngine.onPriceUpdate()
     ↓
5. Crossover detectado → trigger() → beep + CustomEvent
     ↓
6. applyAlertVisual() → card pisca + sino treme + label R/S aparece
     ↓
7. Usuário clica no sino → dismissVisualAlert() → remove visual
     (monitoramento continua ativo)
```

---

## 8. Arquivos Não Alterados

- `assets/js/config.js` — configurações gerais
- `assets/js/utils.js` — utilitários
- `assets/js/main.js` — lazy-load e menu
- `assets/js/projections.js` — projeções
- `assets/js/analista-ia.js` — IA analista
- `assets/js/services/*` — outros serviços
- `assets/js/chart/*` — exceto `dynamicSR.js`
- `assets/css/*` — exceto `widgets.css`

---

## 9. Pendências / TODO

| Item | Status |
|------|--------|
| Remover logs `[DynamicSR]` do console | PENDENTE — aguardando validação |
| Testar fluxo completo no navegador real | PENDENTE |
| Verificar conflito com markerLines (linhas de desenho) | VERIFICAR |
| Responsividade mobile do sino e labels | NÃO TESTADO |
