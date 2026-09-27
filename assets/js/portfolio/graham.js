/* =====================================================================
   EstudeBitcoin — Graham (Preço Justo de Benjamin Graham)
   ---------------------------------------------------------------------
   Preço Justo = sqrt(22.5 × LPA × VPA), onde LPA = lucro por ação (EPS)
   e VPA = valor patrimonial por ação (book value per share).

   - calcularPrecoJustoGraham(lpa, vpa): PURA. Retorna null se LPA ou VPA
     ausentes, não-finitos ou <= 0 (a fórmula não vale com negativos —
     nunca "finge" resultado).
   - getFundamentals(ticker): busca LPA/VPA via Worker próprio
     (/api/fundamentals, com token brapi no secret) com fallback para a
     brapi anônima (só LPA, sem VPA). Cache em memória com TTL de 24h.
     Nunca persiste, nunca toca a carteira (feature aditiva).
   - open(ticker, opts): modal GENÉRICO de detalhe — aceita qualquer
     ticker (carteira, cards de STOCKS ou busca avulsa). Compara o preço
     atual com o justo: subvalorizado / sobrevalorizado / justo (~).
   ===================================================================== */
(function () {
  'use strict';

  function getRoot() {
    try {
      if (typeof globalThis !== 'undefined') return globalThis;
    } catch (e) {}
    return null;
  }

  var WORKER = 'https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/api/fundamentals';
  var WORKER_SEARCH = 'https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/api/tickers/search';
  var BRAPI_ANON = 'https://brapi.dev/api/quote/';
  var CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  var VERDICT_TOLERANCE = 0.02; // ±2% = "preço justo"
  var TIMEOUT_MS = 10000;

  var cache = {}; // ticker -> {data, at}
  // PENDÊNCIA (pausado por decisão): persistência em nuvem/servidor dos
  // fundamentos/histórico. Hoje é só memória local (some ao fechar a página).
  // Retomar depois — sem implementar por enquanto.
  var usdBrlRate = null; // p/ converter justo BRL -> USD na comparação

  /* ---------- 1. Função pura ---------- */

  function calcularPrecoJustoGraham(lpa, vpa) {
    var l = Number(lpa);
    var v = Number(vpa);
    if (!Number.isFinite(l) || !Number.isFinite(v)) return null;
    if (l <= 0 || v <= 0) return null;
    var fair = Math.sqrt(22.5 * l * v);
    if (!Number.isFinite(fair) || fair <= 0) return null;
    return fair;
  }

  function verdict(currentPrice, fairPrice) {
    var c = Number(currentPrice);
    var f = Number(fairPrice);
    if (!Number.isFinite(c) || !Number.isFinite(f) || c <= 0 || f <= 0) return null;
    var ratio = c / f;
    if (ratio < 1 - VERDICT_TOLERANCE) return 'subvalorizado';
    if (ratio > 1 + VERDICT_TOLERANCE) return 'sobrevalorizado';
    return 'justo';
  }

  /* ---------- 2. Símbolos ---------- */

  function normTicker(t) {
    return String(t == null ? '' : t).trim().toUpperCase().replace(/[\s_\/]/g, '-');
  }

  // B3: PETR4, VALE3, ITUB4... (4 letras + dígito). EUA: AAPL, NVDA...
  function looksB3(t) {
    return /^[A-Z]{4}\d{1,2}(-UNIT)?$/.test(String(t || ''));
  }

  /* ---------- 3. Busca de fundamentos ---------- */

  function fetchJSON(url) {
    var ctrl = null;
    var timer = null;
    try {
      if (typeof AbortController !== 'undefined') {
        ctrl = new AbortController();
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, TIMEOUT_MS);
      }
    } catch (e) {}
    return fetch(url, ctrl ? { signal: ctrl.signal, cache: 'no-store' } : { cache: 'no-store' }).then(function (res) {
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

  // Mapeia o payload (Worker normalizado OU brapi crua) p/ {lpa, vpa, ...}.
  // A brapi usa earningsPerShare (LPA); VPA vem no modo fundamental.
  function mapPayload(ticker, payload, source) {
    if (!payload || typeof payload !== 'object') return null;
    var q = payload;
    if (q && typeof q === 'object' && !('earningsPerShare' in q) && !('lpa' in q)) {
      if (Array.isArray(q.results) && q.results[0]) q = q.results[0];
      else if (q.quote && typeof q.quote === 'object') q = q.quote;
    }
    var lpa = num(q.lpa != null ? q.lpa : q.earningsPerShare);
    var vpa = num(
      q.vpa != null ? q.vpa
        : q.bookValuePerShare != null ? q.bookValuePerShare
        : q.bookValue != null ? q.bookValue
        : q.bvps != null ? q.bvps
        : q.valorPatrimonialPorAcao
    );
    var price = num(q.price != null ? q.price : q.regularMarketPrice);
    var currency = String(q.currency || '').trim().toUpperCase() || null;
    var name = q.name || q.longName || q.shortName || null;
    if (typeof name !== 'string' || !name.trim()) name = null;
    return {
      ticker: ticker,
      name: name && name.trim(),
      lpa: lpa,
      vpa: vpa,
      price: price,
      currency: currency,
      source: source || q.source || null,
      fetchedAt: q.fetchedAt || new Date().toISOString()
    };
  }

  function getCached(ticker) {
    var hit = cache[ticker];
    if (!hit) return null;
    if ((Date.now() - hit.at) > CACHE_TTL_MS) { delete cache[ticker]; return null; }
    return hit.data;
  }

  // Resolve nome da empresa -> ticker (catálogo B3 via Worker). Retorna
  // {ticker, name} do primeiro resultado ou null.
  function resolveTicker(rawName) {
    var q = String(rawName == null ? '' : rawName).trim();
    if (q.length < 2) return Promise.resolve(null);
    return fetchJSON(WORKER_SEARCH + '?name=' + encodeURIComponent(q))
      .then(function (payload) {
        var list = payload && Array.isArray(payload.results) ? payload.results : [];
        for (var i = 0; i < list.length; i++) {
          var t = normTicker(list[i] && list[i].ticker).replace(/-/g, '');
          if (t) return { ticker: t, name: list[i].name || null };
        }
        return null;
      })
      .catch(function () { return null; });
  }

  function getFundamentals(rawTicker) {
    var ticker = normTicker(rawTicker);
    if (!ticker) return Promise.resolve(null);
    var hit = getCached(ticker);
    if (hit) return Promise.resolve(hit);
    // 1) Worker próprio (com token brapi no secret: LPA + VPA, B3 e EUA).
    return fetchJSON(WORKER + '?symbol=' + encodeURIComponent(ticker))
      .then(function (payload) {
        var data = mapPayload(ticker, payload, 'worker');
        if (data && (data.lpa != null || data.vpa != null)) {
          cache[ticker] = { data: data, at: Date.now() };
          return data;
        }
        throw new Error('sem fundamentos no worker');
      })
      .catch(function () {
        // 2) Fallback: brapi anônima (B3, só LPA — sem VPA o Graham
        // retorna null e o modal explica; nunca finge resultado).
        var b3 = ticker.replace(/-/g, '');
        return fetchJSON(BRAPI_ANON + encodeURIComponent(b3))
          .then(function (payload) {
            var data = mapPayload(ticker, payload, 'brapi-anon');
            if (data && data.lpa != null) {
              cache[ticker] = { data: data, at: Date.now() };
              return data;
            }
            return null;
          })
          .catch(function () { return null; });
      });
  }

  /* ---------- 4. Moeda ---------- */

  // Taxa USD/BRL p/ comparar justo (BRL) com preço atual (USD).
  // Vem do mesmo evento dos cards; até chegar, sem conversão.
  function onTickerPrice(ev) {
    try {
      var d = ev && ev.detail;
      if (!d) return;
      var s = String(d.symbol || '').trim().toUpperCase().replace(/[\s_\/]/g, '-');
      var p = Number(d.price);
      if ((s === 'USDT-BRL' || s === 'USDTBRL') && Number.isFinite(p) && p > 0) usdBrlRate = p;
    } catch (e) {}
  }

  function toUSD(value, currency) {
    var v = Number(value);
    if (!Number.isFinite(v)) return null;
    if (!currency || currency === 'USD') return v;
    if (currency === 'BRL' && usdBrlRate) return v / usdBrlRate;
    return null; // outra moeda ou sem taxa: sem conversão
  }

  /* ---------- 5. Formatação ---------- */

  function fmtMoney(v, currency) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    var prefix = currency === 'BRL' ? 'R$ ' : '$ ';
    var sign = v < 0 ? '-' : '';
    return sign + prefix + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var ICON_SCALE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18"/><path d="M5 7h14"/><path d="M7 7l-3 6a3.5 3.5 0 0 0 6 0L7 7z"/><path d="M17 7l-3 6a3.5 3.5 0 0 0 6 0l-3-6z"/><path d="M8 21h8"/></svg>';

  /* ---------- 6. Modal genérico ---------- */

  var overlay = null;

  function closeModal() {
    try {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    } catch (e) {}
    overlay = null;
    try {
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('keydown', onKeyDown);
      }
    } catch (e) {}
  }

  function onKeyDown(ev) {
    if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) closeModal();
  }

  function verdictChip(v) {
    if (v === 'subvalorizado') return '<span class="gb-chip gb-sub">▼ SUBVALORIZADO</span>';
    if (v === 'sobrevalorizado') return '<span class="gb-chip gb-sobre">▲ SOBREVALORIZADO</span>';
    if (v === 'justo') return '<span class="gb-chip gb-justo">≈ PREÇO JUSTO</span>';
    return '';
  }

  function renderBody(ticker, fund, currentPrice) {
    var fair = fund ? calcularPrecoJustoGraham(fund.lpa, fund.vpa) : null;
    var fairCur = fund && fund.currency ? fund.currency : null;
    var fairUSD = fair != null ? toUSD(fair, fairCur) : null;
    var curUSD = toUSD(currentPrice, 'USD');
    var v = (curUSD != null && fairUSD != null) ? verdict(curUSD, fairUSD) : null;

    var html = '';
    html += '<div class="gb-rows">';
    // LPA/VPA zerados (ex.: brapi EUA devolve 0 como placeholder) valem
    // como ausentes na exibição — a fórmula já os rejeita no cálculo.
    var showLpa = fund && fund.lpa != null && fund.lpa > 0;
    var showVpa = fund && fund.vpa != null && fund.vpa > 0;
    html += '<div class="gb-row"><span>LPA — lucro por ação</span><strong>' + (showLpa ? esc(fmtMoney(fund.lpa, fairCur)) : '—') + '</strong></div>';
    html += '<div class="gb-row"><span>VPA — valor patrimonial por ação</span><strong>' + (showVpa ? esc(fmtMoney(fund.vpa, fairCur)) : '—') + '</strong></div>';
    html += '<div class="gb-row gb-total"><span>Preço justo (Graham)</span><strong>' + (fair != null ? esc(fmtMoney(fair, fairCur)) : '—') + '</strong></div>';
    if (fair != null && fairCur && fairCur !== 'USD' && fairUSD != null) {
      html += '<div class="gb-row"><span>Preço justo em USD</span><strong>' + esc(fmtMoney(fairUSD, 'USD')) + '</strong></div>';
    }
    html += '<div class="gb-row"><span>Preço atual</span><strong>' + (curUSD != null ? esc(fmtMoney(curUSD, 'USD')) : '—') + '</strong></div>';
    html += '</div>';

    if (v) {
      html += '<div class="gb-verdict">' + verdictChip(v) + '</div>';
      if (v === 'subvalorizado') html += '<p class="gb-note">O preço atual está abaixo do preço justo calculado: possível subvalorização.</p>';
      else if (v === 'sobrevalorizado') html += '<p class="gb-note">O preço atual está acima do preço justo calculado: possível sobrevalorização.</p>';
      else html += '<p class="gb-note">O preço atual está próximo (±2%) do preço justo calculado.</p>';
    } else if (fair != null && curUSD == null) {
      html += '<p class="gb-note">Sem preço atual disponível para comparar.</p>';
    } else {
      html += '<p class="gb-note">Dados insuficientes para o cálculo (LPA e VPA precisam ser positivos). ' +
        'Isso é comum em criptoativos e empresas com prejuízo ou patrimônio líquido negativo.</p>';
    }

    html += '<p class="gb-src">Fonte: ' + esc((fund && fund.source) || '—') +
      (fund && fund.fetchedAt ? ' · ' + esc(new Date(fund.fetchedAt).toLocaleString('pt-BR')) : '') + '</p>';
    return html;
  }

  // Abre o modal p/ QUALQUER ticker. opts: {price (atual, USD), autoPrice=true,
  // onDone(resultado)} — onDone é opcional e só informa o resultado
  // {ticker, fund, fair, fairUSD, current} p/ camadas de exibição
  // (ex.: histórico de sessão). Não altera modal nem cálculo.
  // Se price não vier, tenta o preço que acompanha os fundamentos.
  function open(rawTicker, opts) {
    var ticker = normTicker(rawTicker);
    if (!ticker || typeof document === 'undefined' || !document.body) return;
    opts = opts || {};
    closeModal();

    overlay = document.createElement('div');
    overlay.className = 'gb-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Preço justo de ' + ticker);
    overlay.innerHTML =
      '<div class="gb-card">' +
        '<div class="gb-head"><span class="gb-ico">' + ICON_SCALE + '</span>' +
        '<div><h3>Preço Justo do Ativo ' + esc(ticker) + ' segundo Fórmula de Benjamin Graham</h3>' +
        '<p class="gb-sub">√(22,5 × LPA × VPA) — valor intrínseco estimado a partir do lucro e do patrimônio por ação. Conteúdo educativo, não é recomendação de investimento.</p></div>' +
        '<button type="button" class="gb-close" aria-label="Fechar">✕</button></div>' +
        '<div class="gb-body"><p class="gb-loading">Buscando fundamentos…</p></div>' +
      '</div>';
    document.body.appendChild(overlay);

    var card = overlay.querySelector('.gb-card');
    var body = overlay.querySelector('.gb-body');
    overlay.querySelector('.gb-close').addEventListener('click', closeModal);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) closeModal(); });
    document.addEventListener('keydown', onKeyDown);
    if (card) card.addEventListener('click', function (ev) { ev.stopPropagation(); });

    var optPrice = Number(opts.price);
    getFundamentals(ticker).then(function (fund) {
      if (!overlay) return; // fechado durante o fetch
      var current = Number.isFinite(optPrice) && optPrice > 0 ? optPrice
        : (fund && fund.price > 0 ? (fund.currency === 'BRL' ? toUSD(fund.price, 'BRL') : fund.price) : null);
      // Preço vindo dos fundamentos em BRL é convertido p/ USD p/ comparar.
      body.innerHTML = renderBody(ticker, fund, current);
      // Nome da empresa (longName/shortName da fonte) como subtítulo.
      if (fund && fund.name) {
        try {
          var h3 = overlay.querySelector('.gb-head h3');
          if (h3 && !overlay.querySelector('.gb-name')) {
            var nm = document.createElement('p');
            nm.className = 'gb-name';
            nm.textContent = fund.name;
            h3.parentNode.insertBefore(nm, h3.nextSibling);
          }
        } catch (e) {}
      }
      if (opts.onDone) {
        try {
          var f2 = fund ? calcularPrecoJustoGraham(fund.lpa, fund.vpa) : null;
          opts.onDone({
            ticker: ticker,
            fund: fund,
            fair: f2,
            fairUSD: f2 != null ? toUSD(f2, fund && fund.currency) : null,
            current: current
          });
        } catch (e) {}
      }
    }).catch(function () {
      if (!overlay) return;
      body.innerHTML = '<p class="gb-note">Não foi possível carregar os fundamentos agora. Tente novamente.</p>';
    });
  }

  /* ---------- 7. Nuvem (histórico por usuário logado) ----------
     SOMENTE quem tem login (id && !anonymous). Anônimo: só memória da
     sessão, sem localStorage, sem nuvem. Caminho:
     users/{uid}/panels/graham (herda as rules por dono já existentes).
     Tudo silencioso: falha de rede/permissão nunca quebra a consulta. */

  var GrahamCloud = (function () {
    var MAX_ITEMS = 50;
    var PUSH_DEBOUNCE_MS = 2000;
    var cbs = null; // {getHistory, setHistory}
    var uid = null;
    var pulledUid = null;
    var pushTimer = null;
    var listening = false;

    function authedUid() {
      try {
        var host = getRoot();
        var u = host && host.EstudeAuth && host.EstudeAuth.getUser ? host.EstudeAuth.getUser() : null;
        if (u && u.id && !u.anonymous) return String(u.id);
      } catch (e) {}
      return null;
    }

    function dbRef(id) {
      try {
        var host = getRoot();
        if (!id || !host || !host.firebase || !host.firebase.apps ||
            !host.firebase.apps.length || !host.firebase.database) return null;
        return host.firebase.database().ref('users/' + id + '/panels/graham');
      } catch (e) { return null; }
    }

    function cleanItems(list) {
      var out = [];
      if (!Array.isArray(list)) return out;
      for (var i = 0; i < list.length && out.length < MAX_ITEMS; i++) {
        var h = list[i];
        if (!h || typeof h !== 'object') continue;
        var t = String(h.ticker || '').trim().toUpperCase();
        if (!t) continue;
        var cur = Number(h.currentUSD);
        var fair = Number(h.fairUSD);
        var brl = Number(h.fairBRL);
        out.push({
          ticker: t,
          name: (typeof h.name === 'string' && h.name.trim()) ? h.name.trim().slice(0, 80) : null,
          currentUSD: (Number.isFinite(cur) && cur > 0) ? cur : null,
          fairBRL: (Number.isFinite(brl) && brl > 0) ? brl : null,
          fairUSD: (Number.isFinite(fair) && fair > 0) ? fair : null,
          upside: (function () {
            var u = Number(h.upside);
            return Number.isFinite(u) ? u : null;
          })(),
          at: (typeof h.at === 'string' && h.at) ? h.at : new Date().toISOString()
        });
      }
      return out;
    }

    function doPush() {
      pushTimer = null;
      try {
        var id = authedUid();
        if (!id || !cbs) return;
        var ref = dbRef(id);
        if (!ref) return;
        var items = cleanItems(cbs.getHistory ? cbs.getHistory() : []);
        ref.set({ items: items, updatedAt: new Date().toISOString() }).catch(function () {});
      } catch (e) {}
    }

    function pushSoon() {
      try {
        if (!authedUid()) return; // anônimo: nada a persistir
        if (pushTimer) { try { clearTimeout(pushTimer); } catch (e) {} }
        pushTimer = setTimeout(doPush, PUSH_DEBOUNCE_MS);
      } catch (e) {}
    }

    function pull() {
      try {
        var id = authedUid();
        if (!id || !cbs) return;
        if (pulledUid === id) return; // já sincronizado p/ este uid
        var ref = dbRef(id);
        if (!ref) return;
        ref.once('value').then(function (snap) {
          try {
            var val = snap && snap.val ? snap.val() : null;
            var items = cleanItems(val && val.items);
            pulledUid = id;
            if (cbs.setHistory) cbs.setHistory(items);
          } catch (e) {}
        }).catch(function () {});
      } catch (e) {}
    }

    // Troca de sessão: logou (authed) → pull; deslogou/anonimizou → limpa
    // a visão local (não vaza histórico entre contas).
    function onAuthChange(user) {
      try {
        var id = (user && user.id && !user.anonymous) ? String(user.id) : null;
        uid = id;
        if (!id) {
          pulledUid = null;
          if (pushTimer) { try { clearTimeout(pushTimer); } catch (e) {} pushTimer = null; }
          if (cbs && cbs.setHistory) cbs.setHistory([]);
          return;
        }
        pull();
      } catch (e) {}
    }

    function init(callbacks) {
      cbs = callbacks || null;
      try {
        var host = getRoot();
        if (!listening && host) {
          var target = null;
          try {
            var w = host.window || null;
            target = (w && typeof w.addEventListener === 'function') ? w : null;
            if (!target && typeof host.addEventListener === 'function') target = host;
            if (!target && typeof document !== 'undefined' && document.addEventListener) target = document;
          } catch (e) {}
          if (target) {
            target.addEventListener('estudebitcoin:auth-change', function (ev) {
              onAuthChange(ev && ev.detail && ev.detail.user);
            });
            listening = true;
          }
        }
      } catch (e) {}
      // Já logado no boot (sessão restaurada): puxa direto.
      try { if (authedUid()) pull(); } catch (e) {}
      return api.Cloud;
    }

    return {
      init: init,
      pushSoon: pushSoon,
      pull: pull,
      onAuthChange: onAuthChange,
      _test: {
        cleanItems: cleanItems,
        authedUid: authedUid,
        reset: function () { uid = null; pulledUid = null; cbs = null; listening = false; if (pushTimer) { try { clearTimeout(pushTimer); } catch (e) {} } pushTimer = null; }
      }
    };
  })();

  var api = {
    calcularPrecoJustoGraham: calcularPrecoJustoGraham,
    verdict: verdict,
    getFundamentals: getFundamentals,
    resolveTicker: resolveTicker,
    open: open,
    close: closeModal,
    Cloud: GrahamCloud,
    // Superfície de teste (sem efeito no comportamento normal).
    _test: {
      mapPayload: mapPayload,
      normTicker: normTicker,
      looksB3: looksB3,
      toUSD: toUSD,
      setRate: function (r) { usdBrlRate = r; },
      clearCache: function () { cache = {}; }
    }
  };

  var host = getRoot();
  if (host) {
    host.Graham = api;
    try {
      var w = host.window || null;
      var target = (w && typeof w.addEventListener === 'function') ? w : host;
      if (target && typeof target.addEventListener === 'function') {
        target.addEventListener('estudebitcoin:ticker-price', onTickerPrice);
      }
    } catch (e) {}
  }
  if (typeof module === 'object' && module.exports && typeof module.exports === 'object') {
    module.exports = api;
  }
})();
