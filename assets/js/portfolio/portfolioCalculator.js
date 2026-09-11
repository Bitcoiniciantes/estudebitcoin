/* =====================================================================
   EstudeBitcoin — PortfolioCalculator (FASE 1)
   ---------------------------------------------------------------------
   Módulo PURO de matemática financeira. REGRA EXPLÍCITA:
   - NÃO conhece type, ticker, storage, DOM, API, fetch ou localStorage.
   - Entrada: números { quantity, averagePrice, currentPrice, dailyVariation }.
   - NÃO arredonda internamente; arredondar SOMENTE na apresentação (UI).
   - Guardas: entradas inválidas viram 0; nunca retorna NaN/Infinity.
   - UMD simples: browser (globalThis) + Node. Sem closures entre
     funções de níveis diferentes para o objeto exportado.
   ===================================================================== */
(function () {
  'use strict';

  function num(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
  }

  // Enriquecer UMA posição. Recebe só números — sem type/ticker/storage/DOM.
  function enrichPosition(input) {
    var quantity = num(input && input.quantity);
    var averagePrice = num(input && input.averagePrice);
    var currentPrice = num(input && input.currentPrice);
    var dailyVariation = num(input && input.dailyVariation);

    var invested = quantity * averagePrice;
    var current = quantity * currentPrice;
    var profit = current - invested;
    var profitability = invested > 0 ? (current / invested - 1) * 100 : 0;
    var dailyDelta = current * dailyVariation / 100;

    if (!Number.isFinite(invested)) invested = 0;
    if (!Number.isFinite(current)) current = 0;
    if (!Number.isFinite(profit)) profit = 0;
    if (!Number.isFinite(profitability)) profitability = 0;
    if (!Number.isFinite(dailyDelta)) dailyDelta = 0;

    return {
      invested: invested,
      current: current,
      profit: profit,
      profitability: profitability,
      dailyDelta: dailyDelta,
      allocation: 0 // preenchido por applyAllocations()
    };
  }

  // Totais ponderados. NUNCA média simples de percentuais.
  function calcTotals(enrichedList) {
    var list = Array.isArray(enrichedList) ? enrichedList : [];
    var invested = 0;
    var current = 0;
    var dailyDelta = 0;
    for (var i = 0; i < list.length; i++) {
      invested += num(list[i] && list[i].invested);
      current += num(list[i] && list[i].current);
      dailyDelta += num(list[i] && list[i].dailyDelta);
    }
    var profit = current - invested;
    var profitability = invested > 0 ? (current / invested - 1) * 100 : 0;
    if (!Number.isFinite(profitability)) profitability = 0;
    return { invested: invested, current: current, profit: profit, profitability: profitability, dailyDelta: dailyDelta, count: list.length };
  }

  // Alocação por valor atual. Garante Σ = 100% (ajuste no maior).
  function applyAllocations(enrichedList, totalCurrent) {
    var list = Array.isArray(enrichedList) ? enrichedList : [];
    var total = Number.isFinite(totalCurrent) ? totalCurrent : 0;
    if (!(total > 0)) {
      for (var i = 0; i < list.length; i++) list[i].allocation = 0;
      return list;
    }
    var sum = 0;
    var maxIdx = 0;
    for (var j = 0; j < list.length; j++) {
      var a = num(list[j] && list[j].current) / total * 100;
      if (!Number.isFinite(a) || a < 0) a = 0;
      list[j].allocation = a;
      sum += a;
      if (a > list[maxIdx].allocation) maxIdx = j;
    }
    var diff = 100 - sum;
    if (list.length && Math.abs(diff) > 1e-9) {
      list[maxIdx].allocation = num(list[maxIdx].allocation) + diff;
    }
    return list;
  }

  var api = {
    enrichPosition: enrichPosition,
    calcTotals: calcTotals,
    applyAllocations: applyAllocations
  };

  if (typeof module === 'object' && module.exports && typeof module.exports === 'object') {
    module.exports = api;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.PortfolioCalculator = api;
  }
})();
