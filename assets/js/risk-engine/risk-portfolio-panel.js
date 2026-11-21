/** Interface e sincronização do Risk Engine Multicripto. */
(function (global, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(global);
  else { global.RiskPortfolioPanel = factory(global); if (global.document) global.document.readyState === "loading" ? global.document.addEventListener("DOMContentLoaded", global.RiskPortfolioPanel.bind) : global.RiskPortfolioPanel.bind(); }
})(typeof globalThis !== "undefined" ? globalThis : this, function (host) {
  "use strict";
  var PANEL = "risk_portfolio", VERSION = 2, MAX = 5, positions = [], balance = 0, referenceAt = null, referencePrices = {}, initial = null, power = null, last = null, bound = false, uid = null, rowsSignature = null, demo = false;
  /* Demonstração: só cripto (sem ações). Não é salva até o usuário editar. */
  var DEMO = [
    { symbol: "AVAX", side: "LONG", quantity: 109.5678, averagePrice: 8.21 },
    { symbol: "ETH", side: "LONG", quantity: 0.25273989, averagePrice: 1978.32 },
    { symbol: "LINK", side: "LONG", quantity: 126.1869, averagePrice: 9.906 },
    { symbol: "BTC", side: "LONG", quantity: 0.03489119, averagePrice: 65919.21 },
    { symbol: "SOL", side: "LONG", quantity: 13.2609, averagePrice: 80.16 }
  ];
  var COINS = {
    BTC: { name: "Bitcoin", color: "#f7931a" },
    ETH: { name: "Ethereum", color: "#8a9cf7" },
    SOL: { name: "Solana", color: "#b57bff" },
    LINK: { name: "Chainlink", color: "#4f7cf6" },
    AVAX: { name: "Avalanche", color: "#e84142" },
    RENDER: { name: "Render", color: "#c084fc" },
    PAXG: { name: "Pax Gold", color: "#f5c451" }
  };
  var RISK_CLASS = {
    "BAIXO NO CENÁRIO": "rp-risk-baixo-no-cenario",
    "ATENÇÃO": "rp-risk-atencao",
    "ELEVADO": "rp-risk-elevado",
    "CRÍTICO": "rp-risk-critico",
    "LIMITE TEÓRICO ATINGIDO": "rp-risk-critico",
    "INDETERMINADO": "rp-risk-indeterminado"
  };
  var RISK_TONE = {
    "BAIXO NO CENÁRIO": "green",
    "ATENÇÃO": "amber",
    "ELEVADO": "red",
    "CRÍTICO": "red",
    "LIMITE TEÓRICO ATINGIDO": "red",
    "INDETERMINADO": "neutral"
  };
  function $(s) { return document.querySelector(s); }
  function num(v) { var s = String(v == null ? "" : v).trim(); if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", "."); var n = Number(s); return Number.isFinite(n) ? n : NaN; }
  function symbol(s) { return host.BI && host.BI.normalizeSymbol ? host.BI.normalizeSymbol(s) : String(s || "").trim().toUpperCase().replace(/USDT$/, ""); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function usd(v) { return Number.isFinite(v) ? v.toLocaleString("pt-BR", { style: "currency", currency: "USD" }) : "—"; }
  function fmt(v, d) { return Number.isFinite(v) ? v.toLocaleString("pt-BR", { minimumFractionDigits: d || 2, maximumFractionDigits: d || 2 }) : "—"; }
  function inputNumber(v, min, max) {
    if (!Number.isFinite(v)) return "";
    return v.toLocaleString("pt-BR", { minimumFractionDigits: min || 0, maximumFractionDigits: max == null ? 8 : max }).replace(/\u00a0/g, " ");
  }
  function text(id, value, cls) {
    var el = typeof id === "string" ? $(id) : id;
    if (!el) return;
    el.textContent = value;
    if (cls != null) el.className = cls;
  }
  function status(v) { text("#rp-status", v || ""); }
  function quotes() { return host.RiskPortfolioAdapter.getQuotes(); }
  /* Saldo informado ≠ saldo zero: zero explícito passa por setReference e grava referenceAt. */
  function hasBalance() { return referenceAt != null || balance > 0; }
  function unavailable(id, label) { text(id, label); var el = $(id); if (el) el.title = "Informe o valor depositado na corretora para calcular."; }
  function valid(p) { return p && symbol(p.symbol) && (p.side === "LONG" || p.side === "SHORT") && Number(p.quantity) > 0 && Number(p.averagePrice) > 0 && Number.isFinite(Number(p.quantity)) && Number.isFinite(Number(p.averagePrice)); }
  function ensureRefs() {
    /* Modelo do painel: "Depositado na corretora" = capital depositado (base A).
       Referência contábil alinhada ao preço médio para garantir equity = depositado + PnL. */
    for (var i = 0; i < positions.length; i++) {
      var s = positions[i].symbol;
      referencePrices[s] = positions[i].averagePrice;
    }
  }
  function payload() { return { schemaVersion: VERSION, equityBasis: "deposited", model: "quantfury-account-balance-simulation", referenceBalance: balance, referenceTimestamp: referenceAt, referencePrices: referencePrices, settings: { initialWealth: null, tradingPower: power }, positions: positions.map(function (p) { return { id: p.id, symbol: p.symbol, side: p.side, quantity: p.quantity, averagePrice: p.averagePrice, invested: p.quantity * p.averagePrice }; }) }; }
  function apply(data) {
    /* Aceita apenas o formato canônico (capital depositado). Estados legados/ambíguos são
       ignorados (persistência do painel pode ser reinicializada) para eliminar interferência
       de referências históricas e garantir resultados determinísticos. */
    if (!data || Number(data.schemaVersion) !== VERSION || data.equityBasis !== "deposited" || !Array.isArray(data.positions) || data.positions.length > MAX) return false;
    var seen = {}, next = [];
    for (var i = 0; i < data.positions.length; i++) { var p = data.positions[i], s = symbol(p && p.symbol); if (!valid(p) || seen[s]) return false; seen[s] = true; next.push({ id: typeof p.id === "string" ? p.id : "rp-" + s, symbol: s, side: p.side, quantity: Number(p.quantity), averagePrice: Number(p.averagePrice) }); }
    positions = next; balance = Number(data.referenceBalance) || 0; referenceAt = typeof data.referenceTimestamp === "string" ? data.referenceTimestamp : null; referencePrices = {};
    var settings = data.settings || {}; initial = null; power = settings.tradingPower != null && Number.isFinite(Number(settings.tradingPower)) ? Number(settings.tradingPower) : null;
    ensureRefs();
    demo = false; syncDemoNotice(); return true;
  }
  function syncDemoNotice() {
    var el = $("#rp-demo"); if (el) el.hidden = !demo;
    var p = $("#rp-demo-text");
    if (p) p.innerHTML = uid
      ? "<b>Dados de exemplo.</b> Estas 5 criptomoedas são apenas demonstração e ainda não foram salvas. Edite qualquer campo para guardar a carteira na sua conta."
      : "<b>Dados de exemplo.</b> Você está como visitante: as alterações não são salvas e, ao recarregar, o exemplo volta. Entre para guardar sua carteira.";
  }
  function seedDemo() {
    demo = true;
    positions = DEMO.map(function (p) { return { id: "rp-" + p.symbol, symbol: p.symbol, side: p.side, quantity: p.quantity, averagePrice: p.averagePrice }; });
    balance = 3000; referenceAt = new Date().toISOString();
    referencePrices = { AVAX: 8.21, ETH: 1978.32, LINK: 9.906, BTC: 65919.21, SOL: 80.16 };
    initial = null; power = null; rowsSignature = null; last = null;
    ensureRefs();
  }
  function clearDemo() {
    demo = false;
    positions = []; balance = 0; referenceAt = null; referencePrices = {}; initial = null; power = null; rowsSignature = null; last = null;
    fillInputs(); configure(); syncDemoNotice();
    status("Exemplo removido. Informe o saldo e adicione suas posições.");
  }
  /* Visitante (sem uid) nunca grava: só memória. Logado confirma a carteira de exemplo. */
  function save() {
    if (!uid) { syncDemoNotice(); status("Modo visitante: as alterações ficam apenas nesta sessão. Entre para salvar."); return false; }
    if (demo) { demo = false; syncDemoNotice(); }
    var ok = host.PanelSync && host.PanelSync.saveLocal && host.PanelSync.saveLocal(PANEL, payload());
    status(ok ? "Salvo localmente." : "Erro de sincronização.");
    return ok;
  }
  function restore(currentUid) {
    if (!currentUid) return false;
    var saved = host.PanelSync && host.PanelSync.loadLocal && host.PanelSync.loadLocal(PANEL);
    return !!(saved && saved.params && saved.owner === currentUid && apply(saved.params));
  }
  function adapterState() { return { referenceBalance: balance, referencePrices: referencePrices, positions: positions, equityBasis: "deposited" }; }
  function configure() { var result = host.RiskPortfolioAdapter.configure(adapterState()); render(result || last); }
  function positionSignature() { return positions.map(function (p) { return [p.id, p.symbol, p.side, p.quantity, p.averagePrice].join("|"); }).join(";"); }
  function setLive(row, key, value, cls) {
    var el = row && row.querySelector('[data-live="' + key + '"]');
    if (!el) return;
    el.textContent = value;
    if (key === "pnl") el.className = "rp-cell-num rp-pnl" + (cls ? " " + cls : "");
  }
  function buildRows() {
    var body = $("#rp-positions"); if (!body) return;
    body.innerHTML = "";
    if (!positions.length) {
      body.innerHTML = '<tr class="rp-empty-row"><td colspan="9" data-label="">Nenhuma criptomoeda cadastrada. Use <b>+ Adicionar ativo</b> para começar.</td></tr>';
      return;
    }
    positions.forEach(function (p, i) {
      var coin = COINS[p.symbol] || { name: p.symbol, color: "#9db6c2" };
      var key = COINS[p.symbol] ? p.symbol.toLowerCase() : "btc";
      var row = document.createElement("tr");
      row.className = "rp-row";
      row.dataset.index = i;
      row.innerHTML =
        '<td class="rp-cell-asset" data-label="Ativo">' +
          '<span class="rp-asset">' +
            '<span class="rp-coin" style="--coin:' + coin.color + '"><svg class="rp-coin-svg" aria-hidden="true"><use href="#rp-coin-' + key + '"/></svg></span>' +
            '<span class="rp-asset-name"><strong>' + esc(p.symbol) + '</strong><small>' + esc(coin.name) + '</small></span>' +
          '</span>' +
        '</td>' +
        '<td class="rp-cell-side" data-label="Lado"><select class="rp-side' + (p.side === "SHORT" ? " rp-side-short" : "") + '" data-field="side" aria-label="Lado de ' + esc(p.symbol) + '"><option value="LONG"' + (p.side === "LONG" ? " selected" : "") + '>LONG</option><option value="SHORT"' + (p.side === "SHORT" ? " selected" : "") + '>SHORT</option></select></td>' +
        '<td class="rp-cell-num" data-label="Investido" data-live="invested">—</td>' +
        '<td class="rp-cell-qty rp-cell-num" data-label="Quantidade"><input data-field="quantity" inputmode="decimal" value="' + inputNumber(Number(p.quantity), 0, 8) + '" aria-label="Quantidade de ' + esc(p.symbol) + '"></td>' +
        '<td class="rp-cell-avg rp-cell-num" data-label="Preço médio"><input data-field="averagePrice" inputmode="decimal" value="' + inputNumber(Number(p.averagePrice), 2, 8) + '" aria-label="Preço médio de ' + esc(p.symbol) + '"></td>' +
        '<td class="rp-cell-num rp-current-quote" data-label="Preço atual" data-live="price">—</td>' +
        '<td class="rp-cell-num" data-label="Valor atual" data-live="value">—</td>' +
        '<td class="rp-cell-num rp-pnl" data-label="P/L" data-live="pnl">—</td>' +
        '<td class="rp-cell-del" data-label=""><button type="button" class="rp-delete" data-delete="' + i + '" aria-label="Excluir ' + esc(p.symbol) + '"><svg class="rp-ico" aria-hidden="true"><use href="#rp-i-trash"/></svg></button></td>';
      body.appendChild(row);
    });
  }
  function updateRows(result) {
    var body = $("#rp-positions"); if (!body) return;
    var bySymbol = {};
    if (result && result.success && Array.isArray(result.positions)) result.positions.forEach(function (r) { bySymbol[r.symbol] = r; });
    var q = quotes();
    Array.prototype.forEach.call(body.querySelectorAll(".rp-row"), function (row, i) {
      var p = positions[i]; if (!p) return;
      var quote = q[p.symbol], r = bySymbol[p.symbol];
      setLive(row, "invested", usd(p.quantity * p.averagePrice));
      setLive(row, "price", quote && quote.price > 0 ? usd(quote.price) : "Cotação indisponível");
      setLive(row, "value", r ? usd(r.marketValue) : "—");
      setLive(row, "pnl", r ? usd(r.pnl) : "—", r ? (r.pnl < 0 ? "rp-negative" : r.pnl > 0 ? "rp-positive" : "") : "");
    });
  }
  function setLiquidationAlert(visible) {
    var alert = $("#rp-liquidation-alert");
    if (alert) alert.hidden = !visible;
  }
  function updateEssentials() { /* seção essencial simplificada: saldo na corretora como referência */ }
  function renderRows() {
    var sig = positionSignature();
    if (sig !== rowsSignature) { buildRows(); rowsSignature = sig; }
    var add = $("#rp-add-toggle");
    if (add) {
      add.disabled = positions.length >= MAX;
      add.title = add.disabled ? "Limite de 5 posições atingido" : "Adicionar criptomoeda";
    }
    text("#rp-count", positions.length + " de " + MAX);
  }
  function render(result) {
    renderRows(); updateEssentials();
    var q = quotes(), validQuotes = positions.filter(function (p) { return q[p.symbol] && q[p.symbol].price > 0; }).length;
    text("#rp-updated", validQuotes ? "Atualizado — " + new Date().toLocaleTimeString("pt-BR") : (positions.length ? "Cotação atrasada ou indisponível" : "Nenhuma criptomoeda cadastrada"));
    text("#rp-valid-quotes", validQuotes + " de " + positions.length + " ativos com cotação");
    if (!result || !result.success) {
      ["#rp-equity", "#rp-exposure", "#rp-pnl", "#rp-leverage", "#rp-drop", "#rp-loss", "#rp-risk", "#rp-invested", "#rp-market", "#rp-table-pnl"].forEach(function (id) { text(id, "—"); });
      setLiquidationAlert(false);
      last = null; updateRows(null); return;
    }
    last = result;
    var informed = hasBalance();
    text("#rp-equity", informed ? usd(result.equity) : "Aguardando depósito", informed && result.equity < 0 ? "rp-negative" : "");
    setLiquidationAlert(informed && result.equity <= 0);
    text("#rp-exposure", usd(result.exposure));
    text("#rp-pnl", usd(result.pnlTotal), result.pnlTotal < 0 ? "rp-negative" : result.pnlTotal > 0 ? "rp-positive" : "");
    if (informed) {
      text("#rp-leverage", result.leverage === null ? "Patrimônio não positivo" : fmt(result.leverage) + "x");
      text("#rp-drop", result.uniformDropToZero === null ? "Indeterminado" : fmt(result.uniformDropToZero) + "%");
      text("#rp-loss", usd(result.additionalLossSupported));
      text("#rp-risk", result.riskState, RISK_CLASS[result.riskState] || "");
    } else {
      unavailable("#rp-leverage", "Indisponível");
      unavailable("#rp-drop", "Indisponível");
      unavailable("#rp-loss", "Indisponível");
      text("#rp-risk", "Depósito não informado", RISK_CLASS["INDETERMINADO"]);
      var riskHint = $("#rp-risk"); if (riskHint) riskHint.title = "Informe o valor depositado na corretora para avaliar o risco de liquidação.";
    }
    text("#rp-invested", usd(result.investedTotal));
    text("#rp-market", usd(result.marketValue));
    text("#rp-table-pnl", usd(result.pnlTotal), result.pnlTotal < 0 ? "rp-negative" : result.pnlTotal > 0 ? "rp-positive" : "");
    var pnlCard = $("#rp-pnl-card"); if (pnlCard) pnlCard.dataset.tone = result.pnlTotal < 0 ? "red" : result.pnlTotal > 0 ? "green" : "neutral";
    var equityCard = $("#rp-equity-card"); if (equityCard) { equityCard.dataset.tone = informed ? "green" : "neutral"; var eq = $("#rp-equity"); if (eq) eq.title = informed ? "" : "Informe o valor depositado na corretora para calcular o patrimônio."; }
    var riskCard = $("#rp-risk-card"); if (riskCard) riskCard.dataset.tone = informed ? (RISK_TONE[result.riskState] || "neutral") : "neutral";
    updateRows(result);
  }
  function fillInputs() {
    $("#rp-balance").value = (balance > 0 || referenceAt != null) ? fmt(balance, 2) : "";
    var pw = $("#rp-power"); if (pw) pw.value = power == null ? "" : inputNumber(Number(power), 0, 2);
    updateEssentials();
  }
  function reset() { positions = []; balance = 0; referenceAt = null; referencePrices = {}; initial = null; power = null; rowsSignature = null; demo = false; syncDemoNotice(); fillInputs(); configure(); }
  function applyDeposit() {
    var v = num($("#rp-balance").value);
    if (!Number.isFinite(v) || v < 0) return status("Informe um valor de depósito válido.");
    balance = v;
    if (referenceAt == null) {
      referenceAt = new Date().toISOString();
      referencePrices = {};
      positions.forEach(function (p) { referencePrices[p.symbol] = p.averagePrice; });
    } else {
      ensureRefs();
    }
    save(); configure();
  }
  function add() {
    var s = symbol($("#rp-symbol").value), side = $("#rp-side").value, quantity = num($("#rp-quantity").value), price = num($("#rp-average").value);
    if (!s || quantity <= 0 || price <= 0) return status("Ativo, quantidade e preço médio devem ser positivos.");
    var old = positions.filter(function (p) { return p.symbol === s; })[0];
    if (old) {
      if (old.side !== side) return status("Não é permitido inverter o lado na mesma posição.");
      var updated = host.RiskPortfolioEngine.addPurchase(old, quantity, price);
      positions[positions.indexOf(old)] = updated;
      referencePrices[s] = updated.averagePrice;
    } else {
      if (positions.length >= MAX) return status("Limite de 5 posições atingido.");
      positions.push({ id: "rp-" + s, symbol: s, side: side, quantity: quantity, averagePrice: price });
      referencePrices[s] = price;
    }
    $("#rp-quantity").value = ""; $("#rp-average").value = "";
    closeAddForm();
    save(); configure();
    status(old ? "Aporte acumulado em " + s + "." : s + " adicionado à carteira.");
  }
  function openAddForm() { var form = $("#rp-add-form"); if (!form || positions.length >= MAX) return; form.hidden = false; var s = $("#rp-symbol"); if (s && s.focus) s.focus(); }
  function closeAddForm() { var form = $("#rp-add-form"); if (form) form.hidden = true; }
  function refreshQuotes() {
    var result = host.RiskPortfolioAdapter.configure(adapterState());
    render(result || last);
    var q = quotes(), n = positions.filter(function (p) { return q[p.symbol] && q[p.symbol].price > 0; }).length;
    status(positions.length ? "Cotações atualizadas — " + n + " de " + positions.length + " ativos." : "Nenhuma posição para atualizar.");
  }
  function simulateDrop() {
    var out = $("#rp-scenario-result"); if (!out) return;
    var pct = num($("#rp-scenario").value), q = quotes();
    if (!Number.isFinite(pct)) { out.textContent = "Informe uma variação válida."; return; }
    if (!positions.length) { out.textContent = "Adicione ao menos uma posição para simular."; return; }
    var missing = positions.filter(function (p) { return !q[p.symbol] || !(q[p.symbol].price > 0); });
    if (missing.length) { out.textContent = "Cotação indisponível para: " + missing.map(function (p) { return p.symbol; }).join(", ") + "."; return; }
    var changes = {}, inputPositions = positions.map(function (p) { changes[p.symbol] = pct; return { symbol: p.symbol, side: p.side, quantity: p.quantity, averagePrice: p.averagePrice, currentPrice: q[p.symbol].price }; });
    var simulated = host.RiskPortfolioEngine.simulate({ referenceBalance: balance, referencePrices: referencePrices, positions: inputPositions, equityBasis: "deposited" }, changes);
    if (!simulated.success) { out.textContent = simulated.message || "Não foi possível simular."; return; }
    if (!hasBalance()) {
      out.textContent = "Cenário de " + fmt(pct, 2) + "%: resultado do cenário " + usd(simulated.additionalPnl) + " nos ativos. Informe o valor depositado na corretora para calcular patrimônio e risco.";
      out.className = simulated.additionalPnl < 0 ? "rp-negative" : simulated.additionalPnl > 0 ? "rp-positive" : "";
      return;
    }
    out.textContent = "Cenário de " + fmt(pct, 2) + "%: patrimônio " + usd(simulated.equity) + " • resultado do cenário " + usd(simulated.additionalPnl) + " • risco " + simulated.riskState + ".";
    out.className = simulated.additionalPnl < 0 ? "rp-negative" : simulated.additionalPnl > 0 ? "rp-positive" : "";
  }
  function bind() {
    if (bound || !document.getElementById("rp-painel") || !host.RiskPortfolioAdapter || !host.RiskPortfolioEngine || !host.PanelSync) return false; bound = true;
    var boot = host.EstudeAuth && host.EstudeAuth.getUser ? host.EstudeAuth.getUser() : null;
    uid = boot && boot.id ? boot.id : null;
    if (!uid || !restore(uid)) seedDemo();
    fillInputs(); host.RiskPortfolioAdapter.attach(); host.RiskPortfolioAdapter.onResult(render);
    $("#rp-add").addEventListener("click", add);
    var demoClear = $("#rp-demo-clear"); if (demoClear) demoClear.addEventListener("click", clearDemo);
    var toggle = $("#rp-add-toggle"); if (toggle) toggle.addEventListener("click", openAddForm);
    var cancel = $("#rp-add-cancel"); if (cancel) cancel.addEventListener("click", closeAddForm);
    var refresh = $("#rp-refresh"); if (refresh) refresh.addEventListener("click", refreshQuotes);
    $("#rp-reference").addEventListener("click", applyDeposit); $("#rp-balance").addEventListener("change", applyDeposit);
    var powerInput = $("#rp-power");
    if (powerInput) powerInput.addEventListener("change", function () { var v = num(powerInput.value); if (Number.isFinite(v) && v >= 0) { power = v; save(); configure(); } });
    var simulate = $("#rp-simulate"); if (simulate) simulate.addEventListener("click", simulateDrop);
    $("#rp-positions").addEventListener("click", function (e) { var btn = e.target.closest("[data-delete]"); var i = btn ? Number(btn.dataset.delete) : NaN; if (Number.isInteger(i) && positions[i]) { delete referencePrices[positions[i].symbol]; positions.splice(i, 1); rowsSignature = null; save(); configure(); } });
    $("#rp-positions").addEventListener("change", function (e) {
      var row = e.target.closest(".rp-row"), i = row && Number(row.dataset.index), field = e.target.dataset.field, v = field === "side" ? e.target.value : num(e.target.value);
      if (!Number.isInteger(i) || !field || (field !== "side" && !(v > 0))) return status("Quantidade e preço médio devem ser positivos.");
      positions[i][field] = v;
      if (field === "averagePrice") referencePrices[positions[i].symbol] = positions[i].averagePrice;
      ensureRefs(); save(); configure();
    });
    host.addEventListener("estudebitcoin:auth-change", function (ev) {
      var u = ev.detail && ev.detail.user;
      if (!u) {
        var wasLogged = !!uid; uid = null;
        if (wasLogged) { reset(); seedDemo(); fillInputs(); rowsSignature = null; configure(); }
        syncDemoNotice();
        return status(wasLogged ? "Você saiu da conta. Exibindo dados de exemplo." : "Modo visitante: as alterações não são salvas.");
      }
      var previous = uid; uid = u.id;
      if (restore(uid)) { fillInputs(); rowsSignature = null; configure(); return status("Carteira restaurada."); }
      if (previous && previous !== uid) reset();
      if (!positions.length) seedDemo();
      fillInputs(); rowsSignature = null; configure(); syncDemoNotice();
      status("Dados de exemplo — edite para salvar na sua conta.");
    });
    host.addEventListener("estudebitcoin:panel-pull", function (ev) { var d = ev.detail; if (uid && d && d.panel === PANEL && apply(d.params)) { fillInputs(); rowsSignature = null; configure(); status("Sincronizado."); } });
    host.addEventListener("estudebitcoin:panel-push-start", function (ev) { if (ev.detail && ev.detail.panel === PANEL) status("Sincronizando..."); }); host.addEventListener("estudebitcoin:panel-push-success", function (ev) { if (ev.detail && ev.detail.panel === PANEL) status("Sincronizado."); }); host.addEventListener("estudebitcoin:panel-push-error", function (ev) { if (ev.detail && ev.detail.panel === PANEL) status("Erro de sincronização."); });
    configure(); syncDemoNotice(); return true;
  }
  return { bind: bind, getState: payload, applyState: apply };
});
