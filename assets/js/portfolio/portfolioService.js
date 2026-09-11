/* =====================================================================
   EstudeBitcoin — PortfolioService (FASE 1)
   ---------------------------------------------------------------------
   Orquestra CRUD + validação + sort/filter + recalc. NÃO toca
   localStorage (usa o StorageAdapter injetado) e NÃO recalcula
   matemática (delega a PortfolioCalculator).
   ===================================================================== */
(function () {
  'use strict';

  function getCalc() {
    try {
      if (typeof globalThis !== 'undefined' && globalThis.PortfolioCalculator) return globalThis.PortfolioCalculator;
    } catch (e) {}
    try {
      if (typeof require === 'function') return require('./portfolioCalculator.js');
    } catch (e) {}
    return null;
  }

  var VALID_TYPES = { CRYPTO: true, STOCK: true };

  function normType(t) {
    var s = String(t == null ? '' : t).trim().toUpperCase();
    if (s === 'CRIPTO' || s === 'CRIPTOATIVOS') return 'CRYPTO';
    if (s === 'STOCKS' || s === 'STOCK' || s === 'ACAO' || s === 'ACOES') return 'STOCK';
    if (s === 'CRYPTO') return 'CRYPTO';
    return s;
  }

  function normTicker(t) {
    return String(t == null ? '' : t).trim().toUpperCase();
  }

  // parsePtBR: aceita "1.234,56" e "1234.56" sem corromper decimais US.
  function parseNumber(v, def) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : (def != null ? def : 0);
    var s = String(v == null ? '' : v).trim();
    if (!s) return def != null ? def : 0;
    if (s.indexOf(',') !== -1) s = s.replace(/\./g, '').replace(',', '.');
    var n = Number(s);
    if (!Number.isFinite(n)) return def != null ? def : 0;
    return n;
  }

  function validate(input) {
    var errors = [];
    var ticker = normTicker(input && input.ticker);
    var type = normType(input && input.type);
    var quantity = parseNumber(input && input.quantity, NaN);
    var averagePrice = parseNumber(input && input.averagePrice, NaN);
    var currentPrice = parseNumber(input && input.currentPrice, NaN);
    var dailyVariation = parseNumber(input && input.dailyVariation, 0);

    if (!ticker) errors.push('Ticker é obrigatório.');
    if (!VALID_TYPES[type]) errors.push('Tipo inválido (use CRYPTO ou STOCK).');
    if (!Number.isFinite(quantity) || quantity < 0) errors.push('Quantidade deve ser ≥ 0.');
    if (!Number.isFinite(averagePrice) || averagePrice < 0) errors.push('Preço médio deve ser ≥ 0.');
    if (!Number.isFinite(currentPrice) || currentPrice < 0) errors.push('Preço atual deve ser ≥ 0.');
    if (!Number.isFinite(dailyVariation)) errors.push('Variação do dia inválida.');

    return {
      ok: errors.length === 0,
      errors: errors,
      value: { ticker: ticker, type: type, quantity: quantity, averagePrice: averagePrice, currentPrice: currentPrice, dailyVariation: dailyVariation }
    };
  }

  function genId(ticker) {
    var base = normTicker(ticker).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'asset';
    var rand = Math.random().toString(36).slice(2, 7);
    return base + '-' + Date.now().toString(36) + '-' + rand;
  }

  function numSafe(v) {
    return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
  }

  function findInList(assets, ticker, excludeId) {
    var t = normTicker(ticker);
    if (!t || !Array.isArray(assets)) return null;
    for (var i = 0; i < assets.length; i++) {
      var a = assets[i];
      if (!a) continue;
      // excludeId aceita id interno OU ticker: a UI identifica por ticker
      // (estável entre local e nuvem), então ambos excluem.
      if (excludeId != null && excludeId !== '' &&
          (a.id === excludeId || normTicker(a.ticker) === normTicker(excludeId))) continue;
      if (normTicker(a.ticker) === t) return a;
    }
    return null;
  }

  // Mescla estilo DCA: soma quantidades e recalcula o médio ponderado.
  // Preço atual e variação do dia são cotação (sobrescrevem, não mediam).
  function mergeNumbers(existing, v) {
    var eq = numSafe(existing.quantity);
    var eavg = numSafe(existing.averagePrice);
    var nq = numSafe(v.quantity);
    var navg = numSafe(v.averagePrice);
    var newQty = eq + nq;
    var newAvg = newQty > 0 ? (eq * eavg + nq * navg) / newQty : eavg;
    if (!Number.isFinite(newAvg)) newAvg = eavg;
    return {
      quantity: newQty,
      averagePrice: newAvg,
      currentPrice: v.currentPrice,
      dailyVariation: v.dailyVariation
    };
  }

  // Prévia de inclusão: diz se o ticker já existe e como fica a posição.
  // Retorna { ok, errors?, duplicate, existing?, value?, merged? }.
  function previewMerge(assets, input, excludeId) {
    var v = validate(input);
    if (!v.ok) return { ok: false, errors: v.errors };
    var found = findInList(assets, v.value.ticker, excludeId);
    if (!found) return { ok: true, duplicate: false, value: v.value };
    return { ok: true, duplicate: true, existing: found, value: v.value, merged: mergeNumbers(found, v.value) };
  }

  function createService(storage) {
    if (!storage || typeof storage.load !== 'function' || typeof storage.save !== 'function') {
      throw new Error('PortfolioService: storage adapter inválido (load/save).');
    }
    var calc = getCalc();
    if (!calc) throw new Error('PortfolioService: PortfolioCalculator não carregado.');

    var state = storage.load();

    function persist() {
      return storage.save(state);
    }

    // Enriquece ativos crus com derivados (sem persistir derivados).
    function recalc(assets) {
      var list = (assets || state.assets).map(function (a) {
        return {
          id: a.id, ticker: a.ticker, name: a.name, type: a.type,
          quantity: a.quantity, averagePrice: a.averagePrice,
          currentPrice: a.currentPrice, dailyVariation: a.dailyVariation,
          demo: a.demo === true,
          calc: calc.enrichPosition(a)
        };
      });
      var totals = calc.calcTotals(list.map(function (x) { return x.calc; }));
      calc.applyAllocations(list.map(function (x) { return x.calc; }), totals.current);
      return { assets: list, totals: totals };
    }

    function add(input, opts) {
      var o = opts || {};
      var p = previewMerge(state.assets, input, null);
      if (!p.ok) return { ok: false, errors: p.errors };
      if (!p.duplicate) {
        var asset = {
          id: genId(p.value.ticker),
          ticker: p.value.ticker,
          name: String((input && input.name) || p.value.ticker),
          type: p.value.type,
          quantity: p.value.quantity,
          averagePrice: p.value.averagePrice,
          currentPrice: p.value.currentPrice,
          dailyVariation: p.value.dailyVariation,
          demo: !!(o.demo)
        };
        state.assets.push(asset);
        var res = persist();
        return { ok: res.ok !== false, asset: asset, merged: false, errors: res.ok === false ? ['Falha ao salvar.'] : [] };
      }
      if (!o.merge) {
        return { ok: false, errors: ['Ativo "' + p.value.ticker + '" já existe na carteira.'], duplicate: true, preview: p };
      }
      // Merge DCA: soma a quantidade, médio ponderado, cotação mais recente.
      p.existing.quantity = p.merged.quantity;
      p.existing.averagePrice = p.merged.averagePrice;
      p.existing.currentPrice = p.merged.currentPrice;
      p.existing.dailyVariation = p.merged.dailyVariation;
      var resM = persist();
      return { ok: resM.ok !== false, asset: p.existing, merged: true, errors: resM.ok === false ? ['Falha ao salvar.'] : [] };
    }

    function update(id, input) {
      var v = validate(input);
      if (!v.ok) return { ok: false, errors: v.errors };
      // Aceita id interno OU ticker (a UI identifica por ticker, estável
      // entre local e nuvem).
      var idx = -1;
      for (var i = 0; i < state.assets.length; i++) {
        if (state.assets[i].id === id ||
            normTicker(state.assets[i].ticker) === normTicker(id)) { idx = i; break; }
      }
      if (idx === -1) return { ok: false, errors: ['Ativo não encontrado.'] };
      var clash = state.assets.filter(function (a) {
        if (a.id === id) return false;
        if (normTicker(a.ticker) === normTicker(id)) return false; // o próprio, via ticker
        return normTicker(a.ticker) === v.value.ticker;
      })[0];
      if (clash) return { ok: false, errors: ['Já existe outro ativo com ticker "' + v.value.ticker + '".'] };
      state.assets[idx].ticker = v.value.ticker;
      state.assets[idx].name = String((input && input.name) || v.value.ticker);
      state.assets[idx].type = v.value.type;
      state.assets[idx].quantity = v.value.quantity;
      state.assets[idx].averagePrice = v.value.averagePrice;
      state.assets[idx].currentPrice = v.value.currentPrice;
      state.assets[idx].dailyVariation = v.value.dailyVariation;
      var res = persist();
      return { ok: res.ok !== false, asset: state.assets[idx], errors: res.ok === false ? ['Falha ao salvar.'] : [] };
    }

    function remove(id) {
      var before = state.assets.length;
      state.assets = state.assets.filter(function (a) { return a.id !== id; });
      if (state.assets.length === before) return { ok: false, errors: ['Ativo não encontrado.'] };
      var res = persist();
      return { ok: res.ok !== false };
    }

    function clearAll() {
      state = { version: 1, portfolio: { name: 'Minha Carteira', currency: 'USD', updatedAt: null }, assets: [] };
      return storage.save(state);
    }

    function replaceAll(assets) {
      state.assets = Array.isArray(assets) ? assets : [];
      return persist();
    }

    // Substituição silenciosa (snapshot ao vivo): não carimba updatedAt.
    // Usa saveSnapshot quando o adapter oferece; senão, cai para save().
    function replaceAllSilent(assets) {
      state.assets = Array.isArray(assets) ? assets : [];
      if (storage && typeof storage.saveSnapshot === 'function') {
        return storage.saveSnapshot(state);
      }
      return persist();
    }

    var SORTS = {
      value_desc: function (a, b) { return b.calc.current - a.calc.current; },
      value_asc: function (a, b) { return a.calc.current - b.calc.current; },
      profit_desc: function (a, b) { return b.calc.profit - a.calc.profit; },
      profit_asc: function (a, b) { return a.calc.profit - b.calc.profit; },
      rent_desc: function (a, b) { return b.calc.profitability - a.calc.profitability; },
      day_desc: function (a, b) { return b.dailyVariation - a.dailyVariation; },
      ticker_asc: function (a, b) { return String(a.ticker).localeCompare(String(b.ticker)); },
      alloc_desc: function (a, b) { return b.calc.allocation - a.calc.allocation; }
    };

    function query(opts) {
      var o = opts || {};
      var view = recalc();
      var list = view.assets;
      if (o.filter === 'CRYPTO' || o.filter === 'STOCK') {
        list = list.filter(function (a) { return a.type === o.filter; });
        var totals = calc.calcTotals(list.map(function (x) { return x.calc; }));
        // Realoca sobre o subconjunto filtrado para o donut fechar 100%.
        calc.applyAllocations(list.map(function (x) { return x.calc; }), totals.current);
        view = { assets: list, totals: totals };
      }
      var sortFn = SORTS[o.sort] || SORTS.value_desc;
      view.assets = view.assets.slice().sort(sortFn);
      return view;
    }

    return {
      validate: validate,
      add: add,
      update: update,
      remove: remove,
      previewMerge: function (input, excludeId) { return previewMerge(state.assets, input, excludeId); },
      findByTicker: function (ticker, excludeId) { return findInList(state.assets, ticker, excludeId); },
      clearAll: clearAll,
      replaceAll: replaceAll,
      replaceAllSilent: replaceAllSilent,
      recalc: recalc,
      query: query,
      getState: function () { return state; },
      normType: normType,
      normTicker: normTicker,
      SORTS: Object.keys(SORTS)
    };
  }

  var api = { createService: createService, normType: normType, normTicker: normTicker };

  if (typeof module === 'object' && module.exports && typeof module.exports === 'object') {
    module.exports = api;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.PortfolioService = api;
  }
})();
