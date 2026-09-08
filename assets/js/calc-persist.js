/* =====================================================================
   EstudeBitcoin — Persistência do Simulador de Alavancagem (ponte)
   ---------------------------------------------------------------------
   O simulador roda num iframe same-origin cujo fonte React NÃO está no
   repo (só o build). Em vez de reescrever a UI (risco de quebrar os
   cálculos), esta ponte lê/escreve os INPUTS do iframe pelo DOM —
   mesmo modelo do painel Risk Engine:

   - Anônimo: salva/restaura em localStorage (`eb_panel_sim`).
   - Logado: PanelSync empurra para a nuvem (debounce interno) e aplica
     o pull via evento 'estudebitcoin:panel-pull'.

   Estado persistido (panel 'sim'):
     { margemCorretora, alavancagemMaxima, mmrAtivo,
       dcaOrders: [{ precoCompra, valorAportado }] }

   Seletores (bundle atual, verificados em 2026-09-08):
   - Parâmetros: 2 primeiros inputs sem aria-label, na ordem do DOM
     (saldo, alavancagem) — labels "Saldo/Margem na Corretora",
     "Qtde de Alavancagem".
   - Ordens: `.order-row` × (input[aria-label^="Preço do ativo"],
     input[aria-label^="Valor aportado"]).
   - Adicionar: botão `.secondary-button` ("+ Adicionar ordem").
   - Remover: `.order-row .remove-button` (remove do FIM).
   - MMR: botão `.toggle` (aria-pressed).

   Tudo defensivo: qualquer falha desliga a ponte em silêncio sem
   afetar a página nem o iframe.

   Expõe: window.CalcPersist { scrape, restoreNow, saveNow }
   ===================================================================== */
