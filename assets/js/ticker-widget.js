(function () {
  var WORKER = "https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/api/quotes";
  var CRYPTO = [
    ["BTC", "BTCUSDT", "USD"],
    ["ETH", "ETHUSDT", "USD"],
    ["SOL", "SOLUSDT", "USD"],
    ["LINK", "LINKUSDT", "USD"],
    ["AVAX", "AVAXUSDT", "USD"],
    ["RENDER", "RENDERUSDT", "USD"],
    ["PAXG", "PAXGUSDT", "USD"],
    ["USDT-BRL", "USDTBRL", "BRL"],
  ];
  var STOCKS = ["^GSPC", "^NDX", "SI=F", "HG=F", "BZ=F", "URNM", "GC=F", "USAR", "QUBT", "QBTS", "NVDA", "AMD", "GOOGL", "META", "AAPL", "SNDK", "GLW", "MSTR", "CRCL", "MP", "RIO", "BHP", "SPCX", "TSLA"];
  var CRYPTO_NAMES = {
    BTC: "Bitcoin",
    ETH: "Ethereum",
    SOL: "Solana",
    LINK: "Chainlink",
    AVAX: "Avalanche",
    RENDER: "Render",
    PAXG: "Pax Gold",
    "USDT-BRL": "Dólar em Reais (USDT-BRL)",
  };
  var STOCK_NAMES = {
    "SI=F": "PRATA",
    "MSTR": "STRATEGY",
    "HG=F": "COBRE",
    "URNM": "URÂNIO ETF",
    "SPCX": "SPACEX",
    "GLW": "CORNING",
    "QUBT": "QUANTUM",
    "BZ=F": "BRENT",
    "^NDX": "NASDAQ 100",
    "NVDA": "NVIDIA",
    "CRCL": "CIRCLE",
    "MP": "MP MATERIALS",
    "AMD": "AMD",
    "TSLA": "TESLA",
    "GOOGL": "ALPHABET",
    "META": "META PLATFORMS",
    "GC=F": "OURO",
    "QBTS": "D-WAVE QUANTUM",
    "AAPL": "APPLE",
    "SNDK": "SANDISK",
    "RIO": "RIO TINTO",
    "BHP": "BHP",
    "USAR": "USA RARE EARTH",
    "^GSPC": "S&P 500",
  };
  var STOCK_LABELS = {
    "^GSPC": "S&P 500",
    "SI=F": "PRATA",
    "HG=F": "COBRE",
    "GC=F": "OURO",
    "BZ=F": "BRENT",
    "^NDX": "NASDAQ 100",
  };
  // Aba B3 — lista fixa, sempre em reais. O sufixo .SA é obrigatório: sem ele o
  // Worker devolve zero cotações (Yahoo não reconhece PETR4, só PETR4.SA).
  // Nomes são fixos no front porque o meta.shortName da B3 vem sujo
  // ("ITAUUNIBANCOPN      N1").
  var B3 = [
    { sym: "^BVSP", label: "IBOV", name: "Ibovespa" },
    { sym: "VALE3.SA", label: "VALE3", name: "Vale ON" },
    { sym: "PETR4.SA", label: "PETR4", name: "Petrobras PN" },
    { sym: "ITUB4.SA", label: "ITUB4", name: "Itaú Unibanco PN" },
    { sym: "BBDC4.SA", label: "BBDC4", name: "Bradesco PN" },
    { sym: "BBAS3.SA", label: "BBAS3", name: "Banco do Brasil ON" },
    { sym: "QBTC11.SA", label: "QBTC11", name: "QBTC11" },
    { sym: "USIM5.SA", label: "USIM5", name: "Usiminas PNA" },
  ];
  var B3_META = {};
  var B3_ASSETS = [];
  B3.forEach(function (item) {
    B3_META[item.sym] = item;
    B3_ASSETS.push(item.sym);
  });
  var B3_FIXED_ASSETS = B3_ASSETS.slice();
  var b3AdditionalAssets = [];
  var b3VisitorExtra = [];
  var b3ValidationPending = {};
  var b3SessionGeneration = 0;
  var b3AuthUid = null;
  var b3PreferencesLoading = true;
  var b3WriteQueues = {};
  var b3MessageTimer = null;
  var B3_TICKER_RE = /^[A-Z][A-Z0-9]{3}[0-9]{1,2}$/;
  var KLINE_CFG = {
    "1h": { interval: "1h", limit: 12, baseFromPrev: true },
    "24h": { interval: "1h", limit: 25 },
    "7d": { interval: "1d", limit: 8 },
    "30d": { interval: "1d", limit: 31 },
  };
  var grid = document.getElementById("ticker-grid");
  var statusEl = document.getElementById("ticker-status");
  if (!grid) return;

  var activeTab = "crypto";
  var stockPollTimer = null;
  var stocksBroadcastTimer = null;
  var tickerPageWasHidden = document.hidden;
  var activeWindow = "24h";
  var uiStateGen = 0;
  var cache = {};
  var livePrices = {};
  var preMarketEstimates = {}; // display-only: lido exclusivamente por card()
  var cardPrices = {}; // último preço visto por símbolo (p/ modal Graham)
  var cardChangePct = {}; // variação do dia (%) por monitorado (não sobrescreve preço)
  var cardChange30d = {}; // variação 30d (%) por monitorado (janela fixa; só memória)
  var cardChange1y = {}; // variação 1 ano (%) por monitorado (janela fixa; só memória)
  var cardShortHistory1y = {}; // 1Y curto na última resposta do Worker
  var cardCloses24Len = {}; // nº de fechamentos do batch 24h (1mo) por ticker
  var last30dAt = 0; // último agendamento do lote 30d (marca antes do fetch)
  var MONITOR_30D_EVERY_MS = 5 * 60000; // 30d a cada 5 min, no mesmo ciclo de 60s
  var liveVolume = {};
  var quoteData = {};
  var pairSymbol = {};
  var symbolCurrency = {};
  // RSI semanal da aba B3. `rsiBySymbol` é o que o card lê; `rsiMemo` guarda a
  // última resposta válida por 1h — o refresh de 5s NÃO pode bater no Worker.
  // O memo é independente de `cache` (que o refresh(true) apaga a cada ciclo).
  var rsiBySymbol = {};
  var rsiMemo = {
    b3: { at: 0, bySymbol: null, pending: null, signature: "" },
    stocks: { at: 0, bySymbol: null, pending: null, signature: "stocks" },
  };
  var RSI_TTL_MS = 60 * 60 * 1000;
  var CRYPTO_RSI_TTL_MS = 60 * 60 * 1000;
  var CRYPTO_RSI_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
  var CRYPTO_RSI_LIMIT = 200;
  var CRYPTO_RSI_MIN_CANDLES = 15;
  var cryptoRsiMemo = {};
  var cryptoRsiSync = { pending: null, failedAt: 0 };
  CRYPTO.forEach(function (entry) {
    cryptoRsiMemo[entry[0]] = { value: null, fetchedAt: 0, pending: null, failedAt: 0, failureCount: 0 };
  });
  var RSI_LOW_PULSE_THRESHOLDS = { b3: 29, stocks: 31 };
  var RSI_LOW_PULSE_LIMIT = 20;
  var RSI_COMPRA_LIMITE = 40;
  var RSI_VENDA_LIMITE = 70;
  var rsiPulseCounts = {};
  var displayToPair = {};
  CRYPTO.forEach(function (entry) {
    pairSymbol[entry[1].toLowerCase()] = entry[0];
    symbolCurrency[entry[0]] = entry[2];
    displayToPair[entry[0]] = entry[1];
  });

  function symbolKey(symbol) { return String(symbol || "").replace(/["\\]/g, ""); }

  function esc(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function fmtPrice(value, currency, noPrefix) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    var prefix = noPrefix ? "" : (currency === "BRL" ? "R$ " : "$ ");
    return prefix + value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function changeClass(change) {
    if (change === null || !Number.isFinite(change)) return "flat";
    if (change >= 5) return "up5";
    if (change > 3) return "up3";
    if (change >= 0) return "up1";
    if (change <= -5) return "down5";
    return "down";
  }
  function fmtVolume(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    if (value >= 1e9) return (value / 1e9).toFixed(2).replace(".", ",") + " B";
    if (value >= 1e6) return (value / 1e6).toFixed(2).replace(".", ",") + " M";
    if (value >= 1e3) return (value / 1e3).toFixed(2).replace(".", ",") + " K";
    return value.toLocaleString("pt-BR");
  }
  var cryptoSymbols = {};
  CRYPTO.forEach(function (e) { cryptoSymbols[e[0]] = true; });
  function isCrypto(sym) { return !!cryptoSymbols[sym]; }

  function getB3Assets() {
    return B3_FIXED_ASSETS.concat(b3AdditionalAssets);
  }

  function b3Signature(assets) { return assets.join(","); }

  function canonicalB3Symbol(value) {
    var raw = String(value || "").trim().toUpperCase();
    if (raw === "^BVSP") return raw;
    if (raw.slice(-3) === ".SA") raw = raw.slice(0, -3);
    return B3_TICKER_RE.test(raw) ? raw + ".SA" : "";
  }

  function isFixedB3(symbol) { return B3_FIXED_ASSETS.indexOf(symbol) !== -1; }

  function clearB3Data() {
    Object.keys(cache).forEach(function (key) { if (key.indexOf("b3|") === 0) delete cache[key]; });
    rsiMemo.b3 = { at: 0, bySymbol: null, pending: null, signature: "" };
    if (activeTab === "b3") rsiBySymbol = {};
  }

  function currentB3User() {
    var auth = window.EstudeAuth;
    var user = auth && auth.getUser ? auth.getUser() : null;
    return user && user.id && !user.anonymous && user.verified ? user : null;
  }

  function persistB3Extras(uid, assets) {
    if (!uid || !window.EstudeAuth || !window.EstudeAuth.getDatabase) return Promise.resolve(false);
    var snapshot = assets.slice();
    var queue = b3WriteQueues[uid] || Promise.resolve();
    b3WriteQueues[uid] = queue.then(function () {
      return window.EstudeAuth.getDatabase().then(function (database) {
        if (!database) return false;
        return database.ref("users/" + uid + "/preferences/b3AdditionalSymbols").set(snapshot).then(function () { return true; });
      });
    }).catch(function () { return false; });
    return b3WriteQueues[uid];
  }

  function normalizeStoredB3(value) {
    var source = Array.isArray(value) ? value : (value && typeof value === "object" ? Object.keys(value).map(function (key) { return value[key]; }) : []);
    var out = [];
    source.forEach(function (item) {
      var symbol = canonicalB3Symbol(item);
      if (!symbol || isFixedB3(symbol) || out.indexOf(symbol) !== -1 || out.length >= 8) return;
      out.push(symbol);
    });
    return out;
  }

  function mergeB3Extras(first, second) {
    return normalizeStoredB3((first || []).concat(second || []));
  }

  function renderB3Controls() {
    var controls = document.getElementById("b3-custom-controls");
    var count = document.getElementById("b3-count");
    var input = document.getElementById("b3-add-input");
    var add = document.getElementById("b3-add-button");
    var login = document.getElementById("b3-login-link");
    var status = document.getElementById("b3-add-status");
    var user = currentB3User();
    var canEdit = !b3PreferencesLoading && (user ? b3AdditionalAssets.length < 8 : true);
    var extras = document.getElementById("b3-extra-list");
    if (count) count.textContent = getB3Assets().length + "/16";
    if (input) {
      input.disabled = !canEdit;
      input.setAttribute("aria-disabled", canEdit ? "false" : "true");
    }
    if (add) {
      add.disabled = !canEdit;
      add.setAttribute("aria-disabled", canEdit ? "false" : "true");
    }
    if (login) login.hidden = !!user || b3PreferencesLoading;
    if (status && !user && !b3PreferencesLoading) {
      status.textContent = "Faça login para adicionar seus ativos";
      status.className = "b3-add-status";
    } else if (status && b3PreferencesLoading) {
      status.textContent = "";
      status.className = "b3-add-status";
    }
    if (!extras) return;
    extras.textContent = "";
    b3AdditionalAssets.forEach(function (symbol) {
      var item = document.createElement("span");
      item.className = "b3-extra-item";
      item.textContent = symbol.replace(/\.SA$/, "");
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "b3-extra-remove";
      remove.setAttribute("aria-label", "Remover " + symbol.replace(/\.SA$/, ""));
      remove.textContent = "×";
      remove.addEventListener("click", function () { removeB3Extra(symbol); });
      item.appendChild(remove);
      extras.appendChild(item);
    });
    if (controls) controls.hidden = activeTab !== "b3";
  }

  function showB3Message(message, isError) {
    var el = document.getElementById("b3-add-status");
    if (!el) return;
    if (b3MessageTimer) window.clearTimeout(b3MessageTimer);
    el.textContent = message || "";
    el.className = isError ? "b3-add-status error" : "b3-add-status";
    if (message) b3MessageTimer = window.setTimeout(function () {
      el.textContent = "";
      b3MessageTimer = null;
    }, 4500);
  }

  function invalidateB3AndRefresh() {
    clearB3Data();
    renderB3Controls();
    if (activeTab === "b3") refresh(true);
  }

  function removeB3Extra(symbol) {
    var index = b3AdditionalAssets.indexOf(symbol);
    if (index === -1) return;
    b3AdditionalAssets.splice(index, 1);
    var user = currentB3User();
    if (user) persistB3Extras(user.id, b3AdditionalAssets).then(function (ok) {
      if (!ok) showB3Message("Não foi possível salvar a remoção. A sessão atual foi mantida.", true);
    });
    invalidateB3AndRefresh();
  }

  function validateAndAddB3() {
    var input = document.getElementById("b3-add-input");
    var user = currentB3User();
    if (b3PreferencesLoading) return showB3Message("Aguarde o carregamento dos seus ativos B3.", true);
    if (!user && b3AdditionalAssets.length >= 1) {
      showB3Message("Faça login para adicionar outro ativo.", true);
      if (window.EstudeAuth && typeof window.EstudeAuth.openModal === "function") window.EstudeAuth.openModal("login");
      return;
    }
    var raw = input ? input.value : "";
    var symbol = canonicalB3Symbol(raw);
    if (!symbol) return showB3Message("Informe um ticker B3 válido, como PETR4 ou ^BVSP.", true);
    if (isFixedB3(symbol) || b3AdditionalAssets.indexOf(symbol) !== -1 || b3ValidationPending[symbol]) return showB3Message("Esse ativo já está na lista.", true);
    if (b3AdditionalAssets.length + Object.keys(b3ValidationPending).length >= 8) return showB3Message("Limite de 16 ativos atingido.", true);
    var generation = b3SessionGeneration;
    b3ValidationPending[symbol] = true;
    renderB3Controls();
    showB3Message("Validando " + symbol.replace(/\.SA$/, "") + "…", false);
    fetch(WORKER + "?assets=" + encodeURIComponent(symbol) + "&window=24h", { cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        var quote = payload && Array.isArray(payload.quotes) && payload.quotes.find(function (item) { return item && String(item.symbol).toUpperCase() === symbol; });
        var valid = payload && payload.window === "24h" && quote && typeof quote.price === "number" && Number.isFinite(quote.price) && quote.price > 0;
        if (generation !== b3SessionGeneration) return;
        if (!valid) return showB3Message("Não foi possível validar a cotação de " + symbol.replace(/\.SA$/, "") + ".", true);
        if (b3AdditionalAssets.length >= 8 || getB3Assets().indexOf(symbol) !== -1) return;
        b3AdditionalAssets.push(symbol);
        if (user) persistB3Extras(user.id, b3AdditionalAssets).then(function (ok) {
          if (!ok) showB3Message("Ativo incluído nesta sessão, mas não foi possível salvar no Firebase.", true);
        });
        if (input) input.value = "";
        showB3Message("Ativo incluído.", false);
        invalidateB3AndRefresh();
      })
      .catch(function () { if (generation === b3SessionGeneration) showB3Message("Não foi possível validar a cotação agora.", true); })
      .then(function () { delete b3ValidationPending[symbol]; renderB3Controls(); });
  }

  // Faixas do RSI semanal. A classificação usa o INTEIRO EXIBIDO (Math.floor),
  // não o valor bruto. Número e cor sempre coincidem.
  function rsiBand(shown) {
    if (shown < RSI_COMPRA_LIMITE) return "compra";
    if (shown <= RSI_VENDA_LIMITE) return "neutro";
    return "venda";
  }
  function rsiBandLabel(band) {
    if (band === "compra") return "Compra";
    if (band === "neutro") return "Neutro";
    return "Venda";
  }
  var WINDOW_LABELS = {
    "1h": "1H",
    "24h": "24H",
    "7d": "7D",
    "30d": "30D",
    "90d": "90D",
    "1y": "1Y",
    "3y": "3Y",
  };
  function activeWindowLabel() {
    var button = document.querySelector('.ticker-window button[data-window="' + activeWindow + '"]');
    var text = button && typeof button.textContent === "string" ? button.textContent.trim() : "";
    return text || WINDOW_LABELS[activeWindow] || activeWindow;
  }
  function b3ReferencePrice(quote) {
    if (!quote || quote.windowKey !== activeWindow) return null;
    var current = quote.price;
    var base = quote.baseClose;
    var change = quote.changePct;
    if (typeof current !== "number" || !Number.isFinite(current) || current <= 0) return null;
    if (typeof base !== "number" || !Number.isFinite(base) || base <= 0) return null;
    if (typeof change !== "number" || !Number.isFinite(change)) return null;
    var derivedChange = (current / base - 1) * 100;
    return Math.abs(derivedChange - change) <= 1 ? base : null;
  }
  function rsiBadge(rsi, context) {
    if (typeof rsi !== "number" || !Number.isFinite(rsi)) return "";
    var shown = Math.floor(rsi);
    var band = rsiBand(shown);
    var label = rsiBandLabel(band);
    var contextLabel = context ? " do par " + context : "";
    return '<span class="tq-rsi tq-rsi-' + band + '" role="img"' +
      ' title="RSI 14 semanal' + contextLabel + ': ' + shown + ' — ' + label + '"' +
      ' aria-label="RSI ' + shown + ' — ' + label + '">' + shown + "</span>";
  }

  function card(quote) {
    var preMarket = activeTab === "stocks" && activeWindow === "24h" &&
      (quote.symbol === "^GSPC" || quote.symbol === "^NDX") ? preMarketEstimates[quote.symbol] : null;
    var change = preMarket && typeof preMarket.changePct === "number"
      ? preMarket.changePct
      : (quote.shortHistory === true ? null : (typeof quote.changePct === "number" ? quote.changePct : null));
    if (preMarket && typeof change === "number" && Math.abs(change) < 0.005) change = 0;
    var pct = change === null ? "—" : (change >= 0 ? "+" : "") + change.toFixed(2).replace(".", ",") + "%";
    var shortWindowLabel = activeWindow === "3y" ? "3 anos" : activeWindow === "1y" ? "1 ano" : (activeWindow === "90d" ? "90 dias" : "30 dias");
    var pctTitle = quote.shortHistory === true ? ' title="Menos de ' + shortWindowLabel + ' de histórico"' : "";
    var price = preMarket && typeof preMarket.price === "number"
      ? preMarket.price
      : (typeof livePrices[quote.symbol] === "number" ? livePrices[quote.symbol] : quote.price);
    // Moeda do próprio objeto de cotação primeiro: a B3 chega com BRL do
    // Worker. CRIPTO e STOCKS continuam com o mesmo valor de antes.
    var currency = quote.currency || symbolCurrency[quote.symbol] || "USD";
    var small = quote.symbol === "BTC" || quote.symbol === "ETH" || quote.symbol === "PAXG" ? " tq-sm" : "";
    var smallLabel = quote.symbol === "^NDX" ? " tq-label-sm" : "";
    var isIbov = quote.symbol === "^BVSP";
    var isB3Asset = activeTab === "b3";
    var priceText = isIbov
      ? (typeof price === "number" && Number.isFinite(price) ? price.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) : "--")
      : fmtPrice(price, currency, !isCrypto(quote.symbol) && currency !== "BRL");
    var fallbackLabel = activeTab === "b3" ? quote.symbol.replace(/\.SA$/, "") : quote.symbol;
    var label = (B3_META[quote.symbol] && B3_META[quote.symbol].label) || STOCK_LABELS[quote.symbol] || fallbackLabel;
    var bell = isCrypto(quote.symbol)
      ? '<button class="tq-bell" data-bell="' + esc(symbolKey(quote.symbol)) + '" aria-label="Dispensar alerta" title="Dispensar alerta">&#128276;</button>'
      : '';
    // Preço Justo (Graham): só em STOCKS (cripto não tem LPA/VPA; a aba B3
    // ficou fora do escopo do ⚖).
    var grahamBtn = !isCrypto(quote.symbol) && activeTab !== "b3"
      ? '<button class="tq-graham" data-graham="' + esc(symbolKey(quote.symbol)) + '" aria-label="Ver preço justo de ' + esc(symbolKey(quote.symbol)) + '" title="Preço justo (Graham)">&#9878;</button>'
      : '';
    // Selo de RSI: cada segmento consulta apenas seu próprio memo.
    var quoteSymbol = String(quote.symbol || "").toUpperCase();
    var activeRsi = activeTab === "crypto" ? cryptoRsiFresh(quoteSymbol, Date.now()) :
      (activeTab === "b3" ? (rsiMemo.b3.bySymbol || {})[quoteSymbol] : (activeTab === "stocks" ? (rsiMemo.stocks.bySymbol || {})[quoteSymbol] : null));
    var rsiContext = activeTab === "crypto" && quoteSymbol === "USDT-BRL" ? "USDT/BRL" : "";
    var badge = (activeTab === "crypto" || activeTab === "b3" || activeTab === "stocks") ? rsiBadge(activeRsi, rsiContext) : '';
    var preMarketTitle = preMarket && typeof preMarket.delayMinutes === "number" && preMarket.delayMinutes > 0
      ? 'Cotação estimada · aproximadamente ' + preMarket.delayMinutes + ' minutos de atraso'
      : 'Estimativa pelo futuro ' + (preMarket ? preMarket.future || "" : "");
    var preMarketBadge = preMarket
      ? '<span class="tq-pre-market" title="' + esc(preMarketTitle) + '">PRÉ · FUT</span>'
      : '';
    var pulseKey = activeTab + "|" + quoteSymbol;
    var pulseThreshold = RSI_LOW_PULSE_THRESHOLDS[activeTab];
    var lowRsiPulse = (activeTab === "b3" || activeTab === "stocks") && typeof activeRsi === "number" &&
      Number.isFinite(activeRsi) && activeRsi < pulseThreshold &&
      (rsiPulseCounts[pulseKey] || 0) < RSI_LOW_PULSE_LIMIT;
    var referencePrice = isB3Asset ? b3ReferencePrice(quote) : null;
    var referenceLabel = activeWindowLabel();
    var nowBlockPrice = isIbov && isB3Asset ? priceText : (isB3Asset ? fmtPrice(price, currency, true) : "");
    var referenceBlockPrice = isIbov && isB3Asset
      ? (typeof referencePrice === "number" && Number.isFinite(referencePrice)
        ? referencePrice.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) : "--")
      : (isB3Asset ? fmtPrice(referencePrice, currency, true) : "");
    var referenceBlock = isB3Asset
      ? '<div class="tq-b3-reference" aria-label="Agora ' + esc(nowBlockPrice) + '. ' + esc(referenceLabel) + ' ' + esc(referenceBlockPrice) + '">' +
          '<div class="tq-b3-reference-col"><span class="tq-b3-reference-label">Agora</span><strong class="tq-b3-reference-price">' + esc(nowBlockPrice) + '</strong></div>' +
          '<div class="tq-b3-reference-col"><span class="tq-b3-reference-label">' + esc(referenceLabel) + '</span><strong class="tq-b3-reference-price">' + esc(referenceBlockPrice) + '</strong></div>' +
        '</div>'
      : '';
    // Pílula de variação: só na aba B3 (ativos B3 + IBOV), só no desktop (CSS).
    // O sinal vem do valor numérico de changePct, nunca do texto exibido.
    var pctClass = "";
    var pctInner = pct;
    if (activeTab === "b3") {
      var rawChangePct = quote.changePct;
      var pctIsNonNumeric = rawChangePct !== null && rawChangePct !== undefined && rawChangePct !== "" &&
        !(typeof rawChangePct === "number" && Number.isFinite(rawChangePct));
      if (!pctIsNonNumeric) {
        var roundedChange = typeof change === "number" && Number.isFinite(change) ? Math.round(change * 100) / 100 : 0;
        var pctTone = roundedChange > 0 ? "up" : roundedChange < 0 ? "down" : "neutral";
        var pctArrow = pctTone === "up" ? "\u2191" : pctTone === "down" ? "\u2193" : "";
        pctClass = " tq-b3-pct tq-b3-pct--" + pctTone;
        pctInner = pct + (pctArrow ? '<span class="tq-b3-pct-arrow" aria-hidden="true">' + pctArrow + '</span>' : "");
      }
    }
    return '<div class="tq ' + changeClass(change) + (badge ? ' has-rsi' : '') + (lowRsiPulse ? ' rsi-low-pulse' : '') + (isB3Asset ? ' tq--b3' : '') + '" data-tq="' + esc(symbolKey(quote.symbol)) + '">' +
      '<b class="tqSym' + smallLabel + '">' + esc(label) + "</b>" +
      bell +
      grahamBtn +
      badge +
      preMarketBadge +
      '<span class="tqPct' + pctClass + '"' + pctTitle + '>' + pctInner + "</span>" +
      '<strong class="tqPrice' + small + '">' + priceText + "</strong>" +
      referenceBlock +
      "</div>";
  }

  function fetchCrypto() {
    var cfg = KLINE_CFG[activeWindow];
    var jobs = CRYPTO.map(function (entry) {
      var symbol = entry[0], pair = entry[1], currency = entry[2];
      return fetch("https://api.binance.com/api/v3/klines?symbol=" + pair + "&interval=" + cfg.interval + "&limit=" + cfg.limit, { cache: "no-store" })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (klines) {
          if (!Array.isArray(klines) || klines.length < 2) return null;
          var closes = klines.map(function (row) { return Number(row[4]); });
          var volume = klines.reduce(function (sum, row) { return sum + (Number(row[5]) || 0); }, 0);
          var last = closes[closes.length - 1];
          var base = cfg.baseFromPrev ? closes[closes.length - 2] : closes[0];
          quoteData[symbol] = {
            name: CRYPTO_NAMES[symbol] || symbol,
            volume: typeof liveVolume[symbol] === "number" ? liveVolume[symbol] : volume,
            volumeLabel: "Volume 24h",
          };
          // Calcular S/R dinâmico para todos os cryptos (suporte = menor low, resistência = maior high)
          if (window.DynamicSR && window.AlertEngine && klines.length >= 3) {
            // CORREÇÃO: Normalizar símbolo antes de verificar autoridade
            var normalizedSymbol = window.BI && window.BI.normalizeSymbol ? window.BI.normalizeSymbol(symbol) : symbol;
            var hasUserLevels = window.AlertEngine.hasUserDefinedLevels(normalizedSymbol);
            
            if (hasUserLevels) {
              var userLevels = window.AlertEngine.getLevels(normalizedSymbol);
              console.log('[SR-TRACE] TICKER SKIPPED', {
                symbol: normalizedSymbol,
                originalSymbol: symbol,
                reason: 'USER_DEFINED_LEVELS',
                source: userLevels ? userLevels.source : 'unknown',
                timeframe: userLevels ? userLevels.timeframe : 'unknown'
              });
            } else {
              var candles = klines.map(function (row) {
                return { high: Number(row[2]), low: Number(row[3]) };
              });
              var srResult = window.DynamicSR.calculateSR(candles);
              if (srResult) {
                console.log('[SR-TRACE] TICKER UPDATE', {
                  symbol: normalizedSymbol,
                  originalSymbol: symbol,
                  support: srResult.support,
                  resistance: srResult.resistance,
                  source: 'TICKER',
                  timeframe: cfg.interval
                });
                window.AlertEngine.unlockAudio();
                window.AlertEngine.setAlertLevels(normalizedSymbol, srResult.support, srResult.resistance, {
                  source: 'TICKER',
                  timeframe: cfg.interval
                });
                if (normalizedSymbol === 'BTC' && window.PushSubscribe && window.PushSubscribe.isEnabled() && window.PushSubscribe.syncToWorker) {
                  window.PushSubscribe.syncToWorker(normalizedSymbol, srResult.support, srResult.resistance, last);
                }
              }
            }
          }
          return { symbol: symbol, currency: currency, price: last, changePct: base ? ((last - base) / base) * 100 : 0 };
        })
        .catch(function () { return null; });
    });
    return Promise.all(jobs).then(function (quotes) { return quotes.filter(Boolean); });
  }

  function cryptoRsiWilder(closes, period) {
    var n = Number(period) > 0 ? Math.floor(Number(period)) : 14;
    if (!Array.isArray(closes) || closes.length < n + 1) return null;
    for (var i = 0; i < closes.length; i++) {
      if (typeof closes[i] !== "number" || !Number.isFinite(closes[i])) return null;
    }
    var gain = 0;
    var loss = 0;
    for (var j = 1; j <= n; j++) {
      var firstDelta = closes[j] - closes[j - 1];
      if (firstDelta >= 0) gain += firstDelta;
      else loss -= firstDelta;
    }
    gain /= n;
    loss /= n;
    for (var k = n + 1; k < closes.length; k++) {
      var delta = closes[k] - closes[k - 1];
      gain = (gain * (n - 1) + Math.max(delta, 0)) / n;
      loss = (loss * (n - 1) + Math.max(-delta, 0)) / n;
    }
    if (loss === 0) return gain === 0 ? null : 100;
    return 100 - 100 / (1 + gain / loss);
  }

  function closedCryptoWeeklyCloses(rows, serverTime) {
    if (!Array.isArray(rows) || !Number.isFinite(serverTime)) return null;
    var seen = {};
    var previousOpen = -1;
    var closes = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!Array.isArray(row) || row.length < 7) return null;
      var openTime = Number(row[0]);
      var closeTime = Number(row[6]);
      if (!Number.isFinite(openTime) || !Number.isFinite(closeTime) || openTime <= previousOpen || seen[openTime]) return null;
      seen[openTime] = true;
      previousOpen = openTime;
      if (closeTime >= serverTime) continue;
      var close = Number(row[4]);
      if (!Number.isFinite(close) || close <= 0) return null;
      closes.push(close);
    }
    return closes.length >= CRYPTO_RSI_MIN_CANDLES ? closes : null;
  }

  function cryptoRsiFresh(symbol, now) {
    var record = cryptoRsiMemo[symbol];
    if (!record || typeof record.value !== "number" || !Number.isFinite(record.value)) return null;
    return now - record.fetchedAt < CRYPTO_RSI_TTL_MS ? record.value : null;
  }

  function fetchCryptoRsiSymbol(entry, serverTime) {
    var symbol = entry[0];
    var pair = entry[1];
    var record = cryptoRsiMemo[symbol];
    if (record.pending) return record.pending;
    var request = fetch("https://api.binance.com/api/v3/klines?symbol=" + pair + "&interval=1w&limit=" + CRYPTO_RSI_LIMIT, { cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (rows) {
        var closes = closedCryptoWeeklyCloses(rows, serverTime);
        var value = closes ? cryptoRsiWilder(closes, 14) : null;
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("RSI semanal inválido");
        record.value = value;
        record.fetchedAt = Date.now();
        record.failedAt = 0;
        record.failureCount = 0;
        return value;
      })
      .catch(function () {
        record.failedAt = Date.now();
        record.failureCount += 1;
        return null;
      })
      .then(function (value) {
        if (record.pending === request) record.pending = null;
        return value;
      });
    record.pending = request;
    return request;
  }

  function ensureCryptoRsi() {
    var now = Date.now();
    var needed = CRYPTO.filter(function (entry) {
      var record = cryptoRsiMemo[entry[0]];
      var fresh = cryptoRsiFresh(entry[0], now) !== null;
      var coolingDown = record.failedAt && now - record.failedAt < CRYPTO_RSI_FAILURE_COOLDOWN_MS;
      return !fresh && !coolingDown;
    });
    if (!needed.length) return Promise.resolve();
    if (cryptoRsiSync.pending) return cryptoRsiSync.pending;
    if (cryptoRsiSync.failedAt && now - cryptoRsiSync.failedAt < CRYPTO_RSI_FAILURE_COOLDOWN_MS) return Promise.resolve();

    cryptoRsiSync.pending = fetch("https://api.binance.com/api/v3/time", { cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        var serverTime = payload && Number(payload.serverTime);
        if (!Number.isFinite(serverTime)) throw new Error("Horário da Binance indisponível");
        cryptoRsiSync.failedAt = 0;
        return Promise.allSettled(needed.map(function (entry) {
          return fetchCryptoRsiSymbol(entry, serverTime);
        }));
      })
      .catch(function () {
        // Falha de /time é global: não marca os oito pares como falhos.
        cryptoRsiSync.failedAt = Date.now();
        return null;
      })
      .then(function (result) {
        cryptoRsiSync.pending = null;
        return result;
      });
    return cryptoRsiSync.pending;
  }

  function fetchStocks() {
    return fetch(WORKER + "?assets=" + encodeURIComponent(STOCKS.join(",")) + "&window=" + activeWindow, { cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        if (!payload || !Array.isArray(payload.quotes)) return [];
        if (payload.window !== activeWindow) return [];
        preMarketEstimates = activeWindow === "24h" && payload.preMarketEstimates &&
          typeof payload.preMarketEstimates === "object" ? payload.preMarketEstimates : {};
        return payload.quotes.map(function (quote) {
          quoteData[quote.symbol] = {
            name: STOCK_NAMES[quote.symbol] || quote.name || quote.symbol,
            volume: quote.volume,
            volumeLabel: "Volume hoje",
          };
          // Preserva o payload do Worker: shortHistory só existe quando o
          // histórico é curto (nas janelas 24h/7d a propriedade fica ausente).
          var cardQuote = {
            symbol: quote.symbol,
            currency: "USD",
            price: quote.price,
            changePct: quote.changePct,
            name: quote.name,
            volume: quote.volume,
            closes: quote.closes,
            shortHistory: quote.shortHistory === true,
          };
          // Fora das janelas longas o Worker não manda a flag: o card mantém
          // a propriedade AUSENTE (não false, não null).
          if (quote.shortHistory !== true) delete cardQuote.shortHistory;
          return cardQuote;
        });
      })
      .catch(function () { return []; });
  }

  // Cotações da aba B3: chamada própria (nunca reaproveita fetchStocks), 8
  // ativos, cache `b3|janela` próprio. Como são só 8, o teto de 26 ativos do
  // Worker nem é tocado.
  function fetchB3(assets) {
    // B3_ASSETS.join(",") remains the fixed baseline; runtime requests use getB3Assets().
    return fetch(WORKER + "?assets=" + encodeURIComponent(assets.join(",")) + "&window=" + activeWindow, { cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        if (!payload || !Array.isArray(payload.quotes)) return [];
        if (payload.window !== activeWindow) return [];
        var quotesBySymbol = {};
        payload.quotes.forEach(function (quote) {
          if (quote && quote.symbol) quotesBySymbol[String(quote.symbol).toUpperCase()] = quote;
        });
        return assets.map(function (assetSymbol) {
          var quote = quotesBySymbol[String(assetSymbol).toUpperCase()];
          if (!quote) {
            if (assetSymbol !== "^BVSP") return null;
            quote = { symbol: "^BVSP", currency: "", price: null, changePct: null, name: "Ibovespa", volume: null, closes: [] };
          }
          var meta = B3_META[quote.symbol] || {};
          var name = meta.name || quote.name || quote.symbol;
          quoteData[quote.symbol] = {
            name: name,
            volume: quote.volume,
            volumeLabel: "Volume hoje",
          };
          var cardQuote = {
            symbol: quote.symbol,
            currency: String(quote.currency || "").trim().toUpperCase() === "BRL" ? "BRL" : "USD",
            price: quote.price,
            changePct: quote.changePct,
            name: name,
            volume: quote.volume,
            closes: quote.closes,
            baseClose: quote.baseClose,
            baseTime: quote.baseTime,
            windowKey: activeWindow,
            shortHistory: quote.shortHistory === true,
          };
          if (quote.shortHistory !== true) delete cardQuote.shortHistory;
          return cardQuote;
        }).filter(function (quote) { return !!quote; });
      })
      .catch(function () { return []; });
  }

  // RSI semanal (fonte única: janela interna `1wk`, que o Worker calcula sobre
  // a série de 5 anos). Só é chamado quando o memo está vazio ou vencido.
  function fetchRsi(assets, memoKey, signature) {
    var now = Date.now();
    var memo = rsiMemo[memoKey];
    var request = fetch(WORKER + "?assets=" + encodeURIComponent(assets.join(",")) + "&window=1wk", { cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        // Se o Worker não tiver a janela `1wk` ele cai em `24h` em silêncio e o
        // RSI sairia de uma série diária. Descarta e mantém o memo anterior.
        if (!payload || payload.window !== "1wk" || !Array.isArray(payload.quotes)) {
          return memo.bySymbol || {};
        }
        var map = {};
        payload.quotes.forEach(function (quote) {
          var symbol = String(quote && quote.symbol || "").toUpperCase();
          if (symbol && typeof quote.rsi === "number" && Number.isFinite(quote.rsi)) map[symbol] = quote.rsi;
        });
        memo.at = now;
        memo.bySymbol = map;
        memo.signature = signature;
        return map;
      })
      .catch(function () { return memo.bySymbol || {}; })
      .then(function (map) {
        if (memo.pending === request) memo.pending = null;
        return map;
      });
    memo.pending = request;
    return request;
  }

  // Porta de entrada do RSI no ciclo de render. Com memo válido (1h) resolve
  // na hora, sem request — é o que impede o refresh de 5s de bater no Worker.
  function ensureRsi(assets, memoKey, signature) {
    var now = Date.now();
    var memo = rsiMemo[memoKey];
    if (memo.bySymbol && memo.signature === signature && (now - memo.at) < RSI_TTL_MS) {
      rsiBySymbol = memo.bySymbol;
      return Promise.resolve(rsiBySymbol);
    }
    if (memo.pending) return memo.pending.then(function (map) {
      rsiBySymbol = map || {};
      return rsiBySymbol;
    });
    return fetchRsi(assets, memoKey, signature).then(function (map) {
      rsiBySymbol = map || {};
      return rsiBySymbol;
    });
  }

  function render(quotes) {
    grid.innerHTML = quotes.length
      ? quotes.map(card).join("")
      : '<div class="tqEmpty">Sem cotações disponíveis no momento.</div>';
    for (var i = 0; i < quotes.length; i++) {
      var q = quotes[i];
      var seen = typeof livePrices[q.symbol] === "number" ? livePrices[q.symbol] : q.price;
      if (typeof seen === "number" && Number.isFinite(seen) && seen > 0) cardPrices[q.symbol] = seen;
    }
    grid.style.gridTemplateColumns = "repeat(" + Math.min(Math.max(quotes.length, 1), 8) + ", minmax(0, 1fr))";
    if (statusEl) statusEl.textContent = "AO VIVO · " + new Date().toLocaleTimeString("pt-BR");
    updateGrahamBar();
    // Tabela Graham acompanha os cards no mesmo ciclo (display-only, sem
    // fetch/polling próprio: só relê cardPrices já alimentado pelos cards).
    if (activeTab === "stocks" && grahamHistory.length) {
      try { renderGrahamHistory(); } catch (e) {}
    }
    restoreAlertVisuals();
    if (pinnedSymbol) {
      var pinnedCard = grid.querySelector('.tq[data-tq="' + symbolKey(pinnedSymbol) + '"]');
      if (pinnedCard) positionTooltip(pinnedCard);
      else unpinTooltip();
    }
  }

  function restoreAlertVisuals() {
    if (!window.AlertEngine || !alertDirection) return;
    var symbols = Object.keys(alertDirection);
    for (var i = 0; i < symbols.length; i++) {
      var sym = symbols[i];
      if (window.AlertEngine.isEnabled(sym)) {
        applyAlertVisual(sym, true, alertDirection[sym]);
      }
    }
  }

  // Broadcast de cotações para consumidores (ex.: painel de ativos): emite o
  // MESMO evento dos ticks WS para cada quote do refresh — cobre o preço
  // inicial dos cryptos e TODOS os stocks (que não têm WebSocket).
  function broadcastQuotes(quotes) {
    if (!Array.isArray(quotes)) return;
    for (var i = 0; i < quotes.length; i++) {
      var q = quotes[i];
      if (!q || typeof q.price !== "number" || !Number.isFinite(q.price) || q.price <= 0) continue;
      try {
        window.dispatchEvent(new CustomEvent("estudebitcoin:ticker-price", {
          detail: { symbol: q.symbol, price: q.price, changePct: q.changePct, source: "snapshot" }
        }));
      } catch (broadcastError) { /* broadcast opcional, nunca quebra o ticker */ }
    }
  }

  function refresh(force) {
    ensureGrahamCloud();
    var tab = activeTab;
    var win = activeWindow;
    var gen = uiStateGen;
    var assets = tab === "b3" ? getB3Assets() : null;
    var signature = tab === "b3" ? b3Signature(assets) : tab;
    var key = tab + "|" + win + (tab === "b3" ? "|" + signature : "");
    if (force) delete cache[key];
    // Três caminhos explícitos: a aba B3 nunca pode cair no fluxo de STOCKS.
    var loader = tab === "crypto" ? fetchCrypto : (tab === "stocks" ? fetchStocks : function () { return fetchB3(assets); });
    var quotesPromise = cache[key] ? Promise.resolve(cache[key]) : loader().then(function (quotes) {
      cache[key] = quotes;
      return quotes;
    });
    // B3 e STOCKS carregam RSI semanal por memos independentes de 1h.
    // CRIPTO usa um fluxo paralelo próprio, sem bloquear a primeira pintura.
    if (tab === "crypto") {
      var cryptoRsiPromise = ensureCryptoRsi();
      quotesPromise.then(function (quotes) {
        if (gen !== uiStateGen) return cryptoRsiPromise;
        broadcastQuotes(quotes);
        render(quotes);
        return cryptoRsiPromise.then(function () {
          if (gen === uiStateGen) render(quotes);
        });
      }).catch(function () { if (gen === uiStateGen) render([]); });
      return;
    }
    var rsiAssets = tab === "b3" ? assets : STOCKS;
    var rsiMemoKey = tab === "b3" ? "b3" : "stocks";
    var rsiPromise = (tab === "b3" || tab === "stocks")
      ? ensureRsi(rsiAssets, rsiMemoKey, signature)
      : Promise.resolve(null);
    Promise.all([quotesPromise, rsiPromise]).then(function (results) {
      if (gen !== uiStateGen) return;
      var quotes = results[0];
      // B3 NUNCA vai para o evento global: preço em BRL contaminaria o
      // portfólio (USD), o Risk Engine e o histórico do Graham.
      if (tab !== "b3") broadcastQuotes(quotes);
      render(quotes);
    }).catch(function () { if (gen === uiStateGen) render([]); });
  }

  function updateLivePrice(symbol, price, volume, changePct) {
    livePrices[symbol] = price;
    if (typeof price === "number" && Number.isFinite(price) && price > 0) cardPrices[symbol] = price;
    // Dólar atualizou: repinta a coluna Reais do histórico (só aba STOCKS).
    if (symbol === "USDT-BRL" && grahamHistory.length && activeTab === "stocks") {
      try { renderGrahamHistory(); } catch (e) {}
    }
    // INTEGRAÇÃO RISK ENGINE (aditivo, sem efeito sobre o ticker): expõe cada
    // tick via evento para o adapter (risk-engine-adapter.js), que encaminha
    // o preço ao RiskEngine.calcularRisco(). Justificativa: nenhum mecanismo
    // existente expõe o preço em tempo real (livePrices é closure privada) e
    // é proibido criar segundo WebSocket/polling/fetch só para o Risk Engine.
    // Mesmo padrão de CustomEvent já usado neste arquivo (load-asset).
    try {
      window.dispatchEvent(new CustomEvent("estudebitcoin:ticker-price", { detail: { symbol: symbol, price: price, changePct: changePct, source: "websocket" } }));
    } catch (broadcastError) { /* broadcast opcional, nunca quebra o ticker */ }
    if (typeof volume === "number" && Number.isFinite(volume)) {
      liveVolume[symbol] = volume;
      if (quoteData[symbol]) quoteData[symbol].volume = volume;
    }
    
    // ==================== INSTRUMENTAÇÃO P0 ====================
    if (symbol === 'BTC') {
      var tickerEntry = {
        kind: 'TICKER_PRICE',
        symbol: symbol,
        source: 'TICKER_WEBSOCKET',
        price: price,
        volume: volume,
        timestamp: new Date().toISOString(),
        isCrypto: isCrypto(symbol),
        alertEngineAvailable: !!window.AlertEngine
      };
      console.log('[BTC ALERT TRACE] PREÇO RECEBIDO DO TICKER', tickerEntry);
      if (window.__AUDIT_PUSH__) window.__AUDIT_PUSH__(tickerEntry);
    }
    // ==================== FIM INSTRUMENTAÇÃO ====================
    
    // Fase C: alimentar motor de alertas S/R Dinâmico (apenas criptos)
    // CORREÇÃO: AlertEngine deve funcionar INDEPENDENTE de Push
    if (isCrypto(symbol) && window.AlertEngine) {
      window.AlertEngine.onPriceUpdate(symbol, price);
    }
    if (activeTab !== "crypto") return;
    var priceEl = grid.querySelector('.tq[data-tq="' + symbolKey(symbol) + '"] .tqPrice');
    if (priceEl) priceEl.textContent = fmtPrice(price, symbolCurrency[symbol] || "USD", !isCrypto(symbol));
  }

  function connectWs() {
    var streams = CRYPTO.map(function (entry) { return entry[1].toLowerCase() + "@ticker"; }).join("/");
    var ws;
    try { ws = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + streams); }
    catch (error) { return; }
    ws.onmessage = function (event) {
      try {
        var payload = JSON.parse(event.data);
        var pair = String(payload.stream || "").replace("@ticker", "");
        var symbol = pairSymbol[pair];
        if (symbol && payload.data && typeof payload.data.c !== "undefined") {
          updateLivePrice(symbol, parseFloat(payload.data.c), parseFloat(payload.data.q), parseFloat(payload.data.P));
        }
      } catch (error) { /* ignora mensagens invalidas */ }
    };
    ws.onclose = function () { window.setTimeout(connectWs, 3000); };
    ws.onerror = function () { try { ws.close(); } catch (error) { /* noop */ } };
  }

  var tooltip = document.createElement("div");
  tooltip.className = "tq-tooltip";
  document.body.appendChild(tooltip);
  var pinnedSymbol = null;
  var pinTimer = null;
  var PIN_MS = 5000;
  function clearPinTimer() {
    if (pinTimer !== null) {
      window.clearTimeout(pinTimer);
      pinTimer = null;
    }
  }
  function positionTooltip(cardEl) {
    var rect = cardEl.getBoundingClientRect();
    var halfW = tooltip.offsetWidth / 2;
    var tipH = tooltip.offsetHeight;
    var center = rect.left + rect.width / 2;
    var minLeft = halfW + 8;
    var maxLeft = Math.max(minLeft, window.innerWidth - halfW - 8);
    var left = Math.min(Math.max(center, minLeft), maxLeft);
    var top = rect.top > 90 ? rect.top - 10 : rect.bottom + 10;
    if (top + tipH > window.innerHeight - 8) top = window.innerHeight - tipH - 8;
    if (top < 8) top = 8;
    tooltip.style.left = Math.round(left) + "px";
    tooltip.style.top = Math.round(top) + "px";
  }
  function showTooltip(cardEl) {
    var symbol = cardEl.getAttribute("data-tq");
    var meta = quoteData[symbol];
    if (!meta) return;
    var html = "<b>" + esc(meta.name || symbol) + "</b>";
    if (meta.volume !== null && meta.volume !== undefined) {
      html += '<span class="tq-tip-vol">' + esc(meta.volumeLabel || "Volume") + ": " + fmtVolume(meta.volume) + "</span>";
    }
    tooltip.innerHTML = html;
    positionTooltip(cardEl);
    tooltip.classList.add("show");
  }
  function hideTooltip() {
    tooltip.classList.remove("show");
  }
  function unpinTooltip() {
    clearPinTimer();
    pinnedSymbol = null;
    hideTooltip();
  }
  function pinTooltip(symbol, cardEl) {
    clearPinTimer();
    pinnedSymbol = symbol;
    showTooltip(cardEl);
    pinTimer = window.setTimeout(unpinTooltip, PIN_MS);
  }
  grid.addEventListener("mouseover", function (event) {
    var cardEl = event.target.closest(".tq");
    if (cardEl && !pinnedSymbol) showTooltip(cardEl);
  });
  grid.addEventListener("mouseout", function (event) {
    if (event.target.closest(".tq") && !pinnedSymbol) hideTooltip();
  });
  grid.addEventListener("animationiteration", function (event) {
    if (event.animationName !== "tq-rsi-low-pulse") return;
    var cardEl = event.target.closest ? event.target.closest(".tq") : null;
    var symbol = cardEl && cardEl.getAttribute("data-tq");
    if (!symbol) return;
    var pulseKey = activeTab + "|" + symbol;
    rsiPulseCounts[pulseKey] = (rsiPulseCounts[pulseKey] || 0) + 1;
    if (rsiPulseCounts[pulseKey] >= RSI_LOW_PULSE_LIMIT) cardEl.classList.remove("rsi-low-pulse");
  });
  grid.addEventListener("animationend", function (event) {
    if (event.animationName !== "tq-rsi-low-pulse") return;
    var cardEl = event.target.closest ? event.target.closest(".tq") : null;
    var symbol = cardEl && cardEl.getAttribute("data-tq");
    if (!symbol) return;
    rsiPulseCounts[activeTab + "|" + symbol] = RSI_LOW_PULSE_LIMIT;
    cardEl.classList.remove("rsi-low-pulse");
  });
  grid.addEventListener("click", function (event) {
    if (event.target.closest(".tq-bell, .tq-graham")) return;
    var cardEl = event.target.closest(".tq");
    if (!cardEl) return;
    var symbol = cardEl.getAttribute("data-tq");
    if (pinnedSymbol === symbol) {
      unpinTooltip();
    } else {
      pinTooltip(symbol, cardEl);
    }
    try {
      var detail;
      if (isCrypto(symbol)) {
        detail = { kind: "crypto", symbol: symbol, pair: displayToPair[symbol] || (symbol + "USDT"), label: CRYPTO_NAMES[symbol] || symbol };
      } else {
        detail = { kind: "stock", symbol: symbol, pair: null, label: STOCK_NAMES[symbol] || STOCK_LABELS[symbol] || symbol };
      }
      window.dispatchEvent(new CustomEvent("estudebitcoin:load-asset", { detail: detail }));
      var conversor = document.getElementById("conversor");
      if (conversor) {
        var cv = conversor.getBoundingClientRect();
        var vh = window.innerHeight;
        /// Só rola quando o conversor não está visível na janela
        if (cv.bottom < 0 || cv.top > vh) {
          conversor.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    } catch (err) { /* evento opcional, ignorar falhas */ }
  });
  document.addEventListener("click", function (event) {
    if (!event.target.closest(".tq") && pinnedSymbol) unpinTooltip();
  });
  function closePinnedOnScroll() {
    if (pinnedSymbol) unpinTooltip();
  }
  window.addEventListener("scroll", closePinnedOnScroll, { passive: true, capture: true });
  grid.addEventListener("scroll", closePinnedOnScroll, { passive: true, capture: true });
  window.addEventListener("resize", function () {
    if (!pinnedSymbol) return;
    var pinnedCard = grid.querySelector('.tq[data-tq="' + symbolKey(pinnedSymbol) + '"]');
    if (pinnedCard) positionTooltip(pinnedCard);
  });

  function tabAllowedBy(only, tab) {
    if (!only) return true;
    return only.split(",").indexOf(tab) !== -1;
  }

  function isWindowAllowedForTab(win, tab) {
    var btn = document.querySelector('.ticker-window button[data-window="' + win + '"]');
    var only = btn ? btn.getAttribute("data-only-tab") : null;
    if (only) return tabAllowedBy(only, tab);
    return !!KLINE_CFG[win];
  }

  function applyWindowVisibility() {
    document.querySelectorAll(".ticker-window button").forEach(function (btn) {
      var only = btn.getAttribute("data-only-tab");
      btn.hidden = !!(only && !tabAllowedBy(only, activeTab));
    });
    // A legenda do RSI é IRMÃ do grid (o render() substitui o innerHTML do
    // grid a cada 5s e apagaria a legenda se ela fosse filha) e só aparece
    // nas abas B3 e STOCKS.
    var legend = document.getElementById("tq-rsi-legend");
    if (legend) legend.hidden = activeTab !== "crypto" && activeTab !== "b3" && activeTab !== "stocks";
  }

  function setActiveWindow(win) {
    if (!isWindowAllowedForTab(win, activeTab)) win = "24h";
    activeWindow = win;
    uiStateGen++;
    document.querySelectorAll(".ticker-window button").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-window") === win);
    });
  }

  function bindButtons() {
    document.querySelectorAll(".ticker-window button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var win = btn.getAttribute("data-window") || "24h";
        if (btn.hidden || !isWindowAllowedForTab(win, activeTab)) return;
        setActiveWindow(win);
        refresh(true);
        startStockPolling();
      });
    });
    document.querySelectorAll(".ticker-tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeTab = btn.getAttribute("data-tab") || "crypto";
        document.querySelectorAll(".ticker-tabs button").forEach(function (b) { b.classList.toggle("active", b === btn); });
        renderB3Controls();
        setActiveWindow(activeWindow);
        applyWindowVisibility();
        refresh(true);
        startStockPolling();
      });
    });
  }

  function loadB3Preferences(user, generation) {
    if (!user || !window.EstudeAuth || !window.EstudeAuth.getDatabase) return;
    window.EstudeAuth.getDatabase().then(function (database) {
      if (!database) return null;
      return database.ref("users/" + user.id + "/preferences/b3AdditionalSymbols").once("value");
    }).then(function (snapshot) {
      if (generation !== b3SessionGeneration || b3AuthUid !== user.id) return;
      b3AdditionalAssets = mergeB3Extras(snapshot && snapshot.val(), b3VisitorExtra);
      b3VisitorExtra = [];
      b3PreferencesLoading = false;
      persistB3Extras(user.id, b3AdditionalAssets).then(function (ok) {
        if (!ok) showB3Message("Preferências carregadas, mas não foi possível consolidá-las no Firebase.", true);
      });
      invalidateB3AndRefresh();
    }).catch(function () {
      if (generation === b3SessionGeneration && b3AuthUid === user.id) {
        b3PreferencesLoading = false;
        renderB3Controls();
        showB3Message("Não foi possível carregar seus ativos B3 salvos.", true);
      }
    });
  }

  function handleB3AuthChange(event) {
    var user = event && event.detail ? event.detail.user : null;
    b3SessionGeneration++;
    b3ValidationPending = {};
    if (!user || user.anonymous || !user.id || !user.verified) {
      b3AuthUid = null;
      b3AdditionalAssets = [];
      b3VisitorExtra = [];
      b3PreferencesLoading = false;
      invalidateB3AndRefresh();
      return;
    }
    if (!b3AuthUid) b3VisitorExtra = normalizeStoredB3(b3AdditionalAssets).slice(0, 1);
    b3AuthUid = user.id;
    b3AdditionalAssets = [];
    b3PreferencesLoading = true;
    invalidateB3AndRefresh();
    loadB3Preferences(user, b3SessionGeneration);
  }

  function bindB3Controls() {
    var input = document.getElementById("b3-add-input");
    var add = document.getElementById("b3-add-button");
    var login = document.getElementById("b3-login-link");
    if (add) add.addEventListener("click", validateAndAddB3);
    if (login) login.addEventListener("click", function () {
      if (window.EstudeAuth && typeof window.EstudeAuth.openModal === "function") window.EstudeAuth.openModal("login");
    });
    if (input) input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); validateAndAddB3(); }
      if (event.key === "Escape") { input.value = ""; input.blur(); }
    });
    window.addEventListener("estudebitcoin:auth-change", handleB3AuthChange);
    renderB3Controls();
  }

  function startStockPolling() {
    if (stockPollTimer) window.clearInterval(stockPollTimer);
    stockPollTimer = null;
    if (!document.hidden && activeTab !== "crypto") {
      stockPollTimer = window.setInterval(function () {
        if (!document.hidden && activeTab !== "crypto") refresh(true);
      }, 15000);
    }
  }

  function startStocksBroadcastPolling() {
    if (stocksBroadcastTimer) window.clearInterval(stocksBroadcastTimer);
    stocksBroadcastTimer = null;
    if (!document.hidden) stocksBroadcastTimer = window.setInterval(refreshStocksBroadcast, 60000);
  }

  function onTickerVisibility() {
    if (document.hidden) {
      tickerPageWasHidden = true;
      if (stockPollTimer) window.clearInterval(stockPollTimer);
      if (stocksBroadcastTimer) window.clearInterval(stocksBroadcastTimer);
      stockPollTimer = null;
      stocksBroadcastTimer = null;
      return;
    }
    if (!tickerPageWasHidden) return;
    tickerPageWasHidden = false;
    if (activeTab !== "crypto") refresh(true);
    if (activeTab === "stocks") refreshMonitoredBroadcast();
    else refreshStocksBroadcast();
    startStockPolling();
    startStocksBroadcastPolling();
  }

  bindButtons();
  bindB3Controls();
  setActiveWindow(activeWindow);
  applyWindowVisibility();
  window.setInterval(function () { if (activeTab === "crypto") refresh(true); }, 5000);
  startStockPolling();
  connectWs();

  // Broadcast de stocks independente da aba ativa: fetchStocks() só roda com
  // a aba stocks visível, mas stocks não têm WebSocket — sem este loop, a
  // carteira nunca receberia cotação deles. 60s basta (stocks andam devagar);
  // só emite o evento, sem mexer nos cards. 1 chamada ao Worker por minuto.
  function refreshStocksBroadcast() {
    if (document.hidden) return;
    try {
      fetchStocks().then(function (quotes) { broadcastQuotes(quotes); }).catch(function () {});
      refreshMonitoredBroadcast();
    } catch (e) {}
  }
  document.addEventListener("visibilitychange", onTickerVisibility);
  startStocksBroadcastPolling();
  refreshStocksBroadcast();

  // Réplica do mecanismo do Painel Pessoal (portfolioLive) SÓ p/ os
  // monitorados sem card (ex.: ITUB4, PETR4): batch no MESMO Worker, no
  // MESMO intervalo de 60s, sem tocar no painel. B3 vai como *.SA (Yahoo)
  // e volta convertida p/ USD pela taxa USDT-BRL em memória; sem taxa,
  // mantém snapshot (fail-safe). Monitorado com fluxo vivo é pulado.
  function yahooSymbolFor(ticker) {
    var t = String(ticker || "").trim().toUpperCase();
    if (/^[A-Z]{4}\d{1,2}$/.test(t)) return t + ".SA";
    return t;
  }
  function refreshMonitoredBroadcast() {
    try {
      if (!grahamHistory.length) return;
      var covered = {};
      for (var s = 0; s < STOCKS.length; s++) covered[STOCKS[s]] = true;
      // Batch de 24h do Worker: fonte fixa da variação do DIA. Inclui TODOS os
      // monitorados (inclusive os que já têm preço vivo/card) apenas para ler
      // changePct; cardPrices continua sendo gravado só onde já era gravado.
      // O Worker /api/quotes corta em 26 assets por chamada: envia em lotes de
      // 20 (máx. 30 monitorados → no máximo 2 requisições por ciclo de 60s).
      var MONITOR_BATCH = 20;
      var wanted = [];
      var wantMap = {}; // símbolo Yahoo -> ticker puro
      var priceAllowed = {}; // tickers cujo preço este fluxo ainda pode gravar
      var seen = {}; // dedup por ticker, preservando a ordem de grahamHistory
      for (var i = 0; i < grahamHistory.length; i++) {
        var t = String((grahamHistory[i] && grahamHistory[i].ticker) || "").trim().toUpperCase();
        if (!t || seen[t]) continue;
        seen[t] = true;
        var y = yahooSymbolFor(t);
        if (wantMap[y]) continue;
        wantMap[y] = t;
        wanted.push(y);
        var live = Number(cardPrices[t]);
        if (!covered[t] && !(Number.isFinite(live) && live > 0)) priceAllowed[t] = true;
      }
      if (!wanted.length) return;
      var now = Date.now();
      var refresh30d = now - last30dAt >= MONITOR_30D_EVERY_MS;
      var touched = false;
      // Um lote = uma chamada. Erro de um lote é silencioso e NÃO apaga os
      // valores já existentes de cardPrices/cardChangePct (não zera nada).
      function applyQuotes(payload) {
        if (!payload || !Array.isArray(payload.quotes)) return;
        var rate = Number(cardPrices["USDT-BRL"]);
        if (!Number.isFinite(rate) || rate <= 0) rate = null;
        for (var k = 0; k < payload.quotes.length; k++) {
          var q = payload.quotes[k] || {};
          var pure = wantMap[String(q.symbol || "").trim().toUpperCase()];
          if (!pure) continue;
          // Guarda o tamanho da série de 1mo p/ saber se há histórico de 30d.
          if (Array.isArray(q.closes)) cardCloses24Len[pure] = q.closes.length;
          // % do dia: grava SEMPRE, sem tocar no preço do card/WebSocket.
          var ch = Number(q.changePct);
          if (Number.isFinite(ch)) { cardChangePct[pure] = ch; touched = true; }
          // Preço: só onde o fluxo anterior já gravava (sem card vivo).
          if (!priceAllowed[pure]) continue;
          var px = Number(q.price);
          if (!Number.isFinite(px) || px <= 0) continue;
          if (String(q.currency || "").trim().toUpperCase() === "BRL") {
            if (rate == null) continue;
            px = px / rate;
          }
          if (!Number.isFinite(px) || px <= 0) continue;
          cardPrices[pure] = px;
          touched = true;
        }
      }
      var touched30d = false;
      var touched1y = false;
      // 30d em mapa próprio: nunca toca em preço/cardPrices nem no % do dia.
      // A série de 3mo (30d) tem mais fechamentos que a de 1mo (24h) quando o
      // ativo já existia 30 dias atrás; sem pontos extras, histórico curto → "—".
      var pending30d = {};
      function collect30d(payload) {
        if (!payload || !Array.isArray(payload.quotes)) return;
        for (var k = 0; k < payload.quotes.length; k++) {
          var q = payload.quotes[k] || {};
          var pure = wantMap[String(q.symbol || "").trim().toUpperCase()];
          if (!pure) continue;
          var ch = Number(q.changePct);
          pending30d[pure] = { ch: Number.isFinite(ch) ? ch : null, len: Array.isArray(q.closes) ? q.closes.length : 0 };
        }
      }
      function has30dHistory(len30, len24) {
        // Sem sinal de 1mo (batch falhou) mantém o valor do Worker.
        if (!Number.isFinite(len30) || !Number.isFinite(len24) || len30 <= 0) return true;
        return len30 > len24;
      }
      // 1 ano em mapa próprio: mesma janela fixa do 30d. Falha/resposta de
      // outra janela NÃO apaga o último valor válido (só "—" se nunca houve).
      var pending1y = {};
      function collect1y(payload) {
        if (!payload || payload.window !== "1y" || !Array.isArray(payload.quotes)) return;
        for (var k = 0; k < payload.quotes.length; k++) {
          var q = payload.quotes[k] || {};
          var pure = wantMap[String(q.symbol || "").trim().toUpperCase()];
          if (!pure) continue;
          if (q.shortHistory === true) {
            pending1y[pure] = { shortHistory: true, ch: null };
            continue;
          }
          var ch = Number(q.changePct);
          if (Number.isFinite(ch)) pending1y[pure] = { shortHistory: false, ch: ch };
        }
      }
      var jobs = [];
      for (var c = 0; c < wanted.length; c += MONITOR_BATCH) {
        var group = wanted.slice(c, c + MONITOR_BATCH);
        try {
          jobs.push(fetch(WORKER + "?assets=" + encodeURIComponent(group.join(",")) + "&window=24h", { cache: "no-store" })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(applyQuotes)
            .catch(function () {}));
        } catch (e) { /* lote falhou: mantém os valores anteriores */ }
      }
      if (refresh30d) {
        // Marca no agendamento: falha de lote espera os 5 min (sem repetir
        // fora do intervalo) e os valores anteriores ficam intactos.
        last30dAt = now;
        for (var c30 = 0; c30 < wanted.length; c30 += MONITOR_BATCH) {
          var group30 = wanted.slice(c30, c30 + MONITOR_BATCH);
          try {
            jobs.push(fetch(WORKER + "?assets=" + encodeURIComponent(group30.join(",")) + "&window=30d", { cache: "no-store" })
              .then(function (response) { return response.ok ? response.json() : null; })
              .then(collect30d)
              .catch(function () {}));
          } catch (e) { /* lote 30d falhou: mantém os valores anteriores */ }
        }
        for (var c1y = 0; c1y < wanted.length; c1y += MONITOR_BATCH) {
          var group1y = wanted.slice(c1y, c1y + MONITOR_BATCH);
          try {
            jobs.push(fetch(WORKER + "?assets=" + encodeURIComponent(group1y.join(",")) + "&window=1y", { cache: "no-store" })
              .then(function (response) { return response.ok ? response.json() : null; })
              .then(collect1y)
              .catch(function () {}));
          } catch (e) { /* lote 1y falhou: mantém os valores anteriores */ }
        }
      }
      Promise.all(jobs).then(function () {
        // Decide o 30d só depois do 24h: assim cardCloses24Len já está pronto.
        Object.keys(pending30d).forEach(function (p) {
          var item = pending30d[p];
          if (!has30dHistory(item.len, cardCloses24Len[p])) {
            delete cardChange30d[p];
            touched30d = true;
          } else if (item.ch != null) {
            cardChange30d[p] = item.ch;
            touched30d = true;
          }
        });
        Object.keys(pending1y).forEach(function (p) {
          if (pending1y[p].shortHistory) {
            delete cardChange1y[p];
            cardShortHistory1y[p] = true;
          } else {
            cardChange1y[p] = pending1y[p].ch;
            delete cardShortHistory1y[p];
          }
          touched1y = true;
        });
        if ((touched || touched30d || touched1y) && activeTab === "stocks") { try { renderGrahamHistory(); } catch (e) {} }
      });
    } catch (e) {}
  }

  /* ── S/R Dinâmico — Alertas visuais nos cards ── */
  var alertDirection = {};

  function applyAlertVisual(symbol, triggered, direction) {
    var cardEl = grid.querySelector('.tq[data-tq="' + symbolKey(symbol) + '"]');
    if (!cardEl) return;
    cardEl.classList.toggle('alert-triggered', triggered);
    var bellEl = cardEl.querySelector('.tq-bell');
    if (bellEl) bellEl.classList.toggle('alert-bell-active', triggered);
    var srLabel = cardEl.querySelector('.tq-sr-label');
    if (triggered && direction) {
      alertDirection[symbol] = direction;
      if (!srLabel) {
        srLabel = document.createElement('span');
        srLabel.className = 'tq-sr-label';
        var pctEl = cardEl.querySelector('.tqPct');
        if (pctEl) pctEl.parentNode.insertBefore(srLabel, pctEl.nextSibling);
      }
      var lvl = direction === 'resistance' ? 'R' : 'S';
      var cls = direction === 'resistance' ? 'sr-res' : 'sr-sup';
      srLabel.textContent = lvl;
      srLabel.className = 'tq-sr-label ' + cls;
    } else if (!triggered && srLabel) {
      srLabel.remove();
      delete alertDirection[symbol];
    }
  }

  window.addEventListener('PriceAlertTriggered', function (event) {
    var detail = event.detail;
    if (detail && detail.symbol) {
      applyAlertVisual(detail.symbol, true, detail.direction);
    }
  });

  window.addEventListener('PriceAlertDismissed', function (event) {
    var detail = event.detail;
    if (detail && detail.symbol) {
      applyAlertVisual(detail.symbol, false);
    }
  });

  // Réplica de LEITURA do barramento do Painel Pessoal (portfolioLive):
  // alimenta cardPrices SÓ de tickers monitorados, sem tocar no painel
  // nem nos cards. Cobre de graça todo monitorado que já tem fluxo vivo
  // (card próprio ou evento da carteira). Sem fluxo, vale o snapshot.
  window.addEventListener("estudebitcoin:ticker-price", function (event) {
    try {
      var d = event && event.detail;
      var p = d && Number(d.price);
      if (!d || !Number.isFinite(p) || p <= 0) return;
      var sym = String(d.symbol || "").trim().toUpperCase();
      var pure = sym;
      var isBRL = false;
      if (/\.SA$/.test(sym)) { pure = sym.replace(/\.SA$/, ""); isBRL = true; }
      var watched = false;
      for (var i = 0; i < grahamHistory.length; i++) {
        if (grahamHistory[i] && grahamHistory[i].ticker === pure) { watched = true; break; }
      }
      if (!watched) return;
      var px = p;
      if (isBRL) {
        var rate = Number(cardPrices["USDT-BRL"]);
        if (!Number.isFinite(rate) || rate <= 0) return; // sem taxa: mantém snapshot
        px = p / rate;
      }
      cardPrices[pure] = px;
      if (activeTab === "stocks" && grahamHistory.length) { try { renderGrahamHistory(); } catch (e) {} }
    } catch (e) {}
  });

  // CORREÇÃO 6: Handler permanente do sino
  grid.addEventListener("click", function (event) {
    var bellEl = event.target.closest(".tq-bell");
    if (bellEl) {
      event.stopPropagation(); // Evitar clique no card pai
      var symbol = bellEl.getAttribute("data-bell");
      if (window.AlertEngine && window.AlertEngine.dismissVisualAlert) {
        window.AlertEngine.dismissVisualAlert(symbol);
      }
      return;
    }
  });

  /* ── Preço Justo (Graham) — modal genérico ── */
  // Botão ⚖ nos cards de STOCKS. Capture (true) + stopPropagation para não
  // disparar o clique do card (tooltip/conversor), registrado em bubble.
  grid.addEventListener("click", function (event) {
    var gEl = event.target && event.target.closest ? event.target.closest(".tq-graham") : null;
    if (!gEl) return;
    event.stopPropagation();
    event.preventDefault();
    var sym = gEl.getAttribute("data-graham");
    if (sym && window.Graham && window.Graham.open) {
      window.Graham.open(sym, grahamModalOpts(cardPrices[sym] || null));
    }
  }, true);

  // Busca avulsa de preço justo: fica abaixo da legenda e só aparece na aba
  // STOCKS (nunca na primeira página/CRIPTO). O formulário B3 fica entre o
  // grid e a legenda, portanto o Graham deve ser inserido depois dele.
  var grahamBar = document.createElement("div");
  grahamBar.className = "tq-graham-bar";
  grahamBar.style.display = "none";
  grahamBar.innerHTML = '<span class="tq-graham-label">&#9878; Preço justo (Graham): <span id="tq-graham-count">0/30</span></span>' +
    '<input id="tq-graham-input" placeholder="TICKER (ex: PETR4, AAPL)" maxlength="14" autocomplete="off" spellcheck="false" value="ITUB4" />' +
    '<input id="tq-graham-name" placeholder="EMPRESA (ex: Petrobras)" maxlength="40" autocomplete="off" spellcheck="false" value="Itau Unibanco Holding SA Pfd" />' +
    '<button type="button" id="tq-graham-go">Consultar</button>';
  var b3Controls = document.getElementById("b3-custom-controls");
  grid.parentNode.insertBefore(grahamBar, b3Controls ? b3Controls.nextSibling : grid.nextSibling);
  // A legenda RSI deve ficar imediatamente acima da consulta Graham.
  var rsiLegend = document.getElementById("tq-rsi-legend");
  if (rsiLegend && rsiLegend.parentNode) rsiLegend.parentNode.insertBefore(rsiLegend, grahamBar);

  // Histórico da sessão (só memória; some ao recarregar). Tabela abaixo da
  // busca, visível só na aba STOCKS. Linha clicável reabre o modal.
  // Lista é ESCOLHA do usuário (só entra via Monitorar): sem FIFO —
  // no limite, o botão desabilita em vez de expulsar. Ordem alfabética
  // por empresa aplicada SÓ na renderização (armazenamento intacto).
  var GRAHAM_HIST_MAX = 30;
  var grahamHistory = []; // [{ticker, name, currentUSD, fairBRL, fairUSD, upside}]
  var grahamHistEl = document.createElement("div");
  grahamHistEl.className = "tq-graham-hist";
  grahamHistEl.style.display = "none";
  grid.parentNode.insertBefore(grahamHistEl, grahamBar.nextSibling);

  function fmtPctSigned(v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return "—";
    var sign = v > 0 ? "+" : (v < 0 ? "-" : "");
    return sign + Math.abs(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
  }

  function shortName(name) {
    var full = String(name || "");
    var chars = Array.from(full);
    if (chars.length <= 10) return full;
    return chars.slice(0, 10).join("").replace(/\s+$/, "") + "\u2026";
  }

  function fmtShortUSD(v) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "—";
    return "$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtShortBRL(v) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "—";
    return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function renderGrahamHistory() {
    // Totalizador monitorados/limite (toda mutação passa por aqui).
    try {
      var cnt = document.getElementById("tq-graham-count");
      if (cnt) cnt.textContent = grahamHistory.length + "/" + GRAHAM_HIST_MAX;
    } catch (e) {}
    if (!grahamHistory.length) { grahamHistEl.innerHTML = ""; return; }
    // Ordem alfabética por empresa (pt-BR, sem acento/maiúsculas);
    // sem nome → ticker; desempate por ticker. Só visual.
    var sorted = grahamHistory.slice().sort(function (a, b) {      var na = (a.name || a.ticker || '').toString();
      var nb = (b.name || b.ticker || '').toString();
      var c = na.localeCompare(nb, 'pt-BR', { sensitivity: 'base' });
      if (c !== 0) return c;
      return String(a.ticker || '').localeCompare(String(b.ticker || ''), 'pt-BR', { sensitivity: 'base' });
    });
    var html = '<div class="tq-graham-hist-title">Ativos monitorados</div><table><thead><tr><th>Empresa</th><th>Hoje</th><th>% Dia</th><th>% 30D</th><th>% 1Y</th><th>Reais</th><th>Preço Justo R$</th><th>Preço Justo USD</th><th>Upside (%)</th><th></th></tr></thead><tbody>';
    // Taxa p/ a coluna Reais (Atual USD → BRL): vem do próprio ticker USDT-BRL.
    var rate = Number(cardPrices["USDT-BRL"]);
    if (!Number.isFinite(rate) || rate <= 0) rate = null;
    for (var i = 0; i < sorted.length; i++) {
      var h = sorted[i];
      // DISPLAY-ONLY: cotação viva do card p/ exibição; o snapshot em
      // h.currentUSD / h.upside / h.fairUSD / h.fairBRL nunca é sobrescrito.
      var seenLive = Number(cardPrices[h.ticker]);
      var isLive = Number.isFinite(seenLive) && seenLive > 0;
      var livePrice = isLive ? seenLive : h.currentUSD;
      // Dot verde idêntico ao do Painel Pessoal quando o HOJE exibido
      // é cotação viva; cinza (pa-stale) no snapshot — mesmo span sempre,
      // para as linhas não desalinharem. Verde = ao vivo, cinza = Monitorar.
      var dotHtml = isLive
        ? ' <span class="pa-live" title="Preço ao vivo"></span>'
        : ' <span class="pa-live pa-stale" title="Cotação do Monitorar (sem atualização)"></span>';
      var fairNum = Number(h.fairUSD);
      var liveNum = Number(livePrice);
      var fairBRLNum = Number(h.fairBRL); // B3: justo USD exibido pela taxa atual
      var fairUsdShown = (Number.isFinite(fairBRLNum) && fairBRLNum > 0 && rate != null)
        ? (fairBRLNum / rate) : (Number.isFinite(fairNum) && fairNum > 0 ? fairNum : null);
      var upShown = (Number.isFinite(fairUsdShown) && fairUsdShown > 0 && Number.isFinite(liveNum) && liveNum > 0) ? ((fairUsdShown / liveNum) - 1) * 100 : h.upside;
      var cls = upShown == null ? "" : (upShown > 0 ? "tq-h-up" : (upShown < 0 ? "tq-h-down" : ""));
      var reais = (rate != null && livePrice != null) ? livePrice * rate : null;
      // % do dia (fonte 24h do Worker, fechamento anterior). Sem dado → "—";
      // zero usa classe própria (cinza), sem mexer nas classes do Upside.
      var dayCh = Number(cardChangePct[h.ticker]);
      if (!Number.isFinite(dayCh)) dayCh = null;
      var dayCls = dayCh == null ? "" : (dayCh > 0 ? "tq-h-up" : (dayCh < 0 ? "tq-h-down" : "tq-h-flat"));
      // 30d: janela fixa do Worker, independente do seletor 7D/30D dos cards.
      var day30Ch = Number(cardChange30d[h.ticker]);
      if (!Number.isFinite(day30Ch)) day30Ch = null;
      var day30Cls = day30Ch == null ? "" : (day30Ch > 0 ? "tq-h-up" : (day30Ch < 0 ? "tq-h-down" : "tq-h-flat"));
      // 1y: histórico curto remove o valor anterior e mostra ausência explícita.
      var day1yCh = Number(cardChange1y[h.ticker]);
      if (!Number.isFinite(day1yCh)) day1yCh = null;
      var day1yCls = day1yCh == null ? "" : (day1yCh > 0 ? "tq-h-up" : (day1yCh < 0 ? "tq-h-down" : "tq-h-flat"));
      var day1yTitle = cardShortHistory1y[h.ticker] ? ' title="Menos de 1 ano de histórico"' : "";
      // Selo p/ linhas antigas sem justo calculável (só visual, sem apagar).
      var flag = (h.fairUSD == null && h.fairBRL == null)
        ? ' <span class="tq-h-flag">dados incompletos</span>' : '';
      var fullName = h.name || h.ticker;
      var shownName = shortName(h.name || '—');
      html += '<tr data-ticker="' + esc(symbolKey(h.ticker)) + '">' +
        '<td title="' + esc(fullName) + '"><span class="tq-h-name" title="' + esc(fullName) + '" aria-label="' + esc(fullName) + '">' + esc(shownName) + '</span><br><span class="tq-h-ticker">' + esc(h.ticker) + '</span>' + flag + '</td>' +
        '<td><b>' + esc(fmtShortUSD(livePrice)) + '</b>' + dotHtml + '</td>' +
        '<td class="' + dayCls + '">' + esc(fmtPctSigned(dayCh)) + '</td>' +
        '<td class="' + day30Cls + '">' + esc(fmtPctSigned(day30Ch)) + '</td>' +
        '<td class="' + day1yCls + '"' + day1yTitle + '>' + esc(fmtPctSigned(day1yCh)) + '</td>' +
        '<td>' + esc(fmtShortBRL(reais)) + '</td>' +
        '<td>' + esc(fmtShortBRL(h.fairBRL)) + '</td>' +
        '<td><b>' + esc(fmtShortUSD(fairUsdShown)) + '</b></td>' +
        '<td class="' + cls + '">' + esc(fmtPctSigned(upShown)) + '</td>' +
        '<td><button type="button" class="tq-h-del" data-del="' + esc(symbolKey(h.ticker)) + '" title="Remover ' + esc(h.ticker) + ' do histórico" aria-label="Remover ' + esc(h.ticker) + '">✕</button></td></tr>';
    }
    grahamHistEl.innerHTML = html + "</tbody></table>";
  }

  // Nuvem do histórico Graham (só logados; anônimo fica na memória).
  // Lazy: graham.js carrega DEPOIS do ticker (defer em ordem).
  var grahamCloudReady = false;
  function ensureGrahamCloud() {
    if (grahamCloudReady) return;
    try {
      if (window.Graham && window.Graham.Cloud && window.Graham.Cloud.init) {
        window.Graham.Cloud.init({
          getHistory: function () { return grahamHistory; },
          setHistory: function (list) {
            grahamHistory = Array.isArray(list) ? list : [];
            renderGrahamHistory();
            // Histórico chegou da nuvem: cotar os sem-card já, sem
            // esperar o próximo ciclo de 60s (a réplica no load pegou vazio).
            try { refreshMonitoredBroadcast(); } catch (e) {}
          }
        });
        grahamCloudReady = true;
      }
    } catch (e) {}
  }

  // Opts padrão do modal Graham: salva SÓ via Monitorar; informa se o
  // ticker já está na tabela + contagem/limite p/ os estados do botão.
  // onSettled opcional: {ticker, fund, err} quando a consulta termina.
  function grahamModalOpts(price, onSettled) {
    var opts = {
      price: price,
      onMonitor: logGrahamHistory,
      isMonitored: function (t) {
        var k = String(t || '').trim().toUpperCase();
        for (var i = 0; i < grahamHistory.length; i++) {
          if (grahamHistory[i].ticker === k) return true;
        }
        return false;
      },
      monitorInfo: function () { return { count: grahamHistory.length, limit: GRAHAM_HIST_MAX }; }
    };
    if (onSettled) opts.onSettled = onSettled;
    return opts;
  }

  function logGrahamHistory(result) {
    try {
      if (!result || !result.ticker) return;
      // Trava: ticker não reconhecido (fonte sem nenhum dado) não
      // alimenta a tabela — o modal já informa a indisponibilidade.
      if (!result.fund) return;
      // Trava real (além do botão): só grava via podeMonitorar.
      try {
        var host = (typeof window !== 'undefined') ? window : null;
        var chk = host && host.Graham && host.Graham.podeMonitorar
          ? host.Graham.podeMonitorar(grahamHistory, result, GRAHAM_HIST_MAX) : { ok: true };
        if (!chk || !chk.ok) return;
      } catch (e) { return; }
      var t = String(result.ticker).trim().toUpperCase();
      var cur = Number(result.current);
      var fair = Number(result.fairUSD);
      var up = (Number.isFinite(cur) && cur > 0 && Number.isFinite(fair) && fair > 0)
        ? (fair - cur) / cur * 100 : null;
      // Preço justo em BRL só quando a fonte de origem é BRL (B3). Ativos
      // em USD mostram '—' (sem converter USD→BRL→USD de volta). O upside
      // continua sempre em USD.
      var fairBRL = (result.fund && result.fund.currency === "BRL" &&
        Number.isFinite(Number(result.fair)) && Number(result.fair) > 0)
        ? Number(result.fair) : null;
      var entry = { ticker: t, name: (result.fund && result.fund.name) || null, currentUSD: (Number.isFinite(cur) && cur > 0) ? cur : null, fairBRL: fairBRL, fairUSD: (Number.isFinite(fair) && fair > 0) ? fair : null, upside: up };
      var idx = -1;
      for (var i = 0; i < grahamHistory.length; i++) {
        if (grahamHistory[i].ticker === t) { idx = i; break; }
      }
      if (idx >= 0) grahamHistory[idx] = entry;
      else grahamHistory.push(entry);
      // Sem FIFO: no limite, o botão Monitorar desabilita (a lista é escolha).
      renderGrahamHistory();
      // Novo monitorado: cotar os sem-card já, sem esperar o ciclo de 60s.
      // Zera o gate do 30d para trazer a janela de 30 dias na hora.
      last30dAt = 0;
      try { refreshMonitoredBroadcast(); } catch (e) {}
      // Persistência (só logados; anônimo: memória da sessão).
      try {
        if (window.Graham && window.Graham.Cloud && window.Graham.Cloud.pushSoon) {
          window.Graham.Cloud.pushSoon();
        }
      } catch (e) {}
    } catch (e) {}
  }

  grahamHistEl.addEventListener("click", function (event) {
    var del = event.target && event.target.closest ? event.target.closest("[data-del]") : null;
    if (del) {
      event.stopPropagation();
      var dt = del.getAttribute("data-del");
      grahamHistory = grahamHistory.filter(function (h) { return h.ticker !== dt; });
      renderGrahamHistory();
      try {
        if (window.Graham && window.Graham.Cloud && window.Graham.Cloud.pushSoon) {
          window.Graham.Cloud.pushSoon();
        }
      } catch (e) {}
      return;
    }
    var row = event.target && event.target.closest ? event.target.closest("tr[data-ticker]") : null;
    if (!row) return;
    var sym = row.getAttribute("data-ticker");
    var price = null;
    // DISPLAY-ONLY: preço vivo do card p/ o modal; sem card, o snapshot
    // armazenado. O histórico nunca é alterado aqui.
    var seenRow = Number(cardPrices[sym]);
    if (Number.isFinite(seenRow) && seenRow > 0) { price = seenRow; }
    else {
      for (var i = 0; i < grahamHistory.length; i++) {
        if (grahamHistory[i].ticker === sym) { price = grahamHistory[i].currentUSD; break; }
      }
    }
    if (sym && window.Graham && window.Graham.open) {
      window.Graham.open(sym, grahamModalOpts(price));
    }
  });

  function updateGrahamBar() {
    var show = activeTab === "stocks";
    grahamBar.style.display = show ? "" : "none";
    grahamHistEl.style.display = show ? "" : "none";
  }

  // Ticker cujo nome está exibido no campo empresa (default do HTML ou
  // último preenchimento). Divergiu → o nome exibido é obsoleto e o campo
  // é limpo ao digitar (nunca exibe nome de outra empresa ao lado do novo
  // ticker). Inicializa com o valor default da barra (ex.: ITUB4).
  var lastNameTicker = "";
  try {
    var lastNameInit = document.getElementById("tq-graham-input");
    if (lastNameInit) lastNameTicker = String(lastNameInit.value).trim().toUpperCase();
  } catch (e) {}

  // Preenche o campo empresa SÓ após Consultar/Enter retornar (zero
  // chamadas enquanto digita). Nome da fonte; dados válidos sem nome →
  // o próprio ticker (nunca mensagem de erro); erro → mensagem classificada.
  // Todo preenchimento com sucesso atualiza lastNameTicker.
  function fillGrahamName(settled) {
    try {
      if (!settled) return;
      var cur = document.getElementById("tq-graham-input");
      var nm = document.getElementById("tq-graham-name");
      if (!cur || !nm) return;
      if (String(cur.value).trim().toUpperCase() !== settled.ticker) return; // usuário já mudou
      if (document.activeElement === nm) return; // não atropela digitação
      var fund = settled.fund || null;
      if (fund && fund.name) { nm.value = fund.name; lastNameTicker = settled.ticker; return; }
      if (fund && (fund.lpa != null || fund.vpa != null || fund.price != null)) { nm.value = settled.ticker; lastNameTicker = settled.ticker; return; }
      if (settled.err && window.Graham && window.Graham.messageForKind) {
        nm.value = window.Graham.messageForKind(settled.err.kind);
      }
    } catch (e) {}
  }

  function submitGrahamSearch() {
    var input = document.getElementById("tq-graham-input");
    var nameInput = document.getElementById("tq-graham-name");
    var goBtn = document.getElementById("tq-graham-go");
    var ticker = input ? String(input.value).trim().toUpperCase() : "";
    if (input && input.value !== ticker) input.value = ticker;
    if (ticker) {
      if (window.Graham && window.Graham.open) window.Graham.open(ticker, grahamModalOpts(null, fillGrahamName));
      return;
    }
    // Sem ticker: tenta resolver pelo nome da empresa (primeiro resultado).
    var name = nameInput ? String(nameInput.value).trim() : "";
    if (!name || !window.Graham || !window.Graham.resolveTicker) return;
    if (goBtn) { goBtn.disabled = true; goBtn.textContent = "Buscando…"; }
    window.Graham.resolveTicker(name).then(function (hit) {
      if (goBtn) { goBtn.disabled = false; goBtn.textContent = "Consultar"; }
      if (hit && hit.ticker) {
        if (input) input.value = hit.ticker;
        window.Graham.open(hit.ticker, grahamModalOpts(null, fillGrahamName));
      } else if (nameInput) {
        nameInput.title = "Empresa não encontrada — tente o ticker direto.";
      }
    });
  }

  var grahamGo = document.getElementById("tq-graham-go");
  if (grahamGo) grahamGo.addEventListener("click", submitGrahamSearch);
  var grahamInput = document.getElementById("tq-graham-input");
  if (grahamInput) grahamInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); submitGrahamSearch(); }
  });
  var grahamName = document.getElementById("tq-graham-name");
  if (grahamName) grahamName.addEventListener("keydown", function (event) {
    if (event.key === "Enter") { event.preventDefault(); submitGrahamSearch(); }
  });
  // Digitou a empresa: limpa o ticker p/ a consulta ir pela resolução
  // do nome (ticker preenchido sempre venceria e ignoraria o nome).
  if (grahamName) grahamName.addEventListener("input", function () {
    try {
      var tick = document.getElementById("tq-graham-input");
      if (tick && String(tick.value).trim() !== "") tick.value = "";
    } catch (e) {}
  });

  // Busca ao vivo do nome (B3): usa /api/tickers/search (SEM rate limit
  // diário) — nunca /api/fundamentals. Preenche SÓ em match exato do
  // ticker; sem match não escreve nada (erro só no Consultar, com as
  // mensagens classificadas). <2 letras nem consulta. Fora do catálogo
  // (ex.: EUA), o campo fica vazio até o Consultar. Nunca mexe no que o
  // usuário digitou no campo empresa enquanto ele está com foco nele.
  var grahamLiveTimer = null;
  var grahamLiveLast = "";
  function lookupGrahamNameLive() {
    try {
      var input = document.getElementById("tq-graham-input");
      var nameInput = document.getElementById("tq-graham-name");
      if (!input || !nameInput || !window.Graham || !window.Graham.lookupTickerName) return;
      var ticker = String(input.value).trim().toUpperCase();
      if (ticker.length < 2 || ticker === grahamLiveLast) return;
      grahamLiveLast = ticker;
      window.Graham.lookupTickerName(ticker).then(function (name) {
        try {
          var cur = document.getElementById("tq-graham-input");
          var nm = document.getElementById("tq-graham-name");
          if (!cur || !nm) return;
          if (String(cur.value).trim().toUpperCase() !== ticker) return; // corrida: usuário já mudou
          if (document.activeElement === nm) return; // não atropela digitação
          if (name) { nm.value = name; lastNameTicker = ticker; } // match exato; sem match: intocado
        } catch (e) {}
      }).catch(function () {});
    } catch (e) {}
  }
  if (grahamInput) grahamInput.addEventListener("input", function () {
    // Nome obsoleto: ticker divergiu do ticker resolvido → limpa o campo
    // (exceto com foco nele, p/ não apagar digitação do nome da empresa).
    try {
      var curTyped = document.getElementById("tq-graham-input");
      var nmShown = document.getElementById("tq-graham-name");
      if (curTyped && nmShown &&
          String(curTyped.value).trim().toUpperCase() !== lastNameTicker &&
          document.activeElement !== nmShown) {
        nmShown.value = "";
      }
    } catch (e) {}
    if (grahamLiveTimer) window.clearTimeout(grahamLiveTimer);
    grahamLiveTimer = window.setTimeout(lookupGrahamNameLive, 700);
  });

  refresh(true);
})();
