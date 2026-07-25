window.BIWidgets = window.BIWidgets || {};

window.BIWidgets.costBasis = async function () {
  var container = document.getElementById('costbasis-root');
  if (!container) return;

  container.innerHTML = `
    <div class="btc-ultra-card costbasis-widget">
      <div class="costbasis-header">
        <div>
          <h3 class="costbasis-title">Base de Custo do Bitcoin</h3>
          <p class="costbasis-subtitle">Preço de mercado versus custo médio dos investidores.</p>
        </div>
        <div class="costbasis-values" aria-live="polite">
          <span><small>Realized Price</small><strong id="costbasis-realized">—</strong></span>
          <span><small>LTH Cost Basis</small><strong id="costbasis-lth">—</strong></span>
        </div>
        <div class="costbasis-filters" aria-label="Período do gráfico">
          <button type="button" data-range="1">1 ano</button>
          <button type="button" data-range="3">3 anos</button>
          <button type="button" data-range="2021" class="active">Desde 2021</button>
          <button type="button" data-range="max">Máx.</button>
        </div>
      </div>
      <div class="costbasis-chart-wrap">
        <canvas id="costbasis-chart" aria-label="Gráfico histórico do preço do Bitcoin, Realized Price e LTH Cost Basis"></canvas>
      </div>
      <p class="costbasis-note">
        Realized Price representa o custo médio de todo o mercado. LTH Cost Basis considera investidores de longo prazo.
        Fonte: <a href="https://charts.checkonchain.com/btconchain/pricing/pricing_costbasisoriginals/pricing_costbasisoriginals_light.html"
          target="_blank" rel="noopener noreferrer">Checkonchain</a>.
      </p>
    </div>`;

  var payload = await loadData();
  if (!validPayload(payload)) {
    container.innerHTML = '<div class="btc-ultra-card costbasis-error">Não foi possível carregar os dados de base de custo.</div>';
    return;
  }
  if (typeof Chart === 'undefined') await BI.loadScript(window.BI_CONFIG.cdn.chartjs);

  var chart;
  var selectedRange = '2021';
  var money = new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0
  });

  setLatestValue('costbasis-realized', payload.realised);
  setLatestValue('costbasis-lth', payload.lth);

  container.querySelectorAll('.costbasis-filters button').forEach(function (button) {
    button.addEventListener('click', function () {
      selectedRange = button.dataset.range;
      container.querySelectorAll('.costbasis-filters button').forEach(function (item) {
        item.classList.toggle('active', item === button);
      });
      render();
    });
  });
  render();

  async function loadData() {
    if (location.protocol !== 'file:') {
      try {
        var response = await fetch(window.BI_CONFIG.data.costBasis);
        if (response.ok) return await response.json();
      } catch (error) {}
    }
    try {
      await BI.loadScript(window.BI_CONFIG.data.costBasisScript);
      return window.BI_COSTBASIS_HISTORY || null;
    } catch (error) {
      return null;
    }
  }

  function validPayload(data) {
    return data && Array.isArray(data.dates) && Array.isArray(data.price) &&
      Array.isArray(data.realised) && Array.isArray(data.lth);
  }

  function setLatestValue(id, values) {
    var value = null;
    for (var i = values.length - 1; i >= 0 && value === null; i -= 1) {
      if (Number.isFinite(values[i]) && values[i] > 0) value = values[i];
    }
    document.getElementById(id).textContent = value === null ? '—' : money.format(value);
  }

  function cutoffDate() {
    if (selectedRange === 'max') return null;
    if (selectedRange === '2021') return '2021-01-01';
    var cutoff = new Date();
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
    var realised = [];
    var lth = [];

    for (var i = start; i < payload.dates.length; i += step) {
      labels.push(payload.dates[i]);
      price.push(payload.price[i]);
      realised.push(payload.realised[i]);
      lth.push(payload.lth[i]);
    }
    if (labels[labels.length - 1] !== payload.dates[payload.dates.length - 1]) {
      var last = payload.dates.length - 1;
      labels.push(payload.dates[last]);
      price.push(payload.price[last]);
      realised.push(payload.realised[last]);
      lth.push(payload.lth[last]);
    }

    if (chart) chart.destroy();
    chart = new Chart(document.getElementById('costbasis-chart'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          line('Preço BTC · mercado', price, '#f7931a', 1.3),
          line('Realized Price · custo médio geral', realised, '#a28dff', 2),
          line('LTH Cost Basis · longo prazo', lth, '#38d996', 2)
        ]
      },
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
            ticks: { color: '#8d939d', maxTicksLimit: 8, maxRotation: 0 }
          },
          y: {
            type: 'logarithmic',
            position: 'right',
            grid: { color: 'rgba(255,255,255,.06)' },
            border: { display: true, color: 'rgba(255,255,255,.30)', width: 1 },
            ticks: {
              color: '#8d939d',
              callback: function (value) { return '$' + compact(value); }
            }
          }
        },
        plugins: {
          legend: {
            labels: { color: '#d7d9de', usePointStyle: true, pointStyle: 'line', padding: 18 }
          },
          tooltip: {
            callbacks: {
              title: function (items) {
                return items.length
                  ? new Date(items[0].label + 'T12:00:00Z').toLocaleDateString('pt-BR')
                  : '';
              },
              label: function (context) {
                return context.parsed.y === null
                  ? context.dataset.label + ': indisponível'
                  : context.dataset.label + ': ' + money.format(context.parsed.y);
              }
            }
          }
        }
      }
    });
  }

  function line(label, data, color, width) {
    return {
      label: label,
      data: data,
      borderColor: color,
      backgroundColor: color,
      borderWidth: width,
      pointRadius: 0,
      pointHitRadius: 8,
      tension: 0.12,
      clip: { left: 0, top: 0, right: -8, bottom: 0 },
      spanGaps: true
    };
  }

  function compact(value) {
    if (value >= 1000) return Math.round(value / 1000) + 'k';
    return value;
  }
};
