/* =====================================================================
   EstudeBitcoin — portfolioStorage (FASE 1)
   ---------------------------------------------------------------------
   ÚNICO ponto do painel com acesso a localStorage. UI e Service NUNCA
   tocam localStorage diretamente — passam por este adapter.

   Interface StorageAdapter: { load(), save(state), clear() }
   FASE 1b: valores em USD, chave "eb_portfolio_v2" (v1 era BRL, sem
   migração por magnitudes incompatíveis).
   FUTURO: FirebasePortfolioStorage com a mesma interface
   (users/{uid}/panels/portfolio). A troca é por injeção, sem reescrever
   UI/calculator/service.
   ===================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'eb_portfolio_v2';
  var CURRENT_VERSION = 1;

  function getRoot() {
    try {
      if (typeof globalThis !== 'undefined') return globalThis;
    } catch (e) {}
    return null;
  }

  function getLS() {
    try {
      var r = getRoot();
      if (r && r.localStorage) return r.localStorage;
    } catch (e) { /* sem storage (SSR/teste) */ }
    return null;
  }

  function blankState() {
    return {
      version: CURRENT_VERSION,
      portfolio: { name: 'Minha Carteira', currency: 'USD', updatedAt: null },
      assets: []
    };
  }

  function sanitizeAsset(a) {
    if (!a || typeof a !== 'object') return null;
    return {
      id: String(a.id || ''),
      ticker: String(a.ticker || ''),
      name: String(a.name || ''),
      type: String(a.type || ''),
      quantity: typeof a.quantity === 'number' ? a.quantity : 0,
      averagePrice: typeof a.averagePrice === 'number' ? a.averagePrice : 0,
      currentPrice: typeof a.currentPrice === 'number' ? a.currentPrice : 0,
      dailyVariation: typeof a.dailyVariation === 'number' ? a.dailyVariation : 0,
      demo: a.demo === true
    };
  }

  function sanitizeState(s) {
    var out = blankState();
    if (!s || typeof s !== 'object') return out;
    if (s.portfolio && typeof s.portfolio === 'object') {
      if (typeof s.portfolio.name === 'string' && s.portfolio.name) out.portfolio.name = s.portfolio.name;
      if (typeof s.portfolio.updatedAt === 'string') out.portfolio.updatedAt = s.portfolio.updatedAt;
    }
    if (Array.isArray(s.assets)) {
      for (var i = 0; i < s.assets.length; i++) {
        var a = sanitizeAsset(s.assets[i]);
        if (a && a.id && a.ticker) out.assets.push(a);
      }
    }
    return out;
  }

  // Memória de fallback quando localStorage indisponível (ex.: Node/teste).
  var memoryState = null;

  var LocalPortfolioStorage = {
    key: STORAGE_KEY,
    load: function () {
      var ls = getLS();
      if (!ls) return memoryState ? sanitizeState(memoryState) : blankState();
      try {
        var raw = ls.getItem(STORAGE_KEY);
        if (!raw) return blankState();
        return sanitizeState(JSON.parse(raw));
      } catch (e) {
        return blankState();
      }
    },
    save: function (state) {
      var clean = sanitizeState(state);
      clean.portfolio.updatedAt = new Date().toISOString();
      var ls = getLS();
      if (!ls) {
        memoryState = clean;
        return { ok: true, persistent: false };
      }
      try {
        ls.setItem(STORAGE_KEY, JSON.stringify(clean));
        return { ok: true, persistent: true };
      } catch (e) {
        return { ok: false, persistent: false, error: String(e && e.message || e) };
      }
    },
    // Snapshot silencioso (ex.: preços ao vivo): persiste SEM carimbar
    // updatedAt — o carimbo significa "usuário mexeu", não "preço andou".
    // sanitizeState preserva updatedAt quando já é string.
    saveSnapshot: function (state) {
      var clean = sanitizeState(state);
      var ls = getLS();
      if (!ls) {
        memoryState = clean;
        return { ok: true, persistent: false };
      }
      try {
        ls.setItem(STORAGE_KEY, JSON.stringify(clean));
        return { ok: true, persistent: true };
      } catch (e) {
        return { ok: false, persistent: false, error: String(e && e.message || e) };
      }
    },
    clear: function () {
      memoryState = null;
      var ls = getLS();
      if (!ls) return { ok: true };
      try {
        ls.removeItem(STORAGE_KEY);
        return { ok: true };
      } catch (e) {
        return { ok: false };
      }
    }
  };

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    blankState: blankState,
    LocalPortfolioStorage: LocalPortfolioStorage
  };

  if (typeof module === 'object' && module.exports && typeof module.exports === 'object') {
    module.exports = api;
  } else {
    var r = getRoot();
    if (r) r.PortfolioStorage = api;
  }
})();
