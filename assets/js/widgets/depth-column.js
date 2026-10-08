/**
 * Coluna de Profundidade (DEPTH) — Book-style canvas
 * Sem header. Barras finas por nível de preço.
 * Verde = bids, vermelho = asks.
 * Labels de preço nas 2 barras de maior volume (1 por lado).
 */
(function () {
  'use strict';

  var canvas = null;
  var animFrame = null;

  // Range visível acima/abaixo do preço atual (USD)
  var RANGE_USD = 2000;

  // ------------------------------------------------------------------
  function init() {
    var root = document.getElementById('orderbook-root');
    if (!root) return;

    var col = document.createElement('div');
    col.className = 'ob__depth-column';

    canvas = document.createElement('canvas');
    canvas.className = 'ob__depth-canvas';
    col.appendChild(canvas);

    var grid = root.querySelector('.ob__grid');
    if (grid) grid.appendChild(col);
  }

  // ------------------------------------------------------------------
  function draw() {
    if (!canvas || !window.OrderBookData) return;

    var data = window.OrderBookData.getLevels();
    if (!data || !data.displayPrice) return;

    var bids     = data.bids;
    var asks     = data.asks;
    var midPrice = data.displayPrice;

    var dpr = window.devicePixelRatio || 1;
    var W   = canvas.clientWidth  || 180;
    var H   = canvas.clientHeight || 320;

    if (canvas.width  !== Math.round(W * dpr) ||
        canvas.height !== Math.round(H * dpr)) {
      canvas.width  = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }

    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var lo = midPrice - RANGE_USD;
    var hi = midPrice + RANGE_USD;

    var axisW   = 58;
    var barMaxW = W - axisW - 4;

    function priceToY(p) {
      return (1 - (p - lo) / (hi - lo)) * H;
    }

    // Coleta níveis dentro do range
    var bidArr = [], askArr = [];
    bids.forEach(function (qty, pStr) {
      var p = +pStr;
      if (p >= lo && p <= midPrice) bidArr.push({ p: p, q: qty });
    });
    asks.forEach(function (qty, pStr) {
      var p = +pStr;
      if (p >= midPrice && p <= hi) askArr.push({ p: p, q: qty });
    });

    if (!bidArr.length && !askArr.length) return;

    // Pico global
    var peak = 0;
    bidArr.forEach(function (l) { if (l.q > peak) peak = l.q; });
    askArr.forEach(function (l) { if (l.q > peak) peak = l.q; });
    if (!peak) return;

    // Altura por barra
    var pxPerUsd = H / (RANGE_USD * 2);
    var barH = Math.max(2, Math.ceil(pxPerUsd * 2));

    // Barra de maior volume por lado (para o label)
    var topBid = bidArr.reduce(function (a, b) { return b.q > a.q ? b : a; }, bidArr[0]);
    var topAsk = askArr.reduce(function (a, b) { return b.q > a.q ? b : a; }, askArr[0]);

    // Fundo eixo
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(W - axisW, 0, axisW, H);

    // --- Bids (verde) ---
    ctx.fillStyle = 'rgba(76,175,80,0.85)';
    bidArr.forEach(function (lvl) {
      var y  = priceToY(lvl.p);
      var bw = Math.max(2, (lvl.q / peak) * barMaxW);
      ctx.fillRect(0, Math.round(y - barH / 2), Math.round(bw), barH);
    });

    // --- Asks (vermelho) ---
    ctx.fillStyle = 'rgba(244,67,54,0.85)';
    askArr.forEach(function (lvl) {
      var y  = priceToY(lvl.p);
      var bw = Math.max(2, (lvl.q / peak) * barMaxW);
      ctx.fillRect(0, Math.round(y - barH / 2), Math.round(bw), barH);
    });

    // --- Grid + eixo ---
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    var step = niceStep((RANGE_USD * 2) / 5);
    var tv = Math.ceil(lo / step) * step;
    while (tv <= hi) {
      var py = Math.round(priceToY(tv));
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W - axisW, py); ctx.stroke();
      ctx.fillStyle = '#555';
      ctx.fillText(tv.toLocaleString('pt-BR', { maximumFractionDigits: 0 }), W - axisW + 4, py);
      tv += step;
    }

    // --- Linha do preço atual ---
    var midY = Math.round(priceToY(midPrice));
    ctx.strokeStyle = 'rgba(247,147,26,0.9)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W - axisW, midY); ctx.stroke();
    ctx.setLineDash([]);

    // Tag laranja
    var tag = midPrice.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
    var tagH = 16;
    ctx.fillStyle = '#F7931A';
    ctx.fillRect(W - axisW + 1, midY - tagH / 2, axisW - 2, tagH);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(tag, W - axisW + 4, midY);

    // --- Label nas barras de maior volume ---
    ctx.font = 'bold 10px sans-serif';
    ctx.textBaseline = 'middle';

    function drawPeakLabel(lvl, color) {
      var y   = Math.round(priceToY(lvl.p));
      var bw  = Math.max(2, Math.round((lvl.q / peak) * barMaxW));
      var lbl = lvl.p.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
      var tw  = ctx.measureText(lbl).width;
      // Tenta colocar à direita da barra; se não couber, coloca à esquerda dentro
      var lx = bw + 3;
      if (lx + tw > W - axisW - 2) lx = Math.max(0, bw - tw - 4);

      // Pastilha de fundo
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(lx - 2, y - 8, tw + 4, 16);
      // Texto
      ctx.fillStyle = color;
      ctx.fillText(lbl, lx, y);
    }

    if (topBid) drawPeakLabel(topBid, '#4caf50');
    if (topAsk) drawPeakLabel(topAsk, '#f44336');
  }

  function niceStep(raw) {
    if (!(raw > 0)) return 500;
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }

  // ------------------------------------------------------------------
  function sync() {
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = requestAnimationFrame(draw);
  }

  window.DepthColumn = { init: init, sync: sync };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
