/* =====================================================================
   EstudeBitcoin — FirebasePortfolio RTDB (FASE 2, pivot custo zero)
   ---------------------------------------------------------------------
   Adapter REMOTO sobre o RTDB EXISTENTE (mural-bitcoiniciantes, Spark).
   Sem Firestore, sem Functions, sem Blaze. Mesma interface do adapter
   anterior, para a UI não mudar:
     { load, add, update, remove, removeLot, migrateLocal, clearLocal,
       isConfigured, friendlyError, currentUid }

   Atomicidade: TODA mutação passa por UMA transação na raiz
   `users/{uid}/carteira`, calculada por funções puras (op*) testáveis
   em Node. Concorrência entre abas = retry automático do SDK.

   Formato UI (Fase 1): { id, ticker, name, type, quantity,
   averagePrice, currentPrice, dailyVariation, closedAt?, demo:false }
   Formato nuvem: { ticker, name, type(crypto|stock), quantity,
   avgPrice, currentPrice, manualPrice, priceSource, dailyChangePercent,
   createdAt?, updatedAt?, closedAt?, lots: { lotId: {quantity, price,
   avgPrice?, date} } }
   ===================================================================== */
(function () {
  'use strict';

  /* ---------- util puro ---------- */
  function numSafe(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
  }

  // parseNumber pt-BR: "77.800,00" → 77800, "0,1" → 0.1, "67000.5" → 67000.5.
  // O form entrega strings; o adapter normaliza antes de validar/gravar.
  function parseNumber(v, def) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : (def != null ? def : 0);
    var s = String(v == null ? '' : v).trim();
    if (!s) return def != null ? def : 0;
    if (s.indexOf(',') !== -1) s = s.replace(/\./g, '').replace(',', '.');
    var n = Number(s);
    if (!Number.isFinite(n)) return def != null ? def : 0;
    return n;
  }

  function normTicker(t) {
    return String(t == null ? '' : t).trim().toUpperCase().replace(/\//g, '-');
  }

  function normType(t) {
    var s = String(t == null ? '' : t).trim().toLowerCase();
    if (s === 'crypto') return 'crypto';
    if (s === 'stock') return 'stock';
    return null;
  }

  function clone(o) {
    return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
  }

  // quantity > 0 ? médio ponderado : mantém (venda não mexe no custo).
  function mergeInto(eq, eavg, nq, navg) {
    var newQty = eq + nq;
    var newAvg = newQty > 0 ? (eq * eavg + nq * navg) / newQty : eavg;
    if (!Number.isFinite(newAvg)) newAvg = eavg;
    return { quantity: newQty, averagePrice: newAvg };
  }

  function newLotId() {
    try {
      if (typeof Math !== 'undefined' && Math.random) {
        return 'lot_' + Date.now().toString(36) + '_' +
          Math.random().toString(36).slice(2, 8);
      }
    } catch (e) {}
    return 'lot_' + Date.now();
  }

  /* ---------- ops puras: (carteira, args, now) -> {carteira} | {error} ---
     `now` é número (Date.now()) para testes determinísticos. */

  function blankCarteira() {
    return { currency: 'USD', assets: {} };
  }

  // input: {ticker,name,type,quantity,purchasePrice,currentPrice,dailyVariation}
  // quantity > 0 compra, < 0 venda, 0 rejeitado.
  function opAddAsset(cart, input, now) {
    var c = clone(cart) || blankCarteira();
    if (!c.assets || typeof c.assets !== 'object') c.assets = {};
    var ticker = normTicker(input && input.ticker);
    var type = normType(input && input.type);
    var name = String((input && input.name) || '').trim();
    var q = parseNumber(input && input.quantity, NaN);
    var pp = parseNumber(input && input.purchasePrice, NaN);
    var cp = parseNumber(input && input.currentPrice, NaN);
    var dv = parseNumber(input && input.dailyVariation, 0);
    if (!ticker) return { error: 'ticker inválido' };
    if (!name) return { error: 'name inválido' };
    if (!type) return { error: 'type inválido: use crypto ou stock' };
    if (!Number.isFinite(q) || q === 0) return { error: 'quantity deve ser diferente de zero' };
    if (!Number.isFinite(pp) || pp < 0) return { error: 'purchasePrice inválido' };
    if (!Number.isFinite(cp) || cp < 0) return { error: 'currentPrice inválido' };
    if (!Number.isFinite(dv)) return { error: 'dailyVariation inválida' };

    var cur = c.assets[ticker] || null;
    if (!cur) {
      if (q < 0) return { error: 'Não é possível vender um ativo inexistente.' };
      c.assets[ticker] = {
        ticker: ticker, name: name, type: type,
        quantity: q, avgPrice: pp,
        currentPrice: cp, manualPrice: cp, priceSource: 'manual',
        dailyChangePercent: dv, createdAt: now, updatedAt: now,
        lots: {}
      };
      c.assets[ticker].lots[newLotId()] = { quantity: q, price: pp, date: now };
      return { carteira: c, action: 'created', ticker: ticker };
    }

    var eq = numSafe(cur.quantity);
    var eavg = numSafe(cur.avgPrice);
    var newQty = eq + q;
    if (newQty < 0) return { error: 'Saldo insuficiente: a venda supera a quantidade em carteira.' };

    var avg = eavg;
    if (q > 0) avg = mergeInto(eq, eavg, q, pp).averagePrice;
    cur.quantity = newQty;
    cur.avgPrice = newQty === 0 ? 0 : avg;
    cur.name = name;
    cur.type = type;
    cur.currentPrice = cp;
    cur.manualPrice = cp;
    cur.dailyChangePercent = dv;
    cur.updatedAt = now;
    if (!cur.lots || typeof cur.lots !== 'object') cur.lots = {};
    if (newQty === 0) {
      cur.closedAt = now;
    } else if (cur.closedAt) {
      delete cur.closedAt;
    }
    var lot = { quantity: q, price: pp, date: now };
    if (q < 0) lot.avgPrice = eavg;
    cur.lots[newLotId()] = lot;
    c.assets[ticker] = cur;
    return {
      carteira: c,
      action: newQty === 0 ? 'closed' : (q < 0 ? 'sold' : 'updated'),
      ticker: ticker,
      quantity: newQty,
      avgPrice: cur.avgPrice
    };
  }

  // changes: {name,type,currentPrice,dailyVariation} — nunca quantity/avgPrice.
  function opUpdateAsset(cart, ticker, changes, now) {
    var c = clone(cart) || blankCarteira();
    var t = normTicker(ticker);
    var cur = (c.assets || {})[t];
    if (!cur) return { error: 'Ativo não encontrado.' };
    var name = String((changes && changes.name) || '').trim();
    var type = normType(changes && changes.type);
    var cp = parseNumber(changes && changes.currentPrice, NaN);
    var dv = parseNumber(changes && changes.dailyVariation, 0);
    if (!name) return { error: 'name inválido' };
    if (!type) return { error: 'type inválido' };
    if (!Number.isFinite(cp) || cp < 0) return { error: 'currentPrice inválido' };
    cur.name = name;
    cur.type = type;
    cur.currentPrice = cp;
    cur.manualPrice = cp;
    cur.dailyChangePercent = dv;
    cur.updatedAt = now;
    c.assets[t] = cur;
    return { carteira: c, ticker: t };
  }

  function opRemoveAsset(cart, ticker) {
    var c = clone(cart) || blankCarteira();
    var t = normTicker(ticker);
    if (!((c.assets || {})[t])) return { error: 'Ativo não encontrado.' };
    delete c.assets[t];
    return { carteira: c, ticker: t };
  }

  function opRemoveLot(cart, ticker, lotId, now) {
    var c = clone(cart) || blankCarteira();
    var t = normTicker(ticker);
    var cur = (c.assets || {})[t];
    if (!cur) return { error: 'Ativo não encontrado.' };
    var lots = cur.lots && typeof cur.lots === 'object' ? cur.lots : {};
    if (!lots[lotId]) return { error: 'Lote não encontrado.' };
    var restantes = Object.keys(lots)
      .filter(function (k) { return k !== lotId; })
      .map(function (k) { return lots[k]; });
    var quantity = 0, qtdPos = 0, custoPos = 0;
    for (var i = 0; i < restantes.length; i++) {
      var l = restantes[i] || {};
      var lq = numSafe(l.quantity);
      quantity += lq;
      if (lq > 0) { qtdPos += lq; custoPos += lq * numSafe(l.price); }
    }
    if (quantity < 0) return { error: 'Remoção deixaria saldo negativo.' };
    delete lots[lotId];
    cur.quantity = quantity;
    cur.avgPrice = qtdPos > 0 ? custoPos / qtdPos : 0;
    if (!Number.isFinite(cur.avgPrice)) cur.avgPrice = 0;
    cur.updatedAt = now;
    if (quantity === 0) cur.closedAt = now;
    else if (cur.closedAt) delete cur.closedAt;
    cur.lots = lots;
    c.assets[t] = cur;
    return { carteira: c, ticker: t, lotId: lotId };
  }

  // itens: [{ticker,name,type,quantity,purchasePrice,currentPrice,dailyVariation}]
  function opMigrate(cart, itens, currency, now) {
    var c = clone(cart);
    var already = !!(c && c.localMigrationCompleted === true);
    if (already) return { status: 'already_migrated', carteira: c };
    if (!c || typeof c !== 'object') c = blankCarteira();
    if (!c.assets || typeof c.assets !== 'object') c.assets = {};
    var seen = {};
    for (var i = 0; i < itens.length; i++) {
      var it = itens[i] || {};
      var t = normTicker(it.ticker);
      if (!t || seen[t]) return { error: 'Ticker duplicado na migração: ' + (it.ticker || '?') };
      seen[t] = true;
      if (!(Number(it.quantity) > 0)) {
        return { error: 'Item "' + (it.ticker || '?') + '": quantity deve ser maior que zero na migração.' };
      }
    }
    if (Object.keys(c.assets).length > 0) {
      return { status: 'remote_exists', carteira: c };
    }
    if (itens.length > 200) return { error: 'A migração permite no máximo 200 ativos por operação.' };
    for (var j = 0; j < itens.length; j++) {
      var m = itens[j];
      var tt = normTicker(m.ticker);
      var ty = normType(m.type) || 'crypto';
      c.assets[tt] = {
        ticker: tt,
        name: String(m.name || tt).trim() || tt,
        type: ty,
        quantity: Number(m.quantity),
        avgPrice: Number(m.purchasePrice) || 0,
        currentPrice: Number(m.currentPrice) || 0,
        manualPrice: Number(m.currentPrice) || 0,
        priceSource: 'manual',
        dailyChangePercent: Number(m.dailyVariation == null ? 0 : m.dailyVariation),
        createdAt: now, updatedAt: now,
        lots: {}
      };
      c.assets[tt].lots['mig_' + tt] = {
        quantity: Number(m.quantity), price: Number(m.purchasePrice) || 0, date: now
      };
    }
    var cur2 = (typeof currency === 'string' && currency.trim())
      ? currency.trim().slice(0, 8) : (c.currency || 'USD');
    c.currency = cur2;
    c.localMigrationCompleted = true;
    c.localMigrationAt = now;
    return { status: 'migrated', itens: itens.length, carteira: c };
  }

  /* ---------- SDK ---------- */
  function getRoot() {
    try {
      if (typeof globalThis !== 'undefined') return globalThis;
    } catch (e) {}
    return null;
  }

  function cfg() {
    var host = getRoot();
    return (host && host.BI_CONFIG && host.BI_CONFIG.firebase) || {};
  }

  function isConfigured() {
    var c = cfg();
    return !!(c.apiKey && c.authDomain && c.databaseURL);
  }

  function db() {
    var host = getRoot();
    if (!host || !host.firebase || !host.firebase.apps || !host.firebase.apps.length) {
      throw new Error('Firebase não inicializado.');
    }
    return host.firebase.database();
  }

  function online() {
    try {
      var host = getRoot();
      if (host && host.navigator && typeof host.navigator.onLine === 'boolean') {
        return host.navigator.onLine;
      }
    } catch (e) {}
    return true;
  }

  function offlineErr() {
    var e = new Error('Sem conexão. Não foi possível salvar a alteração.');
    e.code = 'offline';
    return e;
  }

  // UID sempre da fonte viva (sessão real do SDK), nunca só de cache:
  // com anônimos duplicados, caches podiam apontar para UID velho e as
  // escritas caíam em permission-denied no UID errado.
  function currentUid() {
    var host = getRoot();
    try {
      if (host && host.firebase && host.firebase.apps && host.firebase.apps.length &&
          host.firebase.auth) {
        var fu = host.firebase.auth().currentUser;
        if (fu && fu.uid) return fu.uid;
      }
    } catch (e) {}
    try {
      if (host && host.EstudeAuth && host.EstudeAuth.getUser) {
        var u = host.EstudeAuth.getUser();
        if (u && u.id) return u.id;
      }
    } catch (e) {}
    return null;
  }

  function friendlyError(err) {
    if (!err) return 'Não foi possível concluir. Tente de novo.';
    if (err.code === 'offline' || err.code === 'timeout') return err.message;
    var m = String(err.message || err);
    if (/permission.?denied|permission_denied/i.test(m)) {
      return 'Sem permissão. Entre novamente.';
    }
    if (/disponível|saldo|não encontrado|inválido|excede|limite/i.test(m)) return m;
    if (/network|unavailable|disconnect/i.test(m)) {
      return 'Servidor indisponível. Tente novamente.';
    }
    return m || 'Não foi possível concluir. Tente de novo.';
  }

  function cartRef(uid) {
    return db().ref('users/' + uid + '/carteira');
  }

  // Cache quente para transações: sem listener ativo no path, a primeira
  // invocação do callback de ref.transaction() recebe current = null e
  // operações que exigem o ativo (venda, exclusão) abortam em definitivo
  // com "não existe" — mesmo com o dado no servidor. O listener noop
  // mantém o SyncTree sincronizado; leituras once() não fazem isso.
  var warmRef = null;
  var warmUid = null;
  function noopListener() {}

  function warmup(uid) {
    try {
      if (!uid) return false;
      if (warmRef && warmUid === uid) return true;
      coolDown();
      var host = getRoot();
      if (!host || !host.firebase || !host.firebase.apps ||
          !host.firebase.apps.length || !host.firebase.database) return false;
      warmRef = host.firebase.database().ref('users/' + uid + '/carteira');
      warmRef.on('value', noopListener);
      warmUid = uid;
      return true;
    } catch (e) { return false; }
  }

  function coolDown() {
    try {
      if (warmRef) { try { warmRef.off('value', noopListener); } catch (e) {} }
    } catch (e) {}
    warmRef = null;
    warmUid = null;
  }

  function requireUid() {
    var uid = currentUid();
    if (!uid) {
      var e = new Error('Login necessário.');
      e.code = 'unauthenticated';
      throw e;
    }
    return uid;
  }

  // Transação atômica na raiz da carteira. opFn(carteira|null, now)
  // retorna {carteira} | {status,...} (sem escrita) | {error}.
  // Com timeout próprio: o SDK do RTDB pode aguardar conexão indefinidamente
  // (promise pendente, sem erro) — sem timeout a UI trava em "Excluindo…"
  // para sempre e o usuário só vê que "não vai".
  var TX_TIMEOUT_MS = 15000;

  function transact(opFn) {
    if (!online()) return Promise.reject(offlineErr());
    var uid;
    try { uid = requireUid(); } catch (e) { return Promise.reject(e); }
    var ref;
    try { ref = cartRef(uid); } catch (e) { return Promise.reject(e); }
    var last = null;
    var settled = false;
    var txPromise = ref.transaction(function (current) {
      var out;
      try {
        out = opFn(current ? JSON.parse(JSON.stringify(current)) : null, Date.now());
      } catch (e) {
        return; // aborta sem escrever
      }
      if (!out || out.error || (out.status && out.status !== 'migrated')) {
        last = out;
        return; // aborta: nada a gravar (erro ou status sem escrita)
      }
      last = out;
      return out.carteira;
    }).then(function (res) {
      var out = last;
      if (!res || !res.committed) {
        if (out && out.error) {
          var e = new Error(out.error);
          e.code = 'failed-precondition';
          throw e;
        }
        if (out && out.status) return out;
        throw new Error('Transação abortada. Tente novamente.');
      }
      return out;
    });
    var timeoutPromise = new Promise(function (_, reject) {
      setTimeout(function () {
        if (settled) return;
        settled = true;
        var e = new Error('Servidor demorou a responder. Verifique a conexão e tente de novo.');
        e.code = 'timeout';
        reject(e);
      }, TX_TIMEOUT_MS);
    });
    return Promise.race([txPromise.then(function (v) { settled = true; return v; }, function (e) { settled = true; throw e; }), timeoutPromise]);
  }

  function fromCloud(cloud) {
    var c = cloud || {};
    var assets = c.assets && typeof c.assets === 'object' ? c.assets : {};
    var out = Object.keys(assets).map(function (k) {
      var d = assets[k] || {};
      var t = String(d.type || '').trim().toUpperCase();
      return {
        id: String(d.ticker || k),
        ticker: String(d.ticker || k),
        name: String(d.name || k),
        type: t === 'STOCK' ? 'STOCK' : 'CRYPTO',
        quantity: typeof d.quantity === 'number' ? d.quantity : 0,
        averagePrice: typeof d.avgPrice === 'number' ? d.avgPrice : 0,
        currentPrice: typeof d.currentPrice === 'number' ? d.currentPrice : 0,
        dailyVariation: typeof d.dailyChangePercent === 'number' ? d.dailyChangePercent : 0,
        closedAt: d.closedAt || null,
        demo: false
      };
    });
    return {
      version: 1,
      portfolio: { name: 'Minha Carteira', currency: c.currency || 'USD', updatedAt: new Date().toISOString() },
      assets: out
    };
  }

  var api = {
    isConfigured: isConfigured,
    friendlyError: friendlyError,
    currentUid: currentUid,
    warmup: warmup,
    coolDown: coolDown,

    load: function () {
      if (!online()) return Promise.reject(offlineErr());
      var uid;
      try { uid = requireUid(); } catch (e) { return Promise.reject(e); }
      var ref;
      try { ref = cartRef(uid); } catch (e) { return Promise.reject(e); }
      return ref.once('value').then(function (snap) {
        return fromCloud(snap.val());
      });
    },

    add: function (input) {
      return transact(function (cart, now) {
        return opAddAsset(cart, {
          ticker: input.ticker, name: input.name, type: input.type,
          quantity: input.quantity,
          purchasePrice: input.averagePrice,
          currentPrice: input.currentPrice,
          dailyVariation: input.dailyVariation
        }, now);
      }).then(function (out) {
        return { status: 'ok', action: out.action, ticker: out.ticker, quantity: out.quantity, avgPrice: out.carteira.assets[out.ticker].avgPrice };
      });
    },

    update: function (ticker, changes) {
      return transact(function (cart, now) {
        return opUpdateAsset(cart, ticker, changes, now);
      }).then(function (out) {
        return { status: 'ok', ticker: out.ticker };
      });
    },

    remove: function (ticker) {
      return transact(function (cart) {
        return opRemoveAsset(cart, ticker);
      }).then(function (out) {
        return { status: 'ok', ticker: out.ticker };
      });
    },

    removeLot: function (ticker, lotId) {
      return transact(function (cart, now) {
        return opRemoveLot(cart, ticker, lotId, now);
      }).then(function (out) {
        return { status: 'ok', ticker: out.ticker, lotId: lotId };
      });
    },

    migrateLocal: function () {
      var host = getRoot();
      var raw = null;
      try { raw = host.localStorage.getItem('eb_portfolio_v2'); }
      catch (e) { return Promise.resolve({ status: 'empty' }); }
      if (!raw) return Promise.resolve({ status: 'empty' });
      var state = null;
      try { state = JSON.parse(raw); } catch (e) { return Promise.resolve({ status: 'empty' }); }
      var lista = state && Array.isArray(state.assets) ? state.assets : [];
      if (!lista.length) return Promise.resolve({ status: 'empty' });

      var skipped = [];
      var itens = [];
      for (var i = 0; i < lista.length; i++) {
        var a = lista[i] || {};
        var aq = parseNumber(a.quantity, NaN);
        if (!(aq > 0)) {
          skipped.push(String(a.ticker || '?').trim().toUpperCase() || '?');
          continue;
        }
        itens.push({
          ticker: a.ticker, name: a.name, type: a.type,
          quantity: aq,
          purchasePrice: parseNumber(a.averagePrice, 0),
          currentPrice: parseNumber(a.currentPrice, 0),
          dailyVariation: parseNumber(a.dailyVariation == null ? 0 : a.dailyVariation, 0)
        });
      }
      if (!itens.length) return Promise.resolve({ status: 'empty', skipped: skipped });
      var currency = state.portfolio && state.portfolio.currency;

      return transact(function (cart, now) {
        return opMigrate(cart, itens, currency, now);
      }).then(function (out) {
        out.skipped = skipped;
        return out;
      });
    },

    clearLocal: function () {
      try {
        getRoot().localStorage.removeItem('eb_portfolio_v2');
        return true;
      } catch (e) { return false; }
    }
  };

  var testApi = {
    opAddAsset: opAddAsset, opUpdateAsset: opUpdateAsset,
    opRemoveAsset: opRemoveAsset, opRemoveLot: opRemoveLot,
    opMigrate: opMigrate, fromCloud: fromCloud, parseNumber: parseNumber,
    normTicker: normTicker, normType: normType, blankCarteira: blankCarteira
  };

  if (typeof module === 'object' && module.exports && typeof module.exports === 'object') {
    module.exports = { api: api, test: testApi };
  } else {
    var r = getRoot();
    if (r) r.FirebasePortfolio = api;
  }
})();
