/* =====================================================================
   DynamicSR — Cálculo de S/R Dinâmico + desenho no Canvas
   - Usa as últimas 20 velas FECHADAS (exclui vela em formação)
   - Resistência = maior HIGH das 20 velas
   - Suporte = menor LOW das 20 velas
   - Mesma fórmula do gráfico Preditivo (page.tsx:98)
   - Desenha linhas tracejadas no canvas do gráfico
   - Registra níveis no AlertEngine
   ===================================================================== */
window.DynamicSR = (function () {
  'use strict';

  var active = false;
  var currentSymbol = null;
  var srLevels = null; // { support, resistance, symbol, timeframe }

  var AXIS_W = 56;
  var LOOKBACK = 20;

  /**
   * Calcula Suporte e Resistência a partir das últimas 20 velas fechadas.
   * Mesma fórmula do gráfico Preditivo (page.tsx:98):
   *   resistance = Math.max(...recent.map(x => x.high))
   *   support    = Math.min(...recent.map(x => x.low))
   *
   * @param {Array} candlesHistory - array completo de velas
   * @returns {Object|null} - { support, resistance, firstCandle, lastCandle, count }
   */
  function calculateSR(candlesHistory) {
    if (!candlesHistory || candlesHistory.length < 2) return null;

    // Excluir a vela em formação (última do array)
    // Usar no máximo as últimas 20 velas fechadas
    var closed = candlesHistory.slice(0, -1);
    var recent = closed.slice(-LOOKBACK);

    if (recent.length < 2) return null;

    var highs = recent.map(function (c) { return c.high; });
    var lows = recent.map(function (c) { return c.low; });

    // Validar que todos os valores são numéricos
    for (var i = 0; i < recent.length; i++) {
      if (!Number.isFinite(highs[i]) || !Number.isFinite(lows[i])) return null;
    }

    var resistance = Math.max.apply(null, highs);
    var support = Math.min.apply(null, lows);

    if (!Number.isFinite(support) || !Number.isFinite(resistance)) return null;
    if (support >= resistance) return null;

    return {
      support: support,
      resistance: resistance,
      firstCandle: recent[0],
      lastCandle: recent[recent.length - 1],
      count: recent.length
    };
  }

  /**
   * Ativa S/R Dinâmico para o símbolo atual.
   * @param {string} symbol - símbolo normalizado (ex: "BTC")
   * @param {Array} candlesHistory - array de velas do gráfico
   * @param {string} timeframe - timeframe atual (ex: "1D")
   * @returns {Object|null} - { support, resistance } ou null
   */
  function activate(symbol, candlesHistory, timeframe) {
    // CORREÇÃO: Normalizar símbolo antes de usar
    symbol = window.BI && window.BI.normalizeSymbol ? window.BI.normalizeSymbol(symbol) : symbol;
    
    if (!symbol || !candlesHistory || !candlesHistory.length) return null;

    var result = calculateSR(candlesHistory);
    if (!result) return null;

    // Desativa anterior se houver
    if (active && currentSymbol) {
      deactivate();
    }

    currentSymbol = symbol;
    srLevels = {
      support: result.support,
      resistance: result.resistance,
      symbol: symbol,
      timeframe: timeframe
    };
    active = true;

    console.log('[DynamicSR] ATIVADO', {
      TIMEFRAME: timeframe,
      CANDLES_USADOS: result.count,
      PRIMEIRA_VELA: new Date(result.firstCandle.time).toISOString(),
      ULTIMA_VELA: new Date(result.lastCandle.time).toISOString(),
      HIGH_MAXIMO: result.resistance,
      LOW_MINIMO: result.support,
      RESISTENCIA: result.resistance,
      SUPORTE: result.support
    });

    console.log('[SR-TRACE] GRAPH activate', {
      source: 'GRAPH',
      symbol: symbol,
      support: result.support,
      resistance: result.resistance,
      timeframe: timeframe,
      timestamp: Date.now()
    });

    // Desbloquear áudio
    window.AlertEngine.unlockAudio();

    // CORREÇÃO 4: Registrar no motor de alertas com source=GRAPH
    window.AlertEngine.setAlertLevels(symbol, result.support, result.resistance, {
      source: 'GRAPH',
      timeframe: timeframe
    });

    return { support: result.support, resistance: result.resistance };
  }

  /**
   * Desativa S/R Dinâmico e limpa estado do gráfico.
   * NÃO desativa alertas do AlertEngine — o ticker gerencia seus próprios alertas.
   */
  function deactivate() {
    active = false;
    currentSymbol = null;
    srLevels = null;
  }

  /**
   * Alterna estado ativo/inativo.
   */
  function toggle(symbol, candlesHistory, timeframe) {
    // CORREÇÃO: Normalizar símbolo antes de usar
    symbol = window.BI && window.BI.normalizeSymbol ? window.BI.normalizeSymbol(symbol) : symbol;
    
    if (active && currentSymbol === symbol) {
      deactivate();
      return null;
    }
    return activate(symbol, candlesHistory, timeframe);
  }

  function isActive() { return active; }
  function getLevels() { return srLevels; }
  function getSymbol() { return currentSymbol; }

  /**
   * Desenha as linhas Resistência/Suporte no canvas.
   * Deve ser chamado APÓS renderBaseChart() para sobrepor.
   */
  function draw(ctx, chartState, displayCurrency) {
    if (!active || !srLevels || !chartState) return;

    var priceY = chartState.priceY || chartState.yOf;
    if (!priceY) return;

    var w = chartState.w;
    var h = chartState.h;
    var plotW = w - AXIS_W;

    var yR = priceY(srLevels.resistance);
    var yS = priceY(srLevels.support);

    var prefix = displayCurrency === 'BRL' ? 'R$ ' : displayCurrency === 'BTC' ? '₿ ' : '$ ';
    function fmtPrice(val) {
      if (!Number.isFinite(val)) return '';
      if (val >= 1e4) return prefix + val.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
      return prefix + val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    ctx.save();

    ctx.beginPath();
    ctx.rect(0, 0, plotW, h);
    ctx.clip();

    ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Consolas, monospace';

    // --- Linha Resistência (vermelho) ---
    if (Number.isFinite(yR)) {
      var yRClamped = Math.max(10, Math.min(h - 10, yR));
      ctx.beginPath();
      ctx.setLineDash([8, 5]);
      ctx.moveTo(0, yRClamped);
      ctx.lineTo(plotW, yRClamped);
      ctx.strokeStyle = '#ff4343';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.setLineDash([]);

      var labelR = 'R ' + fmtPrice(srLevels.resistance);
      var twR = ctx.measureText(labelR).width;
      var labelRY = yRClamped - 8;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(6, labelRY - 9, twR + 10, 16);
      ctx.fillStyle = '#111';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelR, 10, labelRY - 1);
    }

    // --- Linha Suporte (verde) ---
    if (Number.isFinite(yS)) {
      var ySClamped = Math.max(10, Math.min(h - 10, yS));
      ctx.beginPath();
      ctx.setLineDash([8, 5]);
      ctx.moveTo(0, ySClamped);
      ctx.lineTo(plotW, ySClamped);
      ctx.strokeStyle = '#4caf50';
      ctx.lineWidth = 1.8;
      ctx.stroke();
      ctx.setLineDash([]);

      var labelS = 'S ' + fmtPrice(srLevels.support);
      var twS = ctx.measureText(labelS).width;
      var labelSY = ySClamped - 8;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(6, labelSY - 9, twS + 10, 16);
      ctx.fillStyle = '#111';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(labelS, 10, labelSY - 1);
    }

    ctx.restore();
  }

  /**
   * Recalcula S/R para o novo ativo se estiver ativo.
   */
  function recalculate(symbol, candlesHistory, timeframe) {
    // CORREÇÃO: Normalizar símbolo antes de usar
    symbol = window.BI && window.BI.normalizeSymbol ? window.BI.normalizeSymbol(symbol) : symbol;
    
    if (!active) return null;
    if (!symbol || !candlesHistory || candlesHistory.length < 2) {
      deactivate();
      return null;
    }
    var result = calculateSR(candlesHistory);
    if (!result) {
      deactivate();
      return null;
    }
    currentSymbol = symbol;
    srLevels = {
      support: result.support,
      resistance: result.resistance,
      symbol: symbol,
      timeframe: timeframe
    };

    console.log('[DynamicSR] RECALCULADO', {
      TIMEFRAME: timeframe,
      CANDLES_USADOS: result.count,
      PRIMEIRA_VELA: new Date(result.firstCandle.time).toISOString(),
      ULTIMA_VELA: new Date(result.lastCandle.time).toISOString(),
      HIGH_MAXIMO: result.resistance,
      LOW_MINIMO: result.support,
      RESISTENCIA: result.resistance,
      SUPORTE: result.support
    });

    console.log('[SR-TRACE] GRAPH recalculate', {
      source: 'GRAPH',
      symbol: symbol,
      support: result.support,
      resistance: result.resistance,
      timeframe: timeframe,
      timestamp: Date.now()
    });

    if (window.AlertEngine) {
      window.AlertEngine.unlockAudio();
      // CORREÇÃO 4: Registrar no motor de alertas com source=GRAPH
      window.AlertEngine.setAlertLevels(symbol, result.support, result.resistance, {
        source: 'GRAPH',
        timeframe: timeframe
      });
    }
    return { support: result.support, resistance: result.resistance };
  }

  return {
    activate: activate,
    deactivate: deactivate,
    toggle: toggle,
    isActive: isActive,
    getLevels: getLevels,
    getSymbol: getSymbol,
    draw: draw,
    calculateSR: calculateSR,
    recalculate: recalculate
  };
})();
