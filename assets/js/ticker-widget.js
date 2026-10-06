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
  var STOCKS = ["^GSPC", "^NDX", "SI=F", "HG=F", "BZ=F", "URNM", "OKLO", "USAR", "QUBT", "QBTS", "NVDA", "AMD", "GOOGL", "META", "AAPL", "SNDK", "GLW", "MSTR", "CRCL", "MP", "RIO", "BHP", "SPCX", "TSLA"];
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
    "OKLO": "OKLO",
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
    "BZ=F": "BRENT",
    "^NDX": "NASDAQ 100",
  };
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
  var activeWindow = "24h";
  var cache = {};
  var livePrices = {};
  var cardPrices = {}; // último preço visto por símbolo (p/ modal Graham)
  var liveVolume = {};
  var quoteData = {};
  var pairSymbol = {};
  var symbolCurrency = {};
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

  function card(quote) {
    var change = typeof quote.changePct === "number" ? quote.changePct : null;
    var pct = change === null ? "—" : (change >= 0 ? "+" : "") + change.toFixed(2).replace(".", ",") + "%";
    var price = typeof livePrices[quote.symbol] === "number" ? livePrices[quote.symbol] : quote.price;
    var currency = symbolCurrency[quote.symbol] || "USD";
    var small = quote.symbol === "BTC" || quote.symbol === "ETH" || quote.symbol === "PAXG" ? " tq-sm" : "";
    var smallLabel = quote.symbol === "^NDX" ? " tq-label-sm" : "";
    var label = STOCK_LABELS[quote.symbol] || quote.symbol;
    var bell = isCrypto(quote.symbol)
      ? '<button class="tq-bell" data-bell="' + esc(symbolKey(quote.symbol)) + '" aria-label="Dispensar alerta" title="Dispensar alerta">&#128276;</button>'
      : '';
    // Preço Justo (Graham): só em STOCKS (cripto não tem LPA/VPA).
    var grahamBtn = !isCrypto(quote.symbol)
      ? '<button class="tq-graham" data-graham="' + esc(symbolKey(quote.symbol)) + '" aria-label="Ver preço justo de ' + esc(symbolKey(quote.symbol)) + '" title="Preço justo (Graham)">&#9878;</button>'
      : '';
    return '<div class="tq ' + changeClass(change) + '" data-tq="' + esc(symbolKey(quote.symbol)) + '">' +
      '<b class="tqSym' + smallLabel + '">' + esc(label) + "</b>" +
      bell +
      grahamBtn +
      '<span class="tqPct">' + pct + "</span>" +
      '<strong class="tqPrice' + small + '">' + fmtPrice(price, currency, !isCrypto(quote.symbol)) + "</strong>" +
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

  function fetchStocks() {
    return fetch(WORKER + "?assets=" + encodeURIComponent(STOCKS.join(",")) + "&window=" + activeWindow, { cache: "no-store" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        if (!payload || !Array.isArray(payload.quotes)) return [];
        return payload.quotes.map(function (quote) {
          quoteData[quote.symbol] = {
            name: STOCK_NAMES[quote.symbol] || quote.name || quote.symbol,
            volume: quote.volume,
            volumeLabel: "Volume hoje",
          };
          return { symbol: quote.symbol, currency: "USD", price: quote.price, changePct: quote.changePct };
        });
      })
      .catch(function () { return []; });
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
    var key = activeTab + "|" + activeWindow;
    if (force) delete cache[key];
    var promise = cache[key] ? Promise.resolve(cache[key]) : (activeTab === "crypto" ? fetchCrypto() : fetchStocks()).then(function (quotes) {
      cache[key] = quotes;
      return quotes;
    });
    promise.then(function (quotes) { broadcastQuotes(quotes); render(quotes); }).catch(function () { render([]); });
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
  function showTooltip(cardEl) {
    var symbol = cardEl.getAttribute("data-tq");
    var meta = quoteData[symbol];
    if (!meta) return;
    var html = "<b>" + esc(meta.name || symbol) + "</b>";
    if (meta.volume !== null && meta.volume !== undefined) {
      html += '<span class="tq-tip-vol">' + esc(meta.volumeLabel || "Volume") + ": " + fmtVolume(meta.volume) + "</span>";
    }
    tooltip.innerHTML = html;
    var rect = cardEl.getBoundingClientRect();
    tooltip.style.left = Math.round(rect.left + rect.width / 2) + "px";
    tooltip.style.top = (rect.top > 90 ? rect.top - 10 : rect.bottom + 10) + "px";
    tooltip.classList.add("show");
  }
  function hideTooltip() {
    tooltip.classList.remove("show");
  }
  grid.addEventListener("mouseover", function (event) {
    var cardEl = event.target.closest(".tq");
    if (cardEl && !pinnedSymbol) showTooltip(cardEl);
  });
  grid.addEventListener("mouseout", function (event) {
    if (event.target.closest(".tq") && !pinnedSymbol) hideTooltip();
  });
  grid.addEventListener("click", function (event) {
    var cardEl = event.target.closest(".tq");
    if (!cardEl) return;
    var symbol = cardEl.getAttribute("data-tq");
    if (pinnedSymbol === symbol) {
      pinnedSymbol = null;
      hideTooltip();
    } else {
      pinnedSymbol = symbol;
      showTooltip(cardEl);
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
    if (!event.target.closest(".tq") && pinnedSymbol) {
      pinnedSymbol = null;
      hideTooltip();
    }
  });

  function bindButtons() {
    document.querySelectorAll(".ticker-window button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeWindow = btn.getAttribute("data-window") || "24h";
        document.querySelectorAll(".ticker-window button").forEach(function (b) { b.classList.toggle("active", b === btn); });
        refresh(true);
      });
    });
    document.querySelectorAll(".ticker-tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeTab = btn.getAttribute("data-tab") || "crypto";
        document.querySelectorAll(".ticker-tabs button").forEach(function (b) { b.classList.toggle("active", b === btn); });
        refresh(true);
      });
    });
  }

  bindButtons();
  window.setInterval(function () { refresh(true); }, 5000);
  connectWs();

  // Broadcast de stocks independente da aba ativa: fetchStocks() só roda com
  // a aba stocks visível, mas stocks não têm WebSocket — sem este loop, a
  // carteira nunca receberia cotação deles. 60s basta (stocks andam devagar);
  // só emite o evento, sem mexer nos cards. 1 chamada ao Worker por minuto.
  function refreshStocksBroadcast() {
    try {
      fetchStocks().then(function (quotes) { broadcastQuotes(quotes); }).catch(function () {});
      refreshMonitoredBroadcast();
    } catch (e) {}
  }
  window.setInterval(refreshStocksBroadcast, 60000);
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
      var wanted = [];
      var wantMap = {}; // símbolo Yahoo -> ticker puro
      for (var i = 0; i < grahamHistory.length; i++) {
        var t = String((grahamHistory[i] && grahamHistory[i].ticker) || "").trim().toUpperCase();
        if (!t || covered[t]) continue;
        covered[t] = true;
        var live = Number(cardPrices[t]);
        if (Number.isFinite(live) && live > 0) continue; // já tem fluxo vivo
        var y = yahooSymbolFor(t);
        wantMap[y] = t;
        wanted.push(y);
      }
      if (!wanted.length) return;
      fetch(WORKER + "?assets=" + encodeURIComponent(wanted.join(",")) + "&window=24h", { cache: "no-store" })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (payload) {
          if (!payload || !Array.isArray(payload.quotes)) return;
          var rate = Number(cardPrices["USDT-BRL"]);
          if (!Number.isFinite(rate) || rate <= 0) rate = null;
          var touched = false;
          for (var k = 0; k < payload.quotes.length; k++) {
            var q = payload.quotes[k] || {};
            var pure = wantMap[String(q.symbol || "").trim().toUpperCase()];
            if (!pure) continue;
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
          if (touched && activeTab === "stocks") { try { renderGrahamHistory(); } catch (e) {} }
        })
        .catch(function () {});
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

  // Busca avulsa de preço justo: fica ABAIXO do grid e só aparece na aba
  // STOCKS (nunca na primeira página/CRIPTO).
  var grahamBar = document.createElement("div");
  grahamBar.className = "tq-graham-bar";
  grahamBar.style.display = "none";
  grahamBar.innerHTML = '<span class="tq-graham-label">&#9878; Preço justo (Graham): <span id="tq-graham-count">0/30</span></span>' +
    '<input id="tq-graham-input" placeholder="TICKER (ex: PETR4, AAPL)" maxlength="14" autocomplete="off" spellcheck="false" value="ITUB4" />' +
    '<input id="tq-graham-name" placeholder="EMPRESA (ex: Petrobras)" maxlength="40" autocomplete="off" spellcheck="false" value="Itau Unibanco Holding SA Pfd" />' +
    '<button type="button" id="tq-graham-go">Consultar</button>';
  grid.parentNode.insertBefore(grahamBar, grid.nextSibling);

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
    var html = '<div class="tq-graham-hist-title">Ativos monitorados</div><table><thead><tr><th>Empresa</th><th>Hoje</th><th>Reais</th><th>Preço Justo R$</th><th>Preço Justo USD</th><th>Upside (%)</th><th></th></tr></thead><tbody>';
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
      // UPSIDE display-only, recalculado do preço vivo sobre o justo
      // armazenado; sem justo/preço válidos, mantém o snapshot exibido.
      var upShown = (Number.isFinite(fairNum) && fairNum > 0 && Number.isFinite(liveNum) && liveNum > 0)
        ? ((fairNum / liveNum) - 1) * 100 : h.upside;
      var cls = upShown == null ? "" : (upShown > 0 ? "tq-h-up" : (upShown < 0 ? "tq-h-down" : ""));
      var reais = (rate != null && livePrice != null) ? livePrice * rate : null;
      // Selo p/ linhas antigas sem justo calculável (só visual, sem apagar).
      var flag = (h.fairUSD == null && h.fairBRL == null)
        ? ' <span class="tq-h-flag">dados incompletos</span>' : '';
      html += '<tr data-ticker="' + esc(symbolKey(h.ticker)) + '">' +
        '<td>' + esc(h.name || '—') + '<br><span class="tq-h-ticker">' + esc(h.ticker) + '</span>' + flag + '</td>' +
        '<td><b>' + esc(fmtShortUSD(livePrice)) + '</b>' + dotHtml + '</td>' +
        '<td>' + esc(fmtShortBRL(reais)) + '</td>' +
        '<td>' + esc(fmtShortBRL(h.fairBRL)) + '</td>' +
        '<td><b>' + esc(fmtShortUSD(h.fairUSD)) + '</b></td>' +
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
