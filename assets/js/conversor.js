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
  const chartTypeBtns = document.querySelectorAll('.preev__chart-type-btn');
  const changeEl = document.getElementById('preev-change');
  const highEl = document.getElementById('preev-high');
  const lowEl = document.getElementById('preev-low');
  const titleEl = document.querySelector('.preev__title'); // Seleciona o título

  let activeTimeframe = '1M';
  let exchangeRate = 0; 
  let pricesHistory = [];
  let candlesHistory = [];
  let openPriceReference = 0;
  let chartMode = 'candles';
  let chartState = null; // guarda coords/preços do último desenho p/ o hover
  let tickerAbortController = null;
  let historyAbortController = null;
  let klineSocket = null;
  let klineSocketKey = '';
  let klineReconnectTimer = null;
  let tooltipHideTimer = null;
  let resizeTimeout = null;

  // Elemento de tooltip (criado dinamicamente e inserido no wrapper do gráfico)
  const chartWrap = document.querySelector('.preev__chart-wrap');
  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'preev__chart-tooltip';
  const chartDateEl = document.createElement('div');
  chartDateEl.className = 'preev__chart-date';
  if (chartWrap) {
    chartWrap.appendChild(tooltipEl);
    chartWrap.appendChild(chartDateEl);
  }

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
        candlesHistory = data.map(kline => normalizeKline(kline, config.invert));
        updateChartFromCandles();
        connectKlineStream();
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error("Klines error", err);
    }
  }

  function normalizeKline(kline, invert) {
    const time = Number(kline[0]);
    const rawOpen = parseFloat(kline[1]);
    const rawHigh = parseFloat(kline[2]);
    const rawLow = parseFloat(kline[3]);
    const rawClose = parseFloat(kline[4]);
    if (!invert) return { time, open: rawOpen, high: rawHigh, low: rawLow, close: rawClose };
    return { time, open: 1 / rawOpen, high: 1 / rawLow, low: 1 / rawHigh, close: 1 / rawClose };
  }

  function updateChartFromCandles() {
    if (!candlesHistory.length) return;
    pricesHistory = candlesHistory.map(candle => candle.close);
    openPriceReference = candlesHistory[0].open;
    const highs = candlesHistory.map(candle => candle.high);
    const lows = candlesHistory.map(candle => candle.low);
    const lastClose = candlesHistory[candlesHistory.length - 1].close;
    renderStats(Math.max(...highs), Math.min(...lows), ((lastClose - openPriceReference) / openPriceReference) * 100);
    drawActiveChart();
  }

  function drawActiveChart() {
    if (!candlesHistory.length) return;
    if (chartMode === 'candles') drawCandlestickChart(candlesHistory);
    else drawTrendChart(pricesHistory, pricesHistory[pricesHistory.length - 1] >= openPriceReference);
  }

  function connectKlineStream() {
    const config = getPairConfig();
    const tf = timeframeParams[activeTimeframe];
    if (!config || !tf) return;
    const nextKey = `${config.symbol.toLowerCase()}@kline_${tf.interval}`;
    if (klineSocketKey === nextKey && klineSocket &&
        (klineSocket.readyState === WebSocket.OPEN || klineSocket.readyState === WebSocket.CONNECTING)) return;

    clearTimeout(klineReconnectTimer);
    const previousSocket = klineSocket;
    klineSocketKey = nextKey;
    klineSocket = new WebSocket(`wss://stream.binance.com:9443/ws/${nextKey}`);
    if (previousSocket) previousSocket.close();
    const socket = klineSocket;

    socket.addEventListener('open', () => {
      if (socket === klineSocket) setLiveStatus(true);
    });
    socket.addEventListener('message', event => {
      if (socket !== klineSocket) return;
      try {
        const payload = JSON.parse(event.data);
        const kline = payload.k;
        const currentConfig = getPairConfig();
        if (!kline || !currentConfig || payload.s !== currentConfig.symbol) return;
        const candle = normalizeKline([kline.t, kline.o, kline.h, kline.l, kline.c], currentConfig.invert);
        exchangeRate = parseFloat(kline.c);
        if (document.activeElement !== inputLeft && document.activeElement !== inputRight) calculateConversion('left');
        const lastIndex = candlesHistory.length - 1;
        if (lastIndex >= 0 && candlesHistory[lastIndex].time === candle.time) candlesHistory[lastIndex] = candle;
        else {
          candlesHistory.push(candle);
          candlesHistory = candlesHistory.slice(-timeframeParams[activeTimeframe].limit);
        }
        updateChartFromCandles();
      } catch (err) {
        console.warn('Kline stream error', err);
      }
    });
    socket.addEventListener('close', () => {
      if (socket !== klineSocket) return;
      setLiveStatus(false);
      klineReconnectTimer = setTimeout(connectKlineStream, 3000);
    });
    socket.addEventListener('error', () => {
      if (socket === klineSocket) setLiveStatus(false);
    });
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
    chartState = { mode: 'line', prices, coords, isBullish, min, range, w, h };

    renderBaseChart();
  }

  /**
   * Redesenha apenas as camadas base (linha, área e referência de abertura),
   * sem tocar em canvas.width/height — usado tanto no desenho inicial quanto
   * para "limpar" o hover a cada movimento do mouse.
   */
  function drawCandlestickChart(candles) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height;
    const top = 18, bottom = 15;
    const min = Math.min(...candles.map(candle => candle.low));
    const range = Math.max(...candles.map(candle => candle.high)) - min || 1;
    const spacing = w / candles.length;
    const candleWidth = Math.max(2, Math.min(10, spacing * 0.62));
    const priceY = price => h - bottom - ((price - min) / range) * (h - top - bottom);
    const coords = candles.map((candle, index) => ({ x: index * spacing + spacing / 2, y: priceY(candle.close) }));
    chartState = { mode: 'candles', candles, coords, min, range, w, h, spacing, candleWidth, priceY };
    renderBaseChart();
  }
  function renderBaseChart() {
    if (!chartState) return;
    if (chartState.mode === 'candles') {
      renderCandles();
      return;
    }
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
  function renderCandles() {
    const { candles, w, h, spacing, candleWidth, priceY } = chartState;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const openY = priceY(openPriceReference);
    ctx.beginPath(); ctx.setLineDash([6, 6]);
    ctx.moveTo(0, openY); ctx.lineTo(w, openY);
    ctx.strokeStyle = '#d5d7dc'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    candles.forEach((candle, index) => {
      const x = index * spacing + spacing / 2;
      const yOpen = priceY(candle.open);
      const yHigh = priceY(candle.high);
      const yLow = priceY(candle.low);
      const yClose = priceY(candle.close);
      const color = candle.close >= candle.open ? '#16a56a' : '#ef5b62';
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yHigh); ctx.lineTo(x, yLow); ctx.stroke();
      const bodyY = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));
      ctx.fillRect(x - candleWidth / 2, bodyY, candleWidth, bodyHeight);
    });
  }
  function handleChartHover(evt) {
    if (!chartState || !chartState.coords.length) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = evt.touches && evt.touches.length ? evt.touches[0].clientX : evt.clientX;
    const x = clientX - rect.left;
    const { coords, w, h } = chartState;
    let idx = Math.round((x / w) * (coords.length - 1));
    idx = Math.max(0, Math.min(coords.length - 1, idx));
    const point = coords[idx];
    renderBaseChart();

    const ctx = canvas.getContext('2d');
    ctx.save(); ctx.beginPath(); ctx.setLineDash([3, 3]);
    ctx.moveTo(point.x, 0); ctx.lineTo(point.x, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    if (chartState.mode === 'line') {
      ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = chartState.isBullish ? '#34d399' : '#f87171'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    }
    ctx.restore();

    if (chartState.mode === 'candles') {
      const candle = chartState.candles[idx];
      showCandleTooltip(candle);
      showCandleDate(point.x, candle.time);
    } else {
      hideCandleDate();
      showPriceTooltip(chartState.prices[idx], chartState.isBullish);
    }
  }

  function handleChartLeave() {
    hideCandleDate();
    renderBaseChart();
  }

  function keepTooltipVisible() {
    tooltipEl.classList.add('visible');
    clearTimeout(tooltipHideTimer);
    tooltipHideTimer = setTimeout(hideTooltip, 15000);
  }

  function showPriceTooltip(price, isUp) {
    if (!tooltipEl) return;
    const pR = selectRight.value;
    const prefix = pR === 'BRL' ? 'R$ ' : pR === 'USD' ? '$ ' : '₿ ';
    tooltipEl.innerHTML = `<span class="ohlc-value ${isUp ? 'up' : 'down'}">${prefix}${formatNumber(price, pR)}</span>`;
    keepTooltipVisible();
  }

  function showCandleTooltip(candle) {
    if (!tooltipEl) return;
    const tone = candle.close >= candle.open ? 'up' : 'down';
    const asset = selectRight.value;
    tooltipEl.innerHTML = [
      ['A', candle.open], ['MÁX', candle.high], ['MÍN', candle.low], ['F', candle.close]
    ].map(([label, value]) => `<span class="ohlc-label">${label}</span><span class="ohlc-value ${tone}">${formatNumber(value, asset)}</span>`).join('');
    keepTooltipVisible();
  }

  function showCandleDate(x, time) {
    if (!chartDateEl || !chartWrap) return;
    chartDateEl.textContent = new Date(time).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    const left = Math.max(55, Math.min(canvas.offsetLeft + x, chartWrap.clientWidth - 55));
    chartDateEl.style.left = `${left}px`;
    chartDateEl.classList.add('visible');
  }

  function hideCandleDate() {
    if (chartDateEl) chartDateEl.classList.remove('visible');
  }
  function hideTooltip() {
    clearTimeout(tooltipHideTimer);
    if (tooltipEl) tooltipEl.classList.remove('visible');
    hideCandleDate();
  }

  document.addEventListener('pointerdown', event => {
    if (chartWrap && !chartWrap.contains(event.target)) hideTooltip();
  });
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
    hideTooltip();
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
        drawActiveChart();
      }
    }, 150);
  });

  tfBtns.forEach(b => b.addEventListener('click', (e) => {
      tfBtns.forEach(btn => btn.classList.remove('active'));
      e.target.classList.add('active');
      activeTimeframe = e.target.dataset.tf;
      hideTooltip();
      fetchHistoricalTrends();
  }));
  
  chartTypeBtns.forEach(button => button.addEventListener('click', () => {
    hideTooltip();
    chartMode = button.dataset.chartType;
    chartTypeBtns.forEach(item => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    });
    drawActiveChart();
  }));

  window.addEventListener('beforeunload', () => {
    clearTimeout(klineReconnectTimer);
    klineSocketKey = '';
    const socket = klineSocket;
    klineSocket = null;
    if (socket) socket.close();
  });
  async function updateAll() { await fetchCurrentTicker(); await fetchHistoricalTrends(); }
  
  // Inicialização
  setInitialDefaults(); // Força Bitcoin para US Dólar no carregamento
  updateAll();
  setInterval(fetchCurrentTicker, 10000);     // preço ao vivo a cada 10s
  setInterval(fetchHistoricalTrends, 60000);  // gráfico/histórico a cada 60s
});
