/**
 * Coluna de PROFUNDIDADE — Order Book EstudeBitcoin
 * ---------------------------------------------------------------------
 * Consumidor SOMENTE LEITURA do orderbook.js. Não tem WebSocket, fetch,
 * bucketização, timer ou polling próprios: tudo chega via sync(scale,
 * snapshot), chamado 1x por ciclo de render() do Order Book (throttle
 * existente de 1,5 s + evento de resize).
 *
 * Posição vertical: SEMPRE a mesma transformação Y dos candles
 * (orderbook.js drawCandles): pad=8, timeGutter=16, h=300. NENHUMA
 * segunda escala: cada barra usa y(centro) com essa função.
 *
 * Zona próxima [nearLo..nearHi] (extremos congelados do snapshot):
 * buckets atuais (bucketMid), exatamente como a concentração agrega.
 * Zona distante (dentro de scale.lo..scale.hi, fora de nearLo/nearHi):
 * níveis crus agregados em faixas grossas de ~1/60 da altura visível,
 * grade ANCORADA em nearLo/nearHi (nunca em scale.lo/hi). Conjuntos
 * disjuntos por construção: próximo só p>=nearLo / p<=nearHi, distante
 * só p<nearLo / p>nearHi — sem contagem dupla.
 * Largura: próximas relativas ao peakNear (intacto, 100% de referência);
 * distantes relativas ao TETO COMUM = peakNear (cap 100%; fallback peakFar
 * se não há próximas visíveis), na unidade atual. Opacidade das distantes
 * proporcional ao mesmo teto: 0.25–0.70. Corte: distante abaixo de
 * FAR_MIN_PCT% do teto não desenha. Cores dos candles: bids verde
 * (#4caf50), asks vermelho.
 * Linha de preço: fina, sem tag, em y(displayPrice) — mesma coordenada
 * do canvas. Sem eixo, labels de pico, grid próprio, score ou sinal.
 * A parte distante é parcial (stream incremental, sem validação de qty):
 * indicado no title do painel. Book vazio: apenas oculta (sem texto).
 *
 * POOL: cresce sob demanda e reutiliza (nunca recria por ciclo); teto de
 * 500 — acima disso, próximos primeiro (mais perto do preço), depois
 * distantes (mais perto do preço). Resync/reconexão muda a âncora
 * (nearLo|nearHi|bucketSize|unit) e esconde tudo antes de redesenhar:
 * nenhuma barra antiga permanece visível.
 */
