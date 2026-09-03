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
    return '<div class="tq ' + changeClass(change) + '" data-tq="' + esc(symbolKey(quote.symbol)) + '">' +
      '<b class="tqSym' + smallLabel + '">' + esc(label) + "</b>" +
      bell +
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
            // CORREÇÃO 2: Verificar se símbolo possui níveis definidos pelo usuário
            var hasUserLevels = window.AlertEngine.hasUserDefinedLevels(symbol);
            
            if (hasUserLevels) {
              var userLevels = window.AlertEngine.getLevels(symbol);
              console.log('[SR-TRACE] TICKER SKIPPED', {
                symbol: symbol,
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
                  symbol: symbol,
                  support: srResult.support,
                  resistance: srResult.resistance,
                  source: 'TICKER',
                  timeframe: cfg.interval
                });
                window.AlertEngine.unlockAudio();
                window.AlertEngine.setAlertLevels(symbol, srResult.support, srResult.resistance, {
                  source: 'TICKER',
                  timeframe: cfg.interval
                });
                if (symbol === 'BTC' && window.PushSubscribe && window.PushSubscribe.isEnabled() && window.PushSubscribe.syncToWorker) {
                  window.PushSubscribe.syncToWorker(symbol, srResult.support, srResult.resistance, last);
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
    grid.style.gridTemplateColumns = "repeat(" + Math.min(Math.max(quotes.length, 1), 8) + ", minmax(0, 1fr))";
    if (statusEl) statusEl.textContent = "AO VIVO · " + new Date().toLocaleTimeString("pt-BR");
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

  function refresh(force) {
    var key = activeTab + "|" + activeWindow;
    if (force) delete cache[key];
    var promise = cache[key] ? Promise.resolve(cache[key]) : (activeTab === "crypto" ? fetchCrypto() : fetchStocks()).then(function (quotes) {
      cache[key] = quotes;
      return quotes;
    });
    promise.then(render).catch(function () { render([]); });
  }

  function updateLivePrice(symbol, price, volume) {
    livePrices[symbol] = price;
    if (typeof volume === "number" && Number.isFinite(volume)) {
      liveVolume[symbol] = volume;
      if (quoteData[symbol]) quoteData[symbol].volume = volume;
    }
    // Fase C: alimentar motor de alertas S/R Dinâmico (apenas criptos)
    if (isCrypto(symbol) && window.AlertEngine && window.PushSubscribe && window.PushSubscribe.isEnabled()) {
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
          updateLivePrice(symbol, parseFloat(payload.data.c), parseFloat(payload.data.q));
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

  refresh(true);
})();
