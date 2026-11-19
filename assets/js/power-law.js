/* =====================================================================
   Análise Power Law do Bitcoin — versão embutida no index.html
   Origem: analise-power-law-bitcoin.html (página standalone).
   Regras de cálculo idênticas ao original; apenas escopo (root = card),
   tema aplicado no próprio card e IIFE para não colidir com outros scripts.
   ===================================================================== */
(function () {
  "use strict";

  var root = document.getElementById("power-law-card");
  if (!root) return;

  var $ = function (id) { return root.querySelector("#" + id); };
  var $$ = function (selector) { return root.querySelectorAll(selector); };

  // Modelo fornecido: confirme parâmetros, limites e adequação antes de publicar.
  var GENESIS = Date.UTC(2009, 0, 3);
  var EXPONENT = 5.84509376;
  var INTERCEPT = -17.01593313;
  var MS_PER_DAY = 86400000;
  var DEFAULT_PRICE = 63000;
  var PRICE_STEP = 100;
  var CUSTOM_COUNTS_IN_VERDICT = false;
  var MAX_CUSTOM_DATES = 5;
  var MIN_CUSTOM_DATE = "2011-01-01";
  var LIVE_URL = "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT";
  var FALLBACK_URL = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
  var PROXY_URL = ""; // Opcional: Worker que responda { "price": 63000 }.
  var FETCH_TIMEOUT_MS = 8000;
  var REFRESH_MS = 60000;
  var TIMEZONE = "America/Sao_Paulo";
  var THEME_KEY = "power-law-theme";

  // Valores históricos de referência informados no briefing (não validados via OHLCV).
  // CONFERIR estes valores com um CSV diário (abertura, máxima, mínima, fechamento) antes de publicar.
  var EVENTS = Object.freeze([
    { id: "covid", name: "COVID", type: "fundo", color: "covid",
      close: { date: "2020-03-12", price: 4970.79 },
      low:   { date: "2020-03-13", price: 3800 } },
    { id: "ftx", name: "FTX", type: "fundo", color: "ftx",
      close: { date: "2022-11-21", price: 15787.28 },
      low:   { date: "2022-11-21", price: 15500 } }
  ]);

  var nfMoney = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
  var nfDecimals = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var nfOne = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nfTwo = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var timeFormatter = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIMEZONE });
  var dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TIMEZONE });
  var fmtUSD = function (n) { return "US$ " + nfMoney.format(n); };
  var fmtUSDCents = function (n) { return "US$ " + nfDecimals.format(n); };
  var fmtRatio = function (n) { return nfTwo.format(n) + "x"; };
  var fmtPct = function (n) { return nfOne.format(n) + "%"; };
  var fmtTime = function (date) { return timeFormatter.format(date); };
  var fmtDateTime = function (date) { return dateTimeFormatter.format(date); };
  var fmtDateBR = function (iso) { return iso.split("-").reverse().join("/"); };
  var todayISO = function (now) { return now.toISOString().slice(0, 10); };
  var utcDay = function (now) { return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()); };

  function dateMs(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return NaN;
    var parts = iso.split("-").map(Number);
    var ms = Date.UTC(parts[0], parts[1] - 1, parts[2]);
    if (new Date(ms).toISOString().slice(0, 10) !== iso) return NaN;
    return ms;
  }
  function fairAt(utcMs) {
    var days = (utcMs - GENESIS) / MS_PER_DAY;
    return days > 0 ? Math.pow(10, EXPONENT * Math.log10(days) + INTERCEPT) : NaN;
  }
  function parseBRPrice(value) {
    var trimmed = String(value).trim();
    if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(trimmed)) return null;
    var number = Number(trimmed.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(number) && number > 0 ? number : null;
  }
  function eventAtPresent(event, criterion, fairToday) {
    var point = event[criterion];
    var historicFair = fairAt(dateMs(point.date));
    var ratio = point.price / historicFair;
    return { id: event.id, name: event.name, type: event.type, color: event.color, point: point, ratio: ratio, equivalent: ratio * fairToday };
  }
  function compareVerdict(price, funds) {
    if (!Number.isFinite(price) || price <= 0 || !funds.length) return "neutral";
    var below = funds.filter(function (f) { return price < f.equivalent; }).length;
    return below === funds.length ? "red" : below === 0 ? "blue" : "amber";
  }
  function joinNames(names) {
    if (names.length <= 1) return names[0] || "";
    return names.slice(0, -1).join(", ") + " e " + names[names.length - 1];
  }
  function node(tag, cls, content) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (content !== undefined) el.textContent = String(content);
    return el;
  }
  function fillParts(target, parts) {
    target.replaceChildren();
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part.bold) {
        target.appendChild(node("strong", part.price ? "pl-btc-price" : "", part.text));
      } else {
        target.appendChild(document.createTextNode(part.text));
      }
    }
  }
  function svgUse(symbol) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "svg-icon");
    svg.setAttribute("aria-hidden", "true");
    var use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#" + symbol);
    svg.appendChild(use);
    return svg;
  }

  var state = {
    price: null, criterion: "close", selected: new Set(EVENTS.map(function (e) { return e.id; })),
    custom: [], manual: false, status: "loading", lastGood: null,
    lastSuccess: null, source: "", lastFailure: "", currentRequest: 0
  };
  var refreshTimer = null;

  function getSnapshot(now) {
    // Calculado UMA vez por atualização e reutilizado por todos os elementos.
    var reference = now || new Date();
    var fairToday = fairAt(utcDay(reference));
    var baseEvents = EVENTS.filter(function (e) { return state.selected.has(e.id); })
      .map(function (e) { return eventAtPresent(e, state.criterion, fairToday); });
    var customs = state.custom.map(function (e) { return eventAtPresent(e, "close", fairToday); });
    var ordered = baseEvents.concat(customs).sort(function (a, b) { return dateMs(a.point.date) - dateMs(b.point.date); });
    var funds = ordered.filter(function (e) { return e.type === "fundo" || (CUSTOM_COUNTS_IN_VERDICT && e.type === "referencia"); });
    return { now: reference, fairToday: fairToday, ordered: ordered, funds: funds, ratio: state.price === null ? null : state.price / fairToday };
  }
  function renderBadge() {
    var badge = $("live-badge");
    badge.dataset.mode = state.status;
    var label = "Carregando preço";
    var source = "Buscando cotação ao vivo via Binance (fallback: CoinGecko).";
    if (state.status === "live") {
      label = "AO VIVO · " + fmtTime(state.lastSuccess);
      source = state.source === "CoinGecko"
        ? "Preço ao vivo via CoinGecko (fallback após tentativa via Binance)."
        : state.source === "Proxy" ? "Preço ao vivo via proxy configurado." : "Preço ao vivo via Binance (BTC/USDT; fallback: CoinGecko).";
    } else if (state.status === "stale") {
      label = "Sem conexão · último preço " + fmtTime(state.lastSuccess);
      source = "Falha nas fontes de cotação; exibindo o último preço confirmado.";
    } else if (state.status === "manual") {
      label = "Preço informado";
      source = state.lastFailure ? "Cotação indisponível; usando preço informado de referência." : "Cotação manual; a atualização automática está pausada.";
    }
    $("badge-text").textContent = label;
    $("price-source").textContent = source;
    $("resume-live").hidden = !(state.manual || state.status === "stale");
  }
  function renderVerdict(snapshot) {
    var funds = snapshot.funds;
    var price = state.price;
    var verdict = $("verdict");
    var titleFundName = function (f) { return f.id === "ftx" ? "quebra da corretora FTX" : f.name; };
    var titleQualified = function (items) {
      return items.length === 1 ? "o fundo da " + titleFundName(items[0]) : "os fundos " + joinNames(items.map(function (f) { return "da " + titleFundName(f); }));
    };
    if (price === null) {
      verdict.dataset.state = "neutral";
      $("verdict-title").textContent = "Digite um preço válido";
      $("verdict-description").textContent = "A comparação será exibida quando houver um valor positivo.";
    } else if (funds.length === 0) {
      verdict.dataset.state = "neutral";
      $("verdict-title").textContent = "Selecione um fundo para comparar";
      $("verdict-description").textContent = "As datas personalizadas não participam do veredito.";
    } else {
      var verdictState = compareVerdict(price, funds);
      verdict.dataset.state = verdictState;
      var below = funds.filter(function (f) { return price < f.equivalent; });
      var above = funds.filter(function (f) { return price >= f.equivalent; });
      var entries = function (items) { return joinNames(items.map(function (e) { return e.name + " (" + fmtUSD(e.equivalent) + ")"; })); };
      if (verdictState === "red") {
        $("verdict-title").textContent = "Mais barato que " + titleQualified(funds);
        $("verdict-description").textContent = "O preço atual (" + fmtUSD(price) + ") está abaixo do equivalente de " + (funds.length === 1 ? "seu fundo selecionado" : "todos os fundos selecionados") + ": " + entries(funds) + ".";
      } else if (verdictState === "amber") {
        $("verdict-title").textContent = "Mais barato que " + titleQualified(below);
        $("verdict-description").textContent = "O preço atual (" + fmtUSD(price) + ") está abaixo do equivalente de " + entries(below) + ", mas acima ou no mesmo nível do de " + entries(above) + ".";
      } else {
        $("verdict-title").textContent = "Ainda acima " + (funds.length === 1 ? "do fundo da " + titleFundName(funds[0]) : "dos fundos " + joinNames(funds.map(function (f) { return "da " + titleFundName(f); })));
        $("verdict-description").textContent = "O preço atual (" + fmtUSD(price) + ") está acima ou no mesmo nível do equivalente de todos os fundos selecionados: " + entries(funds) + ".";
      }
    }
    var icons = { red: "#i-down", amber: "#i-down", blue: "#i-up", neutral: "#i-info" };
    $("verdict-icon").setAttribute("href", icons[verdict.dataset.state]);
  }
  function appendBar(list, label, ratio, amount, color, isTrend) {
    var row = node("div", "bar-row");
    row.setAttribute("data-bar", color);
    var name = node("div", "bar-label");
    name.appendChild(node("strong", "", label));
    name.appendChild(node("span", "", " (" + fmtRatio(ratio) + ")"));
    var track = node("div", "bar-track");
    track.setAttribute("role", "img");
    var percent = ratio * 100;
    track.setAttribute("aria-label", label + ", " + fmtRatio(ratio) + " da tendência, " + fmtUSD(amount) + ", " + fmtPct(percent));
    var fill = node("div", "bar-fill " + color);
    var visiblePercent = Math.min(100, Math.max(0, percent));
    fill.style.width = "0%";
    requestAnimationFrame(function () { if (fill.isConnected) fill.style.width = visiblePercent + "%"; });
    if (percent >= 12) {
      fill.appendChild(node("span", "bar-percent", fmtPct(percent)));
    } else {
      var out = node("span", "bar-percent outside", fmtPct(percent));
      out.style.left = Math.min(visiblePercent, 65) + "%";
      track.appendChild(out);
    }
    track.appendChild(fill);
    row.append(name, track, node("div", "bar-value", fmtUSD(amount)));
    list.appendChild(row);
  }
  function renderBars(snapshot) {
    var list = $("bar-list");
    list.replaceChildren();
    $("comparison-sub").textContent = "Barras proporcionais de 0 até a tendência (1,0x = " + fmtUSD(snapshot.fairToday) + ").";
    if (state.price === null) { list.hidden = true; return; }
    list.hidden = false;
    appendBar(list, "Tendência Power Law", 1, snapshot.fairToday, "trend", true);
    appendBar(list, "Preço hoje", snapshot.ratio, state.price, "price");
    for (var i = 0; i < snapshot.ordered.length; i++) {
      var e = snapshot.ordered[i];
      var label = e.type === "referencia"
        ? "Sua data " + fmtDateBR(e.point.date) + " em valores de hoje"
        : e.name + " em valores de hoje";
      appendBar(list, label, e.ratio, e.equivalent, e.color);
    }
  }
  function renderPrices(snapshot) {
    var criterion = state.criterion === "close" ? "fechamento diário" : "mínima do dia";
    var entries = snapshot.ordered.map(function (e) {
      return (e.name === "Sua data" ? "Sua data" : e.name) + " " + fmtDateBR(e.point.date) + " = " + fmtUSDCents(e.point.price);
    });
    $("used-prices-copy").textContent = entries.length
      ? "Preços usados (critério: " + criterion + (state.custom.length ? "; datas personalizadas: preço informado" : "") + "): " + entries.join(" · ") + "."
      : "Preços usados (critério: " + criterion + "): nenhum evento selecionado.";
  }
  function renderInfo(snapshot) {
    var target = $("info-copy");
    if (state.price === null) {
      target.textContent = "Digite um preço válido para calcular a distância até a tendência.";
      return;
    }
    var delta = Math.abs((snapshot.ratio - 1) * 100);
    var direction = snapshot.ratio < 1 ? "abaixo" : snapshot.ratio > 1 ? "acima" : "no mesmo nível";
    var distance = direction === "no mesmo nível" ? "em linha com" : fmtPct(delta) + " " + direction + " de";
    var parts = [
      { text: "Com o BTC a " }, { text: fmtUSD(state.price), bold: true, price: true },
      { text: ", ele está a " }, { text: "~" + fmtRatio(snapshot.ratio), bold: true },
      { text: " da tendência (" + distance + " ~" }, { text: fmtUSD(snapshot.fairToday), bold: true },
      { text: ")." }
    ];
    if (snapshot.funds.length) {
      var below = snapshot.funds.filter(function (e) { return state.price < e.equivalent; });
      var above = snapshot.funds.filter(function (e) { return state.price >= e.equivalent; });
      var listRatio = function (items) { return joinNames(items.map(function (e) { return e.name + " (" + fmtRatio(e.ratio) + ")"; })); };
      if (below.length === snapshot.funds.length) {
        parts.push({ text: " Esse nível está abaixo das razões dos fundos da " + listRatio(below) + "." });
      } else if (below.length === 0) {
        parts.push({ text: " Esse nível está acima ou no mesmo nível das razões dos fundos da " + listRatio(above) + "." });
      } else {
        parts.push({ text: " Esse nível está abaixo da razão da " + listRatio(below) + ", mas acima ou no mesmo nível da razão da " + listRatio(above) + "." });
      }
    }
    fillParts(target, parts);
  }
  function renderChips() {
    var container = $("custom-chips");
    container.replaceChildren();
    var addCustomChip = function (custom) {
      var chip = node("span", "custom-chip");
      chip.appendChild(document.createTextNode("Sua data " + fmtDateBR(custom.close.date) + " · " + fmtUSDCents(custom.close.price)));
      var remove = node("button", "remove-chip");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remover data " + fmtDateBR(custom.close.date));
      remove.appendChild(svgUse("i-x"));
      remove.addEventListener("click", function () {
        state.custom = state.custom.filter(function (e) { return e.id !== custom.id; });
        render();
      });
      chip.appendChild(remove);
      container.appendChild(chip);
    };
    for (var j = 0; j < state.custom.length; j++) addCustomChip(state.custom[j]);
  }
  function render() {
    var snapshot = getSnapshot();
    renderBadge();
    renderVerdict(snapshot);
    renderBars(snapshot);
    renderPrices(snapshot);
    renderInfo(snapshot);
    renderChips();
    $("custom-date").max = todayISO(snapshot.now);
    $("footer-copy").textContent = "Modelo Power Law (Santostasi/Burger) · atualizado em " + fmtDateTime(snapshot.now) + " · conteúdo educacional, não é recomendação de investimento. É um ajuste estatístico ao passado, com poucos ciclos de dados.";
  }
  function setPriceError(message) {
    $("price-error").textContent = message;
    $("price-error").hidden = !message;
    $("btc-price").setAttribute("aria-invalid", String(Boolean(message)));
  }
  function setCustomError(message) {
    $("custom-error").textContent = message;
    $("custom-error").hidden = !message;
  }
  function manuallySetPrice(value, reformat) {
    state.manual = true;
    $("btc-price").classList.remove("skeleton");
    state.currentRequest += 1;
    clearInterval(refreshTimer);
    refreshTimer = null;
    state.price = parseBRPrice(value);
    state.status = "manual";
    state.lastFailure = "";
    setPriceError(state.price === null ? "Digite um preço válido" : "");
    if (reformat && state.price !== null) $("btc-price").value = nfDecimals.format(state.price);
    render();
  }
  function fetchJSON(url) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .finally(function () { clearTimeout(timeout); });
  }
  function usableQuote(value) {
    var n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function getQuote() {
    var sources = [];
    if (PROXY_URL) sources.push({ name: "Proxy", url: PROXY_URL, read: function (data) { return data.price != null ? data.price : (data.bitcoin && data.bitcoin.usd); } });
    sources.push({ name: "Binance", url: LIVE_URL, read: function (data) { return data.price; } });
    sources.push({ name: "CoinGecko", url: FALLBACK_URL, read: function (data) { return data.bitcoin && data.bitcoin.usd; } });
    var index = 0;
    function attempt() {
      if (index >= sources.length) return Promise.reject(new Error("Nenhuma fonte de cotação respondeu com preço válido."));
      var source = sources[index++];
      return fetchJSON(source.url).then(function (data) {
        var value = usableQuote(source.read(data));
        if (value !== null) return { value: value, source: source.name };
        return attempt();
      }).catch(function () { return attempt(); });
    }
    return attempt();
  }
  function refreshPrice() {
    if (state.manual) return;
    var request = ++state.currentRequest;
    getQuote().then(function (quote) {
      if (state.manual || request !== state.currentRequest) return;
      state.price = quote.value;
      state.lastGood = quote.value;
      state.lastSuccess = new Date();
      state.source = quote.source;
      state.status = "live";
      state.lastFailure = "";
      $("btc-price").value = nfDecimals.format(quote.value);
      setPriceError("");
    }).catch(function (err) {
      if (state.manual || request !== state.currentRequest) return;
      state.lastFailure = err.message;
      if (state.lastGood !== null) {
        state.price = state.lastGood;
        state.status = "stale";
        $("btc-price").value = nfDecimals.format(state.price);
      } else {
        state.price = DEFAULT_PRICE;
        state.manual = true;
        state.status = "manual";
        $("btc-price").value = nfDecimals.format(DEFAULT_PRICE);
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    }).finally(function () {
      if (request === state.currentRequest) $("btc-price").classList.remove("skeleton");
      if (request === state.currentRequest) render();
    });
  }
  function startLive() {
    state.manual = false;
    state.lastFailure = "";
    $("resume-live").hidden = true;
    clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshPrice, REFRESH_MS);
    refreshPrice();
  }
  function applyTheme(theme) {
    root.dataset.theme = theme;
    var buttons = $$("[data-set-theme]");
    for (var i = 0; i < buttons.length; i++) {
      var active = buttons[i].dataset.setTheme === theme;
      buttons[i].classList.toggle("active", active);
      buttons[i].setAttribute("aria-pressed", String(active));
    }
    try { localStorage.setItem(THEME_KEY, theme); } catch (err) { /* Armazenamento pode estar bloqueado. */ }
  }
  function configureTheme() {
    var initial = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    try {
      var saved = localStorage.getItem(THEME_KEY);
      if (saved === "dark" || saved === "light") initial = saved;
    } catch (err) { /* Usar prefers-color-scheme. */ }
    applyTheme(initial);
    var buttons = $$("[data-set-theme]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function () { applyTheme(this.dataset.setTheme); });
    }
  }
  function selfTest() {
    var now = new Date("2026-11-19T12:00:00Z");
    var fair = fairAt(utcDay(now));
    var eventsClose = EVENTS.map(function (e) { return eventAtPresent(e, "close", fair); });
    var eventsLow = EVENTS.map(function (e) { return eventAtPresent(e, "low", fair); });
    var approx = function (a, b) { return Math.abs(a - b) / b <= .003; };
    var total = 0, passed = 0;
    var check = function (name, ok) { ++total; if (ok) ++passed; console.assert(ok, name); };
    check("Power Law novembro/2026", approx(fair, 191600));
    check("Razão de 63000", approx(63000 / fair, .329));
    check("Queda de 67,1%", approx((1 - 63000 / fair) * 100, 67.1));
    check("Fechamento COVID", approx(eventsClose[0].equivalent, 77000));
    check("Fechamento FTX", approx(eventsClose[1].equivalent, 69300));
    check("Mínima COVID", approx(eventsLow[0].equivalent, 58700));
    check("Mínima FTX", approx(eventsLow[1].equivalent, 68000));
    check("Fechamento vermelho", compareVerdict(63000, eventsClose.slice(0, 2)) === "red");
    check("Mínima âmbar", compareVerdict(63000, eventsLow.slice(0, 2)) === "amber");
    check("Sem fundos neutro", compareVerdict(63000, []) === "neutral");
    check("Preço 200000 azul", compareVerdict(200000, eventsClose.slice(0, 2)) === "blue");
    check("Preço 63000 formato simples", parseBRPrice("63000") === 63000);
    check("Preço 63.000 formato pt-BR", parseBRPrice("63.000") === 63000);
    check("Preço 63.000,50 formato pt-BR", parseBRPrice("63.000,50") === 63000.5);
    check("Preço inválido", ["", "0", "-1", "abc", "NaN"].every(function (s) { return parseBRPrice(s) === null; }));
    var previous = state.price;
    state.price = null;
    render();
    check("Entradas inválidas nunca exibem NaN no DOM", root.textContent.indexOf("NaN") === -1);
    state.price = previous;
    render();
    console.info(passed + "/" + total + " testes passaram");
  }

  function init() {
    configureTheme();
    var input = $("btc-price");
    input.classList.add("skeleton");
    input.addEventListener("input", function () { manuallySetPrice(input.value); });
    input.addEventListener("blur", function () {
      if (state.manual && state.price !== null) input.value = nfDecimals.format(state.price);
    });
    [["step-down", -1], ["step-up", 1]].forEach(function (pair) {
      $(pair[0]).addEventListener("click", function () {
        var base = parseBRPrice(input.value);
        if (base === null) base = state.price !== null ? state.price : DEFAULT_PRICE;
        var value = Math.max(.01, Math.round((base + PRICE_STEP * pair[1]) * 100) / 100);
        input.value = nfDecimals.format(value);
        manuallySetPrice(input.value);
      });
    });
    $("resume-live").addEventListener("click", function () {
      setPriceError("");
      startLive();
    });
    var criteria = $$("[data-criterion]");
    for (var i = 0; i < criteria.length; i++) {
      criteria[i].addEventListener("click", function () {
        state.criterion = this.dataset.criterion;
        var options = $$("[data-criterion]");
        for (var k = 0; k < options.length; k++) {
          var active = options[k].dataset.criterion === state.criterion;
          options[k].classList.toggle("active", active);
          options[k].setAttribute("aria-pressed", String(active));
        }
        render();
      });
    }
    // COVID e FTX sempre ativos (seção de comparações removida do HTML).
    state.selected = new Set(EVENTS.map(function (e) { return e.id; }));
    $("custom-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var iso = $("custom-date").value;
      var raw = $("custom-price").value;
      var price = parseBRPrice(raw);
      if (!iso || !raw.trim() || price === null) { setCustomError("Informe a data e o preço."); return; }
      var ms = dateMs(iso);
      var now = todayISO(new Date());
      if (!Number.isFinite(ms) || iso < MIN_CUSTOM_DATE || iso > now) {
        setCustomError("Use uma data entre 2011 e hoje."); return;
      }
      var duplicated = state.custom.some(function (e) { return e.close.date === iso; }) ||
        EVENTS.some(function (e) { return e.close.date === iso || e.low.date === iso; });
      if (duplicated) { setCustomError("Essa data já está na comparação."); return; }
      if (state.custom.length >= MAX_CUSTOM_DATES) { setCustomError("Limite de 5 datas personalizadas."); return; }
      state.custom.push({ id: "custom-" + iso, name: "Sua data", type: "referencia", color: "custom", close: { date: iso, price: price } });
      $("custom-form").reset();
      setCustomError("");
      render();
    });
    render();
    if (new URLSearchParams(location.search).get("test") === "1") selfTest();
    startLive();
  }
  init();
})();
