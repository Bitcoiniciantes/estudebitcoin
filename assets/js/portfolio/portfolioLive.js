/* =====================================================================
   EstudeBitcoin — portfolioLive (motor independente da Minha Carteira)
   ---------------------------------------------------------------------
   - 100% free, sem chave: Binance pública (crypto) + Worker /api/quotes
     (Yahoo) para stocks. Sem alterar o Worker, sem Stooq no loop.
   - Universo dinâmico: tickers da carteira via PainelAtivos.getService().
   - Contrato de evento (CONFIRMADO NO CÓDIGO — onTickerPrice lê
     ev.detail.changePct e normEv faz strip USDT):
       detail: { symbol, price, changePct, source }
       symbol = TICKER PURO ('BNB', não 'BNBUSDT')
       changePct (NUNCA change24h/dailyVariation/pct)
       source = 'websocket' (crypto WS) | 'snapshot' (HTTP batch)
   - Desconhecido/erro: não emite → mantém último preço, sem dot.
   ===================================================================== */
(function () {
  'use strict';

  var WORKER = 'https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/api/quotes';
  var POLL_MS = 60000;
  var TIMEOUT_MS = 8000;
  var CHUNK = 20;

  var pollTimer = null;
  var ws = null;
  var wsStreamsKey = '';
  var started = false;
  var failCount = 0;

  function getRoot() {
    try {
      if (typeof globalThis !== 'undefined') return globalThis;
    } catch (e) {}
    return null;
  }

  function getService() {
    try {
      var host = getRoot();
      if (host && host.PainelAtivos && typeof host.PainelAtivos.getService === 'function') {
        return host.PainelAtivos.getService();
      }
    } catch (e) {}
    return null;
  }

  // Universo: [{ticker, type}] direto do service (fonte da verdade).
  // Fallback: botões data-ticker do DOM (type desconhecido → STOCK seguro,
  // pois Worker/Yahoo aceita qualquer símbolo; crypto sem type não entra no WS).
  function getUniverse() {
    var svc = getService();
    if (svc && typeof svc.query === 'function') {
      try {
        var view = svc.query({});
        var list = (view && view.assets) || [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
          var a = list[i];
          if (!a || !a.ticker) continue;
          out.push({
            ticker: String(a.ticker).trim().toUpperCase(),
            type: String(a.type || '').trim().toUpperCase()
          });
        }
        if (out.length) return out;
      } catch (e) {}
    }
    try {
      var doc = typeof document !== 'undefined' ? document : null;
      if (doc && doc.querySelectorAll) {
        var btns = doc.querySelectorAll('#pa-tbody button[data-ticker]');
        var seen = {};
        var fb = [];
        for (var j = 0; j < btns.length; j++) {
          var t = String(btns[j].getAttribute('data-ticker') || '').trim().toUpperCase();
          if (t && !seen[t]) { seen[t] = true; fb.push({ ticker: t, type: 'STOCK' }); }
        }
        return fb;
      }
    } catch (e) {}
    return [];
  }

  function isUsdtBrl(ticker) {
    var t = String(ticker || '').trim().toUpperCase().replace(/[\s_\/]/g, '-');
    return t === 'USDT-BRL' || t === 'USDTBRL';
  }

  // ticker puro -> par Binance. Ex: BNB→BNBUSDT, POL→POLUSDT.
  // USDT-BRL tem par próprio (USDTBRL) e é tratado à parte.
  function cryptoPair(ticker) {
    if (isUsdtBrl(ticker)) return 'USDTBRL';
    var base = String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!base) return null;
    if (/USDT$/.test(base)) return base; // já veio como par
    return base + 'USDT';
  }

  function dispatch(symbol, price, changePct, source) {
    var p = Number(price);
    if (!symbol || !Number.isFinite(p) || p <= 0) return false;
    var ch = Number(changePct);
    try {
      var host = getRoot();
      if (!host || !host.dispatchEvent) return false;
      var Ctor = host.CustomEvent || null;
      if (typeof Ctor !== 'function') return false;
      host.dispatchEvent(new Ctor('estudebitcoin:ticker-price', {
        detail: {
          symbol: String(symbol).trim().toUpperCase(), // TICKER PURO
          price: p,
          changePct: Number.isFinite(ch) ? ch : null, // NUNCA change24h
          source: source === 'websocket' ? 'websocket' : 'snapshot'
        }
      }));
      return true;
    } catch (e) { return false; }
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
    var opts = ctrl ? { signal: ctrl.signal, cache: 'no-store' } : { cache: 'no-store' };
    return fetch(url, opts).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ---- Stocks (batch Worker, chunk 20, match exato) ----
  function refreshStocks(tickers) {
    if (!tickers.length) return Promise.resolve(0);
    var chunks = [];
    for (var i = 0; i < tickers.length; i += CHUNK) chunks.push(tickers.slice(i, i + CHUNK));
    var jobs = chunks.map(function (group) {
      var url = WORKER + '?assets=' + encodeURIComponent(group.join(',')) + '&window=24h';
      return fetchJSON(url).then(function (payload) {
        var list = (payload && Array.isArray(payload.quotes)) ? payload.quotes : [];
        var bySym = {};
        for (var k = 0; k < list.length; k++) {
          var q = list[k] || {};
          bySym[String(q.symbol || '').trim().toUpperCase()] = q;
        }
        var n = 0;
        for (var g = 0; g < group.length; g++) {
          var want = group[g];
          var hit = bySym[want];
          if (!hit) continue; // desconhecido → mantém último, sem dot
          var price = num(hit.price);
          if (price === null || price <= 0) continue;
          var day = num(hit.changePct != null ? hit.changePct : hit.dailyVariation);
          if (dispatch(want, price, day === null ? null : day, 'snapshot')) n++;
        }
        return n;
      }).catch(function () { return 0; });
    });
    return Promise.all(jobs).then(function (ns) {
      var total = 0;
      for (var i = 0; i < ns.length; i++) total += (ns[i] || 0);
      return total;
    });
  }

  // ---- Crypto fallback REST (quando WS ausente/caiu): Binance 24hr ----
  function refreshCryptoFallback(tickers) {
    if (!tickers.length) return Promise.resolve(0);
    var jobs = tickers.map(function (t) {
      var pair = cryptoPair(t);
      if (!pair) return Promise.resolve(false);
      return fetchJSON('https://api.binance.com/api/v3/ticker/24hr?symbol=' + encodeURIComponent(pair))
        .then(function (j) {
          var price = num(j && j.lastPrice);
          if (price === null || price <= 0) return false;
          var day = num(j && j.priceChangePercent);
          return dispatch(t, price, day === null ? null : day, 'snapshot');
        })
        .catch(function () { return false; });
    });
    return Promise.all(jobs).then(function (rs) {
      var n = 0;
      for (var i = 0; i < rs.length; i++) if (rs[i]) n++;
      return n;
    });
  }

  // ---- Backoff WS com jitter (seção 12): base 1s, dobra por falha,
  // teto 30s, jitter 50%-100%. Reseta após 1 mensagem válida. ----
  var WS_BASE_MS = 1000;
  var WS_CAP_MS = 30000;
  var wsFails = 0;
  var reconnectTimer = null;

  function wsDelayFor(fails) {
    var f = Number(fails);
    if (!Number.isFinite(f) || f < 0) f = 0;
    var d = WS_BASE_MS * Math.pow(2, Math.floor(f));
    if (d > WS_CAP_MS) d = WS_CAP_MS;
    var jitter = 0.5 + Math.random() * 0.5;
    return Math.floor(d * jitter);
  }

  function scheduleReconnect() {
    if (!started || reconnectTimer) return;
    var delay = wsDelayFor(wsFails);
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (!started) return;
      wsStreamsKey = '';
      resync();
    }, delay);
  }

  // Handler nomeado (testável): mensagem válida reseta o backoff.
  function handleWsMessage(ev, map) {
    var dispatchedOk = false;
    try {
      var payload = JSON.parse(ev.data);
      var stream = String((payload && payload.stream) || '').replace('@ticker', '');
      var t2 = map[stream];
      var d = payload && payload.data;
      if (t2 && d && typeof d.c !== 'undefined') {
        var p = parseFloat(d.c);
        var ch = parseFloat(d.P);
        dispatchedOk = dispatch(t2, p, Number.isFinite(ch) ? ch : null, 'websocket');
      }
    } catch (e) {}
    if (dispatchedOk) wsFails = 0; // reset do backoff após sucesso
    return dispatchedOk;
  }

  // ---- Crypto WS dinâmico (tick-a-tick, grátis, sem chave) ----
  function connectCryptoWS(cryptoTickers) {
    var uniq = {};
    var pairs = [];
    var map = {}; // pair-lower -> ticker puro
    for (var i = 0; i < cryptoTickers.length; i++) {
      var t = cryptoTickers[i];
      if (uniq[t]) continue;
      uniq[t] = true;
      var pair = cryptoPair(t);
      if (!pair) continue;
      pairs.push(pair.toLowerCase() + '@ticker');
      map[pair.toLowerCase()] = t;
    }
    var key = pairs.slice().sort().join('/');
    // Mesma carteira E conexão viva → mantém (evita duplicar conexão).
    // Se o WS morreu (ws null), reconecta mesmo com chave igual.
    if (key === wsStreamsKey && ws) return;
    closeWS();
    if (!pairs.length) { wsStreamsKey = ''; return; }
    wsStreamsKey = key;
    var url = 'wss://stream.binance.com:9443/stream?streams=' + pairs.join('/');
    var WSCtor = null;
    try {
      var host = getRoot();
      WSCtor = (host && host.WebSocket) || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    } catch (e) {}
    if (typeof WSCtor !== 'function') { wsStreamsKey = ''; return; }
    try { ws = new WSCtor(url); } catch (e) { ws = null; wsStreamsKey = ''; return; }
    ws.onmessage = function (ev) { handleWsMessage(ev, map); };
    ws.onclose = function () {
      ws = null;
      wsFails++;
      scheduleReconnect();
    };
    ws.onerror = function () { try { if (ws) ws.close(); } catch (e) {} };
  }

  function closeWS() {
    try { if (ws) ws.close(); } catch (e) {}
    ws = null;
  }

  function tick() {
    var uni = getUniverse();
    var crypto = [];
    var stocks = [];
    for (var i = 0; i < uni.length; i++) {
      var u = uni[i];
      if (u.type === 'CRYPTO' && !isUsdtBrl(u.ticker)) crypto.push(u.ticker);
      else stocks.push(u.ticker); // STOCK + USDT-BRL via Worker
    }
    connectCryptoWS(crypto);
    var p1 = refreshStocks(stocks);
    // Fallback REST só se WS não cobre (sem WS ou WS caiu): barato e free.
    var p2 = (!ws && crypto.length) ? refreshCryptoFallback(crypto) : Promise.resolve(0);
    return Promise.all([p1, p2]).then(function (ns) {
      var ok = (ns[0] || 0) + (ns[1] || 0);
      failCount = ok > 0 ? 0 : failCount + 1;
      return ok;
    }).catch(function () { failCount++; return 0; });
  }

  // ---- Debounce de resync (seção 13/15): rajada add/edit/delete em
  // ~1s executa 1 tick (1 batch Worker), não N. ----
  var RESYNC_DEBOUNCE_MS = 1000;
  var resyncTimer = null;
  var resyncWaiters = [];

  function resync() {
    try {
      return new Promise(function (resolve) {
        resyncWaiters.push(resolve);
        if (resyncTimer) return;
        resyncTimer = setTimeout(function () {
          resyncTimer = null;
          var waiters = resyncWaiters;
          resyncWaiters = [];
          Promise.resolve(tick()).then(function (n) {
            for (var i = 0; i < waiters.length; i++) {
              try { waiters[i](n); } catch (e) {}
            }
          }).catch(function () {
            for (var j = 0; j < waiters.length; j++) {
              try { waiters[j](0); } catch (e) {}
            }
          });
        }, RESYNC_DEBOUNCE_MS);
      });
    } catch (e) { return Promise.resolve(0); }
  }

  function startPolling() {
    try {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(function () {
        // Backoff simples em falhas HTTP seguidas: pula 1 ciclo a cada 3 falhas.
        if (failCount >= 3) { failCount = 0; return; }
        tick();
      }, POLL_MS);
    } catch (e) {}
  }

  // Visibilidade (seção 12): aba oculta → fecha WS + para polling
  // (economia, sem duplicar conexão); visível → 1 resync (reabre 1 WS).
  function onVisibility(doc) {
    if (!doc) return;
    if (doc.hidden) {
      closeWS();
      try { if (pollTimer) clearInterval(pollTimer); } catch (e) {}
      pollTimer = null;
    } else if (started) {
      startPolling();
      resync();
    }
  }

  function start() {
    if (started) return;
    started = true;
    try { tick(); } catch (e) {}
    startPolling();
    try {
      var doc = typeof document !== 'undefined' ? document : null;
      if (doc && doc.addEventListener) {
        doc.addEventListener('visibilitychange', function () { onVisibility(doc); });
      }
    } catch (e) {}
  }

  function stop() {
    started = false;
    try { if (pollTimer) clearInterval(pollTimer); } catch (e) {}
    pollTimer = null;
    try { if (reconnectTimer) clearTimeout(reconnectTimer); } catch (e) {}
    reconnectTimer = null;
    try { if (resyncTimer) clearTimeout(resyncTimer); } catch (e) {}
    resyncTimer = null;
    resyncWaiters = [];
    closeWS();
    wsStreamsKey = '';
  }

  var api = {
    start: start,
    stop: stop,
    resync: resync,
    // Superfície de teste (sem efeito no comportamento normal).
    _test: {
      getUniverse: getUniverse,
      cryptoPair: cryptoPair,
      isUsdtBrl: isUsdtBrl,
      dispatch: dispatch,
      refreshStocks: refreshStocks,
      refreshCryptoFallback: refreshCryptoFallback,
      getStreamsKey: function () { return wsStreamsKey; },
      wsDelayFor: wsDelayFor,
      getWsFails: function () { return wsFails; },
      handleWsMessage: handleWsMessage,
      onVisibility: onVisibility,
      isWsOpen: function () { return !!ws; }
    }
  };

  var host = getRoot();
  if (host) host.PortfolioLive = api;
  if (typeof module === 'object' && module.exports && typeof module.exports === 'object') {
    module.exports = api;
  }

  // Auto-start após boot (painel-ativos-ui é defer; espera até 10s).
  try {
    var tries = 0;
    var bootTimer = setInterval(function () {
      tries++;
      var ok = false;
      try {
        var h = getRoot();
        ok = !!(h && h.PainelAtivos && typeof h.PainelAtivos.getService === 'function');
      } catch (e) {}
      if (ok || tries >= 20) {
        try { clearInterval(bootTimer); } catch (e) {}
        if (ok) start();
      }
    }, 500);
  } catch (e) {}
})();
