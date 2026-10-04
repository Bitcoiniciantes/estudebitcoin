/* =====================================================================
   WIDGET: Order Book visual BTCUSDT (Futures USDⓈ-M) — EstudeBitcoin
   ---------------------------------------------------------------------
   O QUE MOSTRA: somente ordens reais do book da Binance Futures,
   agregadas por faixa de preço (buckets). NÃO usa open interest,
   liquidação estimada, alavancagem ou qualquer estimativa — se uma
   faixa não tem ordens no book, ela simplesmente não aparece.

   AGREGAÇÃO POR FAIXA (buckets 1/5/10/25 USD, padrão 10):
     usd_por_nivel = preco * quantidade
     bucket = floor(preco / faixa) * faixa   (ex.: faixa 10 → 84990–85000)
     soma todos os níveis do book dentro de cada bucket, separando
     bids (compras, abaixo do preço) e asks (vendas, acima do preço).
     A largura das barras usa escala ÚNICA: 100% = maior bucket entre
     os dois lados, para comparar compras × vendas visualmente.
     Bucket que atravesse a borda da profundidade conhecida é OMITIDO
     (nunca desenhado como parcial nem estendido).

   SINCRONIZAÇÃO DO BOOK (ritual oficial USDⓈ-M "How to manage a local
   order book correctly"):
     1. abre o WS e bufferiza eventos depthUpdate;
     2. busca snapshot REST (limit=1000) → lastUpdateId;
     3. descarta eventos com u < lastUpdateId;
     4. primeiro evento válido: U <= lastUpdateId && u >= lastUpdateId;
        se todos os eventos em buffer tiverem U > lastUpdateId, busca
        novo snapshot (o book andou durante o fetch);
     5. do segundo evento aplicado em diante, exige pu === u anterior;
        qualquer quebra → descarta todo o estado local e repete o ritual;
     6. reconexão do WS → descarta estado e repete o ritual;
     7. quantidade 0 remove o nível (inclusive níveis ausentes: normal).
     Resnapshot periódico existe só como higiene opcional (5 min).

   COBERTURA (regra de representação do painel, NÃO do protocolo):
     cobertura_lado = (níveis do snapshot de origem que permanecem
                       conhecidos/vivos) / (níveis inicialmente
                       recebidos naquele lado).
     - Denominador congelado até o próximo resync; updates de
       quantidade nunca o alteram; níveis fora da janela original
       não entram no contador; contadores incrementais O(1).
     - BOOK_MIN_LEVELS_PER_SIDE = 200 (única constante configurável).
       Abaixo do mínimo em qualquer lado → badge "profundidade
       limitada" + resync; se o novo snapshot também vier abaixo,
       mantém o estado real sem fabricar profundidade.

   PREÇO: vem exclusivamente do kline de futuros (nunca do midpoint
   do book). Eixo Y definido pelos candles; o book é recortado ao
   range visível (nunca achata os candles).
   ===================================================================== */
