/**
 * BITCOIN INICIANTES — Conversor Bidirecional Profissional
 * Limitação dinâmica: 8 casas p/ BTC, 2 casas p/ Moedas Fiduciárias (USD/BRL).
 * Título dinâmico conforme ativos selecionados.
 */

document.addEventListener('DOMContentLoaded', () => {
  const inputLeft = document.getElementById('preev-left-input');
  const selectLeft = document.getElementById('preev-left-select');
  const inputRight = document.getElementById('preev-right-input');
  const selectRight = document.getElementById('preev-right-select');
  const canvas = document.getElementById('preev-canvas');
  const tfBtns = document.querySelectorAll('.preev__tf-btn');
  const changeEl = document.getElementById('preev-change');
  const highEl = document.getElementById('preev-high');
  const lowEl = document.getElementById('preev-low');
  const titleEl = document.querySelector('.preev__title'); // Seleciona o título

  let activeTimeframe = '1M';
  let exchangeRate = 0; 
  let pricesHistory = [];
  let openPriceReference = 0;
  let chartState = null; // guarda coords/preços do último desenho p/ o hover
  let tickerAbortController = null;
  let historyAbortController = null;
  let resizeTimeout = null;

  // Elemento de tooltip (criado dinamicamente e inserido no wrapper do gráfico)
  const chartWrap = document.querySelector('.preev__chart-wrap');
  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'preev__chart-tooltip';
  if (chartWrap) chartWrap.appendChild(tooltipEl);

  // Badge "AO VIVO" (criado dinamicamente e inserido no card do conversor)
  const previewContainer = document.querySelector('.preev__container');
  const liveBadge = document.createElement('div');
  liveBadge.className = 'preev__live-badge';
  liveBadge.innerHTML = '<span class="preev__live-dot live"></span><span class="preev__live-text">AO VIVO</span>';
  if (previewContainer) previewContainer.appendChild(liveBadge);
  const liveDotEl = liveBadge.querySelector('.preev__live-dot');
  const liveTextEl = liveBadge.querySelector('.preev__live-text');

  /**
   * Atualiza o indicador visual de conexão (verde pulsando / vermelho parado)
   */
  function setLiveStatus(isLive) {
    if (!liveDotEl) return;
    liveDotEl.classList.toggle('live', isLive);
    liveDotEl.classList.toggle('offline', !isLive);
    if (liveTextEl) liveTextEl.textContent = isLive ? 'AO VIVO' : 'OFFLINE';
  }

  const timeframeParams = {
    '1H': { interval: '1m', limit: 60 },
    '1D': { interval: '15m', limit: 96 },
    '1W': { interval: '2h', limit: 84 },
    '1M': { interval: '8h', limit: 90 },
    '1Y': { interval: '1d', limit: 365 }
  };

  /**
   * Mapeia os nomes amigáveis para o título
   */
  const assetNames = {
    'BTC': 'Bitcoin',
    'USD': 'US Dólar',
    'BRL': 'Real Brasileiro'
  };

  /**
   * Atualiza o título dinamicamente
   */
  function updateTitle() {
    if (titleEl) {
      const fromName = assetNames[selectLeft.value] || selectLeft.value;
      const toName = assetNames[selectRight.value] || selectRight.value;
      titleEl.textContent = `${fromName} para ${toName}`;
    }
  }

  /**
   * Configuração inicial padrão: BTC para USD
   */
  function setInitialDefaults() {
    selectLeft.value = 'BTC';
    selectRight.value = 'USD';
    updateTitle();

    // Acessibilidade básica
    inputLeft.setAttribute('aria-label', 'Valor a converter, moeda de origem');
    selectLeft.setAttribute('aria-label', 'Moeda de origem');
    inputRight.setAttribute('aria-label', 'Valor convertido, moeda de destino');
    selectRight.setAttribute('aria-label', 'Moeda de destino');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Gráfico de tendência de preço no período selecionado');
  }

  /**
   * Limita as casas decimais dinamicamente conforme o ativo
   */
  function limitarCasas(input, ativo) {
    const maxCasas = ativo === 'BTC' ? 8 : 2;
    let valor = input.value.replace(',', '.');
    valor = valor.replace(/[^0-9.]/g, '');

    const partes = valor.split('.');
    if (partes.length > 2) {
        valor = partes[0] + '.' + partes.slice(1).join('');
    }

    if (valor.includes('.')) {
        const [inteiro, decimal] = valor.split('.');
        valor = inteiro + '.' + decimal.slice(0, maxCasas);
    }
    input.value = valor.replace('.', ',');
  }

  function getPairConfig() {
    const from = selectLeft.value;
    const to = selectRight.value;
    if (from === to) return null; 
    
    if (from === 'BTC' && to === 'USD') return { symbol: 'BTCUSDT', invert: false };
    if (from === 'USD' && to === 'BTC') return { symbol: 'BTCUSDT', invert: true };
    if (from === 'BTC' && to === 'BRL') return { symbol: 'BTCBRL', invert: false };
    if (from === 'BRL' && to === 'BTC') return { symbol: 'BTCBRL', invert: true };
    if (from === 'USD' && to === 'BRL') return { symbol: 'USDTBRL', invert: false };
    if (from === 'BRL' && to === 'USD') return { symbol: 'USDTBRL', invert: true };
    return null;
  }

  function parseCleanFloat(val) {
    let raw = val.toString().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
    return parseFloat(raw) || 0;
  }

  function formatNumber(val, asset) {
    if (isNaN(val) || val === null) return '—';
    const isCrypto = asset === 'BTC';
    return val.toLocaleString('pt-BR', {
      minimumFractionDigits: isCrypto ? 0 : 2,
      maximumFractionDigits: isCrypto ? 8 : 2
    });
  }

  function calculateConversion(triggerBox) {
    if (selectLeft.value === selectRight.value) {
        if (triggerBox === 'left') inputRight.value = inputLeft.value;
        else inputLeft.value = inputRight.value;
        return;
    }

    const config = getPairConfig();
    if (!config || exchangeRate <= 0) return;

    const rate = config.invert ? (1 / exchangeRate) : exchangeRate;

    if (triggerBox === 'left') {
        const val = parseCleanFloat(inputLeft.value);
        inputRight.value = formatNumber(val * rate, selectRight.value);
    } else {
        const val = parseCleanFloat(inputRight.value);
        inputLeft.value = formatNumber(val * (1 / rate), selectLeft.value);
    }
  }

  async function fetchCurrentTicker() {
    const config = getPairConfig();
    if (!config) {
        exchangeRate = 1; 
        calculateConversion('left');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        chartState = null;
        hideTooltip();
        renderStats(1, 1, 0); 
        return;
    }

    // Cancela uma requisição anterior ainda pendente (ex: usuário trocou de par rápido)
    if (tickerAbortController) tickerAbortController.abort();
    tickerAbortController = new AbortController();

    try {
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${config.symbol}`, { signal: tickerAbortController.signal });
      const data = await res.json();
      if (data && data.price) {
        exchangeRate = parseFloat(data.price);
        if (document.activeElement !== inputLeft && document.activeElement !== inputRight) {
          calculateConversion('left');
        }
      }
      setLiveStatus(true);
    } catch (err) {
      if (err.name === 'AbortError') return; // requisição cancelada de propósito, ignora
      console.warn("Binance API error", err);
      setLiveStatus(false);
    }
  }

  async function fetchHistoricalTrends() {
    const config = getPairConfig();
    if (!config) return;

    // Cancela uma requisição de histórico anterior ainda pendente
    if (historyAbortController) historyAbortController.abort();
    historyAbortController = new AbortController();

    const tf = timeframeParams[activeTimeframe];
    try {
      const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${config.symbol}&interval=${tf.interval}&limit=${tf.limit}`, { signal: historyAbortController.signal });
      const data = await res.json();
      if (data && data.length > 0) {
        let closes = data.map(c => parseFloat(c[4]));
        let highs = data.map(c => parseFloat(c[2]));
        let lows = data.map(c => parseFloat(c[3]));
        let openRef = parseFloat(data[0][1]);
        if (config.invert) {
            closes = closes.map(v => 1 / v);
            const invertedHighs = lows.map(v => 1 / v);
            const invertedLows = highs.map(v => 1 / v);
            highs = invertedHighs;
            lows = invertedLows;
            openRef = 1 / openRef;
        }
        openPriceReference = openRef;
        pricesHistory = closes;
        renderStats(Math.max(...highs), Math.min(...lows), ((closes[closes.length-1] - openRef) / openRef) * 100);
        drawTrendChart(closes, closes[closes.length-1] >= openRef);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error("Klines error", err);
    }
  }

  function renderStats(high, low, pct) {
    const pR = selectRight.value;
    const prefix = pR === 'BRL' ? 'R$ ' : pR === 'USD' ? '$ ' : '₿ ';
    highEl.textContent = `↑ ${prefix}${formatNumber(high, pR)}`;
    lowEl.textContent = `↓ ${prefix}${formatNumber(low, pR)}`;
    changeEl.textContent = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(2)}%`;
    changeEl.className = `preev__stat-item change-indicator ${pct >= 0 ? 'up' : 'down'}`;
  }

  function drawTrendChart(prices, isBullish) {
    hideTooltip();
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reseta a matriz antes de reaplicar a escala
    ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height;
    const min = Math.min(...prices), range = Math.max(...prices) - min || 1;
    const coords = prices.map((p, i) => ({ x: (i/(prices.length-1))*w, y: h-15-((p-min)/range)*(h-30) }));

    // Guarda o estado atual do gráfico para o hover reaproveitar sem redimensionar o canvas
    chartState = { prices, coords, isBullish, min, range, w, h };

    renderBaseChart();
  }

  /**
   * Redesenha apenas as camadas base (linha, área e referência de abertura),
   * sem tocar em canvas.width/height — usado tanto no desenho inicial quanto
   * para "limpar" o hover a cada movimento do mouse.
   */
  function renderBaseChart() {
    if (!chartState) return;
    const { coords, isBullish, min, range, w, h } = chartState;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);

    const openY = h-15-((openPriceReference-min)/range)*(h-30);
    ctx.beginPath(); ctx.setLineDash([6,6]); ctx.moveTo(0, openY); ctx.lineTo(w, openY); ctx.strokeStyle = '#d5d7dc'; ctx.stroke(); ctx.setLineDash([]);

    ctx.beginPath(); ctx.moveTo(coords[0].x, h);
    coords.forEach(c => ctx.lineTo(c.x, c.y));
    ctx.lineTo(coords[coords.length-1].x, h); ctx.closePath();
    const grad = ctx.createLinearGradient(0,0,0,h);
    grad.addColorStop(0, isBullish ? 'rgba(52, 211, 153, 0.24)' : 'rgba(248, 113, 113, 0.24)');
    grad.addColorStop(0.65, isBullish ? 'rgba(52, 211, 153, 0.10)' : 'rgba(248, 113, 113, 0.10)');
    grad.addColorStop(1, isBullish ? 'rgba(52, 211, 153, 0.04)' : 'rgba(248, 113, 113, 0.04)');
    ctx.fillStyle = grad; ctx.fill();

    ctx.beginPath(); coords.forEach((c, i) => i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y));
    ctx.strokeStyle = isBullish ? '#34d399' : '#f87171'; ctx.lineWidth = 2.5; ctx.stroke();
  }

  /**
   * Encontra o ponto mais próximo do mouse/toque, desenha a linha-guia + o
   * ponto destacado, e mostra o tooltip com o valor formatado.
   */
  function handleChartHover(evt) {
    if (!chartState || !chartState.coords.length) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = evt.touches && evt.touches.length ? evt.touches[0].clientX : evt.clientX;
    const x = clientX - rect.left;

    const { coords, prices, w, h, isBullish } = chartState;
    let idx = Math.round((x / w) * (coords.length - 1));
    idx = Math.max(0, Math.min(coords.length - 1, idx));
    const point = coords[idx];
    const price = prices[idx];

    renderBaseChart();

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([3, 3]);
    ctx.moveTo(point.x, 0);
    ctx.lineTo(point.x, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = isBullish ? '#34d399' : '#f87171';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.restore();

    showTooltip(point.x, point.y, price);
  }

  function handleChartLeave() {
    hideTooltip();
    renderBaseChart();
  }

  function showTooltip(x, y, price) {
    if (!tooltipEl) return;
    const pR = selectRight.value;
    const prefix = pR === 'BRL' ? 'R$ ' : pR === 'USD' ? '$ ' : '₿ ';
    tooltipEl.textContent = `${prefix}${formatNumber(price, pR)}`;
    tooltipEl.style.left = (canvas.offsetLeft + x) + 'px';
    tooltipEl.style.top = (canvas.offsetTop + y) + 'px';
    tooltipEl.classList.add('visible');
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.classList.remove('visible');
  }

  // --- EVENTOS FINAIS ---
  inputLeft.addEventListener('input', () => {
      limitarCasas(inputLeft, selectLeft.value);
      calculateConversion('left');
  });
  inputRight.addEventListener('input', () => {
      limitarCasas(inputRight, selectRight.value);
      calculateConversion('right');
  });
  
  [selectLeft, selectRight].forEach(s => s.addEventListener('change', () => { 
    updateTitle(); // Atualiza o título ao mudar o ativo
    updateAll(); 
  }));

  // --- HOVER / TOOLTIP NO GRÁFICO ---
  canvas.addEventListener('mousemove', handleChartHover);
  canvas.addEventListener('mouseleave', handleChartLeave);
  canvas.addEventListener('touchstart', handleChartHover, { passive: true });
  canvas.addEventListener('touchmove', handleChartHover, { passive: true });
  canvas.addEventListener('touchend', handleChartLeave);

  // Redesenha o gráfico (com o mesmo histórico) quando a janela é redimensionada,
  // evitando que fique desalinhado até a próxima atualização de dados
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      if (pricesHistory.length > 0) {
        drawTrendChart(pricesHistory, pricesHistory[pricesHistory.length - 1] >= openPriceReference);
      }
    }, 150);
  });

  tfBtns.forEach(b => b.addEventListener('click', (e) => {
      tfBtns.forEach(btn => btn.classList.remove('active'));
      e.target.classList.add('active');
      activeTimeframe = e.target.dataset.tf;
      fetchHistoricalTrends();
  }));
  
  async function updateAll() { await fetchCurrentTicker(); await fetchHistoricalTrends(); }
  
  // Inicialização
  setInitialDefaults(); // Força Bitcoin para US Dólar no carregamento
  updateAll();
  setInterval(fetchCurrentTicker, 10000);     // preço ao vivo a cada 10s
  setInterval(fetchHistoricalTrends, 60000);  // gráfico/histórico a cada 60s
});
