/* =====================================================================
   EstudeBitcoin — priceProvider (cotações automáticas, custo zero)
   ---------------------------------------------------------------------
   - CRYPTO: Binance pública (24h ticker). Mesma fonte do ticker-widget.
     Par: {TICKER}USDT (ex: BTCUSDT). Sem chave, sem login.
   - STOCK: Worker próprio (/api/quotes — A MESMA fonte dos cards do
     ticker, inclui name). Fallback: Stooq CSV gratuito (.us/.sa).
     Variação (fallback) = (close-open)/open do dia.
   - Tudo com timeout + falha silenciosa (retorna null → UI mantém manual).
   - getQuote(ticker, type) → Promise<{price, dailyVariation, name?, source}|null>.
   ===================================================================== */
(function () {
  'use strict';

  var TIMEOUT_MS = 8000;
  var STOCK_WORKER = 'https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/api/quotes';

  function normTicker(t) {
    return String(t == null ? '' : t).trim().toUpperCase().replace(/\//g, '-');
  }

  function fetchJSON(url) {
    var ctrl = null;
    var timer = null;
    try {
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS);
      }
    } catch (e) {}
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function fetchText(url) {
    var ctrl = null;
    var timer = null;
    try {
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS);
      }
    } catch (e) {}
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function cryptoName(ticker) {
    return fetchJSON('https://api.coingecko.com/api/v3/search?query=' + encodeURIComponent(ticker))
      .then(function (j) {
        var list = j && Array.isArray(j.coins) ? j.coins : [];
        var wanted = String(ticker).toUpperCase();
        var matches = [];
        for (var i = 0; i < list.length; i++) {
          var coin = list[i] || {};
          if (String(coin.symbol || '').toUpperCase() === wanted && coin.name) {
            matches.push(coin);
          }
        }
        matches.sort(function (a, b) {
          var ar = Number.isFinite(Number(a.market_cap_rank)) ? Number(a.market_cap_rank) : Infinity;
          var br = Number.isFinite(Number(b.market_cap_rank)) ? Number(b.market_cap_rank) : Infinity;
          return ar - br;
        });
        return matches.length ? String(matches[0].name).trim() : null;
      })
      .catch(function () { return null; });
  }

  // CRYPTO via Binance 24h ticker: { lastPrice, priceChangePercent }.
  function cryptoQuote(ticker) {
    var symbol = ticker.replace(/[^A-Z0-9]/g, '') + 'USDT';
    return fetchJSON('https://api.binance.com/api/v3/ticker/24hr?symbol=' + symbol)
      .then(function (j) {
        var price = num(j && j.lastPrice);
        var day = num(j && j.priceChangePercent);
        if (price === null || price <= 0) return null;
    return cryptoName(ticker).then(function (name) {
      return {
            price: price,
            dailyVariation: day === null ? 0 : day,
            name: name,
            source: 'binance'
          };
        });
      })
      .catch(function () { return null; });
  }

  // STOCK via Worker próprio (mesma fonte dos cards; inclui name).
  // Símbolo cru (ex.: "SI=F", "^GSPC") — o Worker normaliza como no ticker.
  function stockQuoteWorker(ticker) {
    var raw = String(ticker == null ? '' : ticker).trim().toUpperCase();
    if (!raw) return Promise.resolve(null);
    return fetchJSON(STOCK_WORKER + '?assets=' + encodeURIComponent(raw)).then(function (payload) {
      var list = payload && Array.isArray(payload.quotes) ? payload.quotes : [];
      var q = null;
      for (var i = 0; i < list.length; i++) {
        var sym = String((list[i] && list[i].symbol) || '').trim().toUpperCase();
        if (sym === raw) { q = list[i]; break; }
      }
      // SEM fallback para list[0]: quote de símbolo diferente (ex.: "A" para
      // busca "MSTR") é pior que sem cotação — cai no Stooq ou manual.
      if (!q) return null;
      var price = num(q.price);
      if (price === null || price <= 0) return null;
      var day = num(q.changePct != null ? q.changePct : q.dailyVariation);
      var nm = String((q && q.name) || '').trim();
      return { price: price, dailyVariation: day === null ? 0 : day, name: nm || null, source: 'worker' };
    });
  }

  // STOCK via Stooq CSV (fallback): Symbol,Date,Time,Open,High,Low,Close,Volume.
  // Sufixo .us (EUA) ou .sa (B3). Variação intradiária (close-open)/open.
  function stockQuoteStooq(ticker) {
    var base = ticker.replace(/[^A-Z0-9]/g, '');
    var isBR = /(3|4|5|6|11|34)$/.test(base);
    var symbol = (isBR ? base.toLowerCase() + '.sa' : base.toLowerCase() + '.us');
    return fetchText('https://stooq.com/q/l/?s=' + encodeURIComponent(symbol) +
      '&f=sd2t2ohlcv&h&e=csv').then(function (txt) {
        var lines = String(txt || '').trim().split('\n');
        if (lines.length < 2) return null;
        var cols = lines[1].split(',');
        if ((cols[0] || '').toLowerCase() !== symbol) return null;
        var open = num(cols[3]);
        var close = num(cols[6]);
        if (open === null || close === null || open <= 0 || close <= 0) return null;
        return {
          price: close,
          dailyVariation: (close / open - 1) * 100,
          name: null,
          source: 'stooq'
        };
      });
  }

  // STOCK: Worker primeiro (fonte dos cards), Stooq como fallback.
  function stockQuote(ticker) {
    return stockQuoteWorker(ticker).then(function (q) {
      if (q) return q;
      return stockQuoteStooq(ticker).catch(function () { return null; });
    }).catch(function () {
      return stockQuoteStooq(ticker).catch(function () { return null; });
    });
  }

  function getQuote(ticker, type) {
    var t = normTicker(ticker);
    if (!t) return Promise.resolve(null);
    var isStock = String(type || '').trim().toUpperCase() === 'STOCK';
    return (isStock ? stockQuote(t) : cryptoQuote(t));
  }

  function getCurrentPrice(ticker, type) {
    return getQuote(ticker, type).then(function (q) {
      return q ? q.price : null;
    });
  }

  function getDailyVariation(ticker, type) {
    return getQuote(ticker, type).then(function (q) {
      return q ? q.dailyVariation : null;
    });
  }

  var api = {
    getQuote: getQuote,
    getCurrentPrice: getCurrentPrice,
    getDailyVariation: getDailyVariation
  };

  if (typeof module === 'object' && module.exports && typeof module.exports === 'object') {
    module.exports = api;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.PriceProvider = api;
  }
})();
