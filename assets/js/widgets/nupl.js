window.BIWidgets = window.BIWidgets || {};

window.BIWidgets.nupl = async function () {
  var container = document.getElementById('nupl-root');
  if (!container) return;

  container.innerHTML = `
    <div class="btc-ultra-card nupl-widget">
      <div class="nupl-header">
        <div>
          <h3 class="nupl-title">NUPL — Lucro/Prejuízo Não Realizado</h3>
          <p class="nupl-subtitle">Sentimento do mercado medido pelo lucro ou prejuízo não realizado.</p>
        </div>
        <div class="nupl-values" aria-live="polite">
          <span><small>NUPL atual</small><strong id="nupl-current">—</strong></span>
          <span><small>Fase do mercado</small><strong id="nupl-phase">—</strong></span>
          <span><small>Dados até</small><strong id="nupl-latest-date">—</strong></span>
        </div>
        <div class="nupl-filters" aria-label="Período do gráfico NUPL">
          <button type="button" data-range="1">1 ano</button>
          <button type="button" data-range="3">3 anos</button>
          <button type="button" data-range="2021" class="active">Desde 2021</button>
          <button type="button" data-range="max">Máx.</button>
        </div>
      </div>
      <div class="nupl-chart-wrap">
        <canvas id="nupl-chart" aria-label="Gráfico histórico do preço do Bitcoin e das fases do NUPL"></canvas>
      </div>
      <p class="nupl-note">
        O NUPL compara o lucro ou prejuízo não realizado dos investidores com o valor de mercado.
        As cores mostram a fase predominante: euforia, crença, otimismo, medo ou capitulação.
        Fonte: <a href="https://charts.checkonchain.com/btconchain/unrealised/nupl/nupl_light.html"
          target="_blank" rel="noopener noreferrer">Checkonchain</a>.
      </p>
    </div>`;

  var payload = await loadData();
  if (!validPayload(payload)) {
    container.innerHTML = '<div class="btc-ultra-card nupl-error">Não foi possível carregar os dados do NUPL.</div>';
    return;
  }
  if (typeof Chart === 'undefined') await BI.loadScript(window.BI_CONFIG.cdn.chartjs);

  var chart;
  var selectedRange = '2021';
  var money = new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0
  });
  var decimal = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 3, maximumFractionDigits: 3
  });
  var zones = [
    { key: 'euphoria', label: 'Euforia/Ganância', color: '#45a9f3' },
    { key: 'belief', label: 'Crença/Negação', color: '#48d7aa' },
    { key: 'optimism', label: 'Otimismo', color: '#f2a33b' },
    { key: 'hopeFear', label: 'Esperança/Medo', color: '#e8c14c' },
    { key: 'capitulation', label: 'Capitulação', color: '#f05b78' }
  ];

  setLatestSummary();
  container.querySelectorAll('.nupl-filters button').forEach(function (button) {
    button.addEventListener('click', function () {
      selectedRange = button.dataset.range;
      container.querySelectorAll('.nupl-filters button').forEach(function (item) {
        item.classList.toggle('active', item === button);
      });
      render();
    });
  });
  render();

  async function loadData() {
    if (location.protocol !== 'file:') {
      try {
        var response = await fetch(window.BI_CONFIG.data.nupl);
        if (response.ok) return await response.json();
      } catch (error) {}
    }
    try {
      await BI.loadScript(window.BI_CONFIG.data.nuplScript);
      return window.BI_NUPL_HISTORY || null;
    } catch (error) {
      return null;
    }
  }

  function validPayload(data) {
    return data && Array.isArray(data.dates) && Array.isArray(data.price) &&
      zones.every(function (zone) { return Array.isArray(data[zone.key]); });
  }

  function setLatestSummary() {
    var latest = null;
    for (var i = payload.dates.length - 1; i >= 0 && !latest; i -= 1) {
      for (var z = 0; z < zones.length; z += 1) {
        var value = payload[zones[z].key][i];
        if (Number.isFinite(value)) {
          latest = { value: value, zone: zones[z], date: payload.dates[i] };
          break;
        }
      }
    }

    var valueElement = document.getElementById('nupl-current');
    var phaseElement = document.getElementById('nupl-phase');
    var dateElement = document.getElementById('nupl-latest-date');
    if (!latest) {
      valueElement.textContent = '—';
      phaseElement.textContent = '—';
      dateElement.textContent = '—';
      return;
    }
    valueElement.textContent = decimal.format(latest.value);
    phaseElement.textContent = latest.zone.label;
    valueElement.style.color = latest.zone.color;
    phaseElement.style.color = latest.zone.color;
    dateElement.textContent = formatDate(latest.date);
  }

  function cutoffDate() {
    if (selectedRange === 'max') return null;
    if (selectedRange === '2021') return '2021-01-01';
    var lastDate = payload.latestDataDate || payload.dates[payload.dates.length - 1];
    var cutoff = new Date(lastDate + 'T00:00:00Z');
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - Number(selectedRange));
    return cutoff.toISOString().slice(0, 10);
  }

  function render() {
    var cutoff = cutoffDate();
    var start = 0;
    if (cutoff) {
      start = payload.dates.findIndex(function (date) { return date >= cutoff; });
      if (start < 0) start = payload.dates.length - 1;
    }

    var step = selectedRange === 'max' ? 7 : 1;
    var labels = [];
    var price = [];
    var zoneData = {};
    zones.forEach(function (zone) { zoneData[zone.key] = []; });

    for (var i = start; i < payload.dates.length; i += step) {
      labels.push(payload.dates[i]);
      price.push(payload.price[i]);
      zones.forEach(function (zone) {
        zoneData[zone.key].push(payload[zone.key][i]);
      });
    }
    if (labels[labels.length - 1] !== payload.dates[payload.dates.length - 1]) {
      var last = payload.dates.length - 1;
      labels.push(payload.dates[last]);
      price.push(payload.price[last]);
      zones.forEach(function (zone) {
        zoneData[zone.key].push(payload[zone.key][last]);
      });
    }

    var datasets = [priceLine(price)];
    zones.forEach(function (zone) {
      datasets.push(nuplLine(zone.label, zoneData[zone.key], zone.color));
    });

    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('nupl-chart'), {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        normalized: true,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            grid: { display: false },
            border: { display: true, color: 'rgba(255,255,255,.22)', width: 1 },
            ticks: {
              color: '#8d939d',
              maxTicksLimit: 8,
              maxRotation: 0,
              callback: function (value) {
                var parts = String(this.getLabelForValue(value)).split('-');
                return parts.length === 3 ? parts[2] + '/' + parts[1] + '/' + parts[0].slice(2) : '';
              }
            }
          },
          price: {
            type: 'logarithmic',
            position: 'left',
            grid: { drawOnChartArea: false },
            border: { display: true, color: 'rgba(255,255,255,.24)', width: 1 },
            ticks: {
              color: '#8d939d',
              callback: function (value) { return '$' + compact(value); }
            }
          },
          nupl: {
            type: 'linear',
            position: 'right',
            suggestedMin: -0.6,
            suggestedMax: 1,
            grid: {
              color: function (context) {
                return context.tick && context.tick.value === 0
                  ? 'rgba(255,255,255,.42)'
                  : 'rgba(255,255,255,.06)';
              },
              lineWidth: function (context) {
                return context.tick && context.tick.value === 0 ? 1.5 : 1;
              }
            },
            border: { display: true, color: 'rgba(255,255,255,.30)', width: 1 },
            ticks: {
              color: '#8d939d',
              callback: function (value) {
                return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
              }
            }
          }
        },
        plugins: {
          legend: {
            labels: {
              color: '#d7d9de',
              usePointStyle: true,
              pointStyle: 'line',
              padding: 16
            }
          },
          tooltip: {
            filter: function (context) { return context.parsed.y !== null; },
            callbacks: {
              title: function (items) {
                return items.length ? formatDate(items[0].label) : '';
              },
              label: function (context) {
                if (context.parsed.y === null) return '';
                return context.dataset.yAxisID === 'price'
                  ? context.dataset.label + ': ' + money.format(context.parsed.y)
                  : context.dataset.label + ': ' + decimal.format(context.parsed.y);
              }
            }
          }
        }
      }
    });
  }

  function priceLine(data) {
    return {
      label: 'Preço BTC',
      data: data,
      yAxisID: 'price',
      borderColor: '#d7d9de',
      backgroundColor: '#d7d9de',
      borderWidth: 1.2,
      pointRadius: 0,
      pointHitRadius: 8,
      tension: 0.1,
      spanGaps: true
    };
  }

  function nuplLine(label, data, color) {
    return {
      label: label,
      data: data,
      yAxisID: 'nupl',
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      pointRadius: 0,
      pointHitRadius: 8,
      tension: 0.08,
      spanGaps: false
    };
  }

  function compact(value) {
    if (value >= 1000) return Math.round(value / 1000) + 'k';
    return value;
  }

  function formatDate(value) {
    return new Date(value + 'T12:00:00Z').toLocaleDateString('pt-BR');
  }
};
