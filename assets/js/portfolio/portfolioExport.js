/* =====================================================================
   EstudeBitcoin — PortfolioExport (exportação da Minha Carteira)
   ---------------------------------------------------------------------
   Botão "Exportar Excel" no toolbar do Painel Pessoal. Lê a visão pronta
   via window.PainelAtivos.getExportView() (mesmo pipeline do render:
   filtro/ordem atuais + overlay de preços ao vivo) e gera .xlsx com a
   lib SheetJS carregada sob demanda (CDN). Sem rede/sem lib: fallback
   para .csv (abre no Excel). Sem dependências próprias; funciona com a
   tabela vazia bloqueada (sem carteira visível não exporta).
   ===================================================================== */
(function () {
  'use strict';

  var XLSX_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  var BTN_ID = 'pa-export-xlsx';

  function getRoot() {
    try {
      if (typeof globalThis !== 'undefined') return globalThis;
    } catch (e) {}
    return null;
  }

  var FILTER_LABEL = { ALL: 'Todos', CRYPTO: 'Cripto', STOCK: 'Stocks' };
  var SORT_LABEL = {
    value_desc: 'Maior valor', value_asc: 'Menor valor',
    profit_desc: 'Maior lucro', profit_asc: 'Maior prejuízo',
    rent_desc: 'Maior rentabilidade', day_desc: 'Maior variação diária',
    ticker_asc: 'Ticker A–Z', alloc_desc: 'Maior alocação'
  };

  function filterLabel(f) { return FILTER_LABEL[f] || 'Todos'; }
  function sortLabel(s) { return SORT_LABEL[s] || s || ''; }

  function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : 0; }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fileNameFor(d, ext) {
    var t = (d instanceof Date && !isNaN(d)) ? d : new Date();
    return 'minha-carteira-' + t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate()) + '.' + ext;
  }

  function fmtDateTimeBR(iso) {
    try {
      var d = iso ? new Date(iso) : new Date();
      if (isNaN(d)) return '—';
      return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    } catch (e) { return '—'; }
  }

  // Monta a planilha como array-of-arrays (números como números, para o
  // Excel somar/formatar). Retorna { aoa, headerRow, firstDataRow, lastRow, nCols }.
  function buildSheetAOA(view) {
    var totals = view.totals || {};
    var header = ['Ativo', 'Nome', 'Tipo', 'Preço atual (USD)', 'Qtd',
      'Preço médio (USD)', 'Valor atual (USD)', 'Lucro/Prejuízo (USD)',
      'Rent. (%)', 'Hoje (%)', 'Alocação (%)'];
    var aoa = [];
    aoa.push(['Minha Carteira — EstudeBitcoin']);
    aoa.push(['Exportado em ' + fmtDateTimeBR(view.generatedAt) +
      '  •  Filtro: ' + filterLabel(view.filter) + '  •  Ordem: ' + sortLabel(view.sort)]);
    aoa.push([]);
    aoa.push(['RESUMO']);
    aoa.push(['Valor investido (USD)', num(totals.invested)]);
    aoa.push(['Valor atual (USD)', num(totals.current)]);
    aoa.push(['Lucro / Prejuízo (USD)', num(totals.profit)]);
    aoa.push(['Rentabilidade acumulada (%)', num(totals.profitability)]);
    aoa.push(['Variação do dia (USD)', num(totals.dailyDelta)]);
    aoa.push(['Nº de ativos', num(totals.count)]);
    aoa.push(['Atualizado em', view.portfolio && view.portfolio.updatedAt ? fmtDateTimeBR(view.portfolio.updatedAt) : '—']);
    aoa.push([]);
    var headerRow = aoa.length + 1; // 1-indexed
    aoa.push(header);
    var firstDataRow = aoa.length + 1;
    (view.assets || []).forEach(function (a) {
      var c = a.calc || {};
      aoa.push([
        a.ticker,
        a.name + (a.closedAt ? ' (encerrada)' : ''),
        a.type === 'STOCK' ? 'STOCK' : 'CRYPTO',
        num(a.currentPrice),
        num(a.quantity),
        num(a.averagePrice),
        num(c.current),
        num(c.profit),
        num(c.profitability),
        num(a.dailyVariation),
        num(c.allocation)
      ]);
    });
    aoa.push(['TOTAL', '', '', '', '', '',
      num(totals.current), num(totals.profit), num(totals.profitability), '', 100]);
    return { aoa: aoa, headerRow: headerRow, firstDataRow: firstDataRow, lastRow: aoa.length, nCols: header.length };
  }

  var COL_WIDTHS = [10, 28, 10, 18, 14, 18, 18, 20, 12, 12, 13];
  // Colunas (0-indexed) com formato moeda / percentual.
  var MONEY_COLS = [3, 5, 6, 7];
  var PCT_COLS = [8, 9, 10];

  function colLetter(i) {
    var s = '';
    i += 1;
    while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }

  function writeXLSX(view) {
    var host = getRoot();
    var XLSX = host && host.XLSX;
    if (!XLSX || !XLSX.utils) return false;
    var built = buildSheetAOA(view);
    var ws = XLSX.utils.aoa_to_sheet(built.aoa);
    ws['!cols'] = COL_WIDTHS.map(function (w) { return { wch: w }; });
    // Formatos numéricos nas linhas de dados + total (cabeçalho é texto).
    for (var r = built.firstDataRow; r <= built.lastRow; r++) {
      for (var j = 0; j < MONEY_COLS.length; j++) {
        var mc = ws[colLetter(MONEY_COLS[j]) + r];
        if (mc && typeof mc.v === 'number') mc.z = '#,##0.00';
      }
      for (var k = 0; k < PCT_COLS.length; k++) {
        var pc = ws[colLetter(PCT_COLS[k]) + r];
        if (pc && typeof pc.v === 'number') pc.z = '0.00';
      }
    }
    // Resumo: valores em moeda também.
    for (var s = 5; s <= 9; s++) {
      var cell = ws['B' + s];
      if (cell && typeof cell.v === 'number') cell.z = '#,##0.00';
    }
    var lastCol = colLetter(built.nCols - 1);
    ws['!autofilter'] = { ref: 'A' + built.headerRow + ':' + lastCol + built.lastRow };
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Carteira');
    XLSX.writeFile(wb, fileNameFor(new Date(), 'xlsx'));
    return true;
  }

  /* ---------- Fallback CSV (pt-BR: separador ";" + BOM) ---------- */
  function csvNum(v, dec) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '';
    return v.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function csvEsc(v) {
    var s = String(v == null ? '' : v);
    return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function buildCSVText(view) {
    var t = view.totals || {};
    var L = [];
    L.push('Minha Carteira — EstudeBitcoin');
    L.push('Exportado em ' + fmtDateTimeBR(view.generatedAt) + ' | Filtro: ' + filterLabel(view.filter) + ' | Ordem: ' + sortLabel(view.sort));
    L.push('');
    L.push('RESUMO');
    L.push('Valor investido (USD);' + csvNum(num(t.invested), 2));
    L.push('Valor atual (USD);' + csvNum(num(t.current), 2));
    L.push('Lucro / Prejuízo (USD);' + csvNum(num(t.profit), 2));
    L.push('Rentabilidade acumulada (%);' + csvNum(num(t.profitability), 2));
    L.push('Variação do dia (USD);' + csvNum(num(t.dailyDelta), 2));
    L.push('Nº de ativos;' + num(t.count));
    L.push('');
    L.push(['Ativo', 'Nome', 'Tipo', 'Preço atual (USD)', 'Qtd', 'Preço médio (USD)',
      'Valor atual (USD)', 'Lucro/Prejuízo (USD)', 'Rent. (%)', 'Hoje (%)', 'Alocação (%)'].map(csvEsc).join(';'));
    (view.assets || []).forEach(function (a) {
      var c = a.calc || {};
      L.push([
        csvEsc(a.ticker),
        csvEsc(a.name + (a.closedAt ? ' (encerrada)' : '')),
        a.type === 'STOCK' ? 'STOCK' : 'CRYPTO',
        csvNum(num(a.currentPrice), 2),
        csvNum(num(a.quantity), 8),
        csvNum(num(a.averagePrice), 2),
        csvNum(num(c.current), 2),
        csvNum(num(c.profit), 2),
        csvNum(num(c.profitability), 2),
        csvNum(num(a.dailyVariation), 2),
        csvNum(num(c.allocation), 2)
      ].join(';'));
    });
    L.push(['TOTAL', '', '', '', '', '',
      csvNum(num(t.current), 2), csvNum(num(t.profit), 2),
      csvNum(num(t.profitability), 2), '', '100,00'].join(';'));
    return '﻿' + L.join('\r\n');
  }

  function downloadText(text, filename, mime) {
    var host = getRoot();
    var doc = (host && host.document) || (typeof document !== 'undefined' ? document : null);
    if (!doc) return false;
    try {
      var blob = new Blob([text], { type: mime + ';charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url;
      a.download = filename;
      doc.body.appendChild(a);
      a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); a.remove(); } catch (e) {} }, 1000);
      return true;
    } catch (e) { return false; }
  }

  function exportCSV(view) {
    return downloadText(buildCSVText(view), fileNameFor(new Date(), 'csv'), 'text/csv');
  }

  // Carrega o SheetJS sob demanda (uma vez por sessão). Resolve false
  // quando offline/CDN bloqueado — aí o chamador usa o fallback CSV.
  var xlsxPromise = null;
  function loadXLSX() {
    var host = getRoot();
    if (host && host.XLSX && host.XLSX.utils) return Promise.resolve(true);
    if (xlsxPromise) return xlsxPromise;
    xlsxPromise = new Promise(function (resolve) {
      try {
        var doc = (host && host.document) || document;
        var s = doc.createElement('script');
        s.src = XLSX_CDN;
        s.async = true;
        s.onload = function () { resolve(!!(host.XLSX && host.XLSX.utils)); };
        s.onerror = function () { resolve(false); };
        doc.head.appendChild(s);
        setTimeout(function () { resolve(!!(host.XLSX && host.XLSX.utils)); }, 15000);
      } catch (e) { resolve(false); }
    });
    return xlsxPromise;
  }

  function getView() {
    try {
      var host = getRoot();
      var api = host && host.PainelAtivos;
      if (api && typeof api.getExportView === 'function') return api.getExportView();
    } catch (e) {}
    return null;
  }

  function openLogin() {
    try {
      var host = getRoot();
      if (host && host.EstudeAuth && host.EstudeAuth.openModal) { host.EstudeAuth.openModal('login'); return true; }
    } catch (e) {}
    return false;
  }

  function flash(btn, label, ms) {
    if (!btn) return;
    var orig = btn.getAttribute('data-label') || btn.innerHTML;
    btn.setAttribute('data-label', orig);
    btn.disabled = true;
    btn.textContent = label;
    setTimeout(function () { btn.innerHTML = orig; btn.disabled = false; }, ms || 2200);
  }

  function onExportClick(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    var btn = null;
    try { btn = document.getElementById(BTN_ID); } catch (e) {}
    var view = getView();
    if (!view) { openLogin(); return; }
    if (!view.assets || !view.assets.length) { flash(btn, 'Carteira vazia'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    var done = function () { if (btn) { btn.disabled = false; mountLabel(btn); } };
    loadXLSX().then(function (ok) {
      try {
        if (ok && writeXLSX(view)) { done(); return; }
        if (exportCSV(view)) { done(); return; }
        flash(btn, 'Falha ao exportar');
      } catch (e) { flash(btn, 'Falha ao exportar'); }
    });
  }

  var ICON_DL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';

  function mountLabel(btn) {
    btn.innerHTML = ICON_DL + ' <span>Exportar Excel</span>';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.gap = '6px';
  }

  function mount() {
    try {
      if (typeof document === 'undefined' || document.getElementById(BTN_ID)) return;
      var toolbar = document.querySelector('#painel-ativos .pa-toolbar');
      if (!toolbar) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.id = BTN_ID;
      btn.className = 'pa-btn-ghost';
      btn.title = 'Baixar a carteira (filtro e ordem atuais) em Excel (.xlsx)';
      mountLabel(btn);
      btn.addEventListener('click', onExportClick);
      toolbar.appendChild(btn);
    } catch (e) {}
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount);
    } else {
      mount();
    }
  }

  var host = getRoot();
  if (host) host.PortfolioExport = {
    mount: mount,
    exportNow: onExportClick,
    // Superfície de teste (pura, sem DOM/rede).
    _test: {
      buildSheetAOA: buildSheetAOA,
      buildCSVText: buildCSVText,
      fileNameFor: fileNameFor,
      filterLabel: filterLabel,
      sortLabel: sortLabel
    }
  };

  if (typeof module === 'object' && module.exports && typeof module.exports === 'object') {
    module.exports = host ? host.PortfolioExport : null;
  }
})();
