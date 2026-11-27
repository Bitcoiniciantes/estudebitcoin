/** Ponte única ticker → motor de carteira. */
(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(global);
  else global.RiskPortfolioAdapter = factory(global);
})(typeof globalThis !== "undefined" ? globalThis : this, function (host) {
  "use strict";
  var state = null, quotes = {}, listeners = [], attached = false, lastSignature = "";
  function normalize(symbol) { return host.BI && host.BI.normalizeSymbol ? host.BI.normalizeSymbol(symbol) : String(symbol || "").trim().toUpperCase().replace(/USDT$/, ""); }
  function engine() { if (host.RiskPortfolioEngine) return host.RiskPortfolioEngine; if (typeof require === "function") return require("./risk-portfolio-engine.js"); throw new Error("RiskPortfolioEngine não carregado."); }
  function notify(result) { listeners.slice().forEach(function (fn) { try { fn(result); } catch (e) {} }); }
  function snapshot() {
    if (!state) return null;
    var positions = state.positions.map(function (p) { return Object.assign({}, p, { symbol: normalize(p.symbol), currentPrice: quotes[normalize(p.symbol)] && quotes[normalize(p.symbol)].price }); });
    if (positions.some(function (p) { return !Number.isFinite(p.currentPrice) || p.currentPrice <= 0; })) return { success: false, code: "QUOTE_UNAVAILABLE", message: "Cotação indisponível para uma ou mais posições.", quotes: quotes };
    var sig = JSON.stringify(positions.map(function (p) { return [p.symbol, p.currentPrice]; }));
    if (sig === lastSignature) return null;
    lastSignature = sig;
    var input = { referenceBalance: state.referenceBalance, referencePrices: state.referencePrices, positions: positions };
    if (state.equityBasis) input.equityBasis = state.equityBasis;
    var result = engine().calculate(input);
    result.quotes = quotes; notify(result); return result;
  }
  function configure(next) { state = next && typeof next === "object" ? next : null; lastSignature = ""; return snapshot(); }
  function onTicker(event) { var d = event && event.detail, p = d && Number(d.price), symbol = normalize(d && d.symbol); if (!symbol || !Number.isFinite(p) || p <= 0) return; quotes[symbol] = { price: p, timestamp: d.timestamp || Date.now(), source: d.source || "ticker", stale: d.stale === true, market: d.market || "CRYPTO" }; snapshot(); }
  function attach() { if (!attached && host.addEventListener) { host.addEventListener("estudebitcoin:ticker-price", onTicker); attached = true; } return attached; }
  function detach() { if (attached && host.removeEventListener) host.removeEventListener("estudebitcoin:ticker-price", onTicker); attached = false; }
  function markStale(symbol) { var key = normalize(symbol); if (!quotes[key]) return false; quotes[key].stale = true; snapshot(); return true; }
  return { configure: configure, attach: attach, detach: detach, onResult: function (fn) { if (typeof fn === "function") listeners.push(fn); return fn; }, offResult: function (fn) { listeners = listeners.filter(function (x) { return x !== fn; }); }, getQuotes: function () { return quotes; }, getSnapshot: snapshot, normalizeSymbol: normalize, markStale: markStale };
});
