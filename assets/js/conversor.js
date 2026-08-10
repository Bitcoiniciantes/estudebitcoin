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
  const chartTypeBtns = document.querySelectorAll('[data-chart-type]');
  const drawToggleBtn = document.getElementById('preev-draw-toggle');
  const drawOptionsEl = document.getElementById('preev-draw-options');
  const drawToolBtns = document.querySelectorAll('[data-draw-tool]');
  const changeEl = document.getElementById('preev-change');
  const highEl = document.getElementById('preev-high');
  const lowEl = document.getElementById('preev-low');
  const titleEl = document.querySelector('.preev__title'); // Seleciona o título
  const PUBLIC_MARKERS_URL = 'https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/api/public-markers';

  let activeTimeframe = '1D';
  let externalAsset = null;       // { kind:'crypto'|'stock', symbol, pair, label }
  let stockPollTimer = null;
  let markerMode = false;
  let drawingTool = 'line';
  let markerLines = [];      // [{ y }] linhas horizontais (fração da altura do canvas)
  let markerDraft = null;    // reservado
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
  let lastTouchMarkerAt = 0;
  let lastPublicMarkerUpdate = 0;

  // Largura (em px) reservada para o eixo de preços à esquerda do gráfico
  const AXIS_W = 56;

  function formatAxisValue(val) {
    const abs = Math.abs(val);
    if (abs >= 1e12) return (val / 1e12).toFixed(1) + " T";
    if (abs >= 1e9) return (val / 1e9).toFixed(1) + " B";
    if (abs >= 1e6) return (val / 1e6).toFixed(1) + " M";
    if (abs >= 1e4) return val.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
    if (abs >= 100) return val.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
    return val.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

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

  /**
   * Ativa/desativa o modo "ativo carregado pelo ticker" (cripto ou stock).
   */
  function setExternalAsset(asset) {
    externalAsset = asset || null;
    clearTimeout(stockPollTimer);
    stockPollTimer = null;
    if (externalAsset && externalAsset.kind === 'stock') setLiveStatus(false);
    updateChartTitle();
    hideTooltip();
    fetchCurrentTicker();
    fetchHistoricalTrends();
    if (externalAsset && externalAsset.kind === 'stock') {
      stockPollTimer = setInterval(fetchHistoricalTrends, 20000);
    }
    loadMarkers();
  }

  function isExternal() {
    return !!(externalAsset);
  }

  /**
   * Chave do localStorage para as linhas horizontais por ativo.
   */
  function markerStorageKey() {
    const key = externalAsset
      ? `${externalAsset.kind}:${externalAsset.symbol}`
      : `pair:${selectLeft.value}:${selectRight.value}`;
    return `estudebitcoin:markers:${key}`;
  }

  function isValidMarker(marker) {
    if (!Number.isFinite(marker?.price) || marker.price <= 0) return false;
    if (marker?.type === 'text') return typeof marker.text === 'string' && marker.text.trim().length > 0 && Number.isFinite(marker.x) && marker.x >= 0 && marker.x <= 1;
    if (marker?.type === 'ray') return Number.isFinite(marker.x) && Number.isFinite(marker.endX) && Number.isFinite(marker.endPrice) && marker.x >= 0 && marker.x <= 1 && marker.endX >= 0 && marker.endX <= 1 && marker.endPrice > 0 && Math.abs(marker.endX - marker.x) >= 0.01;
    return !marker?.type || marker.type === 'line';
  }
  function saveMarkers() {
    try {
      localStorage.setItem(markerStorageKey(), JSON.stringify(markerLines));
    } catch (err) { /* localStorage indisponível */ }
  }

  function loadMarkers() {
    lastPublicMarkerUpdate = 0;
    markerLines = [];
    try {
      const raw = localStorage.getItem(markerStorageKey());
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) markerLines = parsed.filter(isValidMarker);
      }
    } catch (err) { /* localStorage indisponível */ }
    renderBaseChart();
    void pullPublicMarkers();
  }

  async function publicMarkersRequest(method, markers) {
    const url = new URL(PUBLIC_MARKERS_URL);
    url.searchParams.set('asset', markerStorageKey());
    const response = await fetch(url, {
      method,
      cache: 'no-store',
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify({ markers }) : undefined,
    });
    if (!response.ok) throw new Error(`public-markers-${response.status}`);
    return response.json();
  }

  async function pushPublicMarkers() {
    try {
      const data = await publicMarkersRequest('POST', markerLines);
      lastPublicMarkerUpdate = Number(data?.updatedAt) || lastPublicMarkerUpdate;
    } catch (err) {
      console.warn('Public marker sync error', err);
    }
  }

  async function pullPublicMarkers() {
    try {
      const data = await publicMarkersRequest('GET');
      const updatedAt = Number(data?.updatedAt) || 0;
      if (!updatedAt || updatedAt <= lastPublicMarkerUpdate) return;
      markerLines = Array.isArray(data.markers) ? data.markers.filter(isValidMarker) : [];
      lastPublicMarkerUpdate = updatedAt;
      saveMarkers();
      renderBaseChart();
    } catch (err) {
      console.warn('Public marker sync error', err);
    }
  }

  function isExternalStock() {
    return !!externalAsset && externalAsset.kind === 'stock';
  }

  /**
   * Título do cartão: nome do ativo carregado, ou o par normal do conversor.
   */
  function updateChartTitle() {
    if (!titleEl) return;
    // O título reflete SEMPRE o par do conversor (BTC/BRL/USD), mesmo com ativo externo carregado.
    const fromName = assetNames[selectLeft.value] || selectLeft.value;
    const toName = assetNames[selectRight.value] || selectRight.value;
    titleEl.textContent = `${fromName} para ${toName}`;
  }

  /**
   * Moeda usada no rodapé/tooltips: no modo externo usamos USD (stocks) ou USDT (cripto).
   */
  function displayCurrency() {
    if (isExternal()) return externalAsset.kind === 'crypto' ? 'USDT' : 'USD';
    return selectRight.value;
  }

  function displayDecimals() {
    if (isExternal()) return 2;
    return displayCurrency() === 'BTC' ? 8 : 2;
  }

  const timeframeParams = {
    '1H': { interval: '1h', limit: 60 },
    '15M': { interval: '15m', limit: 60 },
    '1D': { interval: '1d', limit: 60 },
    '1W': { interval: '1w', limit: 60 },
    '1M': { interval: '1M', limit: 60 },
    // A Binance não oferece candle anual; agregamos os candles mensais por ano civil.
    '1Y': { interval: '1M', limit: 120, aggregate: 'year' }
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

  /**
   * Config do CONVERSOR: par BTC/BRL/USD selecionado. Independente do ativo do gráfico.
   * Nunca retorna config de ativo externo (ETH, stocks, etc.).
   */
  function getConverterConfig() {
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

  /**
   * Config do GRÁFICO (ativo exibido): ativo externo (crypto/stock) se houver,
   * senão o par do conversor. É o que alimenta candles/stats/histórico.
   */
  function getChartConfig() {
    if (externalAsset && externalAsset.kind === 'crypto') {
      return { symbol: externalAsset.pair, invert: false };
    }
    if (externalAsset && externalAsset.kind === 'stock') {
      return null; // stocks usam fetchStockCandles separado
    }
    return getConverterConfig();
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

    const config = getConverterConfig();
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
    // O conversor usa SEMPRE o par BTC/BRL/USD selecionado, independente do gráfico.
    const config = getConverterConfig();

    // Sem par de conversão (selects iguais): apenas atualiza stats do gráfico via candles.
    if (!config) {
        const candles = candlesHistory;
        if (candles.length) {
          const highs = candles.map(c => c.high);
          const lows = candles.map(c => c.low);
          const lastClose = candles[candles.length - 1].close;
          renderStats(Math.max(...highs), Math.min(...lows), ((lastClose - openPriceReference) / openPriceReference) * 100);
        }
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
    if (isExternalStock()) {
      await fetchStockCandles();
      return;
    }
    const config = getChartConfig();
    if (!config) return;

    // Cancela uma requisição de histórico anterior ainda pendente
    if (historyAbortController) historyAbortController.abort();
    historyAbortController = new AbortController();

    const tf = timeframeParams[activeTimeframe];
    try {
      const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${config.symbol}&interval=${tf.interval}&limit=${tf.limit}`, { signal: historyAbortController.signal });
      const data = await res.json();
      if (data && data.length > 0) {
        const normalizedCandles = data.map(kline => normalizeKline(kline, config.invert));
        candlesHistory = tf.aggregate === 'year' ? aggregateAnnualCandles(normalizedCandles) : normalizedCandles;
        updateChartFromCandles();
        connectKlineStream();
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error("Klines error", err);
    }
  }

  /**
   * Carrega velas de uma ação/índice via worker Yahoo Finance (sem WebSocket).
   */
  const exportPeriodMap = {
    '15M': '15M',
    '1H': '1H',
    '1D': '1D',
    '1W': '1S',
    '1M': '1M',
    '1Y': '1M'
  }
  async function fetchStockCandles() {
    const asset = externalAsset ? externalAsset.symbol : '';
    if (!asset) return;
    if (historyAbortController) historyAbortController.abort();
    historyAbortController = new AbortController();
    const period = exportPeriodMap[activeTimeframe] || '1D';
    try {
      const res = await fetch(`https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/api/candles?asset=${encodeURIComponent(asset)}&period=${period}`, { signal: historyAbortController.signal });
      const data = await res.json();
      if (!data || !Array.isArray(data.candles) || !data.candles.length) return;
      let candles = data.candles.map(c => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }));
      if (activeTimeframe === '1Y') {
        candles = aggregateAnnualCandles(candles);
      }
      candlesHistory = candles.slice(-130);
      updateChartFromCandles();
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('Stock candles error', err);
      setLiveStatus(false);
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

  function aggregateAnnualCandles(monthlyCandles) {
    return monthlyCandles.reduce((annual, candle) => {
      const yearStart = Date.UTC(new Date(candle.time).getUTCFullYear(), 0, 1);
      const current = annual[annual.length - 1];
      if (!current || current.time !== yearStart) {
        annual.push({ ...candle, time: yearStart });
      } else {
        current.high = Math.max(current.high, candle.high);
        current.low = Math.min(current.low, candle.low);
        current.close = candle.close;
      }
      return annual;
    }, []);
  }

  function updateAnnualCandle(monthlyCandle) {
    const yearStart = Date.UTC(new Date(monthlyCandle.time).getUTCFullYear(), 0, 1);
    const current = candlesHistory[candlesHistory.length - 1];
    if (!current || current.time !== yearStart) {
      candlesHistory.push({ ...monthlyCandle, time: yearStart });
      candlesHistory = candlesHistory.slice(-12);
      return;
    }
    current.high = Math.max(current.high, monthlyCandle.high);
    current.low = Math.min(current.low, monthlyCandle.low);
    current.close = monthlyCandle.close;
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
    const config = getChartConfig();
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
        const currentConfig = getChartConfig();
        if (!kline || !currentConfig || payload.s !== currentConfig.symbol) return;
        const candle = normalizeKline([kline.t, kline.o, kline.h, kline.l, kline.c], currentConfig.invert);
        // A conversão usa o par do CONVERSOR; o stream reflete o ativo do GRÁFICO.
        if (!isExternal() && document.activeElement !== inputLeft && document.activeElement !== inputRight) {
          exchangeRate = parseFloat(kline.c);
          calculateConversion('left');
        }
        const activeParams = timeframeParams[activeTimeframe];
        if (activeParams.aggregate === 'year') updateAnnualCandle(candle);
        else {
          const lastIndex = candlesHistory.length - 1;
          if (lastIndex >= 0 && candlesHistory[lastIndex].time === candle.time) candlesHistory[lastIndex] = candle;
          else {
            candlesHistory.push(candle);
            candlesHistory = candlesHistory.slice(-activeParams.limit);
          }
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
    const ccy = displayCurrency();
    const prefix = ccy === 'BRL' ? 'R$ ' : ccy === 'BTC' ? '₿ ' : '$ ';
    highEl.textContent = `↑ ${prefix}${formatNumber(high, ccy)}`;
    lowEl.textContent = `↓ ${prefix}${formatNumber(low, ccy)}`;
    changeEl.textContent = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(2)}%`;
    changeEl.className = `preev__stat-item change-indicator ${pct >= 0 ? 'up' : 'down'}`;
  }

  function drawAxis(yOf) {
    const ctx = canvas.getContext('2d');
    const { min, range, w, h } = chartState;
    const ccy = displayCurrency();
    const prefix = ccy === 'BRL' ? 'R$ ' : ccy === 'BTC' ? '₿ ' : '$ ';
    const ticks = 5;
    const axisX = w - AXIS_W;
    ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let t = 0; t <= ticks; t++) {
      const v = min + (range * t) / ticks;
      const y = yOf(v);
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(axisX, y);
      ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#111111';
      ctx.fillText(prefix + formatAxisValue(v), axisX + 6, y);
    }
    ctx.beginPath(); ctx.moveTo(axisX, 0); ctx.lineTo(axisX, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.28)'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  /**
   * Desenha o nome do ativo no centro do corpo do gráfico.
   */
  function drawChartLabel() {
    if (!chartState) return;
    const { w, h } = chartState;
    const ctx = canvas.getContext('2d');
    let label;
    if (externalAsset) {
      label = externalAsset.label ? `${externalAsset.label} (${externalAsset.symbol})` : externalAsset.symbol;
    } else {
      const fromName = assetNames[selectLeft.value] || selectLeft.value;
      const toName = assetNames[selectRight.value] || selectRight.value;
      label = `${fromName}/${toName}`;
    }
    ctx.save();
    ctx.font = 'bold 12px ui-monospace, SFMono-Regular, Consolas, monospace';
    const tw = ctx.measureText(label).width;
    const cx = (w - AXIS_W) / 2;
    const x = cx - tw / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    ctx.fillRect(x - 4, 6, tw + 8, 18);
    ctx.fillStyle = '#222222';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, 16);
    ctx.restore();
  }

  /**
   * Desenha o preço atual (último close) como uma linha + rótulo no eixo direito.
   */
  function drawLivePrice() {
    if (!chartState || !candlesHistory.length) return;
    const { w, h } = chartState;
    const yFn = chartState.priceY || chartState.yOf;
    if (!yFn) return;
    const last = candlesHistory[candlesHistory.length - 1].close;
    const y = yFn(last);
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.setLineDash([8, 4]);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w - AXIS_W, y);
    ctx.strokeStyle = 'rgba(21, 101, 192, 0.5)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.setLineDash([]);
    const ccy = displayCurrency();
    const prefix = ccy === 'BRL' ? 'R$ ' : ccy === 'BTC' ? '₿ ' : '$ ';
    const label = prefix + formatAxisValue(last);
    ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Consolas, monospace';
    const tw = ctx.measureText(label).width;
    const yClamped = Math.max(9, Math.min(h - 9, y));
    ctx.fillStyle = '#111111';
    ctx.fillRect(w - AXIS_W, yClamped - 9, tw + 8, 18);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, w - AXIS_W + 4, yClamped);
    ctx.restore();
  }

  function drawingPoint(evt) {
    if (!chartState) return null;
    const rect = canvas.getBoundingClientRect();
    const touch = evt.touches?.[0] || evt.changedTouches?.[0];
    const clientX = touch ? touch.clientX : evt.clientX;
    const clientY = touch ? touch.clientY : evt.clientY;
    const plotW = Math.max(1, chartState.w - AXIS_W);
    const x = clientX - rect.left, y = clientY - rect.top;
    if (x < 0 || x > plotW || y < 0 || y > chartState.h) return null;
    const top = chartState.mode === 'candles' ? 18 : 15, bottom = 15;
    const py = Math.max(top, Math.min(chartState.h - bottom, y));
    const price = chartState.min + ((chartState.h - bottom - py) / (chartState.h - top - bottom)) * chartState.range;
    return { x, y: py, price, normalX: Math.max(0, Math.min(1, x / plotW)) };
  }

  function rayGeometry(marker) {
    if (!chartState) return null;
    const plotW = chartState.w - AXIS_W, yFn = chartState.priceY || chartState.yOf;
    const startX = Math.max(0, Math.min(plotW, Number(marker.x) * plotW));
    const controlX = Math.max(0, Math.min(plotW, Number(marker.endX) * plotW));
    const startY = yFn(marker.price), controlY = yFn(marker.endPrice);
    if (![startX, controlX, startY, controlY].every(Number.isFinite) || Math.abs(controlX - startX) < 4) return null;
    const edgeX = controlX > startX ? plotW : 0;
    return { startX, startY, controlX, controlY, edgeX, edgeY: startY + ((controlY - startY) * (edgeX - startX)) / (controlX - startX) };
  }

  function distanceToSegment(x, y, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, length = dx * dx + dy * dy;
    if (!length) return Math.hypot(x - x1, y - y1);
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
  }

  function markerHit(point) {
    if (!chartState || !point) return null;
    const plotW = chartState.w - AXIS_W, yFn = chartState.priceY || chartState.yOf, ctx = canvas.getContext('2d');
    for (let index = markerLines.length - 1; index >= 0; index -= 1) {
      const marker = markerLines[index], y = yFn(marker.price);
      if (!Number.isFinite(y)) continue;
      if (marker.type === 'text') {
        ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Consolas, monospace';
        const width = Math.min(plotW - 8, ctx.measureText(marker.text.trim().slice(0, 80)).width + 10);
        const left = Math.max(4, Math.min(plotW - width - 4, Number(marker.x) * plotW));
        if (point.x >= left - 6 && point.x <= left + width + 6 && Math.abs(point.y - y) <= 16) return { index, handle: 'point' };
      } else if (marker.type === 'ray') {
        const ray = rayGeometry(marker); if (!ray) continue;
        if (Math.hypot(point.x - ray.startX, point.y - ray.startY) <= 15) return { index, handle: 'start' };
        if (Math.hypot(point.x - ray.controlX, point.y - ray.controlY) <= 15 || distanceToSegment(point.x, point.y, ray.startX, ray.startY, ray.edgeX, ray.edgeY) <= 9) return { index, handle: 'end' };
      } else if (Math.abs(point.y - y) <= 10) return { index, handle: 'line' };
    }
    return null;
  }

  function saveAndShareMarkers() { saveMarkers(); renderBaseChart(); void pushPublicMarkers(); }

  function drawMarkers() {
    if (!chartState || (!markerLines.length && !markerDraft)) return;
    const { w, h } = chartState, plotW = w - AXIS_W, yFn = chartState.priceY || chartState.yOf, ctx = canvas.getContext('2d');
    const ccy = displayCurrency(), prefix = ccy === 'BRL' ? 'R$ ' : ccy === 'BTC' ? '₿ ' : '$ ';
    ctx.save();
    markerLines.forEach(marker => {
      const y = yFn(marker.price); if (!Number.isFinite(y)) return;
      const yClamped = Math.max(10, Math.min(h - 10, y));
      if (marker.type === 'text') {
        const text = marker.text.trim().slice(0, 80); ctx.setLineDash([]); ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Consolas, monospace';
        const width = Math.min(plotW - 8, ctx.measureText(text).width + 10), x = Math.max(4, Math.min(plotW - width - 4, Number(marker.x) * plotW));
        ctx.fillStyle = 'rgba(255,255,255,0.96)'; ctx.fillRect(x, yClamped - 10, width, 20); ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, yClamped - 9.5, width - 1, 19);
        ctx.fillStyle = '#111111'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(text, x + 5, yClamped); return;
      }
      if (marker.type === 'ray') {
        const ray = rayGeometry(marker); if (!ray) return;
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, plotW, h); ctx.clip(); ctx.strokeStyle = '#f7931a'; ctx.lineWidth = 2; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(ray.startX, ray.startY); ctx.lineTo(ray.edgeX, ray.edgeY); ctx.stroke();
        const angle = Math.atan2(ray.edgeY - ray.startY, ray.edgeX - ray.startX); ctx.fillStyle = '#f7931a'; ctx.beginPath(); ctx.moveTo(ray.edgeX, ray.edgeY); ctx.lineTo(ray.edgeX - 10 * Math.cos(angle - Math.PI / 6), ray.edgeY - 10 * Math.sin(angle - Math.PI / 6)); ctx.lineTo(ray.edgeX - 10 * Math.cos(angle + Math.PI / 6), ray.edgeY - 10 * Math.sin(angle + Math.PI / 6)); ctx.closePath(); ctx.fill();
        if (markerMode && drawingTool === 'adjust') { ctx.fillStyle = '#fff'; ctx.strokeStyle = '#f7931a'; ctx.lineWidth = 2; [[ray.startX, ray.startY], [ray.controlX, ray.controlY]].forEach(([x, pointY]) => { ctx.beginPath(); ctx.arc(x, pointY, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }); }
        ctx.restore(); return;
      }
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
      const label = prefix + formatAxisValue(marker.price); ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Consolas, monospace'; const tw = ctx.measureText(label).width;
      ctx.setLineDash([]); ctx.fillStyle = '#222222'; ctx.fillRect(w - AXIS_W, yClamped - 9, tw + 8, 18); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(label, w - AXIS_W + 4, yClamped);
    });
    if (markerDraft?.type === 'ray') { const y = yFn(markerDraft.price); if (Number.isFinite(y)) { ctx.fillStyle = '#f7931a'; ctx.beginPath(); ctx.arc(markerDraft.x * plotW, y, 5, 0, Math.PI * 2); ctx.fill(); } }
    ctx.restore();
  }
  function drawTrendChart(prices, isBullish) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reseta a matriz antes de reaplicar a escala
    ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height;
    const plotW = w - AXIS_W;
    const min = Math.min(...prices), range = Math.max(...prices) - min || 1;
    const yOf = p => h - 15 - ((p - min) / range) * (h - 30);
    const coords = prices.map((p, i) => ({ x: (i / (prices.length - 1)) * plotW, y: yOf(p) }));

    // Guarda o estado atual do gráfico para o hover reaproveitar sem redimensionar o canvas
    chartState = { mode: 'line', prices, coords, isBullish, min, range, w, h, yOf };

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
    const plotW = w - AXIS_W;
    const min = Math.min(...candles.map(candle => candle.low));
    const range = Math.max(...candles.map(candle => candle.high)) - min || 1;
    const spacing = plotW / candles.length;
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
    const { coords, isBullish, min, range, w, h, yOf } = chartState;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    drawAxis(yOf);

    const openY = h-15-((openPriceReference-min)/range)*(h-30);
    ctx.beginPath(); ctx.setLineDash([6,6]); ctx.moveTo(0, openY); ctx.lineTo(w - AXIS_W, openY); ctx.strokeStyle = '#d5d7dc'; ctx.stroke(); ctx.setLineDash([]);

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
    drawMarkers();
    drawChartLabel();
    drawLivePrice();
  }

  /**
   * Encontra o ponto mais próximo do mouse/toque, desenha a linha-guia + o
   * ponto destacado, e mostra o tooltip com o valor formatado.
   */
  function renderCandles() {
    const { candles, w, h, spacing, candleWidth, priceY } = chartState;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    drawAxis(priceY);
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
    drawMarkers();
    drawChartLabel();
    drawLivePrice();
  }
  function handleChartHover(evt) {
    if (!chartState || !chartState.coords.length) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = evt.touches && evt.touches.length ? evt.touches[0].clientX : evt.clientX;
    const clientY = evt.touches && evt.touches.length ? evt.touches[0].clientY : evt.clientY;
    const x = clientX - rect.left;
    const mouseY = clientY - rect.top;
    const { coords, w, h, min, range } = chartState;
    const plotW = w - AXIS_W;
    let idx = 0;
    if (x <= 0) idx = 0;
    else if (x >= plotW) idx = coords.length - 1;
    else idx = Math.round((x / plotW) * (coords.length - 1));
    idx = Math.max(0, Math.min(coords.length - 1, idx));
    const point = coords[idx];
    renderBaseChart();

    // Preço correspondente ao Y do mouse (permite selecionar pavios high/low)
    const top = chartState.mode === 'candles' ? 18 : 15;
    const bottom = 15;
    const hoverY = Math.max(top, Math.min(h - bottom, mouseY));
    const hoverPrice = min + ((h - bottom - hoverY) / (h - top - bottom)) * range;
    const ctx = canvas.getContext('2d');
    // Guia vertical roam
    ctx.save(); ctx.beginPath(); ctx.setLineDash([4, 4]);
    ctx.moveTo(point.x, 0); ctx.lineTo(point.x, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();
    // Linha horizontal pontilhada até o eixo de preços à direita
    ctx.beginPath(); ctx.setLineDash([4, 4]);
    ctx.moveTo(0, hoverY); ctx.lineTo(w - AXIS_W, hoverY);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    if (chartState.mode === 'line') {
      ctx.beginPath(); ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = chartState.isBullish ? '#34d399' : '#f87171'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    }
    ctx.restore();

    // Rótulo do preço no eixo direito
    ctx.save();
    ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Consolas, monospace';
    const ccy = displayCurrency();
    const prefix = ccy === 'BRL' ? 'R$ ' : ccy === 'BTC' ? '₿ ' : '$ ';
    const label = prefix + formatAxisValue(hoverPrice);
    const tw = ctx.measureText(label).width;
    const yClamped = Math.max(9, Math.min(h - 9, hoverY));
    ctx.fillStyle = '#222222'; ctx.fillRect(w - AXIS_W, yClamped - 9, tw + 8, 18);
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(label, w - AXIS_W + 4, yClamped);
    ctx.restore();

    if (chartState.mode === 'candles') {
      const candle = chartState.candles[idx];
      showCandleTooltip(candle);
      showCandleDate(point.x, candle.time, idx === chartState.candles.length - 1);
    } else {
      hideCandleDate();
      showPriceTooltip(chartState.prices[idx], chartState.isBullish);
    }
  }

  function handleChartLeave() {
    hideCandleDate();
    renderBaseChart();
  }

  function handleChartClick(evt) {
    if (!markerMode || !chartState) return;
    const now = Date.now();
    if (evt.type === 'mouseup' && now - lastTouchMarkerAt < 750) return;
    if (evt.type === 'touchend') lastTouchMarkerAt = now;
    const point = drawingPoint(evt);
    if (!point) return;
    if (drawingTool === 'erase') {
      const hit = markerHit(point);
      if (hit) { markerLines.splice(hit.index, 1); saveAndShareMarkers(); }
      return;
    }
    if (drawingTool === 'adjust') {
      if (markerDraft?.type === 'adjust') {
        const marker = markerLines[markerDraft.index];
        if (!marker) { markerDraft = null; return; }
        if (marker.type === 'ray') {
          if (markerDraft.handle === 'start') { marker.x = point.normalX; marker.price = point.price; }
          else { marker.endX = point.normalX; marker.endPrice = point.price; }
        } else if (marker.type === 'text') { marker.x = point.normalX; marker.price = point.price; }
        else marker.price = point.price;
        markerDraft = null; saveAndShareMarkers();
      } else {
        const hit = markerHit(point);
        if (hit) { markerDraft = { type: 'adjust', ...hit }; renderBaseChart(); }
      }
      return;
    }
    if (drawingTool === 'ray') {
      if (markerDraft?.type === 'ray') {
        if (Math.abs(point.normalX - markerDraft.x) < 0.01) return;
        markerLines.push({ type: 'ray', price: markerDraft.price, x: markerDraft.x, endPrice: point.price, endX: point.normalX });
        markerDraft = null; saveAndShareMarkers();
      } else { markerDraft = { type: 'ray', price: point.price, x: point.normalX }; renderBaseChart(); }
      return;
    }
    if (drawingTool === 'text') {
      const text = window.prompt('Texto para o gráfico:', '');
      if (!text || !text.trim()) return;
      markerLines.push({ type: 'text', price: point.price, x: point.normalX, text: text.trim().slice(0, 80) });
    } else {
      const existing = markerLines.findIndex(marker => marker.type === 'line' && Math.abs(marker.price - point.price) < chartState.range * 0.01);
      if (existing >= 0) markerLines.splice(existing, 1);
      else markerLines.push({ type: 'line', price: point.price });
    }
    saveAndShareMarkers();
  }
  function keepTooltipVisible() {
    tooltipEl.classList.add('visible');
    clearTimeout(tooltipHideTimer);
    tooltipHideTimer = setTimeout(hideTooltip, 15000);
  }

  function showPriceTooltip(price, isUp) {
    if (!tooltipEl) return;
    const ccy = displayCurrency();
    const prefix = ccy === 'BRL' ? 'R$ ' : ccy === 'BTC' ? '₿ ' : '$ ';
    tooltipEl.innerHTML = `<span class="ohlc-value ${isUp ? 'up' : 'down'}">${prefix}${formatNumber(price, ccy)}</span>`;
    keepTooltipVisible();
  }

  function showCandleTooltip(candle) {
    if (!tooltipEl) return;
    const tone = candle.close >= candle.open ? 'up' : 'down';
    const ccy = displayCurrency();
    tooltipEl.innerHTML = [
      ['A', candle.open], ['MÁX', candle.high], ['MÍN', candle.low], ['F', candle.close]
    ].map(([label, value]) => `<span class="ohlc-label">${label}</span><span class="ohlc-value ${tone}">${formatNumber(value, ccy)}</span>`).join('');
    keepTooltipVisible();
  }

  function showCandleDate(x, time, isCurrent = false) {
    if (!chartDateEl || !chartWrap) return;
    const candleDate = new Date(time);
    let candleLabel;

    if (activeTimeframe === '1H' || activeTimeframe === '15M') {
      const date = candleDate.toLocaleDateString('pt-BR', {
        timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric'
      });
      const timeLabel = candleDate.toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit'
      });
      candleLabel = `${date} • ${timeLabel} Brasília`;
    } else if (activeTimeframe === '1M') {
      candleLabel = candleDate.toLocaleDateString('pt-BR', {
        timeZone: 'UTC', month: '2-digit', year: 'numeric'
      });
    } else if (activeTimeframe === '1Y') {
      candleLabel = candleDate.toLocaleDateString('pt-BR', {
        timeZone: 'UTC', year: 'numeric'
      });
    } else {
      candleLabel = candleDate.toLocaleDateString('pt-BR', {
        timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric'
      });
    }

    chartDateEl.textContent = isCurrent ? `${candleLabel} • EM FORMAÇÃO` : candleLabel;
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
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pullPublicMarkers();
  });
  setInterval(() => void pullPublicMarkers(), 5000);
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
    setExternalAsset(null); // voltar ao modo normal BTC/fiat ao mexer nos selects
    updateTitle(); // Atualiza o título ao mudar o ativo
    updateAll(); 
  }));

  // --- CARREGAR ATIVO CLICADO NO TICKER ---
  window.addEventListener('estudebitcoin:load-asset', (event) => {
    const detail = event && event.detail;
    if (!detail || !detail.symbol) return;
    const asset = {
      kind: detail.kind === 'stock' ? 'stock' : 'crypto',
      symbol: detail.kind === 'stock' ? detail.symbol : detail.symbol,
      pair: detail.pair || (detail.symbol + 'USDT'),
      label: detail.label || detail.symbol
    };
    setExternalAsset(asset);
  });

  // --- HOVER / TOOLTIP NO GRÁFICO ---
  canvas.addEventListener('mousemove', handleChartHover);
  canvas.addEventListener('mouseleave', handleChartLeave);
  canvas.addEventListener('mouseup', handleChartClick);
  canvas.addEventListener('touchstart', handleChartHover, { passive: true });
  canvas.addEventListener('touchmove', handleChartHover, { passive: true });
  canvas.addEventListener('touchend', handleChartLeave);
  canvas.addEventListener('touchend', handleChartClick);

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

  function setDrawMenu(open) {
    if (!drawOptionsEl || !drawToggleBtn) return;
    drawOptionsEl.hidden = !open;
    drawToggleBtn.setAttribute('aria-expanded', String(open));
  }

  function setDrawingTool(tool) {
    drawingTool = tool;
    const labels = { line: 'Linha', ray: 'Raio', text: 'Texto', adjust: 'Ajustar', erase: 'Apagar' };
    drawToolBtns.forEach(button => button.setAttribute('aria-checked', String(button.dataset.drawTool === tool)));
    if (drawToggleBtn) {
      drawToggleBtn.textContent = `Desenho · ${labels[tool] || 'Linha'}`;
      drawToggleBtn.title = labels[tool] === 'Raio' ? 'Raio: clique no início e no ponto de direção' : labels[tool] === 'Ajustar' ? 'Ajustar: clique no desenho e depois no novo ponto' : labels[tool] === 'Apagar' ? 'Apagar: clique no desenho' : 'Desenhos públicos compartilhados';
    }
  }

  if (drawToggleBtn) drawToggleBtn.addEventListener('click', () => {
    hideTooltip();
    if (markerMode) {
      markerMode = false;
      markerDraft = null;
      drawToggleBtn.classList.remove('active');
      drawToggleBtn.setAttribute('aria-pressed', 'false');
      setDrawMenu(false);
      renderBaseChart();
      return;
    }
    setDrawMenu(drawOptionsEl?.hidden);
  });

  drawToolBtns.forEach(button => button.addEventListener('click', () => {
    setDrawingTool(button.dataset.drawTool || 'line');
    markerMode = true;
    markerDraft = null;
    drawToggleBtn?.classList.add('active');
    drawToggleBtn?.setAttribute('aria-pressed', 'true');
    setDrawMenu(false);
    renderBaseChart();
  }));
  window.addEventListener('beforeunload', () => {
    clearTimeout(klineReconnectTimer);
    clearTimeout(stockPollTimer);
    klineSocketKey = '';
    const socket = klineSocket;
    klineSocket = null;
    if (socket) socket.close();
  });
  async function updateAll() { await fetchCurrentTicker(); await fetchHistoricalTrends(); }
  
  // Inicialização
  setInitialDefaults(); // Força Bitcoin para US Dólar no carregamento
  loadMarkers();
  updateAll();
  setInterval(fetchCurrentTicker, 10000);     // preço ao vivo a cada 10s
  setInterval(fetchHistoricalTrends, 60000);  // gráfico/histórico a cada 60s
});
