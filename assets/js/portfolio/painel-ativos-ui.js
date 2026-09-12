/* =====================================================================
   EstudeBitcoin — Painel de Ativos UI (FASE 1)
   ---------------------------------------------------------------------
   Renderiza cards, donut SVG, resumo, formulário e tabela. Regras:
   - Fala SOMENTE com PortfolioService (nunca localStorage direto).
   - Formatação vive aqui; matemática vive no calculator.
   - Sem dependências externas; funciona offline.
   ===================================================================== */
(function () {
  'use strict';

  function getRoot() {
    try {
      if (typeof globalThis !== 'undefined') return globalThis;
    } catch (e) {}
    return null;
  }

  var ROOT_ID = 'painel-ativos';
  var PALETTE = ['#22d3ee', '#f7931a', '#34d399', '#a78bfa', '#f472b6', '#fbbf24', '#60a5fa', '#4ade80', '#fb7185', '#2dd4bf'];

  // Identidade da posição em edição: TICKER normalizado (estável entre
  // local e nuvem; ids internos mudam na transição e quebravam edit/del).
  var ui = { filter: 'ALL', sort: 'value_desc', donutMode: 'asset', editingTicker: null, formType: 'CRYPTO', formOpen: false, mode: 'local', sellMode: false, busy: false, needsSync: false };
  var service = null;

  function fb() {
    var host = getRoot();
    return (host && host.FirebasePortfolio) || null;
  }

  // UID remoto atual. Sem ele, trocar de conta (anônimo→Google) com o
  // modo já em "remote" NÃO recarregava: a tabela mostrava dados do UID
  // velho e as escritas iam para a nuvem vazia do UID novo ("não existe").
  var remoteUid = null;

  function setBadgeUid() {
    try {
      var badge = $('pa-mode-badge');
      if (badge && remoteUid) badge.title = 'UID: ' + remoteUid.slice(0, 8) + '…';
      else if (badge) badge.title = '';
    } catch (e) {}
  }

  function isRemote() { return ui.mode === 'remote' && !!fb(); }

  function isAuthedUser(u) {
    return !!(u && u.id && !u.anonymous);
  }

  function setStatus(msg) {
    var upd = $('pa-updated');
    if (upd) upd.textContent = msg || '';
  }

  function setBusy(busy, label) {
    ui.busy = !!busy;
    var btn = $('pa-submit');
    if (btn) {
      btn.disabled = ui.busy;
      if (ui.busy) {
        btn.textContent = label || 'Salvando…';
      } else if (ui.editingTicker) {
        btn.textContent = 'Salvar alterações';
      } else {
        refreshMergePreview();
      }
    }
    var toggle = $('pa-add-toggle');
    if (toggle) toggle.disabled = ui.busy;
  }

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // FASE 1b: todos os valores em dólar (USD). Dígitos em pt-BR,
  // mesmo padrão do BI.formatUSD do site ('$ ' + pt-BR).
  function fmtMoney(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '$ —';
    var sign = v < 0 ? '-' : '';
    return sign + '$ ' + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtMoneySigned(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '$ —';
    var sign = v > 0 ? '+' : (v < 0 ? '-' : '');
    return sign + '$ ' + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtPct(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    var sign = v > 0 ? '+' : (v < 0 ? '-' : '');
    return sign + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  }

  function fmtQty(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    return v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 8 });
  }

  function cls(v) { return v > 0 ? 'pos' : (v < 0 ? 'neg' : ''); }

  // Ícones inline (sem dependências, sem emoji): lápis e lixeira.
  var ICON_EDIT = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
  var ICON_DEL = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  function colorFor(i) { return PALETTE[i % PALETTE.length]; }

  /* ---------- Donut SVG (com % no anel + agrupamento "Outros") ---------- */
  var MAX_SLICES = 6;      // top 6 nomeados; o resto vira "Outros"
  var MIN_LABEL_PCT = 4;   // só rotula no anel fatias >= 4% (evita poluição)
  var OUTROS_COLOR = '#6b7280';

  // Agrupa as menores fatias em "Outros" (como na referência).
  function groupSmall(items, max) {
    var sorted = (items || []).slice().sort(function (a, b) { return b.value - a.value; });
    if (sorted.length <= max) return sorted;
    var top = sorted.slice(0, max - 1);
    var rest = sorted.slice(max - 1);
    var sum = 0;
    for (var i = 0; i < rest.length; i++) sum += Math.max(0, rest[i].value);
    if (sum > 0) top.push({ label: 'Outros', value: sum, color: OUTROS_COLOR });
    return top;
  }

  function donutSegments(items) {
    // items: [{label, value}] com value ≥ 0. Retorna [{label, value, pct, offset}]
    var total = 0;
    for (var i = 0; i < items.length; i++) total += Math.max(0, items[i].value);
    var acc = 0;
    return items.map(function (it) {
      var pct = total > 0 ? Math.max(0, it.value) / total * 100 : 0;
      var seg = { label: it.label, value: it.value, pct: pct, offset: acc, color: it.color || null };
      acc += pct;
      return seg;
    });
  }

  function renderDonut(svgEl, segs) {
    var R = 70;
    var C = 2 * Math.PI * R;
    var html = '<circle cx="90" cy="90" r="' + R + '" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="26"/>';
    if (!segs.length) {
      svgEl.innerHTML = html;
      return;
    }
    for (var i = 0; i < segs.length; i++) {
      var len = Math.max(0, segs[i].pct / 100 * C);
      if (len <= 0) continue;
      // Pequeno gap visual entre segmentos (não altera o cálculo).
      var gap = segs.length > 1 ? 2 : 0;
      var dash = Math.max(0, len - gap) + ' ' + (C - Math.max(0, len - gap));
      var off = -segs[i].offset / 100 * C;
      var color = segs[i].color || colorFor(i);
      html += '<circle cx="90" cy="90" r="' + R + '" fill="none" stroke="' + color +
        '" stroke-width="26" stroke-dasharray="' + dash + '" stroke-dashoffset="' + off +
        '" transform="rotate(-90 90 90)" stroke-linecap="butt"><title>' + esc(segs[i].label) + ' ' +
        segs[i].pct.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%</title></circle>';
      // Rótulo % no meio do anel (só em fatias grandes o suficiente).
      if (segs[i].pct >= MIN_LABEL_PCT) {
        var mid = (segs[i].offset + segs[i].pct / 2) / 100 * 2 * Math.PI - Math.PI / 2;
        var x = 90 + R * Math.cos(mid);
        var y = 90 + R * Math.sin(mid);
        html += '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" dominant-baseline="central">' +
          Math.round(segs[i].pct) + '%</text>';
      }
    }
    svgEl.innerHTML = html;
  }

  /* ---------- Render ---------- */
  function render() {
    if (!service) return;
    // Modo bloqueado: não exibe carteira (exige login), esconde dados sensíveis
    if (ui.mode === 'locked') {
      try {
        var locked = $('pa-locked');
        if (locked) locked.style.display = '';
        var empty = $('pa-empty');
        if (empty) empty.style.display = 'none';
        var wrap = $('pa-table-wrap');
        if (wrap) wrap.style.display = 'none';
        var tfoot = $('pa-tfoot');
        if (tfoot) tfoot.style.display = 'none';
        var cards = $('pa-total');
        if (cards) {
          setText('pa-total', '$ —');
          setText('pa-count', '0');
          var plEl = $('pa-pl'); if (plEl) { plEl.textContent = '$ —'; plEl.className = ''; }
          var sub = $('pa-pl-sub'); if (sub) { sub.textContent = 'Entre para acessar'; sub.className = 'pa-sub'; }
          var dayEl = $('pa-day'); if (dayEl) { dayEl.textContent = '$ —'; dayEl.className = ''; }
          setText('pa-sum-invested', '$ —');
          setText('pa-sum-current', '$ —');
          var rsPl = $('pa-sum-pl'); if (rsPl) { rsPl.textContent = '$ —'; rsPl.className = ''; }
          var rsDay = $('pa-sum-day'); if (rsDay) { rsDay.textContent = '$ —'; rsDay.className = ''; }
          var upd = $('pa-updated'); if (upd) upd.textContent = 'Entre para acessar sua carteira sincronizada.';
        }
        var demoBadge = $('pa-demo-badge');
        if (demoBadge) demoBadge.style.display = 'none';
        var clearBtn = $('pa-clear-demo');
        if (clearBtn) clearBtn.style.display = 'none';
      } catch (e) {}
      return;
    }
    var host = getRoot();
    var view = service.query({ filter: ui.filter === 'ALL' ? null : ui.filter, sort: ui.sort });
    // Overlay ao vivo: patrimônio, donut e tabela acompanham os tickers.
    try {
      var calcApi = host && host.PortfolioCalculator;
      if (calcApi) {
        var over = view.assets.map(function (a) { return liveView(a); });
        var touched = over.some(function (o) { return o.live; });
        if (touched) {
          var list = over.map(function (o) { return o.asset; });
          var calcs = list.map(function (x) { return x.calc; });
          var totals = calcApi.calcTotals(calcs);
          calcApi.applyAllocations(calcs, totals.current);
          view = { assets: list, totals: totals };
        }
      }
    } catch (e) {}
    var totals = view.totals;
    var assets = view.assets;

    // Cards
    setText('pa-total', fmtMoney(totals.current));
    setText('pa-count', String(totals.count));
    var plEl = $('pa-pl');
    if (plEl) {
      plEl.textContent = fmtMoneySigned(totals.profit);
      plEl.className = cls(totals.profit);
      var sub = $('pa-pl-sub');
      if (sub) { sub.textContent = fmtPct(totals.profitability) + ' acumulado'; sub.className = 'pa-sub ' + cls(totals.profitability); }
    }
    var dayEl = $('pa-day');
    if (dayEl) {
      dayEl.textContent = fmtMoneySigned(totals.dailyDelta);
      dayEl.className = cls(totals.dailyDelta);
    }

    // Donut: por ativo ou por categoria
    var items;
    if (ui.donutMode === 'category') {
      var map = {};
      for (var i = 0; i < assets.length; i++) {
        var k = assets[i].type === 'STOCK' ? 'STOCKS' : 'CRIPTO';
        map[k] = (map[k] || 0) + assets[i].calc.current;
      }
      items = Object.keys(map).map(function (k) { return { label: k, value: map[k] }; });
    } else {
      items = assets.map(function (a) { return { label: a.ticker, value: a.calc.current }; });
      items = groupSmall(items, MAX_SLICES);
    }
    var segs = donutSegments(items);
    var svg = $('pa-donut-svg');
    if (svg) renderDonut(svg, segs);

    var centerTop = $('pa-donut-top');
    var centerSub = $('pa-donut-sub');
    if (centerTop) centerTop.textContent = ui.filter === 'ALL' ? String(totals.count) : String(assets.length);
    if (centerSub) centerSub.textContent = ui.filter === 'ALL' ? 'ATIVOS' : (ui.filter === 'CRYPTO' ? 'CRIPTO' : 'STOCKS');

    var legend = $('pa-legend');
    if (legend) {
      if (!segs.length) {
        legend.innerHTML = '<li>Sem dados no filtro atual.</li>';
      } else {
        legend.innerHTML = segs.slice(0, 8).map(function (s, idx) {
          return '<li><span class="pa-dot" style="background:' + (s.color || colorFor(idx)) + '"></span>' +
            '<span class="pa-t">' + esc(s.label) + '</span>' +
            '<span class="pa-p">' + s.pct.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%</span></li>';
        }).join('');
      }
    }

    // Resumo
    setText('pa-sum-invested', fmtMoney(totals.invested));
    setText('pa-sum-current', fmtMoney(totals.current));
    var rsPl = $('pa-sum-pl');
    if (rsPl) { rsPl.textContent = fmtMoneySigned(totals.profit) + ' (' + fmtPct(totals.profitability) + ')'; rsPl.className = cls(totals.profit); }
    var rsDay = $('pa-sum-day');
    if (rsDay) { rsDay.textContent = fmtMoneySigned(totals.dailyDelta); rsDay.className = cls(totals.dailyDelta); }
    var icoPl = $('pa-ico-pl');
    if (icoPl) icoPl.className = 'pa-ico ' + cls(totals.profit);
    var icoDay = $('pa-ico-day');
    if (icoDay) icoDay.className = 'pa-ico ' + cls(totals.dailyDelta);

    // Badge demo + updated
    var hasDemo = service.getState().assets.some(function (a) { return a.demo; });
    var demoBadge = $('pa-demo-badge');
    if (demoBadge) demoBadge.style.display = hasDemo ? '' : 'none';
    var clearBtn = $('pa-clear-demo');
    if (clearBtn) clearBtn.style.display = hasDemo ? '' : 'none';
    var upd = $('pa-updated');
    if (upd) {
      var ts = service.getState().portfolio.updatedAt;
      upd.textContent = ts ? 'Atualizado em ' + new Date(ts).toLocaleString('pt-BR') : 'Ainda sem movimentação salva';
    }

    // Tabela
    renderTable(assets, totals);
  }

  function setText(id, t) {
    var el = $(id);
    if (el) el.textContent = t;
  }

  function renderTable(assets, totals) {
    var tbody = $('pa-tbody');
    var empty = $('pa-empty');
    var wrap = $('pa-table-wrap');
    var tfoot = $('pa-tfoot');
    if (!tbody) return;
    if (!assets.length) {
      tbody.innerHTML = '';
      if (tfoot) tfoot.style.display = 'none';
      if (empty) empty.style.display = '';
      if (wrap) wrap.style.display = 'none';
      return;
    }
    if (empty) empty.style.display = 'none';
    if (wrap) wrap.style.display = '';
    if (tfoot) tfoot.style.display = '';
    tbody.innerHTML = assets.map(function (a) {
      return '<tr>' +
        '<td><span class="pa-ticker">' + esc(a.ticker) + '<small>' + esc(a.name) + '</small></span>' +
        (a.closedAt ? ' <span class="pa-pill">ENCERRADA</span>' : '') + '</td>' +
        '<td><span class="pa-pill">' + (a.type === 'STOCK' ? 'STOCK' : 'CRYPTO') + '</span></td>' +
        '<td>' + esc(fmtMoney(a.currentPrice)) + (liveFresh(a.ticker) ? ' <span class="pa-live" title="Preço ao vivo do ticker"></span>' : '') + '</td>' +
        '<td>' + esc(fmtQty(a.quantity)) + '</td>' +
        '<td>' + esc(fmtMoney(a.averagePrice)) + '</td>' +
        '<td>' + esc(fmtMoney(a.calc.current)) + '</td>' +
        '<td class="' + cls(a.calc.profit) + '">' + esc(fmtMoneySigned(a.calc.profit)) + '</td>' +
        '<td class="' + cls(a.calc.profitability) + '">' + esc(fmtPct(a.calc.profitability)) + '</td>' +
        '<td class="' + cls(a.dailyVariation) + '">' + esc(fmtPct(a.dailyVariation)) + '</td>' +
        '<td>' + a.calc.allocation.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%</td>' +
        '<td><span class="pa-row-actions">' +
        '<button class="pa-icon-btn" data-act="edit" data-ticker="' + esc(a.ticker) + '" title="Editar ' + esc(a.ticker) + '" aria-label="Editar ' + esc(a.ticker) + '">' + ICON_EDIT + '</button>' +
        '<button class="pa-icon-btn danger" data-act="del" data-ticker="' + esc(a.ticker) + '" title="Excluir ' + esc(a.ticker) + '" aria-label="Excluir ' + esc(a.ticker) + '">' + ICON_DEL + '</button>' +
        '</span></td>' +
        '</tr>';
    }).join('');
    setText('pa-foot-current', fmtMoney(totals.current));
    var fp = $('pa-foot-pl');
    if (fp) { fp.textContent = fmtMoneySigned(totals.profit) + ' (' + fmtPct(totals.profitability) + ')'; fp.className = cls(totals.profit); }
    var fd = $('pa-foot-day');
    if (fd) { fd.textContent = fmtMoneySigned(totals.dailyDelta); fd.className = cls(totals.dailyDelta); }
  }

  /* ---------- Formulário expansível (colapsado por padrão) ---------- */
  function setFormOpen(open, opts) {
    ui.formOpen = !!open;
    var wrap = $('pa-form-wrap');
    var toggle = $('pa-add-toggle');
    if (wrap) wrap.style.display = ui.formOpen ? '' : 'none';
    if (toggle) toggle.style.display = ui.formOpen ? 'none' : '';
    var title = $('pa-form-title');
    if (title && !ui.editingTicker) title.textContent = 'Adicionar ativo';
    if (ui.formOpen && !(opts && opts.noScroll)) {
      if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      var t = $('pa-f-ticker');
      if (t && !ui.editingTicker) t.focus();
    }
  }

  // Cotação automática (preço atual + variação; médio é custo, SEMPRE manual).
  var quoteSeq = 0;
  var quoteAuto = false;
  // Nome da última cotação auto (permite trocar de ticker sem travar; se o
  // usuário digitar o nome, ele assume e o auto não sobrescreve mais).
  var quoteAutoName = null;

  function fmtInput(v, dec) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '';
    return v.toLocaleString('pt-BR', { maximumFractionDigits: dec == null ? 2 : dec });
  }

  function setQuoteSrc(msg) {
    var el = $('pa-quote-src');
    if (el) el.textContent = msg || '';
  }

  function fetchQuote(reason) {
    var host = getRoot();
    if (!host || !host.PriceProvider || ui.editingTicker) return;
    var ticker = ($('pa-f-ticker') || {}).value || '';
    if (!String(ticker).trim()) return;
    var my = ++quoteSeq;
    if (reason === 'manual') setQuoteSrc('Buscando cotação…');
    host.PriceProvider.getQuote(ticker, ui.formType === 'STOCK' ? 'STOCK' : 'CRYPTO')
      .then(function (q) {
        if (my !== quoteSeq) return;
        if (!q || !(q.price > 0)) {
          if (reason === 'manual') setQuoteSrc('Cotação indisponível — preencha manualmente.');
          return;
        }
        var cur = $('pa-f-cur');
        var day = $('pa-f-day');
        if (cur) cur.value = fmtInput(q.price, 8);
        if (day) day.value = fmtInput(q.dailyVariation, 2);
        // Nome vindo da fonte (stocks via Worker): preenche se vazio ou se o
        // campo ainda tem o nome da cotação anterior (troca de ticker);
        // nome digitado pelo usuário nunca é sobrescrito.
        var nam = $('pa-f-name');
        if (nam && q.name) {
          var curName = String(nam.value || '');
          if (!curName.trim() || (quoteAutoName !== null && curName === quoteAutoName)) {
            nam.value = String(q.name).slice(0, 60);
          }
          quoteAutoName = String(nam.value || '');
        }
        quoteAuto = true;
        setQuoteSrc('Cotação automática (' + (q.source || 'api') + ') — ajuste se preciso.');
        refreshMergePreview();
      })
      .catch(function () {
        if (my !== quoteSeq) return;
        if (reason === 'manual') setQuoteSrc('Cotação indisponível — preencha manualmente.');
      });
  }

  function markQuoteManual() {
    quoteAuto = false;
    setQuoteSrc('');
  }

  // No modo remoto, quantidade e preço médio são derivados dos lots.
  // Trava total só na edição de COMPRA. Em VENDA a quantidade abre
  // (é o quanto vai sair); o médio segue travado (venda não define custo).
  function lockCostFields(lockQty, lockAvg) {
    var q = $('pa-f-qty');
    var a = $('pa-f-avg');
    if (q) q.disabled = !!lockQty;
    if (a) a.disabled = !!lockAvg;
  }

  function refreshCostLock() {
    var editingBuy = isRemote() && !!ui.editingTicker && !ui.sellMode;
    var selling = isRemote() && ui.sellMode;
    lockCostFields(editingBuy, editingBuy || selling);
  }

  /* ---------- Form ---------- */
  function readForm() {
    return {
      type: ui.formType,
      ticker: ($('pa-f-ticker') || {}).value || '',
      name: ($('pa-f-name') || {}).value || '',
      quantity: ($('pa-f-qty') || {}).value || '',
      averagePrice: ($('pa-f-avg') || {}).value || '',
      currentPrice: ($('pa-f-cur') || {}).value || '',
      dailyVariation: ($('pa-f-day') || {}).value || ''
    };
  }

  function fillForm(a) {
    $('pa-f-ticker').value = a.ticker;
    $('pa-f-name').value = a.name;
    $('pa-f-qty').value = String(a.quantity).replace('.', ',');
    $('pa-f-avg').value = String(a.averagePrice).replace('.', ',');
    $('pa-f-cur').value = String(a.currentPrice).replace('.', ',');
    $('pa-f-day').value = String(a.dailyVariation).replace('.', ',');
    setFormType(a.type);
  }

  function clearForm() {
    var ids = ['pa-f-ticker', 'pa-f-name', 'pa-f-qty', 'pa-f-avg', 'pa-f-cur', 'pa-f-day'];
    for (var i = 0; i < ids.length; i++) { var el = $(ids[i]); if (el) el.value = ''; }
    ui.editingTicker = null;
        lockCostFields(false, false);
    var btn = $('pa-submit');
    if (btn) btn.textContent = '+ Adicionar ativo';
    var cancel = $('pa-cancel-edit');
    if (cancel) cancel.style.display = 'none';
    var info = $('pa-merge-info');
    if (info) { info.style.display = 'none'; info.textContent = ''; }
    quoteAuto = false;
    quoteAutoName = null;
    setQuoteSrc('');
    setErr('');
  }

  function setErr(msg) {
    var el = $('pa-err');
    if (el) el.textContent = msg || '';
  }

  // Prévia de merge DCA: se o ticker já existe, mostra como fica a posição
  // e troca o botão para "Atualizar posição".
  function refreshMergePreview() {
    var info = $('pa-merge-info');
    var btn = $('pa-submit');
    var hideInfo = function () {
      if (info) { info.style.display = 'none'; info.textContent = ''; }
    };
    if (!service) { hideInfo(); return; }
    // Editando compra: sem preview (é correção cadastral). Editando+venda:
    // mostra o efeito sobre a própria posição (exclui a si mesma da busca).
    var editingBuy = !!ui.editingTicker && !ui.sellMode;
    if (editingBuy) {
      hideInfo();
      if (btn) btn.textContent = 'Salvar alterações';
      return;
    }
    var p = null;
    try { p = service.previewMerge(readForm(), ui.sellMode ? null : ui.editingTicker); } catch (e) { p = null; }
    if (!p || !p.ok) { hideInfo(); return; }
    if (!p.duplicate) {
      if (ui.sellMode && p.value && p.value.ticker) {
        if (info) {
          info.textContent = 'Sem posição em ' + p.value.ticker + ' para vender.';
          info.style.display = '';
        }
        if (btn) btn.textContent = 'Confirmar venda';
      } else {
        hideInfo();
        if (btn) btn.textContent = '+ Adicionar ativo';
      }
      return;
    }
    var ex = p.existing, m = p.merged;
    if (info) {
      if (ui.sellMode) {
        var after = ex.quantity - Math.abs(p.value.quantity);
        info.textContent = 'Vender ' + fmtQty(Math.abs(p.value.quantity)) + ' ' + ex.ticker +
          ': posição passa de ' + fmtQty(ex.quantity) + ' para ' + fmtQty(after) +
          (after < 0 ? ' — SALDO INSUFICIENTE.' : after === 0 ? ' (encerra a posição, histórico preservado).' : '.');
      } else {
        info.textContent = ex.ticker + ' já existe (' + fmtQty(ex.quantity) + ' a ' + fmtMoney(ex.averagePrice) +
          '). Adicionar mais ' + fmtQty(p.value.quantity) + ' atualiza para ' + fmtQty(m.quantity) +
          ' a ' + fmtMoney(m.averagePrice) + ' de preço médio.';
      }
      info.style.display = '';
    }
    if (btn) btn.textContent = ui.sellMode ? 'Confirmar venda' : 'Atualizar posição';
  }

  function setFormType(t) {
    ui.formType = t === 'STOCK' ? 'STOCK' : 'CRYPTO';
    var b1 = $('pa-type-crypto');
    var b2 = $('pa-type-stock');
    if (b1) b1.setAttribute('aria-pressed', String(ui.formType === 'CRYPTO'));
    if (b2) b2.setAttribute('aria-pressed', String(ui.formType === 'STOCK'));
    // Trocar o tipo muda a fonte (Binance↔Stooq): recota se auto/vazio.
    if (!ui.editingTicker && ($('pa-f-ticker') || {}).value) {
      var cur = ($('pa-f-cur') || {}).value || '';
      if (!String(cur).trim() || quoteAuto) fetchQuote('auto');
    }
  }

  // Lado da operação (só modo remoto tem venda; local é sempre compra).
  function setSide(sell) {
    ui.sellMode = !!sell && isRemote();
    var g = $('pa-side-group');
    if (g) g.style.display = isRemote() ? '' : 'none';
    var b1 = $('pa-side-buy');
    var b2 = $('pa-side-sell');
    if (b1) b1.setAttribute('aria-pressed', String(!ui.sellMode));
    if (b2) b2.setAttribute('aria-pressed', String(ui.sellMode));
    refreshCostLock();
    // Label imediato (não depende só do preview, que pode não rodar
    // se os campos ainda estão inválidos).
    var submit = $('pa-submit');
    if (submit) {
      if (ui.editingTicker && !ui.sellMode) submit.textContent = 'Salvar alterações';
      else if (ui.sellMode) submit.textContent = 'Confirmar venda';
    }
    refreshMergePreview();
  }

  // ---------- Preços ao vivo (mesmo motor dos cards do ticker) ----------
  // O ticker despacha "estudebitcoin:ticker-price" {symbol, price, changePct}
  // a cada tick do WebSocket. O painel é só consumidor: atualiza a VISÃO em
  // memória; o snapshot local acompanha via persistLiveLocal (throttle);
  // no remoto, o RTDB sincroniza na próxima escrita (sem gravar por tick).
  // Só CRYPTO (stocks não passam pelo WS; mantêm snapshot + cotação manual).
  var LIVE_WS_TTL_MS = 30000;       // websocket crypto: tick a tick
  var LIVE_SNAPSHOT_TTL_MS = 90000; // snapshot HTTP: cobre o loop de 60s dos stocks + latência
  var RENDER_THROTTLE_MS = 2500; // re-render completo (totais/donut) com throttle
  var live = {};                 // ticker normalizado -> {price, change, at, source}
  var liveTimer = null;

  function normEv(sym) {
    var host = getRoot();
    try {
      if (host && host.BI && host.BI.normalizeSymbol) return host.BI.normalizeSymbol(sym);
    } catch (e) {}
    return String(sym == null ? '' : sym).trim().toUpperCase().replace(/USDT$/, '');
  }

  function liveTtlFor(source) {
    return source === 'websocket' ? LIVE_WS_TTL_MS : LIVE_SNAPSHOT_TTL_MS;
  }

  function liveFresh(t) {
    var l = live[t];
    if (!l) return false;
    return (Date.now() - l.at) <= liveTtlFor(l.source);
  }

  // Visão de um ativo com overlay ao vivo (cópia; nunca muta o service).
  function liveView(a) {
    if (!liveFresh(a.ticker)) return { asset: a, live: false };
    var l = live[a.ticker];
    var na = {};
    for (var k in a) na[k] = a[k];
    na.currentPrice = l.price;
    na.dailyVariation = (l.change == null ? a.dailyVariation : l.change);
    var host = getRoot();
    try {
      if (host && host.PortfolioCalculator) {
        na.calc = host.PortfolioCalculator.enrichPosition({
          quantity: na.quantity, averagePrice: na.averagePrice,
          currentPrice: na.currentPrice, dailyVariation: na.dailyVariation
        });
      }
    } catch (e) {}
    return { asset: na, live: true };
  }

  function onTickerPrice(ev) {
    if (ui.mode === 'locked') return;
    var d = ev && ev.detail;
    var price = d && Number(d.price);
    if (!d || !Number.isFinite(price) || price <= 0) return;
    var t = normEv(d.symbol);
    if (!t || !service || !service.findByTicker) return;
    var found = null;
    try { found = service.findByTicker(t); } catch (e) { found = null; }
    // Crypto (WS tick a tick) e stocks (refresh do ticker a cada 5s/60s) usam
    // o MESMO evento; o motor da carteira não distingue a fonte — só a
    // PRIORIDADE: websocket fresco > snapshot HTTP (price+change juntos).
    if (!found) return;
    // Origem normalizada; evento antigo sem source = snapshot (conservador:
    // nunca derruba um websocket fresco).
    var src = (d.source === 'websocket') ? 'websocket' : 'snapshot';
    var ch = Number(d.changePct);
    var prev = live[t];
    if (src === 'snapshot' && prev && prev.source === 'websocket' &&
        (Date.now() - prev.at) <= LIVE_WS_TTL_MS) {
      return; // WS fresco vence: não toca price, change nem at.
    }
    live[t] = { price: price, change: Number.isFinite(ch) ? ch : null, at: Date.now(), source: src };
    paintLiveRow(t);
    scheduleLiveRender();
  }

  // Atualização cirúrgica da linha (mesmo padrão dos cards: sem re-render).
  function paintLiveRow(t) {
    try {
      var doc = typeof document !== 'undefined' ? document : null;
      if (!doc || !doc.querySelector || !service || !service.findByTicker) return;
      var btn = doc.querySelector('#pa-tbody button[data-ticker="' + t + '"]');
      var tr = btn && btn.closest ? btn.closest('tr') : null;
      if (!tr || !tr.cells || tr.cells.length < 10) return;
      if (!liveFresh(t)) return;
      var found = service.findByTicker(t);
      if (!found) return;
      var qty = Number(found.quantity) || 0, avg = Number(found.averagePrice) || 0;
      var l = live[t];
      var day = l.change == null ? Number(found.dailyVariation) || 0 : l.change;
      var cur = qty * l.price, profit = cur - qty * avg;
      var base = qty * avg;
      var profPct = base > 0 ? (cur / base - 1) * 100 : 0;
      tr.cells[2].innerHTML = esc(fmtMoney(l.price)) + ' <span class="pa-live" title="Preço ao vivo do ticker"></span>';
      tr.cells[5].textContent = fmtMoney(cur);
      tr.cells[6].textContent = fmtMoneySigned(profit);
      tr.cells[6].className = cls(profit);
      tr.cells[7].textContent = fmtPct(profPct);
      tr.cells[7].className = cls(profPct);
      tr.cells[8].textContent = fmtPct(day);
      tr.cells[8].className = cls(day);
    } catch (e) {}
  }

  function scheduleLiveRender() {
    try {
      if (liveTimer) return;
      liveTimer = setTimeout(function () {
        liveTimer = null;
        if (service) render();
      }, RENDER_THROTTLE_MS);
    } catch (e) {}
  }

  // Limpa o estado live (troca de carteira/UID ou de modo). NÃO chamar em
  // refresh normal da mesma carteira (perderia a cotação live a cada load).
  function clearLiveState() {
    live = {};
    try {
      if (liveTimer) { clearTimeout(liveTimer); }
    } catch (e) {}
    liveTimer = null;
  }

  // Persiste o snapshot ao vivo SÓ no modo local (sem custo, sem quota).
  // No modo remoto não grava por tick: o RTDB sincroniza na próxima escrita
  // (compra/venda/edição) e gravar a cada tick seria tempestade de transações.
  var LIVE_PERSIST_MS = 60000;
  function persistLiveLocal() {
    try {
      if (ui.mode !== 'local' || !service || !service.getState) return;
      // Só via replaceAllSilent (SEM fallback para replaceAll: save() carimba
      // updatedAt e violaria o contrato silent). Adapter sem suporte = sem persist.
      if (typeof service.replaceAllSilent !== 'function') return;
      var st = service.getState();
      var list = st && st.assets;
      if (!list || !list.length) return;
      var changed = false;
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (!a || !liveFresh(a.ticker)) continue;
        var l = live[a.ticker];
        if (a.currentPrice !== l.price) { a.currentPrice = l.price; changed = true; }
        var day = l.change == null ? a.dailyVariation : l.change;
        if (a.dailyVariation !== day) { a.dailyVariation = day; changed = true; }
      }
      // Snapshot silencioso: preserva portfolio.updatedAt (carimbo é do usuário).
      if (changed) service.replaceAllSilent(list);
    } catch (e) {}
  }

  // Recarrega o estado a partir do Firestore e re-renderiza pelo
  // mesmo pipeline de cálculo local (donut/tabela/sort/filter).
  function refreshFromRemote() {
    return fb().load().then(function (state) {
      var cloudAssets = (state && state.assets) || [];
      if (!cloudAssets.length) {        // Nuvem vazia + local com dados = migração pendente ou falha.
        // NUNCA substituir a visão local por vazio (evita apagar tudo).
        var localHas = false;
        try {
          var raw = null;
          try { raw = localStorage.getItem('eb_portfolio_v2'); } catch (e) {}
          var ls = raw ? JSON.parse(raw) : null;
          localHas = !!(ls && Array.isArray(ls.assets) && ls.assets.length);
        } catch (e) { localHas = false; }
        if (localHas && service.getState().assets.length) {
          // Nuvem vazia + local com dados = migração pendente ou falha.
          // NUNCA substituir a visão local por vazio (evita apagar tudo)
          // E bloquear escritas: o badge diria Nuvem sobre dados locais.
          ui.needsSync = true;
          setErr('Sincronizando carteira, aguarde e tente de novo.');
          render();
          maybeMigrate();
          return state;
        }
      }
      ui.needsSync = false;
      service.replaceAll(cloudAssets);
      render();
      setBadgeUid();
      return state;
    });
  }

  function enterRemoteMode(uid) {
    if (ui.mode === 'remote' && remoteUid && uid && remoteUid === uid) return;
    // Transição (local→remoto) ou UID diferente: descarta live da origem.
    clearLiveState();
    ui.mode = 'remote';
    remoteUid = uid || remoteUid;
    try { if (fb() && fb().warmup) fb().warmup(remoteUid); } catch (e) {}
    var badge = $('pa-mode-badge');
    if (badge) {
      badge.textContent = 'Nuvem';
      badge.classList.remove('pa-local');
      badge.classList.remove('pa-locked');
    }
    setBadgeUid();
    setSide(false);
    updateLockedUI();
  }

  function enterLocalMode() {
    // Transição (remoto→local): descarta live da nuvem anterior.
    clearLiveState();
    ui.mode = 'local';
    ui.needsSync = false;
    remoteUid = null;
    try { if (fb() && fb().coolDown) fb().coolDown(); } catch (e) {}
    var badge = $('pa-mode-badge');
    if (badge) { badge.textContent = 'Local'; badge.classList.add('pa-local'); badge.classList.remove('pa-locked'); }
    setBadgeUid();
    setSide(false);
    updateLockedUI();
  }

  function enterLockedMode() {
    clearLiveState();
    ui.mode = 'locked';
    ui.needsSync = false;
    remoteUid = null;
    try { if (fb() && fb().coolDown) fb().coolDown(); } catch (e) {}
    var badge = $('pa-mode-badge');
    if (badge) { badge.textContent = 'Login necessário'; badge.classList.remove('pa-local'); badge.classList.add('pa-locked'); badge.title = ''; }
    setSide(false);
    updateLockedUI();
  }

  function updateLockedUI() {
    try {
      var locked = $('pa-locked');
      var isLocked = ui.mode === 'locked';
      if (locked) locked.style.display = isLocked ? '' : 'none';
      var hint = $('pa-auth-hint');
      if (hint) hint.textContent = isLocked
        ? 'Entre para acessar sua carteira sincronizada.'
        : 'Carteira sincronizada na nuvem.';
      var addBtn = $('pa-add-toggle');
      if (addBtn) addBtn.style.display = isLocked ? 'none' : '';
      var formWrap = $('pa-form-wrap');
      if (formWrap && isLocked) formWrap.style.display = 'none';
      var toolbar = document.querySelector('#painel-ativos .pa-toolbar');
      if (toolbar) toolbar.style.display = isLocked ? 'none' : '';
      var grid = document.querySelector('#painel-ativos .pa-grid');
      if (grid) grid.style.display = isLocked ? 'none' : '';
    } catch (e) {}
  }

  // Migração eb_portfolio_v2 → Firestore (uma vez por sessão logada).
  // Nunca apaga o local sem resposta definitiva; remote_exists exige
  // confirmação explícita com as strings exatas da spec.
  var migratedThisSession = false;
  function maybeMigrate() {
    if (migratedThisSession || !isRemote()) return Promise.resolve(null);
    migratedThisSession = true;
    return fb().migrateLocal().then(function (res) {
      if (!res) return null;
      if (res.skipped && res.skipped.length) {
        setErr('Posições não migradas porque estavam zeradas: ' + res.skipped.join(', '));
      }
      if (res.status === 'migrated' || res.status === 'already_migrated') {
        fb().clearLocal();
        return refreshFromRemote();
      }
      if (res.status === 'remote_exists') {
        var ok = false;
        try {
          ok = window.confirm('Já existe carteira remota. Deseja descartar a cópia local?');
        } catch (e) { ok = false; }
        if (ok) {
          fb().clearLocal();
          return refreshFromRemote();
        }
        setErr('Já existe carteira remota. A cópia local foi mantida.');
        return refreshFromRemote();
      }
      return null;
    }).catch(function (err) {
      // Falha NÃO marca a sessão: a retentativa prometida pelo needsSync
      // ("aguarde e tente de novo") precisa tentar de verdade na próxima vez.
      migratedThisSession = false;
      setErr(fb().friendlyError(err));
      return null;
    });
  }

  function onSubmit() {
    if (ui.mode === 'locked') {
      setErr('Entre para acessar sua carteira sincronizada.');
      try { var h = getRoot(); if (h && h.EstudeAuth && h.EstudeAuth.openModal) h.EstudeAuth.openModal('login'); } catch (e) {}
      return;
    }
    var input = readForm();
    if (isRemote()) { onSubmitRemote(input); return; }
    // Login obrigatório: sem sessão autenticada, não grava local silenciosamente.
    try {
      var hostChk = getRoot();
      var cu = hostChk && hostChk.EstudeAuth && hostChk.EstudeAuth.getUser ? hostChk.EstudeAuth.getUser() : null;
      if (!isAuthedUser(cu)) {
        setErr('Entre para acessar sua carteira sincronizada.');
        try { if (hostChk && hostChk.EstudeAuth && hostChk.EstudeAuth.openModal) hostChk.EstudeAuth.openModal('login'); } catch (e) {}
        return;
      }
    } catch (e) {}
    var res;
    if (ui.editingTicker) {
      res = service.update(ui.editingTicker, input);
    } else {
      res = service.add(input, { merge: true });
    }
    if (!res.ok) {
      setErr((res.errors || ['Verifique os campos.']).join(' '));
      return;
    }
    var wasEditing = !!ui.editingTicker;
    var didMerge = !!(res.ok && res.merged);
    clearForm();
    if (wasEditing || didMerge) setFormOpen(false, { noScroll: true });
    render();
  }

  // Submit remoto (async): edição COMPRADA via atualizarAtivo; venda
  // (mesmo dentro da edição) e inclusão via adicionarOuConsolidarAtivo.
  // Resposta autoritativa recarrega o estado; nada é definitivo antes dela.
  function onSubmitRemote(input) {
    setErr('');
    if (ui.needsSync) {
      setErr('Sincronizando carteira, aguarde e tente de novo.');
      maybeMigrate();
      return;
    }
    var isSell = ui.sellMode;
    if (isSell) {
      var q = parseFloat(String(input.quantity).replace(/\./g, '').replace(',', '.'));
      if (String(input.quantity).indexOf(',') === -1) q = Number(input.quantity);
      if (!Number.isFinite(q) || q <= 0) {
        setErr('Informe a quantidade a vender (maior que zero).');
        return;
      }
      input = {
        ticker: input.ticker, name: input.name, type: input.type,
        quantity: -Math.abs(q),
        averagePrice: input.averagePrice,
        currentPrice: input.currentPrice,
        dailyVariation: input.dailyVariation
      };
    }
    // Validação de shape reaproveita as regras locais.
    var chk = service.validate(
      isSell
        ? { ticker: input.ticker, name: input.name, type: input.type, quantity: Math.abs(input.quantity), averagePrice: input.averagePrice, currentPrice: input.currentPrice, dailyVariation: input.dailyVariation }
        : input);
    if (!chk.ok) {
      setErr(chk.errors.join(' '));
      return;
    }
    setBusy(true, (ui.editingTicker && !isSell) ? 'Salvando…' : (isSell ? 'Vendendo…' : 'Adicionando…'));
    var done = function (msg) {
      var keepOpen = !ui.editingTicker && !isSell;
      setBusy(false);
      clearForm();
      // Inclusões sucessivas mantêm o formulário aberto e limpo, igual ao
      // modo local. Edição/venda encerram o fluxo após a confirmação.
      if (!keepOpen) setFormOpen(false, { noScroll: true });
      setSide(false);
      refreshFromRemote().then(function () {
        if (msg) setStatus(msg);
      }).catch(function (err) {
        setErr(fb().friendlyError(err));
      });
    };
    var fail = function (err) {
      setBusy(false);
      setErr(fb().friendlyError(err));
    };
    if (ui.editingTicker && !isSell) {
      var found = service.findByTicker ? service.findByTicker(ui.editingTicker) : null;
      if (!found) {
        fail(new Error('Posição ' + ui.editingTicker + ' mudou — reabra a edição.'));
        return;
      }
      fb().update(found.ticker, input).then(function () {
        done(found.ticker + ' atualizado.');
      }, fail);
    } else {
      fb().add(input).then(function (res) {
        res = res || {};
        var msg = res.action === 'closed'
          ? (res.ticker + ' encerrada. Histórico preservado.')
          : res.action === 'sold'
            ? (res.ticker + ' vendida.')
            : (res.ticker + ' consolidado: ' + res.quantity + '.');
        done(msg);
      }, fail);
    }
  }

  /* ---------- Boot ---------- */
  function bind() {
    var host = getRoot();
    // Guarda de inicialização: bind 2× = 2 listeners + 2 intervals + 2 pagehide.
    if (host && host.__PainelAtivosBound) return;
    if (host) host.__PainelAtivosBound = true;
    var root = $(ROOT_ID);
    if (!root || !host || !host.PortfolioService || !host.PortfolioStorage) return;
    service = host.PortfolioService.createService(host.PortfolioStorage.LocalPortfolioStorage);
    // Login obrigatório: não semear demo como carteira do usuário quando bloqueado.
    // Demo só seria exibida como "Exemplo" em modo local antigo, agora suprimida.

    // Filtros
    var filters = root.querySelectorAll('[data-filter]');
    for (var i = 0; i < filters.length; i++) {
      filters[i].addEventListener('click', function () {
        ui.filter = this.getAttribute('data-filter');
        for (var j = 0; j < filters.length; j++) {
          filters[j].setAttribute('aria-pressed', String(filters[j] === this));
        }
        render();
      });
    }

    // Donut modo
    var modes = root.querySelectorAll('[data-donut]');
    for (var m = 0; m < modes.length; m++) {
      modes[m].addEventListener('click', function () {
        ui.donutMode = this.getAttribute('data-donut');
        for (var j = 0; j < modes.length; j++) {
          modes[j].setAttribute('aria-pressed', String(modes[j] === this));
        }
        render();
      });
    }

    // Sort
    var sort = $('pa-sort');
    if (sort) sort.addEventListener('change', function () { ui.sort = sort.value; render(); });

    // Tipo do form
    var b1 = $('pa-type-crypto');
    var b2 = $('pa-type-stock');
    if (b1) b1.addEventListener('click', function () { setFormType('CRYPTO'); });
    if (b2) b2.addEventListener('click', function () { setFormType('STOCK'); });

    // Prévia de merge ao digitar (ticker, qtd, preços)
    var watchIds = ['pa-f-ticker', 'pa-f-name', 'pa-f-qty', 'pa-f-avg', 'pa-f-cur', 'pa-f-day'];
    for (var w = 0; w < watchIds.length; w++) {
      (function (id) {
        var el = $(id);
        if (el) el.addEventListener('input', refreshMergePreview);
      })(watchIds[w]);
    }

    // Cotação automática: ao trocar o ticker, preenche preço/variação
    // (só se vazios ou vindos de cotação anterior; edição manual prevalece).
    var quoteTimer = null;
    var tickEl = $('pa-f-ticker');
    if (tickEl) tickEl.addEventListener('input', function () {
      if (quoteTimer) clearTimeout(quoteTimer);
      quoteTimer = setTimeout(function () {
        if (ui.editingTicker) return;
        var cur = ($('pa-f-cur') || {}).value || '';
        var day = ($('pa-f-day') || {}).value || '';
        if (!String(cur).trim() || !String(day).trim() || quoteAuto) fetchQuote('auto');
      }, 700);
    });
    var curEl = $('pa-f-cur');
    if (curEl) curEl.addEventListener('input', markQuoteManual);
    var dayEl = $('pa-f-day');
    if (dayEl) dayEl.addEventListener('input', markQuoteManual);
    // Se o usuário digitar o nome, ele assume (auto não sobrescreve mais).
    var namEl = $('pa-f-name');
    if (namEl) namEl.addEventListener('input', function () {
      if (String(namEl.value || '') !== quoteAutoName) quoteAutoName = null;
    });
    var rq = $('pa-refresh-quote');
    if (rq) rq.addEventListener('click', function (e) { e.preventDefault(); fetchQuote('manual'); });

    // Lado compra/venda (só remoto tem venda)
    var sBuy = $('pa-side-buy');
    var sSell = $('pa-side-sell');
    if (sBuy) sBuy.addEventListener('click', function () { setSide(false); });
    if (sSell) sSell.addEventListener('click', function () { setSide(true); });

    // Preços ao vivo: mesmo motor e MESMO ALVO dos cards (o ticker emite em
    // window — listener em document nunca receberia o evento).
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('estudebitcoin:ticker-price', onTickerPrice);
    }
    if (typeof document !== 'undefined' && document.addEventListener) {
      // Snapshot local acompanha (throttle + ao sair); remoto sincroniza em escritas.
      try {
        setInterval(persistLiveLocal, LIVE_PERSIST_MS);
        document.addEventListener('pagehide', persistLiveLocal);
      } catch (e) {}
    }

    // Login obrigatório: CTA do bloqueado
    var loginCta = $('pa-login-cta');
    if (loginCta) loginCta.addEventListener('click', function () {
      try { var h = getRoot(); if (h && h.EstudeAuth && h.EstudeAuth.openModal) h.EstudeAuth.openModal('login'); } catch (e) {}
    });
    // Toggle do formulário (colapsado por padrão)
    var toggle = $('pa-add-toggle');
    if (toggle) toggle.addEventListener('click', function () {
      if (ui.mode === 'locked') {
        setErr('Entre para acessar sua carteira sincronizada.');
        try { var h2 = getRoot(); if (h2 && h2.EstudeAuth && h2.EstudeAuth.openModal) h2.EstudeAuth.openModal('login'); } catch (e) {}
        return;
      }
      clearForm(); setFormOpen(true);
    });
    var closeBtn = $('pa-form-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { clearForm(); setFormOpen(false, { noScroll: true }); });

    // Submit
    var submit = $('pa-submit');
    if (submit) submit.addEventListener('click', function (e) { e.preventDefault(); onSubmit(); });

    // Cancelar edição
    var cancel = $('pa-cancel-edit');
    if (cancel) cancel.addEventListener('click', function (e) { e.preventDefault(); clearForm(); setFormOpen(false, { noScroll: true }); });

    // Ações da tabela (delegação). Identidade por TICKER normalizado:
    // estável entre local e nuvem (ids internos mudam na transição).
    var tbody = $('pa-tbody');
    if (tbody) tbody.addEventListener('click', function (e) {
      if (ui.mode === 'locked') {
        setErr('Entre para acessar sua carteira sincronizada.');
        try { var hh = getRoot(); if (hh && hh.EstudeAuth && hh.EstudeAuth.openModal) hh.EstudeAuth.openModal('login'); } catch (ee) {}
        return;
      }
      var btn = e.target && e.target.closest ? e.target.closest('button[data-act]') : null;
      if (!btn) return;
      var ticker = btn.getAttribute('data-ticker');
      var act = btn.getAttribute('data-act');
      var found = service.findByTicker ? service.findByTicker(ticker) : null;
      if (act === 'del') {
        if (!found) {
          setErr('Posição ' + ticker + ' mudou — atualize a lista e tente de novo.');
          render();
          return;
        }
        if (window.confirm('Excluir ' + found.ticker + ' da carteira?')) {
          if (isRemote()) {
            if (ui.needsSync) {
              setErr('Sincronizando carteira, aguarde e tente de novo.');
              maybeMigrate();
              return;
            }
            // Otimista com rollback: remove visualmente, recarrega se falhar.
            var keep = service.getState().assets.filter(function (a) { return service.normTicker(a.ticker) !== service.normTicker(found.ticker); });
            service.replaceAll(keep);
            if (ui.editingTicker && service.normTicker(ui.editingTicker) === service.normTicker(found.ticker)) clearForm();
            render();
            setStatus('Excluindo ' + found.ticker + '…');
            fb().remove(found.ticker).then(function () {
              setStatus(found.ticker + ' excluída.');
              return refreshFromRemote();
            }).catch(function (err) {
              setErr(fb().friendlyError(err));
              refreshFromRemote();
            });
          } else {
            service.remove(found.id);
            if (ui.editingTicker && service.normTicker(ui.editingTicker) === service.normTicker(found.ticker)) clearForm();
            render();
          }
        }
      } else if (act === 'edit' && found) {
        ui.editingTicker = found.ticker;
        fillForm(found);
        var sb = $('pa-submit');
        if (sb) sb.textContent = 'Salvar alterações';
        if (cancel) cancel.style.display = '';
        var title = $('pa-form-title');
        if (title) {
          title.textContent = isRemote()
            ? 'Editar ' + found.ticker + ' (cadastro e cotação)'
            : 'Editar ' + found.ticker;
        }
        refreshCostLock();
        setErr('');
        if (isRemote()) {
          setStatus('Edição cadastral: quantidade e médio não mudam aqui. Para vender, use VENDER; para corrigir custo, exclua e lance de novo.');
        }
        setFormOpen(true);
      }
    });

    // Limpar exemplos
    var clearDemo = $('pa-clear-demo');
    if (clearDemo) clearDemo.addEventListener('click', function () {
      var keep = service.getState().assets.filter(function (a) { return !a.demo; });
      service.replaceAll(keep);
      render();
    });

    // Vazio: CTA
    var emptyBtn = $('pa-empty-add');
    if (emptyBtn) emptyBtn.addEventListener('click', function () {
      if (ui.mode === 'locked') {
        setErr('Entre para acessar sua carteira sincronizada.');
        try { var h3 = getRoot(); if (h3 && h3.EstudeAuth && h3.EstudeAuth.openModal) h3.EstudeAuth.openModal('login'); } catch (e) {}
        return;
      }
      clearForm(); setFormOpen(true);
    });

    setFormType('CRYPTO');
    setFormOpen(false, { noScroll: true });
    setSide(false);
    // Login obrigatório: inicia bloqueado, sem carteira local silenciosa.
    enterLockedMode();
    render();

    // Fase 2: apenas com usuário autenticado (não anônimo) entra em Nuvem.
    try {
      var host2 = getRoot();
      if (host2 && host2.FirebasePortfolio && host2.FirebasePortfolio.isConfigured() &&
          host2.EstudeAuth && host2.EstudeAuth.whenReady && host2.EstudeAuth.onAuthChange) {
        var goRemoteAuthed = function (uid) {
          enterRemoteMode(uid);
          setStatus('Carregando carteira…');
          // Migrar ANTES do primeiro load quando houver dados locais pendentes.
          maybeMigrate().then(function () {
            return refreshFromRemote();
          }).then(function () {
            setStatus('');
          }).catch(function (err) {
            if (err && err.code === 'offline') {
              setErr('Sem conexão.');
              enterLockedMode();
              render();
            } else {
              setErr(err && err.message ? err.message : 'Não foi possível carregar a carteira.');
              enterLockedMode();
              render();
            }
          });
        };
        var checkAuthAndGo = function () {
          var cur = null;
          try { cur = host2.EstudeAuth.getUser(); } catch (e) {}
          if (isAuthedUser(cur)) {
            goRemoteAuthed(cur.id);
          } else {
            // Sem sessão ou anônimo: permanece bloqueado, não cria anônimo, não migra, não apaga.
            enterLockedMode();
            render();
          }
        };
        host2.EstudeAuth.whenReady().then(function () { checkAuthAndGo(); })
          .catch(function () { checkAuthAndGo(); });
        host2.EstudeAuth.onAuthChange(function (user) {
          if (isAuthedUser(user)) {
            if (ui.mode !== 'remote' || remoteUid !== user.id) goRemoteAuthed(user.id);
          } else {
            // Logout ou anônimo: bloqueia (nunca Nuvem para anônimo)
            if (ui.mode === 'remote' || ui.mode === 'locked') {
              enterLockedMode();
              render();
            } else {
              // já bloqueado: apenas garante estado
              enterLockedMode();
              render();
            }
          }
        });
      } else {
        enterLockedMode();
        render();
      }
    } catch (e) { enterLockedMode(); render(); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  var _host = getRoot();
  if (_host) _host.PainelAtivos = {
    render: render,
    getUI: function () { return ui; },
    getService: function () { return service; },
    maybeMigrate: maybeMigrate,
    onTickerPrice: onTickerPrice,
    persistLiveLocal: persistLiveLocal,
    enterRemoteMode: enterRemoteMode,
    enterLocalMode: enterLocalMode,
    // Superfície de teste (isolada, sem efeito no comportamento normal).
    _test: {
      setTtl: function (ms) { // compat: ajusta ambos
        var old = LIVE_WS_TTL_MS;
        if (Number.isFinite(ms) && ms >= 0) { LIVE_WS_TTL_MS = ms; LIVE_SNAPSHOT_TTL_MS = ms; }
        return old;
      },
      setWsTtl: function (ms) { var old = LIVE_WS_TTL_MS; if (Number.isFinite(ms) && ms >= 0) LIVE_WS_TTL_MS = ms; return old; },
      setSnapshotTtl: function (ms) { var old = LIVE_SNAPSHOT_TTL_MS; if (Number.isFinite(ms) && ms >= 0) LIVE_SNAPSHOT_TTL_MS = ms; return old; },
      getTtls: function () { return { ws: LIVE_WS_TTL_MS, snapshot: LIVE_SNAPSHOT_TTL_MS }; },
      clearLive: clearLiveState,
      getLive: function () { var o = {}; for (var k in live) o[k] = live[k]; return o; }
    }
  };
})();