(function () {
  'use strict';

  // ---- Constantes configuráveis ----
  var SYMBOL = 'BTCUSDT';
  var BUCKET_CHOICES = [1, 5, 10, 25, 50, 100];
  var DEFAULT_BUCKET = 50;
  var TIMEFRAMES = ['1m', '5m', '15m', '1h'];
  var DEFAULT_TF = '1m';
  var BOOK_MIN_LEVELS_PER_SIDE = 200; // única constante de cobertura
  var SNAPSHOT_URL = 'https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000';
  var KLINES_URL = 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=';
  var DEPTH_WS_URL = 'wss://fstream.binance.com/public/ws/btcusdt@depth';
  var KLINE_WS_BASE = 'wss://fstream.binance.com/market/ws/btcusdt@kline_';
  var RECONNECT_MS = 3000;
  var HYGIENE_RESYNC_MS = 5 * 60 * 1000;
  var VALIDATE_MS = 60 * 1000;
  var MAX_CANDLES = 150;
  // Anti-flicker: o depth chega a ~4 eventos/s, mas o DOM (linhas + canvas)
  // é reconstruído no máximo 1x a cada 1,5s. Dados continuam ao vivo.
  var RENDER_MIN_INTERVAL_MS = 1500;
  var lastRenderAt = 0;
  var renderTimer = null;

  // ---- Estado ----
  var bucketSize = DEFAULT_BUCKET;
  var timeframe = DEFAULT_TF;
  var candles = [];          // {time, open, high, low, close}
  var currentPrice = 0;
  var bids = new Map();      // priceStr -> qty (números como string p/ chave estável)
  var asks = new Map();
  var lastUpdateId = -1;
  var prevU = -1;            // u do último evento aplicado (p/ checar pu)
  var appliedCount = 0;      // eventos aplicados desde o snapshot
  var depthBuffer = [];      // eventos recebidos antes do snapshot
  var depthReady = false;
  var originBids = new Set(); // níveis do snapshot de origem (lado bid)
  var originAsks = new Set(); // níveis do snapshot de origem (lado ask)
  var aliveBids = new Set();  // subconjunto de originBids ainda conhecido/vivo
  var aliveAsks = new Set();
  var depthSocket = null;
  var klineSocket = null;
  var depthTimer = null;
  var klineTimer = null;
  var hygieneTimer = null;
  var validateTimer = null;
  var bootSeq = 0; // geração do boot atual: esperas/fetches antigos se anulam
  var renderQueued = false;
  // Pool de linhas das barras: atualização NO LUGAR (sem rebuild/pisca).
  var askRowEls = new Map(), bidRowEls = new Map(), midEl = null, rowsMsg = '';
  var lastCandleSig = '';
  var lastUpdateTime = 0;

  // ---- DOM ----
  var root = document.getElementById('orderbook-root');
  if (!root) return;

  root.innerHTML =
    '<div class="ob__wrap">' +
      '<div class="ob__head">' +
        '<h2 class="ob__title">Order Book · BTCUSDT · Futures Binance</h2>' +
        '<div class="ob__meta">' +
          '<span class="ob__price" id="ob-price">—</span>' +
          '<span><span class="ob__dot" id="ob-dot"></span><span id="ob-status">Conectando…</span></span>' +
          '<span id="ob-updated">Atualizado: —</span>' +
          '<span id="ob-coverage"></span>' +
        '</div>' +
      '</div>' +
      '<div class="ob__controls">' +
        '<div class="ob__seg" id="ob-tfseg" role="group" aria-label="Tempo gráfico"></div>' +
        '<div class="ob__seg" id="ob-bkseg" role="group" aria-label="Tamanho da faixa"></div>' +
      '</div>' +
      '<p class="ob__warn" id="ob-warn" hidden></p>' +
      '<p class="ob__legend"><span class="ob__lg"><i class="ob__dotlg ob__dotlg--ask"></i>VENDAS (vermelho, acima do preço)</span>' +
      '<span class="ob__lg"><i class="ob__dotlg ob__dotlg--bid"></i>COMPRAS (azul, abaixo do preço)</span></p>' +
      '<p class="ob__disclaimer">Ordens reais do book neste momento — não são liquidações futuras. ' +
      'Profundidade limitada a 1000 níveis por lado; faixas sem ordens não geram barras.</p>' +
      '<details class="ob__help"><summary>O que é isso?</summary>' +
      '<p>Antes de comprar ou vender Bitcoin, a pessoa deixa uma <strong>ordem</strong> avisando o preço que ela quer. ' +
      'Este painel soma todo o dinheiro dessas ordens por faixa de preço.</p>' +
      '<p><strong style="color:#ff8a80">Barras vermelhas</strong> (acima do preço atual): ordens de <strong>venda</strong> — ' +
      'onde tem muita barra vermelha, tem muita gente querendo vender (isso pode segurar a subida do preço).</p>' +
      '<p><strong style="color:#90caf9">Barras azuis</strong> (abaixo do preço atual): ordens de <strong>compra</strong> — ' +
      'onde tem muita barra azul, tem muita gente querendo comprar (isso pode segurar a queda do preço).</p>' +
      '<p>Conteúdo educativo: mostra onde o dinheiro está posicionado, não diz para onde o preço vai.</p></details>' +
      '<div class="ob__grid">' +
        '<div class="ob__panel"><h3>CANDLES · <span id="ob-tflabel">1m</span></h3><canvas id="ob-candles"></canvas></div>' +
        '<div class="ob__panel"><h3>CONCENTRAÇÃO · faixa US$ <span id="ob-bklabel">50</span></h3><div class="ob__rows" id="ob-rows"><div class="ob__loading">Carregando book…</div></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="ob__tip" id="ob-tip"></div>';

  var priceEl = document.getElementById('ob-price');
  var dotEl = document.getElementById('ob-dot');
  var statusEl = document.getElementById('ob-status');
  var updatedEl = document.getElementById('ob-updated');
  var coverageEl = document.getElementById('ob-coverage');
  var warnEl = document.getElementById('ob-warn');
  var rowsEl = document.getElementById('ob-rows');
  var canvas = document.getElementById('ob-candles');
  var tipEl = document.getElementById('ob-tip');
  var tfSeg = document.getElementById('ob-tfseg');
  var bkSeg = document.getElementById('ob-bkseg');

  function setStatus(mode, text) {
    dotEl.className = 'ob__dot' + (mode === 'on' ? ' ob__dot--on' : mode === 'warn' ? ' ob__dot--warn' : mode === 'off' ? ' ob__dot--off' : '');
    statusEl.textContent = text;
  }

  function fmtUSD(v) {
    if (v >= 1e6) return 'US$ ' + (v / 1e6).toFixed(2).replace('.', ',') + 'M';
    if (v >= 1e3) return 'US$ ' + (v / 1e3).toFixed(1).replace('.', ',') + 'k';
    return 'US$ ' + v.toFixed(0);
  }

  // ---- Controles (timeframe + faixa) ----
  TIMEFRAMES.forEach(function (tf) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = tf;
    if (tf === timeframe) b.className = 'ativo';
    b.addEventListener('click', function () {
      if (timeframe === tf) return;
      timeframe = tf;
      document.getElementById('ob-tflabel').textContent = tf;
      Array.prototype.forEach.call(tfSeg.children, function (x) { x.className = ''; });
      b.className = 'ativo';
      restartKline();
    });
    tfSeg.appendChild(b);
  });
  BUCKET_CHOICES.forEach(function (bk) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'US$ ' + bk;
    if (bk === bucketSize) b.className = 'ativo';
    b.addEventListener('click', function () {
      if (bucketSize === bk) return;
      bucketSize = bk;
      document.getElementById('ob-bklabel').textContent = String(bk);
      Array.prototype.forEach.call(bkSeg.children, function (x) { x.className = ''; });
      b.className = 'ativo';
      queueRender();
    });
    bkSeg.appendChild(b);
  });

  // ================= DEPTH (book) =================
  function resetBookState() {
    bids.clear(); asks.clear();
    originBids.clear(); originAsks.clear();
    aliveBids.clear(); aliveAsks.clear();
    depthBuffer = [];
    depthReady = false;
    lastUpdateId = -1; prevU = -1; appliedCount = 0;
  }

  function applyLevel(map, origin, alive, priceStr, qty) {
    var q = parseFloat(qty);
    if (!isFinite(q) || q < 0) return 'invalid';
    var p = parseFloat(priceStr);
    if (!isFinite(p) || p <= 0) return 'invalid';
    if (q === 0) {
      map.delete(priceStr);
      alive.delete(priceStr); // quantidade zero: deixa de contar na cobertura
    } else {
      map.set(priceStr, q);
      // Níveis novos vindos de eventos NÃO entram no contador de origem:
      // só níveis do snapshot de origem contam (denominador congelado).
    }
    return 'ok';
  }

  function applyDepthEvent(ev) {
    // Primeiro evento após snapshot: U <= lastUpdateId && u >= lastUpdateId.
    // Do segundo em diante: pu === u anterior.
    if (!depthReady) return false;
    var U = ev.U, u = ev.u, pu = ev.pu;
    if (typeof U !== 'number' || typeof u !== 'number') return false;
    if (appliedCount === 0) {
      if (!(U <= lastUpdateId && u >= lastUpdateId)) return false;
    } else {
      if (typeof pu !== 'number' || pu !== prevU) return false; // quebra → resync
    }
    var bad = false;
    (ev.b || []).forEach(function (lv) { if (applyLevel(bids, originBids, aliveBids, lv[0], lv[1]) === 'invalid') bad = true; });
    (ev.a || []).forEach(function (lv) { if (applyLevel(asks, originAsks, aliveAsks, lv[0], lv[1]) === 'invalid') bad = true; });
    if (bad) return false;
    prevU = u; appliedCount++;
    checkCoverage();
    return true;
  }

  function onDepthMessage(ev) {
    if (!ev || ev.e !== 'depthUpdate') return;
    if (!depthReady) { depthBuffer.push(ev); return; } // bufferiza pré-snapshot
    if (!applyDepthEvent(ev)) startResync('quebra de sequência');
    else queueRender();
  }

  function startResync(reason) {
    resetBookState();
    setStatus('warn', 'Ressincronizando…');
    bootDepth();
    if (reason) warnEl.hidden = false, warnEl.textContent = 'Ressincronizando book (' + reason + ').';
    else warnEl.hidden = true;
  }

  function bootDepth() {
    bootSeq++; // invalida esperas/fetches de boots anteriores
    var seq = bootSeq;
    clearTimeout(depthTimer); depthTimer = null;
    resetBookState();
    // 1. Abre o WS primeiro e bufferiza (ritual oficial).
    connectDepthSocket();
    // 1b. Aguarda ao menos 1 evento em buffer ANTES do snapshot (até 3s).
    // Sem isso, o snapshot pode nascer defasado: o primeiro evento ao vivo
    // chegaria com U > lastUpdateId e o sync falharia em loop eterno.
    var waited = 0;
    (function waitBuf() {
      if (seq !== bootSeq) return; // boot superado: aborta
      if (depthBuffer.length > 0 || waited >= 3000) { fetchSnapshot(seq); return; }
      waited += 120;
      setTimeout(waitBuf, 120);
    })();
  }

  function fetchSnapshot(seq) {
    // 2. Snapshot REST (só vale para o boot que o pediu).
    fetch(SNAPSHOT_URL, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (snap) {
        if (seq !== bootSeq) return; // boot superado: descarta resposta tardia
        if (!snap || typeof snap.lastUpdateId !== 'number' || !Array.isArray(snap.bids) || !Array.isArray(snap.asks)) {
          throw new Error('snapshot inválido');
        }
        lastUpdateId = snap.lastUpdateId;
        snap.bids.forEach(function (lv) {
          var p = String(lv[0]), q = parseFloat(lv[1]);
          if (isFinite(parseFloat(p)) && isFinite(q) && q > 0) {
            bids.set(p, q); originBids.add(p); aliveBids.add(p);
          }
        });
        snap.asks.forEach(function (lv) {
          var p = String(lv[0]), q = parseFloat(lv[1]);
          if (isFinite(parseFloat(p)) && isFinite(q) && q > 0) {
            asks.set(p, q); originAsks.add(p); aliveAsks.add(p);
          }
        });
        if (originBids.size === 0 || originAsks.size === 0) throw new Error('snapshot vazio');
        depthReady = true;
        // 3. Descarta u < lastUpdateId; procura o primeiro U <= lastUpdateId <= u.
        var buf = depthBuffer; depthBuffer = [];
        buf = buf.filter(function (ev) { return ev.u >= lastUpdateId; });
        var start = -1;
        for (var i = 0; i < buf.length; i++) {
          if (buf[i].U <= lastUpdateId && buf[i].u >= lastUpdateId) { start = i; break; }
        }
        if (buf.length && start === -1) {
          // Todos os eventos têm U > lastUpdateId: o book andou → novo snapshot.
          startResync('snapshot defasado');
          return;
        }
        for (var j = Math.max(0, start); j < buf.length; j++) {
          if (!applyDepthEvent(buf[j])) { startResync('eventos em buffer inconsistentes'); return; }
        }
        warnEl.hidden = true;
        setStatus('on', 'Conectado');
        checkCoverage();
        queueRender();
      })
      .catch(function () {
        if (seq !== bootSeq) return;
        setStatus('off', 'Falha no snapshot — tentando de novo');
        setTimeout(bootDepth, RECONNECT_MS);
      });
  }

  function connectDepthSocket() {
    try { if (depthSocket) depthSocket.close(); } catch (e) {}
    var ws;
    try { ws = new WebSocket(DEPTH_WS_URL); } catch (e) { setTimeout(connectDepthSocket, RECONNECT_MS); return; }
    depthSocket = ws;
    ws.onmessage = function (evt) {
      try { onDepthMessage(JSON.parse(evt.data)); } catch (e) {}
      lastUpdateTime = Date.now();
      updatedEl.textContent = 'Atualizado: ' + new Date().toLocaleTimeString('pt-BR');
    };
    ws.onclose = function () {
      // Socket fechado de propósito (resync/troca) NÃO reagenda: evita loop
      // de ressincronização — só o socket atual pode pedir reconexão.
      if (depthSocket !== ws) return;
      // Reconexão: descarta estado local e repete o ritual (não reaproveita book).
      setStatus('warn', 'Reconectando book…');
      clearTimeout(depthTimer);
      depthTimer = setTimeout(bootDepth, RECONNECT_MS);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  // ---- Cobertura: originais vivos / originais recebidos, por lado ----
  function checkCoverage() {
    var cb = originBids.size ? aliveBids.size : 0;
    var ca = originAsks.size ? aliveAsks.size : 0;
    var low = cb < BOOK_MIN_LEVELS_PER_SIDE || ca < BOOK_MIN_LEVELS_PER_SIDE;
    if (low && depthReady) {
      coverageEl.textContent = '· profundidade limitada';
      warnEl.hidden = false;
      warnEl.textContent = 'Profundidade limitada (bids ' + cb + ' / asks ' + ca +
        ', mínimo ' + BOOK_MIN_LEVELS_PER_SIDE + ' por lado). Ressincronizando…';
      startResync();
    } else if (depthReady) {
      coverageEl.textContent = '';
    }
  }

  // ================= KLINE (candles + preço) =================
  function restartKline() {
    try { if (klineSocket) klineSocket.close(); } catch (e) {}
    clearTimeout(klineTimer);
    fetch(KLINES_URL + timeframe + '&limit=' + MAX_CANDLES, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!Array.isArray(data) || !data.length) throw new Error('klines vazios');
        candles = data.map(function (k) {
          return { time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4] };
        });
        currentPrice = candles[candles.length - 1].close;
        paintPrice();
        connectKlineSocket();
        queueRender();
      })
      .catch(function () { clearTimeout(klineTimer); klineTimer = setTimeout(restartKline, RECONNECT_MS); });
  }

  function connectKlineSocket() {
    try { if (klineSocket) klineSocket.close(); } catch (e) {}
    var ws;
    try { ws = new WebSocket(KLINE_WS_BASE + timeframe); } catch (e) {
      clearTimeout(klineTimer); klineTimer = setTimeout(connectKlineSocket, RECONNECT_MS); return;
    }
    klineSocket = ws;
    ws.onmessage = function (evt) {
      try {
        var p = JSON.parse(evt.data), k = p.k;
        if (!k) return;
        var c = { time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c };
        var last = candles[candles.length - 1];
        if (last && last.time === c.time) candles[candles.length - 1] = c;
        else { candles.push(c); candles = candles.slice(-MAX_CANDLES); }
        currentPrice = c.close; // preço exclusivamente do kline
        paintPrice();
        queueRender();
      } catch (e) {}
    };
    ws.onclose = function () {
      // Mesmo guarda do depth: socket trocado de propósito não reagenda.
      if (klineSocket !== ws) return;
      clearTimeout(klineTimer); klineTimer = setTimeout(connectKlineSocket, RECONNECT_MS);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function paintPrice() {
    priceEl.textContent = currentPrice ? '$ ' + currentPrice.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '—';
  }

  // ================= VALIDAÇÃO PERIÓDICA (REST × local) =================
  // Compara best bid/ask e topo do book; diferenças puras de timing NÃO
  // disparam resync isoladamente — só problemas estruturais (book
  // cruzado, quantidades inválidas, níveis fora da cobertura).
  function validateBook() {
    if (!depthReady) return;
    fetch(SNAPSHOT_URL, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (snap) {
        if (!snap || !Array.isArray(snap.bids) || !Array.isArray(snap.asks)) return;
        var rb = parseFloat(snap.bids[0][0]), ra = parseFloat(snap.asks[0][0]);
        var lb = bestBid(), la = bestAsk();
        if (!(rb < ra)) return; // REST inconsistente: ignora (timing)
        if (lb && la && !(lb < la)) { startResync('book cruzado'); return; } // estrutural
        var badQty = false;
        bids.forEach(function (q, p) { if (!(q > 0) || !(+p > 0)) badQty = true; });
        asks.forEach(function (q, p) { if (!(q > 0) || !(+p > 0)) badQty = true; });
        if (badQty) { startResync('quantidade inválida'); return; }
        // Níveis fora da cobertura original: apenas ignora na renderização
        // (são descartados do desenho, sem resync por esse motivo isolado).
      })
      .catch(function () {});
  }

  function bestBid() {
    var m = -Infinity;
    bids.forEach(function (_, p) { var v = +p; if (v > m) m = v; });
    return m === -Infinity ? 0 : m;
  }
  function bestAsk() {
    var m = Infinity;
    asks.forEach(function (_, p) { var v = +p; if (v < m) m = v; });
    return m === Infinity ? 0 : m;
  }

  // ================= RENDER =================
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    var wait = RENDER_MIN_INTERVAL_MS - (Date.now() - lastRenderAt);
    if (wait <= 0) {
      renderQueued = false; lastRenderAt = Date.now(); render();
    } else {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(function () {
        renderQueued = false; lastRenderAt = Date.now(); render();
      }, wait);
    }
  }

  function render() {
    drawCandles();
    drawBuckets();
  }

  function drawCandles() {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || canvas.parentElement.clientWidth - 24;
    var h = 300;
    // Setar width/height limpa o canvas e causa pisca: só quando mudou.
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      lastCandleSig = ''; // tamanho novo exige redesenho
    }
    if (!candles.length) return;
    var vis = candles.slice(-120);
    var lo = Math.min.apply(null, vis.map(function (c) { return c.low; }));
    var hi = Math.max.apply(null, vis.map(function (c) { return c.high; }));
    if (!(hi > lo)) return;
    canvas._yScale = { lo: lo, hi: hi, h: h }; // eixo Y oficial: definido pelos candles
    // Gráfico fixo: se nada mudou (velas, preço, largura), não redesenha.
    var last = vis[vis.length - 1];
    var sig = vis.length + '|' + lo + '|' + hi + '|' + last.time + '|' + last.close + '|' + currentPrice + '|' + Math.round(w);
    if (sig === lastCandleSig) return;
    lastCandleSig = sig;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // setTransform (não scale: scale acumula e desloca)
    ctx.clearRect(0, 0, w, h);
    var pad = 8;
    function y(p) { return pad + (1 - (p - lo) / (hi - lo)) * (h - pad * 2); }
    // Eixo de preço à direita: área dos candles + gutter da escala.
    var axisW = 56;
    var plotW = Math.max(50, w - axisW);
    var cw = (plotW - 10) / vis.length;
    vis.forEach(function (c, i) {
      var up = c.close >= c.open;
      ctx.strokeStyle = up ? '#4caf50' : '#f44336';
      ctx.fillStyle = up ? '#4caf50' : '#f44336';
      var x = 5 + i * cw + cw / 2;
      ctx.beginPath(); ctx.moveTo(x, y(c.high)); ctx.lineTo(x, y(c.low)); ctx.stroke();
      var b = Math.max(1, cw * 0.6);
      var yO = y(c.open), yC = y(c.close);
      ctx.fillRect(x - b / 2, Math.min(yO, yC), b, Math.max(1, Math.abs(yC - yO)));
    });
    // Linha do preço atual atravessando os candles + escala de valores à direita.
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'middle';
    var t;
    for (t = 0; t <= 4; t++) {
      var pv = hi - (hi - lo) * t / 4;
      var py = y(pv);
      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(plotW, py); ctx.stroke();
      ctx.fillStyle = '#888';
      ctx.fillText(fmtAxis(pv), plotW + 5, py);
    }
    if (currentPrice >= lo && currentPrice <= hi) {
      var cpy = y(currentPrice);
      ctx.strokeStyle = 'rgba(247,147,26,.8)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(0, cpy); ctx.lineTo(plotW, cpy); ctx.stroke();
      ctx.setLineDash([]);
      // Etiqueta do preço atual no gutter do eixo.
      var tag = fmtAxis(currentPrice);
      ctx.fillStyle = '#F7931A';
      ctx.fillRect(plotW + 2, cpy - 9, axisW - 4, 18);
      ctx.fillStyle = '#111';
      ctx.fillText(tag, plotW + 7, cpy);
    }
  }

  // Rótulo compacto do eixo (pt-BR, sem decimais nessa magnitude).
  function fmtAxis(v) {
    return v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  }

  // Mensagens de estado: só tocam o DOM na TRANSIÇÃO (nunca a cada render).
  function showRowsMsg(kind, html) {
    if (rowsMsg === kind) return;
    rowsMsg = kind;
    rowsEl.innerHTML = html;
    askRowEls.clear(); bidRowEls.clear(); midEl = null;
  }

  function drawBuckets() {
    var scale = canvas._yScale;
    if (!depthReady || !scale || !currentPrice) {
      showRowsMsg('loading', '<div class="ob__loading">Carregando book…</div>');
      return;
    }
    var lo = scale.lo, hi = scale.hi;
    // Profundidade conhecida: [menor bid vivo, maior ask vivo].
    var minBid = Infinity, maxBid = -Infinity, minAsk = Infinity, maxAsk = -Infinity;
    bids.forEach(function (_, p) { var v = +p; if (v < minBid) minBid = v; if (v > maxBid) maxBid = v; });
    asks.forEach(function (_, p) { var v = +p; if (v < minAsk) minAsk = v; if (v > maxAsk) maxAsk = v; });
    if (minBid === Infinity || maxAsk === -Infinity) {
      showRowsMsg('empty', '<div class="ob__empty">Book vazio — aguardando sincronização.</div>');
      return;
    }
    // Agrega USD por bucket, separando bids e asks.
    var bidBuckets = new Map(), askBuckets = new Map();
    bids.forEach(function (q, p) {
      var price = +p;
      if (price < lo || price > hi) return; // recorta ao range dos candles
      var bLo = Math.floor(price / bucketSize) * bucketSize;
      var bHi = bLo + bucketSize;
      // Bucket precisa estar INTEIRO dentro da profundidade conhecida:
      if (!(bLo >= minBid && bHi <= maxBid)) return; // borda → OMITIDO
      bidBuckets.set(bLo, (bidBuckets.get(bLo) || 0) + price * q);
    });
    asks.forEach(function (q, p) {
      var price = +p;
      if (price < lo || price > hi) return;
      var bLo = Math.floor(price / bucketSize) * bucketSize;
      var bHi = bLo + bucketSize;
      if (!(bLo >= minAsk && bHi <= maxAsk)) return; // borda → OMITIDO
      askBuckets.set(bLo, (askBuckets.get(bLo) || 0) + price * q);
    });
    if (!bidBuckets.size && !askBuckets.size) {
      showRowsMsg('nobuckets', '<div class="ob__empty">Sem buckets completos no range visível.</div>');
      return;
    }
    // Saímos de um estado de mensagem: limpa UMA vez e recomeça o pool.
    if (rowsMsg !== 'data') {
      rowsMsg = 'data';
      rowsEl.innerHTML = '';
      askRowEls.clear(); bidRowEls.clear(); midEl = null;
    }
    // Escala ÚNICA: 100% = maior bucket entre os dois lados.
    var peak = 0;
    bidBuckets.forEach(function (v) { if (v > peak) peak = v; });
    askBuckets.forEach(function (v) { if (v > peak) peak = v; });
    if (!peak) return;
    // Maior concentração de cada lado (etiqueta estilo "90k | 20M USD").
    var maxAskK = null, maxAskV = -1, maxBidK = null, maxBidV = -1;
    askBuckets.forEach(function (v, k) { if (v > maxAskV) { maxAskV = v; maxAskK = k; } });
    bidBuckets.forEach(function (v, k) { if (v > maxBidV) { maxBidV = v; maxBidK = k; } });
    var askKeys = Array.from(askBuckets.keys()).sort(function (a, b) { return b - a; });
    var bidKeys = Array.from(bidBuckets.keys()).sort(function (a, b) { return b - a; });
    if (!midEl) {
      midEl = document.createElement('div');
      midEl.className = 'ob__midline';
      rowsEl.appendChild(midEl);
    }
    // Linha persistente: cria uma vez, depois só atualiza largura/texto/chip
    // quando mudam. Mover nó existente (insertBefore/appendChild) não pisca.
    function syncRow(pool, key, bLo, usd, side, isMax) {
      var pct = (usd / peak * 100).toFixed(1);
      var usdTxt = fmtUSD(usd);
      var e = pool.get(key);
      if (!e) {
        var d = document.createElement('div');
        d.className = 'ob__row';
        d.innerHTML = '<span class="ob__bucket"></span>' +
          '<span class="ob__bar-track"><span class="ob__bar-fill ' +
          (side === 'ask' ? 'ob__bar-fill--ask' : 'ob__bar-fill--bid') + '"></span></span>' +
          '<span class="ob__usd"></span>';
        e = { el: d, bucket: d.querySelector('.ob__bucket'), fill: d.querySelector('.ob__bar-fill'),
              usdEl: d.querySelector('.ob__usd'), data: null, bs: 0, w: '', c: '', html: '' };
        d.addEventListener('mousemove', function (ev) {
          var dt = e.data; if (!dt) return;
          var dist = ((dt.bLo + bucketSize / 2 - currentPrice) / currentPrice * 100).toFixed(2).replace('.', ',');
          tipEl.style.display = 'block';
          tipEl.style.left = (ev.clientX + 12) + 'px';
          tipEl.style.top = (ev.clientY + 12) + 'px';
          tipEl.innerHTML = 'Faixa: US$ ' + dt.bLo.toLocaleString('pt-BR') + '–' + (dt.bLo + bucketSize).toLocaleString('pt-BR') +
            '<br>Tipo: ' + (dt.side === 'ask' ? 'VENDAS' : 'COMPRAS') +
            '<br>Ordens: ' + fmtUSD(dt.usd) +
            '<br>Distância do preço: ' + (dist > 0 ? '+' : '') + dist + '%';
        });
        d.addEventListener('mouseleave', function () { tipEl.style.display = 'none'; });
        pool.set(key, e);
      }
      e.data = { bLo: bLo, usd: usd, side: side };
      if (e.bs !== bucketSize) {
        e.bs = bucketSize;
        e.bucket.textContent = bLo.toLocaleString('pt-BR') + '–' + (bLo + bucketSize).toLocaleString('pt-BR');
      }
      var wStr = pct + '%';
      if (e.w !== wStr) { e.fill.style.width = wStr; e.w = wStr; }
      var cls = 'ob__bar-fill ' + (side === 'ask' ? 'ob__bar-fill--ask' : 'ob__bar-fill--bid') + (usd === peak ? ' ob__bar-fill--top' : '');
      if (e.c !== cls) { e.fill.className = cls; e.c = cls; }
      var html = usdTxt + (isMax
        ? ' <em class="ob__max ' + (side === 'ask' ? 'ob__max--ask' : 'ob__max--bid') + '">' +
          bLo.toLocaleString('pt-BR') + ' | ' + usdTxt +
          (side === 'ask' ? ' (VENDAS)' : ' (COMPRAS)') + '</em>'
        : '');
      if (e.html !== html) { e.usdEl.innerHTML = html; e.html = html; }
      return e.el;
    }
    // Remove do DOM as faixas que sumiram.
    askRowEls.forEach(function (e, k) { if (!askBuckets.has(k)) { e.el.remove(); askRowEls.delete(k); } });
    bidRowEls.forEach(function (e, k) { if (!bidBuckets.has(k)) { e.el.remove(); bidRowEls.delete(k); } });
    // Reposiciona na ordem (mover não recria: sem pisca).
    askKeys.forEach(function (k) { rowsEl.insertBefore(syncRow(askRowEls, k, k, askBuckets.get(k), 'ask', k === maxAskK), midEl); });
    var midTxt = 'PREÇO $ ' + currentPrice.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
    if (midEl.textContent !== midTxt) midEl.textContent = midTxt;
    bidKeys.forEach(function (k) { rowsEl.appendChild(syncRow(bidRowEls, k, k, bidBuckets.get(k), 'bid', k === maxBidK)); });
  }

  // ---- Boot (lazy: só quando visível; não toca nos sockets Spot) ----
  function boot() {
    restartKline();
    bootDepth();
    hygieneTimer = setInterval(function () { if (depthReady) startResync(); }, HYGIENE_RESYNC_MS);
    validateTimer = setInterval(validateBook, VALIDATE_MS);
  }
  if ('IntersectionObserver' in window) {
    var obs = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) { obs.disconnect(); boot(); }
    }, { rootMargin: '200px' });
    obs.observe(root);
  } else {
    boot();
  }
})();