(function () {
  'use strict';

  var BAR_H = 3;      // altura fixa; só o CENTRO é posicionado pela escala
  var MAX_POOL = 500; // teto (acima: próximos primeiro, depois distantes)
  var FAR_BANDS = 60; // faixa grossa ~= 1/60 da altura visível
  var FAR_MIN_PCT = 2; // corte: distante abaixo de 2% do teto não desenha (0 = off)

  var panel = null;
  var container = null;
  var priceLine = null;
  var pool = []; // divs reutilizadas
  var lastAnchor = ''; // reancoragem em resync/reconexão (regra 2)

  // ------------------------------------------------------------------
  function init() {
    var root = document.getElementById('orderbook-root');
    if (!root) return;
    var grid = root.querySelector('.ob__grid');
    if (!grid || container) return; // orderbook ainda não montou / já montado

    panel = document.createElement('div');
    panel.className = 'ob__panel ob__panel--depth';
    panel.title = 'Profundidade: faixas próximas por bucket; ' +
      'faixas distantes = agregação parcial do book (mesma escala do gráfico).';

    var h3 = document.createElement('h3');
    h3.textContent = 'PROFUNDIDADE';
    panel.appendChild(h3);

    container = document.createElement('div');
    container.className = 'ob__depth-container';
    panel.appendChild(container);

    priceLine = document.createElement('div');
    priceLine.className = 'ob__depth-price';
    priceLine.style.display = 'none';
    container.appendChild(priceLine);

    grid.appendChild(panel);
  }

  // Cópia exata da transformação Y de drawCandles() (orderbook.js):
  // pad=8, timeGutter=16, plotH = h - timeGutter.
  function makeY(scale) {
    var pad = 8;
    var plotH = scale.h - 16;
    var span = scale.hi - scale.lo;
    return function (p) {
      return pad + (1 - (p - scale.lo) / span) * (plotH - pad * 2);
    };
  }

  function valOf(entry, unit) {
    return unit === 'BTC' ? entry.btc : entry.usd;
  }

  function hideAll() {
    var i;
    for (i = 0; i < pool.length; i++) pool[i].style.display = 'none';
    if (priceLine) priceLine.style.display = 'none';
  }

  // Faixas grossas de UM lado, grade ancorada na fronteira (edge) da zona
  // próxima. Regra 1: sem faixas se a fronteira está fora do visível
  // (bid: edge >= hi; ask: edge <= lo); só faixas que intersectam [lo,hi],
  // recortando a última nos limites. Níveis estritamente fora da zona
  // próxima (sem contagem dupla com os buckets).
  function buildFar(levels, side, edge, dir, scale, y, W, unit) {
    var out = [];
    if (!levels || !levels.length || !(W > 0)) return out;
    if (side === 'bid' && edge >= scale.hi) return out;
    if (side === 'ask' && edge <= scale.lo) return out;
    var k = 1;
    while (k < 500) {
      var bLo, bHi;
      if (dir < 0) { bHi = edge - (k - 1) * W; bLo = edge - k * W; }
      else { bLo = edge + (k - 1) * W; bHi = edge + k * W; }
      if (dir < 0 && bHi <= scale.lo) break; // saiu do visível (monotônico)
      if (dir > 0 && bLo >= scale.hi) break;
      var eLo = Math.max(bLo, scale.lo); // recorte nos limites (regra 1)
      var eHi = Math.min(bHi, scale.hi);
      if (eLo < eHi) {
        var usd = 0, btc = 0, i, p, q;
        for (i = 0; i < levels.length; i++) {
          p = levels[i][0]; q = levels[i][1];
          if (!(q > 0)) continue;
          if (side === 'bid') { if (p < eLo || p >= eHi) continue; }
          else { if (p <= eLo || p > eHi) continue; }
          usd += p * q; btc += q;
        }
        var v = unit === 'BTC' ? btc : usd;
        if (v > 0) out.push({ c: (eLo + eHi) / 2, v: v, side: side, far: true });
      }
      k++;
    }
    return out;
  }

  // ------------------------------------------------------------------
  function sync(scale, snapshot) {
    if (!container) return;
    if (!scale || !(scale.hi > scale.lo) || !(scale.h > 0)) { hideAll(); return; }
    if (!snapshot || !snapshot.displayPrice || !(snapshot.bucketSize > 0)) { hideAll(); return; }

    // Regra 2: snapshot refeito (resync/reconexão) muda a âncora — esconde
    // todas as barras antigas antes de redesenhar.
    var anchor = snapshot.nearLo + '|' + snapshot.nearHi + '|' +
      snapshot.bucketSize + '|' + snapshot.unit;
    if (anchor !== lastAnchor) { hideAll(); lastAnchor = anchor; }

    var y = makeY(scale);
    var size = snapshot.bucketSize;
    var unit = snapshot.unit === 'BTC' ? 'BTC' : 'USD';
    var mid = snapshot.displayPrice;
    var W = (scale.hi - scale.lo) / FAR_BANDS;

    // ---- Zona próxima: buckets (inalterado) ----
    var near = [];
    function collectBuckets(map, side) {
      if (!map || typeof map.forEach !== 'function') return;
      map.forEach(function (entry, bLo) {
        var lo = +bLo;
        if (!isFinite(lo) || !entry) return;
        var c = lo + size / 2; // bucketMid
        if (c < scale.lo || c > scale.hi) return;
        var v = valOf(entry, unit);
        if (!(v > 0)) return;
        near.push({ c: c, v: v, side: side, far: false });
      });
    }
    collectBuckets(snapshot.askBuckets, 'ask');
    collectBuckets(snapshot.bidBuckets, 'bid');

    // ---- Zona distante: faixas grossas (grade ancorada) ----
    var far = [];
    var nLo = snapshot.nearLo, nHi = snapshot.nearHi;
    if (isFinite(nLo) && isFinite(nHi) && nHi > nLo) {
      far = buildFar(snapshot.bidLevels, 'bid', nLo, -1, scale, y, W, unit)
        .concat(buildFar(snapshot.askLevels, 'ask', nHi, +1, scale, y, W, unit));
    }

    if (!near.length && !far.length) { hideAll(); return; }

    // Picos: próximo intacto (100% de referência); distante usa o TETO COMUM
    // (peakNear, fallback peakFar se não há próximos visíveis). Largura das
    // distantes = min(100, v/teto); opacidade proporcional 0.25–0.70 no
    // mesmo teto; corte abaixo de FAR_MIN_PCT% do teto.
    var peakNear = 0, peakFar = 0, i;
    for (i = 0; i < near.length; i++) if (near[i].v > peakNear) peakNear = near[i].v;
    for (i = 0; i < far.length; i++) if (far[i].v > peakFar) peakFar = far[i].v;
    var ceiling = peakNear > 0 ? peakNear : peakFar;
    if (!(ceiling > 0)) { hideAll(); return; }
    if (FAR_MIN_PCT > 0) {
      var cut = ceiling * FAR_MIN_PCT / 100;
      far = far.filter(function (b) { return b.v >= cut; });
    }

    // Pool: próximos primeiro (mais perto do preço), depois distantes.
    byDist(near, mid);
    var list = near.concat(far); // far já sai da âncora p/ fora (mais perto primeiro)
    if (list.length > MAX_POOL) list = list.slice(0, MAX_POOL);

    // Cresce sob demanda; reutiliza sem recriar.
    while (pool.length < list.length) {
      var d = document.createElement('div');
      d.className = 'ob__depth-bar';
      d.style.display = 'none';
      container.appendChild(d);
      pool.push(d);
    }

    for (i = 0; i < list.length; i++) {
      var b = list[i];
      var el = pool[i];
      el.style.display = 'block';
      el.style.top = y(b.c) + 'px';
      var cls = 'ob__depth-bar ' +
        (b.side === 'ask' ? 'ob__depth-bar--ask' : 'ob__depth-bar--bid') +
        (b.far ? ' ob__depth-bar--far' : '');
      if (el.className !== cls) el.className = cls;
      if (b.far) {
        var r = Math.min(1, b.v / ceiling);
        el.style.width = Math.max(2, r * 100) + '%';
        el.style.opacity = (0.25 + 0.45 * r).toFixed(2);
      } else {
        el.style.width = Math.max(2, (b.v / peakNear) * 100) + '%';
        el.style.opacity = '';
      }
    }
    for (i = list.length; i < pool.length; i++) pool[i].style.display = 'none';

    // Linha fina do preço atual — mesma transformação Y do canvas.
    if (mid >= scale.lo && mid <= scale.hi) {
      priceLine.style.display = 'block';
      priceLine.style.top = y(mid) + 'px';
    } else {
      priceLine.style.display = 'none';
    }
  }

  function byDist(arr, mid) {
    arr.sort(function (a, b) { return Math.abs(a.c - mid) - Math.abs(b.c - mid); });
  }

  window.DepthColumn = { init: init, sync: sync };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  // Fallback caso o orderbook monte o grid depois (defer): sem polling,
  // só eventos de ciclo de vida.
  window.addEventListener('load', init);
})();