(function (global) {
  'use strict';

  var PANEL = 'sim';
  var FRAME_ID = 'calcLiquidacaoFrame';
  var SAVE_DEBOUNCE_MS = 800;

  var frame = null;      // elemento <iframe>
  var doc = null;        // contentDocument (same-origin)
  var restoring = false; // guarda anti-loop durante restore
  var pendingPull = null;
  var saveTimer = null;
  var dead = false;

  function $(sel, root) {
    try { return (root || document).querySelector(sel); }
    catch (e) { return null; }
  }

  function $all(sel, root) {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
    catch (e) { return []; }
  }

  /* ---------- Números pt-BR ("58.000,00" / "70,102.23" / "58000") ---------- */
  function parseNum(texto) {
    var s = String(texto == null ? '' : texto).replace(/\s/g, '');
    if (!s) return null;
    var li = s.lastIndexOf(','), di = s.lastIndexOf('.');
    if (li !== -1 && di !== -1) {
      s = li > di ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (li !== -1) {
      s = s.replace(/\./g, '').replace(',', '.');
    }
    var n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function finiteOr(v, fallback) {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  /* ---------- Leitura do estado atual do iframe ---------- */
  function scrape() {
    if (!doc) return null;
    try {
      var bare = $all('input:not([aria-label])', doc);
      if (bare.length < 2) return null;
      var margem = parseNum(bare[0].value);
      var alav = parseNum(bare[1].value);
      if (margem === null || alav === null) return null;
      var rows = $all('.order-row', doc);
      if (!rows.length) return null;
      var orders = [];
      for (var i = 0; i < rows.length; i++) {
        var p = parseNum(($( 'input[aria-label^="Preço do ativo"]', rows[i]) || {}).value);
        var v = parseNum(($( 'input[aria-label^="Valor aportado"]', rows[i]) || {}).value);
        if (p === null || v === null) return null;
        orders.push({ precoCompra: p, valorAportado: v });
      }
      var tg = $('.toggle', doc);
      return {
        margemCorretora: margem,
        alavancagemMaxima: alav,
        mmrAtivo: !!(tg && tg.getAttribute('aria-pressed') === 'true'),
        dcaOrders: orders
      };
    } catch (e) { return null; }
  }

  function validState(s) {
    if (!s || typeof s !== 'object') return false;
    if (!Number.isFinite(s.margemCorretora) || s.margemCorretora < 0) return false;
    if (!Number.isFinite(s.alavancagemMaxima) || s.alavancagemMaxima <= 0) return false;
    if (!Array.isArray(s.dcaOrders) || !s.dcaOrders.length || s.dcaOrders.length > 50) return false;
    for (var i = 0; i < s.dcaOrders.length; i++) {
      var o = s.dcaOrders[i];
      if (!o || !Number.isFinite(o.precoCompra) || o.precoCompra <= 0) return false;
      if (!Number.isFinite(o.valorAportado) || o.valorAportado < 0) return false;
    }
    return true;
  }

  /* ---------- Escrita: valor "canônico" + eventos que o React entende ---------- */
  function setInput(input, value) {
    // Setter nativo + evento 'input' (inputs controlados do React ouvem na raiz).
    try {
      var proto = null;
      try { proto = Object.getOwnPropertyDescriptor(global.HTMLInputElement && global.HTMLInputElement.prototype, 'value'); } catch (e) {}
      var setter = (proto && proto.set) || null;
      if (setter) setter.call(input, String(value));
      else input.value = String(value);
      var ev = null;
      try { ev = new global.Event('input', { bubbles: true }); } catch (e) { return false; }
      input.dispatchEvent(ev);
      try {
        var FocusEv = global.FocusEvent || global.Event;
        input.dispatchEvent(new FocusEv('focusout', { bubbles: true }));
      } catch (e) { /* blur opcional */ }
      return true;
    } catch (e) { return false; }
  }

  function wait(ms) {
    return new Promise(function (res) { global.setTimeout(res, ms); });
  }

  function clickEl(el) {
    try {
      if (!el) return false;
      if (typeof el.click === 'function') { el.click(); return true; }
      return false;
    } catch (e) { return false; }
  }

  function restore(state) {
    if (!validState(state) || !doc) return Promise.resolve(false);
    restoring = true;
    var chain = Promise.resolve(true);
    try {
      // 1) MMR toggle.
      var tg = $('.toggle', doc);
      if (tg && (tg.getAttribute('aria-pressed') === 'true') !== !!state.mmrAtivo) {
        clickEl(tg);
      }
      chain = chain.then(function () { return wait(120); });
      // 2) Ajusta a quantidade de ordens (remove do FIM; adiciona no fim).
      chain = chain.then(function step() {
        var rows = $all('.order-row', doc);
        var want = state.dcaOrders.length;
        if (rows.length > want) {
          var rems = $all('.order-row .remove-button', doc);
          if (!clickEl(rems[rems.length - 1])) return false;
          return wait(120).then(step);
        }
        if (rows.length < want) {
          if (!clickEl($('.secondary-button', doc))) return false;
          return wait(120).then(step);
        }
        return true;
      });
      // 3) Preenche parâmetros + ordens com valores canônicos.
      chain = chain.then(function (ok) {
        if (ok === false) return false;
        var bare = $all('input:not([aria-label])', doc);
        if (bare.length < 2) return false;
        setInput(bare[0], state.margemCorretora);
        setInput(bare[1], state.alavancagemMaxima);
        var rows = $all('.order-row', doc);
        for (var i = 0; i < rows.length && i < state.dcaOrders.length; i++) {
          var p = $('input[aria-label^="Preço do ativo"]', rows[i]);
          var v = $('input[aria-label^="Valor aportado"]', rows[i]);
          if (!p || !v) return false;
          setInput(p, state.dcaOrders[i].precoCompra);
          setInput(v, state.dcaOrders[i].valorAportado);
        }
        return true;
      });
    } catch (e) {
      chain = Promise.resolve(false);
    }
    return chain.then(function (ok) {
      restoring = false;
      return !!ok;
    }, function () {
      restoring = false;
      return false;
    });
  }

  /* ---------- Persistência (modelo Risk Engine) ---------- */
  function saveNow() {
    try {
      if (restoring || dead) return false;
      var s = scrape();
      if (!validState(s)) return false;
      if (global.PanelSync && global.PanelSync.saveLocal) {
        return !!global.PanelSync.saveLocal(PANEL, s);
      }
      return false;
    } catch (e) { return false; }
  }

  function scheduleSave() {
    if (restoring || dead) return;
    if (saveTimer) global.clearTimeout(saveTimer);
    saveTimer = global.setTimeout(function () {
      saveTimer = null;
      saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  function loadSaved() {
    try {
      if (global.PanelSync && global.PanelSync.loadLocal) {
        var s = global.PanelSync.loadLocal(PANEL);
        if (s && validState(s.params)) return s.params;
      }
    } catch (e) { /* segue sem restaurar */ }
    return null;
  }

  function restoreNow() {
    var s = loadSaved();
    if (!s) return Promise.resolve(false);
    return restore(s);
  }

  /* ---------- Ligação com o iframe ---------- */
  function onFrameReady() {
    try {
      if (!frame) return;
      var d = null;
      try { d = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document); } catch (e) { dead = true; return; }
      if (!d) return;
      doc = d;
      // Estado salvo (local ou pull da nuvem que chegou antes do iframe).
      var target = pendingPull || loadSaved();
      pendingPull = null;
      var p = target ? restore(target) : Promise.resolve(false);
      p.then(function () {
        try {
          doc.addEventListener('input', scheduleSave, true);
          doc.addEventListener('click', scheduleSave, true);
          doc.addEventListener('change', scheduleSave, true);
        } catch (e) { dead = true; }
      }, function () {
        try {
          doc.addEventListener('input', scheduleSave, true);
          doc.addEventListener('click', scheduleSave, true);
        } catch (e) { dead = true; }
      });
    } catch (e) { dead = true; }
  }

  function bind() {
    if (!global.document) return false;
    frame = document.getElementById(FRAME_ID);
    if (!frame) return false; // página sem o simulador
    if (bind.done) return true;
    bind.done = true;
    try {
      frame.addEventListener('load', onFrameReady);
      // Iframe pode já estar carregado (cache / reload).
      var ready = false;
      try {
        var d = frame.contentDocument;
        ready = !!(d && d.readyState === 'complete' && d.querySelector('.order-row'));
      } catch (e) { ready = false; }
      if (ready) onFrameReady();
      else {
        // Lazy-load: tenta de novo quando entrar na viewport.
        var tries = 0;
        var iv = global.setInterval(function () {
          tries++;
          try {
            var dd = frame.contentDocument;
            if (dd && dd.querySelector('.order-row')) {
              global.clearInterval(iv);
              onFrameReady();
            } else if (tries > 40) {
              global.clearInterval(iv);
            }
          } catch (e) {
            global.clearInterval(iv);
            dead = true;
          }
        }, 1000);
      }
    } catch (e) { dead = true; return false; }

    // Pull da nuvem (login): aplica se o iframe pronto; senão guarda.
    try {
      if (global.addEventListener) {
        global.addEventListener('estudebitcoin:panel-pull', function (ev) {
          var dt = ev && ev.detail;
          if (!dt || dt.panel !== PANEL || !validState(dt.params)) return;
          if (doc) { restore(dt.params); }
          else { pendingPull = dt.params; }
        });
      }
    } catch (e) { /* listener opcional */ }
    return true;
  }

  global.CalcPersist = {
    scrape: scrape,
    restoreNow: restoreNow,
    saveNow: saveNow,
    bind: bind
  };

  /* ---------- Boot (nunca quebra a página) ---------- */
  function boot() {
    try { bind(); } catch (e) { /* ponte opcional */ }
  }

  if (global.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
