/* =====================================================================
   WIDGET: Strategy — Tesouraria Bitcoin
   Dados oficiais: Strategy API + dados/strategy.json
   ===================================================================== */
window.BIWidgets = window.BIWidgets || {};

window.BIWidgets.strategyTreasury = async function () {
  'use strict';

  var root = document.getElementById('strategy-root');
  if (!root || root.dataset.loaded === 'true') return;
  root.dataset.loaded = 'true';

  root.innerHTML = `
    <div class="strategy__card">
      <div class="strategy__header">
        <div>
          <div class="strategy__eyebrow">TESOURARIA CORPORATIVA</div>
          <h2 class="strategy__title">Strategy — Tesouraria Bitcoin</h2>
          <p class="strategy__subtitle">Reserva, compras e múltiplo sobre o valor dos bitcoins da empresa.</p>
        </div>
        <div class="strategy__status"><span class="strategy__status-dot"></span><span id="strategy-status">CARREGANDO</span></div>
      </div>

      <div class="strategy__warning"><strong>MSTR não é Bitcoin.</strong> A ação envolve riscos empresariais, dívida, diluição e prêmio ou desconto de mercado.</div>

      <div class="strategy__metrics" aria-label="Indicadores principais da Strategy">
        <div class="strategy__metric"><span>BTC em reserva</span><strong id="strategy-btc">—</strong><small id="strategy-supply">—</small></div>
        <div class="strategy__metric"><span>Preço médio</span><strong id="strategy-average">—</strong><small>Custo médio acumulado</small></div>
        <div class="strategy__metric"><span>Valor da reserva</span><strong id="strategy-reserve">—</strong><small id="strategy-btc-price">—</small></div>
        <div class="strategy__metric strategy__metric--accent"><span>mNAV oficial</span><strong id="strategy-mnav">—</strong><small>Valor empresarial ÷ reserva BTC</small></div>
      </div>

      <div class="strategy__layout">
        <div class="strategy__chart-card">
          <div class="strategy__chart-head">
            <div>
              <h3>mNAV e compras de Bitcoin</h3>
              <p>As barras marcam movimentações de BTC; a linha mostra o múltiplo oficial.</p>
            </div>
            <div class="strategy__tf-group" role="group" aria-label="Período do gráfico">
              <button type="button" class="strategy__tf" data-period="1D">1D</button>
              <button type="button" class="strategy__tf" data-period="1W">1S</button>
              <button type="button" class="strategy__tf active" data-period="1M">1M</button>
              <button type="button" class="strategy__tf" data-period="1Y">1A</button>
              <button type="button" class="strategy__tf" data-period="MAX">MÁX</button>
            </div>
          </div>
          <div class="strategy__chart-wrap"><canvas id="strategy-mnav-chart"></canvas></div>
          <div class="strategy__chart-stats">
            <span>Atual <strong id="strategy-chart-current">—</strong></span>
            <span>Mínimo <strong id="strategy-chart-min">—</strong></span>
            <span>Máximo <strong id="strategy-chart-max">—</strong></span>
            <span>Variação <strong id="strategy-chart-change">—</strong></span>
          </div>
          <div class="strategy__mnav-guide" aria-label="Como interpretar o mNAV">
            <div><strong class="strategy__mnav-neutral">mNAV = 1</strong><span>Empresa avaliada pelo valor de sua reserva em Bitcoin.</span></div>
            <div><strong class="strategy__mnav-premium">mNAV &gt; 1</strong><span>Ação com prêmio: mercado otimista espera retornos maiores.</span></div>
            <div><strong class="strategy__mnav-discount">mNAV &lt; 1</strong><span>Ação com desconto: mercado precifica riscos e dívidas.</span></div>
          </div>
          <div class="strategy__availability" id="strategy-availability"></div>
        </div>

        <div class="strategy__side">
          <div class="strategy__purchase-card">
            <div class="strategy__section-label">ÚLTIMA COMPRA REALIZADA</div>
            <div class="strategy__purchase-date" id="strategy-purchase-date">—</div>
            <div class="strategy__purchase-main"><strong id="strategy-purchase-btc">—</strong><span>BTC</span></div>
            <div class="strategy__purchase-grid">
              <div><span>Preço médio</span><strong id="strategy-purchase-price">—</strong></div>
              <div><span>Investimento</span><strong id="strategy-purchase-total">—</strong></div>
            </div>
            <a id="strategy-purchase-source" class="strategy__source-link" href="https://www.strategy.com/purchases" target="_blank" rel="noopener noreferrer">Ver documento oficial ↗</a>
          </div>

          <div class="strategy__calculator">
            <div class="strategy__section-label">CALCULADORA DA RESERVA</div>
            <label for="strategy-future-price">Se o Bitcoin chegar a</label>
            <div class="strategy__input-wrap"><span>US$</span><input id="strategy-future-price" type="text" inputmode="numeric" value="150.000" aria-label="Preço futuro do Bitcoin em dólares"></div>
            <input id="strategy-future-slider" class="strategy__slider" type="range" min="10000" max="1000000" step="10000" value="150000">
            <div class="strategy__calc-results">
              <div><span>Reserva projetada</span><strong id="strategy-projected-reserve">—</strong></div>
              <div><span>Resultado vs. custo</span><strong id="strategy-projected-result">—</strong></div>
            </div>
            <p>Simulação da reserva de BTC; não projeta o preço da ação MSTR.</p>
          </div>
        </div>
      </div>

      <div class="strategy__footer">
        <span id="strategy-updated">Atualizando fonte…</span>
        <span>Fontes: <a href="https://www.strategy.com/purchases" target="_blank" rel="noopener noreferrer">Strategy Purchases</a> e <a href="https://www.strategy.com/charts" target="_blank" rel="noopener noreferrer">Strategy Analytics</a>.</span>
      </div>
      <div class="strategy__error" id="strategy-error" hidden></div>
    </div>`;

  var CFG = window.BI_CONFIG;
  var compras = [];
  var purchaseDataCache = null;
  var current = null;
  var chart = null;
  var activePeriod = '1M';
  var historyController = null;

  function num(value) {
    if (typeof value === 'number') return value;
    return Number(String(value == null ? '' : value).replace(/,/g, ''));
  }

  function fmtInt(value) {
    return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  }

  function fmtUsd(value, decimals) {
    return 'US$ ' + Number(value).toLocaleString('pt-BR', {
      minimumFractionDigits: decimals == null ? 0 : decimals,
      maximumFractionDigits: decimals == null ? 0 : decimals
    });
  }

  function fmtCompactUsd(value) {
    var abs = Math.abs(value);
    var sign = value < 0 ? '-' : '';
    if (abs >= 1e12) return sign + 'US$ ' + (abs / 1e12).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' tri';
    if (abs >= 1e9) return sign + 'US$ ' + (abs / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' bi';
    if (abs >= 1e6) return sign + 'US$ ' + (abs / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
    return fmtUsd(value, 0);
  }

  function fmtDate(value) {
    if (!value) return '—';
    return new Date(value.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('pt-BR');
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  function parseInput(value) {
    return Math.max(0, Number(String(value).replace(/\./g, '').replace(',', '.')) || 0);
  }

  function renderCurrent(mstrData, btcData, purchaseData) {
    var mstr = Array.isArray(mstrData) ? mstrData[0] : null;
    var btc = btcData && btcData.results;
    var latestMovement = purchaseData.compras[purchaseData.compras.length - 1];
    var latestBuy = purchaseData.compras.filter(function (item) {
      return !item.venda && item.quantidadeBtc > 0;
    }).pop();

    if (!mstr || !btc || !latestMovement || !latestBuy) throw new Error('Dados oficiais incompletos.');

    var enterpriseValue = num(mstr.entVal) * 1000000;
    var reserveValue = num(btc.btcNavNumber) * 1000000;
    var mnav = reserveValue > 0 ? enterpriseValue / reserveValue : 0;

    current = {
      holdings: num(btc.btcHoldings),
      btcPrice: num(btc.latestPrice),
      reserveValue: reserveValue,
      mnav: mnav,
      averagePrice: latestMovement.precoMedioAcumuladoUsd,
      totalCost: latestMovement.custoTotalAcumuladoUsd,
      updatedAt: btcData.timestamp || mstr.timeStampUtc || purchaseData.atualizadoEm
    };

    setText('strategy-btc', '₿ ' + fmtInt(current.holdings));
    setText('strategy-supply', num(btc.pctOfBtcTotalSupply).toLocaleString('pt-BR', { maximumFractionDigits: 3 }) + '% dos 21 milhões');
    setText('strategy-average', fmtUsd(current.averagePrice, 0));
    setText('strategy-reserve', fmtCompactUsd(current.reserveValue));
    setText('strategy-btc-price', 'BTC a ' + fmtUsd(current.btcPrice, 0));
    setText('strategy-mnav', current.mnav.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + 'x');

    setText('strategy-purchase-date', fmtDate(latestBuy.data));
    setText('strategy-purchase-btc', fmtInt(latestBuy.quantidadeBtc));
    setText('strategy-purchase-price', fmtUsd(latestBuy.precoOperacaoUsd, 0));
    setText('strategy-purchase-total', fmtCompactUsd(latestBuy.valorOperacaoUsd));
    var sourceLink = document.getElementById('strategy-purchase-source');
    if (sourceLink && latestBuy.documentoSec) sourceLink.href = latestBuy.documentoSec;

    var timestamp = String(current.updatedAt || '');
    if (timestamp && !/[zZ]|[+-]\\d{2}:?\\d{2}$/.test(timestamp)) timestamp += 'Z';
    var updated = new Date(timestamp);
    setText('strategy-updated', 'Atualizado em ' + updated.toLocaleString('pt-BR', {
      dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo'
    }) + ' (horário de Brasília)');
    setText('strategy-status', 'DADOS OFICIAIS');
    root.classList.add('strategy--ready');
    updateCalculator();
  }

  function periodStart(period) {
    var now = new Date();
    var start = new Date(now);
    if (period === '1D') start.setDate(start.getDate() - 7);
    if (period === '1W') start.setDate(start.getDate() - 7);
    if (period === '1M') start.setMonth(start.getMonth() - 1);
    if (period === '1Y') start.setFullYear(start.getFullYear() - 1);
    if (period === 'MAX') start = new Date('2024-12-01T00:00:00Z');
    return start;
  }

  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  async function loadHistory(period) {
    if (historyController) historyController.abort();
    historyController = new AbortController();
    var start = periodStart(period);
    var end = new Date();
    var url = CFG.api.strategyTimeSeries + '?from=' + isoDate(start) + '&to=' + isoDate(end) + '&tickers=MSTR&metrics=mNav';

    root.classList.add('strategy--loading-chart');
    try {
      var response = await fetch(url, { signal: historyController.signal });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var payload = await response.json();
      var values = payload && payload[0] && Array.isArray(payload[0].values) ? payload[0].values : [];
      var points = prepareHistory(values, start, end, period);
      if (!points.length) throw new Error('Sem histórico de mNAV para o período.');
      renderHistory(points, start, period);
    } catch (error) {
      if (error.name !== 'AbortError') {
        var cached = purchaseDataCache && Array.isArray(purchaseDataCache.mnavHistorico) ? purchaseDataCache.mnavHistorico : [];
        var fallbackPoints = prepareHistory(cached, start, end, period);
        if (fallbackPoints.length) {
          renderHistory(fallbackPoints, start, period);
          setText('strategy-availability', 'Exibindo o último histórico oficial salvo.');
        } else {
          showError('Não foi possível carregar o histórico de mNAV.');
        }
      }
    } finally {
      root.classList.remove('strategy--loading-chart');
    }
  }

  function prepareHistory(values, start, end, period) {
    var from = isoDate(start);
    var to = isoDate(end);
    var points = values.filter(function (item) {
      var date = String(item.date || '').slice(0, 10);
      var rawMnav = item.mNav;
      return date >= from && date <= to && rawMnav !== null && rawMnav !== undefined && rawMnav !== '' && num(rawMnav) > 0;
    });
    if (period === '1D') points = points.slice(0, 2);
    points.reverse();
    return points;
  }

  function renderHistory(points, requestedStart, period) {
    var values = points.map(function (item) { return num(item.mNav); });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var first = values[0];
    var last = values[values.length - 1];
    var change = first ? ((last / first) - 1) * 100 : 0;

    setText('strategy-chart-current', last.toFixed(2) + 'x');
    setText('strategy-chart-min', min.toFixed(2) + 'x');
    setText('strategy-chart-max', max.toFixed(2) + 'x');
    setText('strategy-chart-change', (change >= 0 ? '+' : '') + change.toFixed(2) + '%');
    var changeEl = document.getElementById('strategy-chart-change');
    if (changeEl) changeEl.className = change >= 0 ? 'strategy__positive' : 'strategy__negative';

    var earliest = points[0].date.slice(0, 10);
    var note = '';
    if (period === 'MAX' && earliest > isoDate(requestedStart)) {
      note = 'Histórico oficial de mNAV disponível desde ' + fmtDate(earliest) + '.';
    }
    setText('strategy-availability', note);

    var purchasesByDate = new Map();
    compras.forEach(function (item) {
      if (item.data >= points[0].date.slice(0, 10) && item.data <= points[points.length - 1].date.slice(0, 10)) {
        purchasesByDate.set(item.data, (purchasesByDate.get(item.data) || 0) + item.quantidadeBtc);
      }
    });
    var purchaseBars = points.map(function (item) { return purchasesByDate.get(item.date.slice(0, 10)) || null; });

    var ctx = document.getElementById('strategy-mnav-chart').getContext('2d');
    if (chart) chart.destroy();
    chart = new Chart(ctx, {
      data: {
        labels: points.map(function (item) { return item.date.slice(0, 10); }),
        datasets: [
          {
            type: 'line', label: 'mNAV', data: values, borderColor: '#f7931a', backgroundColor: 'rgba(247,147,26,0.16)',
            fill: true, borderWidth: 2.5, pointRadius: 0, pointHitRadius: 10, tension: 0.25, yAxisID: 'y', order: 1
          },
          {
            type: 'bar', label: 'BTC movimentado', data: purchaseBars, backgroundColor: purchaseBars.map(function (v) { return v != null && v < 0 ? 'rgba(255,77,109,0.55)' : 'rgba(74,222,128,0.55)'; }),
            borderRadius: 3, yAxisID: 'y1', order: 2
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#8a8f9e', maxTicksLimit: 7, maxRotation: 0, callback: function (value) { return fmtDate(this.getLabelForValue(value)); } } },
          y: { position: 'left', grid: { color: function (c) { return c.tick.value === 1 ? 'rgba(247,147,26,0.35)' : 'rgba(255,255,255,0.07)'; } }, ticks: { color: '#c9ccd4', callback: function (v) { return Number(v).toFixed(2) + 'x'; } } },
          y1: { display: false, position: 'right', grid: { display: false } }
        },
        plugins: {
          legend: { labels: { color: '#d9dce3', usePointStyle: true, boxWidth: 8 } },
          tooltip: { callbacks: {
            title: function (items) { return items.length ? fmtDate(items[0].label) : ''; },
            label: function (item) { return item.dataset.yAxisID === 'y' ? ' mNAV: ' + Number(item.parsed.y).toFixed(2) + 'x' : ' BTC movimentado: ' + fmtInt(item.parsed.y); }
          } }
        }
      }
    });
  }

  function updateCalculator() {
    if (!current) return;
    var input = document.getElementById('strategy-future-price');
    var price = parseInput(input.value);
    if (!price) return;
    var projected = current.holdings * price;
    var result = projected - current.totalCost;
    setText('strategy-projected-reserve', fmtCompactUsd(projected));
    setText('strategy-projected-result', (result >= 0 ? '+' : '') + fmtCompactUsd(result));
    var resultEl = document.getElementById('strategy-projected-result');
    if (resultEl) resultEl.className = result >= 0 ? 'strategy__positive' : 'strategy__negative';
  }

  function showError(message) {
    var el = document.getElementById('strategy-error');
    if (el) { el.hidden = false; el.textContent = message; }
  }

  document.querySelectorAll('.strategy__tf').forEach(function (button) {
    button.addEventListener('click', function () {
      if (button.dataset.period === activePeriod) return;
      document.querySelectorAll('.strategy__tf').forEach(function (item) { item.classList.remove('active'); });
      button.classList.add('active');
      activePeriod = button.dataset.period;
      loadHistory(activePeriod);
    });
  });

  var priceInput = document.getElementById('strategy-future-price');
  var priceSlider = document.getElementById('strategy-future-slider');
  priceInput.addEventListener('input', function () {
    var value = parseInput(priceInput.value);
    if (value >= Number(priceSlider.min) && value <= Number(priceSlider.max)) priceSlider.value = value;
    updateCalculator();
  });
  priceInput.addEventListener('blur', function () {
    var value = parseInput(priceInput.value);
    priceInput.value = fmtInt(value);
    updateCalculator();
  });
  priceSlider.addEventListener('input', function () {
    priceInput.value = fmtInt(priceSlider.value);
    updateCalculator();
  });

  async function loadPurchaseData() {
    if (location.protocol !== 'file:') {
      try {
        return await loadPurchaseData();
      } catch (error) {
        console.warn('[Strategy] JSON local indisponível; usando arquivo compatível.', error);
      }
    }
    await BI.loadScript(CFG.data.strategyPurchasesScript);
    if (!window.BI_STRATEGY_DATA) throw new Error('Histórico local da Strategy indisponível.');
    return window.BI_STRATEGY_DATA;
  }

  try {
    purchaseDataCache = await loadPurchaseData();
    compras = purchaseDataCache.compras || [];
    var live = await Promise.allSettled([
      BI.fetchJSON(CFG.api.strategyMstr, { timeout: 10000 }),
      BI.fetchJSON(CFG.api.strategyBtc, { timeout: 10000 })
    ]);
    var mstrData = live[0].status === 'fulfilled' ? live[0].value : [purchaseDataCache.snapshot.mstr];
    var btcData = live[1].status === 'fulfilled' ? live[1].value : { results: purchaseDataCache.snapshot.bitcoin, timestamp: purchaseDataCache.snapshot.timestamp };
    renderCurrent(mstrData, btcData, purchaseDataCache);
    try {
      if (typeof Chart === 'undefined') await BI.loadScript(CFG.cdn.chartjs);
      await loadHistory(activePeriod);
    } catch (chartError) {
      showError('Indicadores carregados, mas o gráfico está temporariamente indisponível.');
      console.error('[Strategy gráfico]', chartError);
    }
  } catch (error) {
    setText('strategy-status', 'INDISPONÍVEL');
    showError('Dados da Strategy temporariamente indisponíveis. Tente novamente mais tarde.');
    console.error('[Strategy]', error);
  }
};