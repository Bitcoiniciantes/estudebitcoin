/** Motor puro do painel multicripto. Não representa uma liquidação oficial. */
(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else global.RiskPortfolioEngine = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  var RISK_THRESHOLDS = { LOW: 30, ATTENTION: 15, ELEVATED: 5 };
  function finitePositive(n) { return typeof n === "number" && Number.isFinite(n) && n > 0; }
  function finite(n) { return typeof n === "number" && Number.isFinite(n); }
  function fail(code, message) { return { success: false, code: code, message: message }; }
  function riskState(distance) {
    if (!finite(distance)) return "INDETERMINADO";
    if (distance > RISK_THRESHOLDS.LOW) return "BAIXO NO CENÁRIO";
    if (distance > RISK_THRESHOLDS.ATTENTION) return "ATENÇÃO";
    if (distance > RISK_THRESHOLDS.ELEVATED) return "ELEVADO";
    return "CRÍTICO";
  }
  function validatePosition(p, i) {
    if (!p || typeof p !== "object" || typeof p.symbol !== "string" || !p.symbol ||
      (p.side !== "LONG" && p.side !== "SHORT") || !finitePositive(p.quantity) ||
      !finitePositive(p.averagePrice) || !finitePositive(p.currentPrice)) {
      return "Posição inválida no índice " + i + ".";
    }
    return null;
  }
  function calculate(input) {
    if (!input || typeof input !== "object" || !finite(input.referenceBalance) || input.referenceBalance < 0) {
      return fail("INVALID_BALANCE", "Saldo de referência deve ser finito e maior ou igual a zero.");
    }
    var positions = input.positions;
    if (!Array.isArray(positions) || positions.length > 5) return fail("INVALID_POSITIONS", "Informe de zero a cinco posições válidas.");
    var ref = input.referencePrices && typeof input.referencePrices === "object" ? input.referencePrices : {};
    var results = [], pnlTotal = 0, variationAfterReference = 0, exposure = 0, directionalExposure = 0;
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i], invalid = validatePosition(p, i);
      if (invalid) return fail("INVALID_POSITION", invalid);
      var sign = p.side === "LONG" ? 1 : -1;
      var value = p.quantity * p.currentPrice;
      var pnl = sign * p.quantity * (p.currentPrice - p.averagePrice);
      var referencePrice = ref[p.symbol];
      var changeSinceReference = finitePositive(referencePrice) ? sign * p.quantity * (p.currentPrice - referencePrice) : 0;
      results.push({ symbol: p.symbol, side: p.side, quantity: p.quantity, averagePrice: p.averagePrice,
        currentPrice: p.currentPrice, marketValue: value, pnl: pnl, pnlPercent: (pnl / (p.quantity * p.averagePrice)) * 100,
        referencePrice: finitePositive(referencePrice) ? referencePrice : null, changeSinceReference: changeSinceReference });
      pnlTotal += pnl; variationAfterReference += changeSinceReference; exposure += Math.abs(value); directionalExposure += sign * value;
    }
    var equity = input.referenceBalance + variationAfterReference;
    var leverage = equity > 0 ? exposure / equity : null;
    var additionalLoss = equity > 0 ? equity : 0;
    var uniformDistance = directionalExposure > 0 && equity > 0 ? (equity / directionalExposure) * 100 : null;
    if (uniformDistance !== null && uniformDistance > 100) uniformDistance = null;
    return { success: true, positions: results, investedTotal: results.reduce(function (sum, p) { return sum + p.quantity * p.averagePrice; }, 0),
      marketValue: results.reduce(function (sum, p) { return sum + p.marketValue; }, 0), pnlTotal: pnlTotal, exposure: exposure,
      referenceBalance: input.referenceBalance, variationAfterReference: variationAfterReference, equity: equity, leverage: leverage,
      additionalLossSupported: additionalLoss, uniformDropToZero: uniformDistance, riskState: equity <= 0 ? "CRÍTICO" : riskState(uniformDistance),
      validQuoteCount: results.length, referenceComplete: results.every(function (p) { return p.referencePrice !== null; }) };
  }
  function simulate(input, changes) {
    var base = calculate(input); if (!base.success) return base;
    changes = changes && typeof changes === "object" ? changes : {};
    var altered = input.positions.map(function (p) {
      var pct = Number(changes[p.symbol] || 0);
      if (!Number.isFinite(pct) || pct < -100) pct = 0;
      return Object.assign({}, p, { currentPrice: p.currentPrice * (1 + pct / 100) });
    });
    var simulated = calculate(Object.assign({}, input, { positions: altered }));
    if (!simulated.success) return simulated;
    simulated.additionalPnl = simulated.equity - base.equity;
    return simulated;
  }
  function criticalPrice(input, symbol) {
    var base = calculate(input); if (!base.success) return base;
    var p = input.positions.filter(function (x) { return x.symbol === symbol; })[0];
    if (!p) return fail("UNKNOWN_POSITION", "Posição não encontrada.");
    var price = p.side === "LONG" ? p.currentPrice - base.equity / p.quantity : p.currentPrice + base.equity / p.quantity;
    if (p.side === "LONG" && price < 0) return { success: true, symbol: symbol, price: null, message: "Não atinge o limite com queda isolada de até 100%." };
    return { success: true, symbol: symbol, price: price, direction: p.side === "LONG" ? "queda" : "alta" };
  }
  function addPurchase(position, quantity, price) {
    if (!position || !finitePositive(position.quantity) || !finitePositive(position.averagePrice) || !finitePositive(quantity) || !finitePositive(price)) return null;
    var totalQuantity = position.quantity + quantity;
    return Object.assign({}, position, { quantity: totalQuantity, averagePrice: ((position.quantity * position.averagePrice) + (quantity * price)) / totalQuantity });
  }
  return { calculate: calculate, simulate: simulate, criticalPrice: criticalPrice, addPurchase: addPurchase, RISK_THRESHOLDS: RISK_THRESHOLDS };
});
