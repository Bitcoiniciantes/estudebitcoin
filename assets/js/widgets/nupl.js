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
          <button type="button" data-range="5">5 anos</button>
          <button type="button" data-range="10">10 anos</button>
          <button type="button" data-range="13" class="active">13 anos</button>
          <button type="button" data-range="max">Máx.</button>
        </div>
      </div>
      <div class="nupl-chart-wrap">
        <canvas id="nupl-chart" aria-label="Gráfico histórico do preço do Bitcoin e das fases do NUPL"></canvas>
      </div>
      <p class="nupl-note">
        Fonte: <a href="https://charts.checkonchain.com/btconchain/unrealised/nupl/nupl_light.html"
          target="_blank" rel="noopener noreferrer">Checkonchain</a>.
      </p>
    </div>`;

  var zones = [
    { key: 'euphoria', label: 'Euforia/Ganância', color: '#45a9f3' },
    { key: 'belief', label: 'Crença/Negação', color: '#48d7aa' },
    { key: 'optimism', label: 'Otimismo', color: '#f2a33b' },
    { key: 'hopeFear', label: 'Esperança/Medo', color: '#e8c14c' },
    { key: 'capitulation', label: 'Capitulação/Desespero', color: '#f05b78' }
  ];

  var payload = await loadData();
  if (!validPayload(payload)) {
    container.innerHTML = '<div class="btc-ultra-card nupl-error">Não foi possível carregar os dados do NUPL.</div>';
    return;
  }
  if (typeof Chart === 'undefined') await BI.loadScript(window.BI_CONFIG.cdn.chartjs);

  var chart;
  var selectedRange = '13';
  var money = new Intl.NumberFormat('pt-BR', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0
  });
  var decimal = new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: 3, maximumFractionDigits: 3
  });

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
      for (var z = zones.length - 1; z >= 0; z -= 1) {
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
    var activeZones = [];
    zones.forEach(function (zone) { zoneData[zone.key] = []; });

    for (var i = start; i < payload.dates.length; i += step) {
      labels.push(payload.dates[i]);
      price.push(payload.price[i]);
      var activeZone = activeZoneAt(i);
      activeZones.push(activeZone);
      zones.forEach(function (zone) {
        zoneData[zone.key].push(zone.key === activeZone ? payload[zone.key][i] : null);
      });
    }
    if (labels[labels.length - 1] !== payload.dates[payload.dates.length - 1]) {
      var last = payload.dates.length - 1;
      labels.push(payload.dates[last]);
      price.push(payload.price[last]);
      var lastActiveZone = activeZoneAt(last);
      activeZones.push(lastActiveZone);
      zones.forEach(function (zone) {
        zoneData[zone.key].push(
          zone.key === lastActiveZone ? payload[zone.key][last] : null
        );
      });
    }

    bridgeZoneTransitions(zoneData, activeZones);
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
            min: -0.5,
            max: 1.8,
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
            border: { display: false },
            ticks: {
              color: '#8d939d',
              stepSize: 0.5,
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

  function activeZoneAt(index) {
    // Plotly draws later traces over earlier ones; reverse priority matches the source.
    for (var i = zones.length - 1; i >= 0; i -= 1) {
      if (Number.isFinite(payload[zones[i].key][index])) return zones[i].key;
    }
    return null;
  }

  function bridgeZoneTransitions(data, activeZones) {
    for (var i = 1; i < activeZones.length; i += 1) {
      var previousKey = activeZones[i - 1];
      var currentKey = activeZones[i];
      if (!previousKey || !currentKey || previousKey === currentKey) continue;

      var previousValue = data[previousKey][i - 1];
      var currentValue = data[currentKey][i];
      if (!Number.isFinite(previousValue) || !Number.isFinite(currentValue)) continue;

      data[previousKey][i] = currentValue;
      data[currentKey][i - 1] = previousValue;
    }
  }

  function compact(value) {
    if (value >= 1000) return Math.round(value / 1000) + 'k';
    return value;
  }

  function formatDate(value) {
    return new Date(value + 'T12:00:00Z').toLocaleDateString('pt-BR');
  }
};
