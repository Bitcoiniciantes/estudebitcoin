/** Interface e sincronização do Risk Engine Multicripto. */
(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(global);
  else { global.RiskPortfolioPanel = factory(global); if (global.document) global.document.readyState === "loading" ? global.document.addEventListener("DOMContentLoaded", global.RiskPortfolioPanel.bind) : global.RiskPortfolioPanel.bind(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function (host) {
  "use strict";
  var PANEL = "risk_portfolio", VERSION = 1, MAX = 5, positions = [], balance = 0, referenceAt = null, referencePrices = {}, initial = null, power = null, last = null, bound = false, uid = null;
  function $(s) { return document.querySelector(s); }
  function num(v) { var s = String(v == null ? "" : v).trim(); if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", "."); var n = Number(s); return Number.isFinite(n) ? n : NaN; }
  function symbol(s) { return host.BI && host.BI.normalizeSymbol ? host.BI.normalizeSymbol(s) : String(s || "").trim().toUpperCase().replace(/USDT$/, ""); }
  function usd(v) { return Number.isFinite(v) ? v.toLocaleString("pt-BR", { style: "currency", currency: "USD" }) : "—"; }
  function fmt(v, d) { return Number.isFinite(v) ? v.toLocaleString("pt-BR", { minimumFractionDigits: d || 2, maximumFractionDigits: d || 2 }) : "—"; }
  function text(id, value, cls) { var el = $(id); if (el) { el.textContent = value; el.className = cls || ""; } }
  function status(v) { text("#rp-status", v || ""); }
  function quotes() { return host.RiskPortfolioAdapter.getQuotes(); }
  function valid(p) { return p && symbol(p.symbol) && (p.side === "LONG" || p.side === "SHORT") && Number(p.quantity) > 0 && Number(p.averagePrice) > 0 && Number.isFinite(Number(p.quantity)) && Number.isFinite(Number(p.averagePrice)); }
  function payload() { return { schemaVersion: VERSION, model: "quantfury-account-balance-simulation", referenceBalance: balance, referenceTimestamp: referenceAt, referencePrices: referencePrices, settings: { initialWealth: initial, tradingPower: power }, positions: positions.map(function (p) { return { id: p.id, symbol: p.symbol, side: p.side, quantity: p.quantity, averagePrice: p.averagePrice, invested: p.quantity * p.averagePrice }; }) }; }
  function apply(data) {
    if (!data || Number(data.schemaVersion || 1) !== VERSION || !Array.isArray(data.positions) || data.positions.length > MAX) return false;
    var seen = {}, next = [];
    for (var i = 0; i < data.positions.length; i++) { var p = data.positions[i], s = symbol(p && p.symbol); if (!valid(p) || seen[s]) return false; seen[s] = true; next.push({ id: typeof p.id === "string" ? p.id : "rp-" + s, symbol: s, side: p.side, quantity: Number(p.quantity), averagePrice: Number(p.averagePrice) }); }
    positions = next; balance = Number(data.referenceBalance) || 0; referenceAt = typeof data.referenceTimestamp === "string" ? data.referenceTimestamp : null; referencePrices = data.referencePrices && typeof data.referencePrices === "object" ? data.referencePrices : {};
    var settings = data.settings || {}; initial = settings.initialWealth != null && Number.isFinite(Number(settings.initialWealth)) ? Number(settings.initialWealth) : null; power = settings.tradingPower != null && Number.isFinite(Number(settings.tradingPower)) ? Number(settings.tradingPower) : null; return true;
  }
  function save() { var ok = host.PanelSync && host.PanelSync.saveLocal && host.PanelSync.saveLocal(PANEL, payload()); status(ok ? "Salvo localmente." : "Erro de sincronização."); return ok; }
  function restore(currentUid) { var saved = host.PanelSync && host.PanelSync.loadLocal && host.PanelSync.loadLocal(PANEL); return !!(saved && saved.params && (!currentUid ? saved.owner == null : saved.owner === currentUid) && apply(saved.params)); }
  function configure() { host.RiskPortfolioAdapter.configure({ referenceBalance: balance, referencePrices: referencePrices, positions: positions }); render(); }
  function renderRows() {
    var body = $("#rp-positions"); body.innerHTML = "";
    positions.forEach(function (p, i) { var q = quotes()[p.symbol], row = document.createElement("article"); row.className = "rp-position"; row.dataset.index = i; row.innerHTML = '<div class="rp-position-title"><strong>' + p.symbol + '</strong><button type="button" class="rp-delete" data-delete="' + i + '">Excluir</button></div><label>Lado<select data-field="side"><option' + (p.side === "LONG" ? " selected" : "") + '>LONG</option><option' + (p.side === "SHORT" ? " selected" : "") + '>SHORT</option></select></label><label>Quantidade<input data-field="quantity" inputmode="decimal" value="' + p.quantity + '"></label><label>Preço médio (USD)<input data-field="averagePrice" inputmode="decimal" value="' + p.averagePrice + '"></label><div class="rp-live"><span>Preço atual</span><strong>' + (q && q.price ? usd(q.price) : "Cotação indisponível") + '</strong></div>'; body.appendChild(row); });
    var add = $("#rp-add"); add.disabled = positions.length >= MAX; add.textContent = add.disabled ? "Limite de 5 posições atingido" : "+ Adicionar ativo"; text("#rp-count", positions.length + " / " + MAX + " posições");
  }
  function render(result) {
    renderRows(); var q = quotes(), validQuotes = positions.filter(function (p) { return q[p.symbol] && q[p.symbol].price > 0; }).length;
    text("#rp-updated", validQuotes ? "Atualizado — " + new Date().toLocaleTimeString("pt-BR") : (positions.length ? "Cotação atrasada ou indisponível" : "Dados indisponíveis")); text("#rp-valid-quotes", validQuotes + " de " + positions.length + " ativos com cotação");
    if (!result || !result.success) { ["#rp-equity", "#rp-exposure", "#rp-pnl", "#rp-leverage", "#rp-drop", "#rp-loss", "#rp-risk", "#rp-invested", "#rp-market"].forEach(function (id) { text(id, "—"); }); return; }
    last = result; text("#rp-equity", usd(result.equity)); text("#rp-exposure", usd(result.exposure)); text("#rp-pnl", usd(result.pnlTotal), result.pnlTotal < 0 ? "rp-negative" : "rp-positive"); text("#rp-leverage", result.leverage === null ? "Patrimônio não positivo" : fmt(result.leverage) + "x"); text("#rp-drop", result.uniformDropToZero === null ? "Indeterminado" : fmt(result.uniformDropToZero) + "%"); text("#rp-loss", usd(result.additionalLossSupported)); text("#rp-risk", result.riskState); text("#rp-invested", usd(result.investedTotal)); text("#rp-market", usd(result.marketValue));
  }
  function fillInputs() { $("#rp-balance").value = balance || ""; $("#rp-initial").value = initial == null ? "" : initial; $("#rp-power").value = power == null ? "" : power; }
  function reset() { positions = []; balance = 0; referenceAt = null; referencePrices = {}; initial = null; power = null; fillInputs(); configure(); }
  function setReference() { var v = num($("#rp-balance").value); if (!Number.isFinite(v) || v < 0) return status("Informe um saldo válido."); balance = v; referenceAt = new Date().toISOString(); referencePrices = {}; var q = quotes(); positions.forEach(function (p) { if (q[p.symbol] && q[p.symbol].price > 0) referencePrices[p.symbol] = q[p.symbol].price; }); save(); configure(); }
  function add() { var s = symbol($("#rp-symbol").value), side = $("#rp-side").value, quantity = num($("#rp-quantity").value), price = num($("#rp-average").value); if (!s || quantity <= 0 || price <= 0) return status("Ativo, quantidade e preço médio devem ser positivos."); var old = positions.filter(function (p) { return p.symbol === s; })[0]; if (old) { if (old.side !== side) return status("Não é permitido inverter o lado na mesma posição."); positions[positions.indexOf(old)] = host.RiskPortfolioEngine.addPurchase(old, quantity, price); } else { if (positions.length >= MAX) return status("Limite de 5 posições atingido."); positions.push({ id: "rp-" + s, symbol: s, side: side, quantity: quantity, averagePrice: price }); } $("#rp-quantity").value = ""; $("#rp-average").value = ""; save(); configure(); }
  function bind() {
    if (bound || !document.getElementById("rp-painel") || !host.RiskPortfolioAdapter || !host.RiskPortfolioEngine || !host.PanelSync) return false; bound = true; restore(null); fillInputs(); host.RiskPortfolioAdapter.attach(); host.RiskPortfolioAdapter.onResult(render);
    $("#rp-add").addEventListener("click", add); $("#rp-reference").addEventListener("click", setReference); $("#rp-balance").addEventListener("change", setReference);
    ["#rp-initial", "#rp-power"].forEach(function (id) { $(id).addEventListener("change", function () { var v = num($(id).value); if (Number.isFinite(v) && v >= 0) { if (id === "#rp-initial") initial = v; else power = v; save(); } }); });
    $("#rp-positions").addEventListener("click", function (e) { var i = Number(e.target.dataset.delete); if (Number.isInteger(i) && positions[i]) { delete referencePrices[positions[i].symbol]; positions.splice(i, 1); save(); configure(); } });
    $("#rp-positions").addEventListener("change", function (e) { var row = e.target.closest(".rp-position"), i = row && Number(row.dataset.index), field = e.target.dataset.field, v = field === "side" ? e.target.value : num(e.target.value); if (!Number.isInteger(i) || !field || (field !== "side" && !(v > 0))) return status("Quantidade e preço médio devem ser positivos."); positions[i][field] = v; save(); configure(); });
    host.addEventListener("estudebitcoin:auth-change", function (ev) { var u = ev.detail && ev.detail.user; if (!u) { uid = null; reset(); return status("Dados privados ocultos após sair da conta."); } uid = u.id; if (restore(uid)) { fillInputs(); configure(); } else { reset(); status("Sincronizando..."); } });
    host.addEventListener("estudebitcoin:panel-pull", function (ev) { var d = ev.detail; if (uid && d && d.panel === PANEL && apply(d.params)) { fillInputs(); configure(); status("Sincronizado."); } });
    host.addEventListener("estudebitcoin:panel-push-start", function (ev) { if (ev.detail && ev.detail.panel === PANEL) status("Sincronizando..."); }); host.addEventListener("estudebitcoin:panel-push-success", function (ev) { if (ev.detail && ev.detail.panel === PANEL) status("Sincronizado."); }); host.addEventListener("estudebitcoin:panel-push-error", function (ev) { if (ev.detail && ev.detail.panel === PANEL) status("Erro de sincronização."); });
    configure(); return true;
  }
  return { bind: bind, getState: payload, applyState: apply };
});
