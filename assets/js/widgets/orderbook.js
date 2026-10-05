/* =====================================================================
   WIDGET: Order Book visual BTCUSDT (Futures USDⓈ-M) — EstudeBitcoin
   ---------------------------------------------------------------------
   O QUE MOSTRA: somente ordens reais do book da Binance Futures,
   agregadas por faixa de preço (buckets). NÃO usa open interest,
   liquidação estimada, alavancagem ou qualquer estimativa — se uma
   faixa não tem ordens no book, ela simplesmente não aparece.

    AGREGAÇÃO POR FAIXA (buckets 1/5/10/25/50/100 USD, padrão 50;
    opções congeladas por decisão do dono — não alterar sem confirmação):
      usd_por_nivel = preco * quantidade
      bucket = floor(preco / faixa) * faixa   (ex.: faixa 50 → 86450–86500)
      soma todos os níveis do book dentro de cada bucket, separando
      bids (compras, abaixo do preço) e asks (vendas, acima do preço).
      Cada bucket guarda {usd, btc}; a unidade (US$|BTC, padrão BTC) só
      escolhe o que o render mostra — trocar nunca toca no book.
      O painel exibe as 5 faixas mais próximas do preço de cada lado
      (VISIBLE_BANDS_PER_SIDE), com escala única sobre as exibidas.
      A largura das barras usa escala ÚNICA: 100% = maior bucket entre
      os dois lados, para comparar compras × vendas visualmente.
      Bucket de COMPRAS só se bucketLow >= snapMinBid; de VENDAS só se
      bucketHigh <= snapMaxAsk (extremos do snapshot de origem).
      Fora disso: OMITIDO (nunca parcial, nunca estendido).

    SINCRONIZAÇÃO DO BOOK (ritual oficial USDⓈ-M "How to manage a local
    order book correctly" — NÃO a regra do Spot com +1):
      1. abre o WS e bufferiza eventos depthUpdate;
      2. espera determinística: NUNCA prossegue com buffer vazio;
      3. busca snapshot REST (limit=1000, peso 20) → lastUpdateId;
      4. descarta eventos com u < lastUpdateId; se restar só isso (ou
         nada), continua aguardando; se surgir U > lastUpdateId sem
         cobertura anterior → NOVO snapshot com o MESMO stream aberto;
      5. primeiro evento válido: U <= lastUpdateId && u >= lastUpdateId;
         do segundo em diante: pu === u anterior;
      6. quebra/reconexão → repete o ritual (takeover, nunca em paralelo);
      7. quantidade 0 remove o nível (inclusive níveis ausentes: normal).
      Concorrência: bootSeq (geração) + trava syncing com coalescência;
      book exibido só troca DE UMA VEZ (swap atômico, sem pisca).

    COBERTURA por SPAN DE PREÇO (regra de representação, NÃO do protocolo;
    ÚNICO critério — trocar de bucket nunca dispara resync):
      coverageBid = (bestBid − snapMinBid) / (snapBestBid − snapMinBid)
      coverageAsk = (snapMaxAsk − bestAsk) / (snapMaxAsk − snapBestAsk)
      Extremos congelados no snapshot de origem. Cancelamentos/execuções
      (qty 0) intermediários NÃO contam como perda. Span irrisório:
      razão não avaliada (só console). COVERAGE_MIN_RATIO = 0.5 por lado;
      abaixo → badge "profundidade limitada" + resync.

    VALIDAÇÃO amostral (limit=100, peso 5; pausa com aba oculta): top 8
    níveis/lado com tolerância de qty 20 %, priorizando níveis estáveis
    (+2,5 s); absolutos (cruzado, qty inválida, fora da cobertura) na hora;
    divergência de topo só após 2 strikes consecutivos.

    PREÇO ÚNICO (displayPrice, do kline de futuros): cabeçalho, linha,
    etiqueta do eixo e separador "PREÇO" pintados no mesmo ciclo. O book
    nunca define o preço. Eixo Y com marcas arredondadas + horário no X.
    ===================================================================== */
(function () {
  'use strict';

  // ---- Constantes configuráveis ----
  var SYMBOL = 'BTCUSDT';
  var BUCKET_CHOICES = [1, 5, 10, 25, 50, 100];
  var DEFAULT_BUCKET = 25;
  // Painel compacto: mostra as N faixas MAIS PRÓXIMAS do preço em cada lado,
  // independente do volume (mesmo as pequenas aparecem, com min-width).
  // Só apresentação: não toca no book, sync, cobertura ou validação.
  var VISIBLE_BANDS_PER_SIDE = 5;
  // Auto-faixa (padrão ligado): escolhe o maior bucket com >=5 completas
  // nos dois lados. Subida só com folga (span/bucket >= margem nos dois
  // lados) mantida por N renders (histerese) E por um tempo mínimo
  // configurável (anti-oscilação em fronteira com ruído); descida imediata
  // ao faltar faixa completa. Troca (auto ou manual) nunca dispara
  // fetch/resync.
  var AUTO_UP_MARGIN = 5.5;
  var AUTO_HYSTERESIS_RENDERS = 3;
  var AUTO_MIN_UP_MS = 25000; // tempo mínimo contínuo com folga p/ SUBIR
  // Unidade de exibição (SOMENTE apresentação): 'USD' | 'BTC'. Trocar de
  // unidade só redesenha as barras (nunca fetch/resync/rebuild do book).
  // Para voltar US$ como padrão, trocar só esta constante (sem lógica).
  var DEFAULT_UNIT = 'BTC';
  var TIMEFRAMES = ['1m', '5m', '15m', '1h'];
  var DEFAULT_TF = '1m';
  // ---- Cobertura por SPAN DE PREÇO (P1 item 10, único critério; trocar de
  // bucket nunca dispara resync). Razão mínima configurável por lado.
  var COVERAGE_MIN_RATIO = 0.5;
  var MIN_SPAN_USD = 1.0; // span original irrisório: não avalia razão (só console)
  var SNAPSHOT_URL = 'https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000';
  var KLINES_URL = 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=';
  var DEPTH_WS_URL = 'wss://fstream.binance.com/public/ws/btcusdt@depth';
  var KLINE_WS_BASE = 'wss://fstream.binance.com/market/ws/btcusdt@kline_';
  var RECONNECT_MS = 3000;
  // Watchdog de resync (P1 item 7): monta o novo book em segundo plano e troca
  // de uma vez (sem "carregando", sem pisca). NÃO é necessário para a
  // sincronização — a continuidade por pu já cobre. Padrão DESATIVADO (0);
  // para ativar, configurar intervalo em ms. Roda só com stream saudável
  // (depthReady, sem sync em curso) e aba visível.
  var WATCHDOG_RESYNC_MS = 0;
  var VALIDATE_MS = 60 * 1000;
  // Validação amostral (P1 item 6): compara o topo do book local com um
  // snapshot leve (limit=100 → peso 5 na doc oficial; 1000 → peso 20).
  var VALIDATE_URL = 'https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=100';
  var VALIDATE_LEVELS = 8;    // níveis amostrados por lado no topo
  var VALIDATE_QTY_TOL = 0.20; // tolerância relativa de quantidade (timing distinto)
  var VALIDATE_MAX_MISMATCH = 3; // divergências p/ considerar o ciclo divergente
  var VALIDATE_STABLE_MS = 2500; // nível local intocado há +X é "estável"
  var VALIDATE_STRIKES_TO_RESYNC = 2; // divergências consecutivas p/ resync
  var MAX_CANDLES = 150;
  // Anti-flicker: o depth chega a ~4 eventos/s, mas o DOM (linhas + canvas)
  // é reconstruído no máximo 1x a cada 1,5s. Dados continuam ao vivo.
  var RENDER_MIN_INTERVAL_MS = 1500;
  var lastRenderAt = 0;
  var renderTimer = null;

  // ---- Estado ----
  var bucketSize = DEFAULT_BUCKET;
  var timeframe = DEFAULT_TF;
  var unit = DEFAULT_UNIT; // unidade selecionada no render ('USD' | 'BTC')
  var autoMode = true; // Auto-faixa ligado por padrão; bucket manual desliga
  var autoUpStreak = 0; // renders consecutivos com folga p/ subir
  var autoUpSince = 0; // timestamp do 1º render ok da sequência (portão de tempo)
  var lastAutoSwitch = null; // {to, reason, at} da última troca automática
  var candles = [];          // {time, open, high, low, close}
  var currentPrice = 0;      // preço cru do kline; o EXIBIDO é displayPrice (item 12)
  var displayPrice = 0;      // preço único, fixado 1x por ciclo de render
  var bids = new Map();      // priceStr -> qty (exibido; só trocado de uma vez)
  var asks = new Map();
  var levelTs = new Map();   // priceStr -> timestamp da última atualização (validação)
  var lastUpdateId = -1;
  var prevU = -1;            // u do último evento aplicado (p/ checar pu)
  var appliedCount = 0;      // eventos aplicados desde o snapshot
  var depthBuffer = [];      // eventos recebidos antes do snapshot
  var depthReady = false;    // existe book utilizável exibido
  var syncing = false;       // ciclo de sync em curso (trava P0 item 1)
  var alignPending = null;   // snapshot aguardando 1º evento aplicável (P0 item 4)
  // Extremos congelados no snapshot de origem (cobertura por span, P1 item 10).
  var snapBestBid = 0, snapMinBid = 0, snapBestAsk = 0, snapMaxAsk = 0;
  var coverageWarnedSeq = -1; // evita spam de console na mesma geração
  var validateStrikes = 0;   // divergências consecutivas (P1 item 6)
  var fetchSnapshots = 0;    // contador p/ QA (harness)
  // Contador de resyncs (P2 item 16): total, coalescidos e por hora + motivo.
  var resyncStats = { total: 0, coalesced: 0, byHour: {} };
  var depthSocket = null;
  var klineSocket = null;
  var depthTimer = null;
  var klineTimer = null;
  var watchdogTimer = null;
  var validateTimer = null;
  var bootSeq = 0; // geração do boot atual: esperas/fetches antigos se anulam
  var bootTime = Date.now(); // início p/ uptime da auditoria
  var lastBuckets = null; // último cálculo {unit, peakUSD, peakBTC, ask:{}, bid:{}}
  var lastOmitted = null; // faixas de borda omitidas {ask:{}, bid:{}} (só auditoria)
  var lastShown = { ask: [], bid: [] }; // chaves exibidas (top-N) no último render
  var lastPartial = { ask: null, bid: null }; // chaves das parciais exibidas ("≥")
  // Termômetro compras × vendas (Etapa termômetro, SOMENTE apresentação):
  // distância igual nos dois lados a partir dos extremos CONGELADOS do
  // snapshot; D <= 0 ou D < THERMO_MIN_D_USD (ou book não pronto/cruzado)
  // → estado vazio ("—"), sem fetch, sem resync, sem erro.
  var THERMO_MIN_D_USD = 10;
  var lastThermo = null; // último cálculo p/ auditoria + hook de QA
  var renderQueued = false;
  // Pool de linhas das barras: atualização NO LUGAR (sem rebuild/pisca).
  var askRowEls = new Map(), bidRowEls = new Map(), midEl = null, rowsMsg = '';
  var partAskPool = new Map(), partBidPool = new Map(); // 1 faixa parcial por lado
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
      '<div class="ob__seg" id="ob-unitseg" role="group" aria-label="Unidade de valor"></div>' +
      '</div>' +
      '<p class="ob__warn" id="ob-warn" hidden></p>' +
      '<p class="ob__legend"><span class="ob__lg"><i class="ob__dotlg ob__dotlg--ask"></i>VENDAS (vermelho, acima do preço)</span>' +
      '<span class="ob__lg"><i class="ob__dotlg ob__dotlg--bid"></i>COMPRAS (azul, abaixo do preço)</span></p>' +
      '<p class="ob__disclaimer">Ordens reais do book neste momento — não são liquidações futuras. ' +
      'Profundidade limitada a 1000 níveis por lado; faixas sem ordens não geram barras.</p>' +
      '<details class="ob__help"><summary>O que é isso?</summary>' +
      '<p>São <strong>ordens limite de verdade</strong>, que estão no book da Binance <strong>neste instante</strong> — ' +
      'não são liquidações nem previsão de preço.</p>' +
      '<p>Elas <strong>podem ser canceladas a qualquer momento</strong>: uma parede grande pode sumir segundos depois.</p>' +
      '<p>Paredes grandes <strong>não garantem</strong> suporte ou resistência — existe <strong>spoofing</strong> ' +
      '(gente fingindo comprar/vender para mover o preço).</p>' +
      '<p>A profundidade é <strong>limitada</strong> ao que o book mostra (1000 níveis por lado); ' +
      'faixas sem ordens não geram barras.</p>' +
      '<p>Os valores podem ser vistos em <strong>US$ ou BTC</strong> (botões acima do painel): ' +
      'é só outra forma de mostrar o mesmo dinheiro, sem mudar nenhum dado.</p>' +
      '<p>O <strong>termômetro</strong> no fim do painel soma todas as compras e todas as vendas ' +
      'a igual distância dos melhores preços (independente da faixa escolhida): ' +
      'é outra forma de ver o mesmo book, não uma previsão.</p></details>' +
      '<div class="ob__grid">' +
        '<div class="ob__panel"><h3>CANDLES · <span id="ob-tflabel">1m</span></h3><canvas id="ob-candles"></canvas></div>' +
        '<div class="ob__panel"><h3>CONCENTRAÇÃO · faixa US$ <span id="ob-bklabel">25</span></h3><div class="ob__shortnote" id="ob-shortnote"></div><div class="ob__rows" id="ob-rows"><div class="ob__loading">Carregando book…</div></div>' +
      '<div class="ob__thermo" id="ob-thermo"><div class="ob__thermo-bar" id="ob-thermo-bar"><span class="ob__thermo-fill ob__thermo-fill--bid" id="ob-thermo-bid"></span><span class="ob__thermo-fill ob__thermo-fill--ask" id="ob-thermo-ask"></span><span class="ob__thermo-mid" id="ob-thermo-mid"></span></div>' +
      '<div class="ob__thermo-diff" id="ob-thermo-diff"></div>' +
      '<div class="ob__thermo-labels" id="ob-thermo-labels"><span class="ob__thermo-buy" id="ob-thermo-buy">—</span><span class="ob__thermo-sell" id="ob-thermo-sell"></span></div>' +
      '<div class="ob__thermo-legend" id="ob-thermo-legend">—</div></div></div>' +
      '</div>' +
    '</div>' +
    '<div class="ob__tip" id="ob-tip"></div>';

  var priceEl = document.getElementById('ob-price');
  var dotEl = document.getElementById('ob-dot');
  var statusEl = document.getElementById('ob-status');
  var updatedEl = document.getElementById('ob-updated');
  var coverageEl = document.getElementById('ob-coverage');
  var thermoBar = document.getElementById('ob-thermo-bar');
  var thermoBid = document.getElementById('ob-thermo-bid');
  var thermoAsk = document.getElementById('ob-thermo-ask');
  var thermoBuyEl = document.getElementById('ob-thermo-buy');
  var thermoSellEl = document.getElementById('ob-thermo-sell');
  var thermoLegend = document.getElementById('ob-thermo-legend');
  var thermoDiff = document.getElementById('ob-thermo-diff');
  var warnEl = document.getElementById('ob-warn');
  var rowsEl = document.getElementById('ob-rows');
  var shortEl = document.getElementById('ob-shortnote');
  var shortEl = document.getElementById('ob-shortnote');
  var canvas = document.getElementById('ob-candles');
  var tipEl = document.getElementById('ob-tip');
  var tfSeg = document.getElementById('ob-tfseg');
  var bkSeg = document.getElementById('ob-bkseg');
  var unitSeg = document.getElementById('ob-unitseg');

  function setStatus(mode, text) {
    dotEl.className = 'ob__dot' + (mode === 'on' ? ' ob__dot--on' : mode === 'warn' ? ' ob__dot--warn' : mode === 'off' ? ' ob__dot--off' : '');
    statusEl.textContent = text;
  }

  function fmtUSD(v) {
    if (v >= 1e6) return 'US$ ' + (v / 1e6).toFixed(2).replace('.', ',') + 'M';
    if (v >= 1e3) return 'US$ ' + (v / 1e3).toFixed(1).replace('.', ',') + 'k';
    return 'US$ ' + v.toFixed(0);
  }

  // Formatação BTC em pt-BR (sem k/M, vírgula decimal, ponto de milhar).
  // Aritmética inteira em satoshis p/ classificação consistente nas bordas:
  // - valor cru < 0,01 BTC → '< 0,01 BTC' (ex.: 0,0096);
  // - valor arredondado (half-up, 2 casas) >= 10 BTC → 1 casa ("10,0");
  // - senão → 2 casas ("0,85", "0,01", "9,99").
  function fmtBTC(v) {
    if (!(v > 0)) return '< 0,01 BTC';
    var sats = Math.round(v * 1e8);
    if (sats < 1e6) return '< 0,01 BTC';
    var cents = Math.floor((sats + 500000) / 1000000); // centésimos, half-up
    var intPart, fracPart, fracLen;
    if (cents >= 1000) {
      var tenths = Math.floor((sats + 5e6) / 1e7); // décimos, half-up
      intPart = Math.floor(tenths / 10);
      fracPart = tenths % 10;
      fracLen = 1;
    } else {
      intPart = Math.floor(cents / 100);
      fracPart = cents % 100;
      fracLen = 2;
    }
    var intTxt = intPart.toLocaleString('pt-BR');
    var fracTxt = String(fracPart);
    while (fracTxt.length < fracLen) fracTxt = '0' + fracTxt;
    return intTxt + ',' + fracTxt + ' BTC';
  }

  function fmtVal(usd, btc) {
    return unit === 'BTC' ? fmtBTC(btc) : fmtUSD(usd);
  }

  // Tooltip: unidade selecionada como principal + a outra unidade.
  // Ex.: "130,4 BTC · US$ 11,32M · 0,60% do preço". O % de distância é a
  // métrica já existente (não muda com a unidade).
  function tipHTML(bLo, usd, btc, side, isPartial) {
    var dist = ((bLo + bucketSize / 2 - displayPrice) / displayPrice * 100).toFixed(2).replace('.', ',');
    var main = unit === 'BTC' ? fmtBTC(btc) + ' · ' + fmtUSD(usd) : fmtUSD(usd) + ' · ' + fmtBTC(btc);
    var tip = 'Faixa: US$ ' + bLo.toLocaleString('pt-BR') + '–' + (bLo + bucketSize).toLocaleString('pt-BR') +
      '<br>Tipo: ' + (side === 'ask' ? 'VENDAS' : 'COMPRAS') +
      '<br>Ordens: ' + main +
      '<br>Distância do preço: ' + (dist > 0 ? '+' : '') + dist + '%';
    if (isPartial) {
      tip += '<br>Valor mínimo (≥): só soma níveis visíveis no snapshot; ' +
        'abaixo/acima da borda é desconhecido.';
    }
    return tip;
  }

  function copyBuckets(map) {
    var o = {};
    map.forEach(function (e, k) { o[k] = { usd: e.usd, btc: e.btc }; });
    return o;
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
  // Botão Auto + faixas: escolha manual desliga o Auto; Auto religa.
  var autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.textContent = 'Auto';
  bkSeg.appendChild(autoBtn);
  BUCKET_CHOICES.forEach(function (bk) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'US$ ' + bk;
    b.setAttribute('data-bucket', String(bk));
    b.addEventListener('click', function () {
      applyBucketManual(bk);
    });
    bkSeg.appendChild(b);
  });
  autoBtn.addEventListener('click', function () {
    setAutoMode(true);
  });
  // Pinta seg de faixa + título ("faixa US$ 25 · auto" no modo Auto).
  function refreshBucketUI() {
    document.getElementById('ob-bklabel').textContent =
      String(bucketSize) + (autoMode ? ' · auto' : '');
    Array.prototype.forEach.call(bkSeg.children, function (x) {
      var isAuto = x === autoBtn;
      var on = isAuto ? autoMode :
        (!autoMode && x.getAttribute('data-bucket') === String(bucketSize));
      x.className = on ? 'ativo' : '';
      x.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function applyBucketManual(bk) {
    if (bucketSize === bk && !autoMode) return;
    setAutoMode(false);
    bucketSize = bk;
    refreshBucketUI();
    queueRender(); // só redesenha; nunca fetch/resync
  }
  function setAutoMode(on) {
    if (autoMode === on) return;
    autoMode = on;
    autoUpStreak = 0;
    autoUpSince = 0;
    if (on) {
      lastAutoSwitch = null;
      autoEvaluate();
    }
    refreshBucketUI();
    queueRender();
  }
  // Conta faixas COMPLETAS (regra de borda do snapshot) com níveis, num
  // bucket candidato. Só apresentação (não toca sync/cobertura).
  function countComplete(side, B) {
    if (!snapBestBid || !snapBestAsk) return 0;
    var seen = {}, n = 0;
    function consider(p) {
      var bLo = Math.floor(p / B) * B;
      if (seen[bLo]) return;
      var complete = side === 'bid'
        ? (bLo >= snapMinBid)
        : (bLo + B <= snapMaxAsk);
      if (complete) { seen[bLo] = 1; n++; }
    }
    var map = side === 'bid' ? bids : asks;
    map.forEach(function (_, p) { consider(+p); });
    return n;
  }
  // Avalia o Auto no ritmo do render: descida IMEDIATA ao faltar faixa;
  // subida só com folga (span/B >= margem) N renders seguidos.
  function autoEvaluate() {
    if (!autoMode || !bids.size || !asks.size || !snapBestBid || !snapBestAsk) return;
    var order = BUCKET_CHOICES.slice().sort(function (a, b) { return a - b; });
    var cur = order.indexOf(bucketSize);
    if (cur < 0) cur = 0;
    var down = cur;
    while (down > 0 &&
      (countComplete('bid', order[down]) < VISIBLE_BANDS_PER_SIDE ||
       countComplete('ask', order[down]) < VISIBLE_BANDS_PER_SIDE)) {
      down--;
    }
    if (down !== cur) {
      bucketSize = order[down];
      autoUpStreak = 0;
      autoUpSince = 0;
      lastAutoSwitch = { to: bucketSize, reason: 'downscale-missing', at: new Date().toISOString() };
      refreshBucketUI();
      return; // agregação abaixo usa o novo bucket no MESMO render
    }
    if (cur < order.length - 1) {
      var B2 = order[cur + 1];
      var spanB = snapBestBid - snapMinBid, spanA = snapMaxAsk - snapBestAsk;
      var ok = countComplete('bid', B2) >= VISIBLE_BANDS_PER_SIDE &&
               countComplete('ask', B2) >= VISIBLE_BANDS_PER_SIDE &&
               spanB / B2 >= AUTO_UP_MARGIN && spanA / B2 >= AUTO_UP_MARGIN;
      if (ok) {
        autoUpStreak++;
        if (!autoUpSince) autoUpSince = Date.now();
        if (autoUpStreak >= AUTO_HYSTERESIS_RENDERS &&
            (Date.now() - autoUpSince) >= AUTO_MIN_UP_MS) {
          bucketSize = B2;
          autoUpStreak = 0;
          autoUpSince = 0;
          lastAutoSwitch = { to: B2, reason: 'upscale-margin', at: new Date().toISOString() };
          refreshBucketUI();
        }
      } else {
        autoUpStreak = 0;
        autoUpSince = 0;
      }
    } else {
      autoUpStreak = 0;
      autoUpSince = 0;
    }
  }
  refreshBucketUI();
  // Seletor de unidade US$ | BTC (SOMENTE apresentação): trocar redesenha
  // a partir dos buckets já calculados. Sem fetch, sem resync, sem rebuild
  // do book, sem tocar cobertura/sync. Padrão = DEFAULT_UNIT ('USD').
  [['USD', 'US$'], ['BTC', 'BTC']].forEach(function (pair) {
    var val = pair[0], lbl = pair[1];
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = lbl;
    if (val === unit) b.className = 'ativo';
    b.setAttribute('aria-pressed', val === unit ? 'true' : 'false');
    b.addEventListener('click', function () {
      if (unit === val) return;
      unit = val;
      Array.prototype.forEach.call(unitSeg.children, function (x) {
        x.className = '';
        x.setAttribute('aria-pressed', 'false');
      });
      b.className = 'ativo';
      b.setAttribute('aria-pressed', 'true');
      queueRender(); // só redesenha (com throttle); book intacto
    });
    unitSeg.appendChild(b);
  });

  // ================= DEPTH (book) =================
  // Ritual oficial USD-M Futures (NÃO a regra do Spot com +1):
  // 1º evento: U <= lastUpdateId && u >= lastUpdateId; do 2º em diante:
  // pu === u do evento anterior; qty 0 remove o nível.
  //
  // Concorrência (P0 item 1): bootSeq é a geração do ciclo. bootDepth()
  // SEMPRE incrementa (cancela o anterior); startResync() COALESCECE
  // quando já há sync em curso (nunca dois ciclos em paralelo). O book
  // exibido (bids/asks) só é trocado DE UMA VEZ (swap) — durante o build
  // o painel segue mostrando o book anterior, sem "carregando" e sem pisca.

  // Contador de resyncs (P2 item 16): total, coalescidos e por hora + motivo.
  // Histórico em anel p/ auditoria (somente leitura via __obAudit).
  var resyncLog = [];
  var staleDiscards = 0; // respostas/timers de ciclo antigo descartados
  var valRuns = 0, valPassed = 0, valStruck = 0; // validações REST
  var depthConns = 0, depthCloses = 0, klineConns = 0, klineCloses = 0;
  var depthLastChange = 0, klineLastChange = 0;
  var lastPriceCheck = null; // última verificação do preço único (render)
  function logResync(reason) {
    resyncStats.total++;
    var now = new Date();
    var hk = now.toISOString().slice(0, 13); // por hora (UTC)
    resyncStats.byHour[hk] = (resyncStats.byHour[hk] || 0) + 1;
    resyncLog.push({ t: now.toISOString(), reason: reason, bootSeq: bootSeq });
    if (resyncLog.length > 50) resyncLog.shift();
    console.log('[orderbook] resync #' + resyncStats.total + ' motivo=' + reason +
      ' bootSeq=' + bootSeq);
  }
  // Resposta/timer de ciclo antigo: conta e descarta sem tocar em nada.
  function noteStale(what) {
    staleDiscards++;
    console.log('[orderbook] ' + what + ': bootSeq antigo');
  }

  function applyLevel(map, priceStr, qty) {
    var q = parseFloat(qty);
    if (!isFinite(q) || q < 0) return 'invalid';
    var p = parseFloat(priceStr);
    if (!isFinite(p) || p <= 0) return 'invalid';
    if (q === 0) { map.delete(priceStr); levelTs.delete(priceStr); }
    else { map.set(priceStr, q); levelTs.set(priceStr, Date.now()); }
    return 'ok';
  }

  function applyLevelsTo(bmap, amap, ev) {
    var bad = false;
    (ev.b || []).forEach(function (lv) { if (applyLevel(bmap, lv[0], lv[1]) === 'invalid') bad = true; });
    (ev.a || []).forEach(function (lv) { if (applyLevel(amap, lv[0], lv[1]) === 'invalid') bad = true; });
    return !bad;
  }

  // Evento ao vivo (book já sincronizado): só pu encadeado.
  function applyLiveEvent(ev) {
    var u = ev.u, pu = ev.pu;
    if (typeof ev.U !== 'number' || typeof u !== 'number') return false;
    if (typeof pu !== 'number' || pu !== prevU) return false;
    if (!applyLevelsTo(bids, asks, ev)) return false;
    prevU = u; appliedCount++;
    return true;
  }

  function onDepthMessage(data, ws) {
    // P0 item 3: guarda de socket + geração. Mensagem de socket trocado ou
    // de geração antiga é ignorada (nunca toca estado nem DOM).
    if (!ws || depthSocket !== ws) return;
    if (typeof ws._seq === 'number' && ws._seq !== bootSeq) return;
    var ev;
    try { ev = (typeof data === 'string') ? JSON.parse(data) : data; } catch (e) { return; }
    if (!ev || ev.e !== 'depthUpdate') return;
    lastUpdateTime = Date.now();
    updatedEl.textContent = 'Atualizado: ' + new Date().toLocaleTimeString('pt-BR');
    if (syncing || !depthReady) {
      depthBuffer.push(ev); // bufferiza; o alinhamento decide (tryAlign)
      if (alignPending) tryAlign(bootSeq);
      return;
    }
    // P0 item 3: após pedir resync, return imediato (sem aplicar nem renderizar).
    if (!applyLiveEvent(ev)) { startResync('quebra de sequência'); return; }
    queueRender();
  }

  function startResync(reason, opts) {
    opts = opts || {};
    if (syncing) {
      // P0 item 1: pedido durante sync em curso é COALESCIDO (o ciclo atual
      // continua valendo); nunca dois ciclos em paralelo.
      resyncStats.coalesced++;
      console.log('[orderbook] resync coalescido (sync em curso) motivo=' + reason);
      return;
    }
    logResync(reason);
    if (!opts.quiet) {
      setStatus('warn', 'Ressincronizando…');
      if (reason) { warnEl.hidden = false; warnEl.textContent = 'Ressincronizando book (' + reason + ').'; }
    }
    bootDepth();
  }

  function bootDepth(opts) {
    opts = opts || {};
    bootSeq++; // P0 item 1: cancela o ciclo anterior (nunca em paralelo)
    var seq = bootSeq;
    syncing = true;
    clearTimeout(depthTimer); depthTimer = null;
    // P0 item 5: buffer antigo descartado a cada boot. Com keepSocket, o
    // socket é adotado na geração nova e os PRÓXIMOS eventos acumulam.
    depthBuffer = [];
    alignPending = null;
    lastUpdateId = -1; prevU = -1; appliedCount = 0;
    if (opts.keepSocket && depthSocket) {
      depthSocket._seq = seq; // adota o stream aberto (P0 item 4: stream continua)
    } else {
      connectDepthSocket(seq);
    }
    // P0 item 4: espera DETERMINÍSTICA — o timeout NUNCA prossegue com
    // buffer vazio; sem evento, continua aguardando (o stream empurra).
    (function waitBuf() {
      if (seq !== bootSeq) return; // boot superado: aborta
      if (depthBuffer.length > 0) { fetchSnapshot(seq); return; }
      setTimeout(waitBuf, 120);
    })();
  }

  function fetchSnapshot(seq) {
    // 2. Snapshot REST (só vale para o boot que o pediu). Constrói o book em
    // cópias temporárias: o exibido só troca DE UMA VEZ no commit (sem pisca).
    fetchSnapshots++; // contador p/ QA
    fetch(SNAPSHOT_URL, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (snap) {
        if (seq !== bootSeq) { noteStale('snapshot descartado'); return; }
        if (!snap || typeof snap.lastUpdateId !== 'number' || !Array.isArray(snap.bids) || !Array.isArray(snap.asks)) {
          throw new Error('snapshot inválido');
        }
        var nb = new Map(), na = new Map(), now = Date.now();
        var minB = Infinity, maxB = -Infinity, minA = Infinity, maxA = -Infinity;
        snap.bids.forEach(function (lv) {
          var p = String(lv[0]), q = parseFloat(lv[1]);
          if (isFinite(parseFloat(p)) && isFinite(q) && q > 0) {
            nb.set(p, q); levelTs.set(p, now);
            var v = +p; if (v < minB) minB = v; if (v > maxB) maxB = v;
          }
        });
        snap.asks.forEach(function (lv) {
          var p = String(lv[0]), q = parseFloat(lv[1]);
          if (isFinite(parseFloat(p)) && isFinite(q) && q > 0) {
            na.set(p, q); levelTs.set(p, now);
            var v = +p; if (v < minA) minA = v; if (v > maxA) maxA = v;
          }
        });
        if (!nb.size || !na.size) throw new Error('snapshot vazio');
        // Congela os extremos DESTE snapshot (cobertura por span, P1 item 10).
        alignPending = { lastUpdateId: snap.lastUpdateId, bids: nb, asks: na,
          bestBid: maxB, minBid: minB, bestAsk: minA, maxAsk: maxA };
        pruneLevelTs();
        tryAlign(seq);
      })
      .catch(function () {
        if (seq !== bootSeq) return;
        setStatus('off', 'Falha no snapshot — tentando de novo');
        var s = bootSeq;
        // P0 item 2: este timer pertence ao ciclo de sync → respeita bootSeq.
        setTimeout(function () { if (s === bootSeq) bootDepth(); }, RECONNECT_MS);
      });
  }

  // P0 item 4 — alinhamento DETERMINÍSTICO do buffer contra o snapshot:
  // descarta u < lastUpdateId; se restar só isso (ou nada), NÃO aplica nada
  // e continua aguardando; se surgir U > lastUpdateId sem cobertura anterior,
  // o snapshot não sincroniza mais → NOVO snapshot com o stream aberto.
  function tryAlign(seq) {
    if (seq !== bootSeq || !alignPending) return;
    var pend = alignPending;
    var buf = depthBuffer.filter(function (ev) { return ev.u >= pend.lastUpdateId; });
    var start = -1, i;
    for (i = 0; i < buf.length; i++) {
      if (buf[i].U <= pend.lastUpdateId && buf[i].u >= pend.lastUpdateId) { start = i; break; }
    }
    if (start === -1) {
      var hasNewer = buf.some(function (ev) { return ev.U > pend.lastUpdateId; });
      if (hasNewer) {
        console.log('[orderbook] snapshot defasado: novo snapshot, stream mantido');
        bootDepth({ keepSocket: true });
      }
      return; // só u < last (ou vazio): continua aguardando novos eventos
    }
    var nb = pend.bids, na = pend.asks, pu = -1, n = 0, bad = false;
    for (var j = start; j < buf.length; j++) {
      var ev = buf[j];
      if (n === 0) {
        if (!(ev.U <= pend.lastUpdateId && ev.u >= pend.lastUpdateId)) { bad = true; break; }
      } else if (ev.pu !== pu) { bad = true; break; }
      if (!applyLevelsTo(nb, na, ev)) { bad = true; break; }
      pu = ev.u; n++;
    }
    if (bad || !n) { bootDepth({ keepSocket: true }); return; }
    commitSync(seq, pend, nb, na, pu, n);
  }

  // Troca atômica: o book exibido vira o novo de uma vez (sem rebuild parcial).
  function commitSync(seq, pend, nb, na, lastU, nEvents) {
    if (seq !== bootSeq) { noteStale('commit descartado'); return; }
    bids = nb; asks = na;
    pruneLevelTs();
    lastUpdateId = pend.lastUpdateId; prevU = lastU; appliedCount = nEvents;
    snapBestBid = pend.bestBid; snapMinBid = pend.minBid;
    snapBestAsk = pend.bestAsk; snapMaxAsk = pend.maxAsk;
    depthBuffer = []; alignPending = null;
    syncing = false; depthReady = true;
    validateStrikes = 0;
    warnEl.hidden = true;
    setStatus('on', 'Conectado');
    queueRender();
  }

  function pruneLevelTs() {
    levelTs.forEach(function (_, p) {
      if (!bids.has(p) && !asks.has(p)) levelTs.delete(p);
    });
  }

  function connectDepthSocket(seq) {
    try { if (depthSocket) depthSocket.close(); } catch (e) {}
    var ws;
    try { ws = new WebSocket(DEPTH_WS_URL); } catch (e) {
      // P0 item 2: retry de construção pertence ao ciclo → respeita bootSeq.
      setTimeout(function () { if (seq === bootSeq) connectDepthSocket(seq); }, RECONNECT_MS);
      return;
    }
    ws._seq = seq; // geração do socket: mensagens velhas são ignoradas (P0 item 3)
    depthSocket = ws;
    depthConns++; depthLastChange = Date.now();
    ws.onmessage = function (evt) {
      onDepthMessage(evt.data, ws);
    };
    ws.onclose = function () {
      // Socket fechado de propósito (resync/troca) NÃO reagenda: evita loop
      // de ressincronização — só o socket atual pode pedir reconexão.
      if (depthSocket !== ws) return;
      depthCloses++; depthLastChange = Date.now();
      // Reconexão assume o ciclo (takeover): o anterior não pode completar
      // sem stream, então bootDepth() direto (não startResync, que coalesceria).
      setStatus('warn', 'Reconectando book…');
      clearTimeout(depthTimer);
      depthTimer = setTimeout(function () {
        // P0 item 2: este timer pertence ao ciclo de sync → respeita bootSeq.
        if (seq === bootSeq && depthSocket === ws) bootDepth();
      }, RECONNECT_MS);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  // ---- Cobertura por SPAN DE PREÇO (P1 item 10, ÚNICO critério) ----
  // coverageBid = (bestBid − snapMinBid) / (snapBestBid − snapMinBid)
  // coverageAsk = (snapMaxAsk − bestAsk) / (snapMaxAsk − snapBestAsk)
  // Cancelamentos e execuções (qty 0) em níveis intermediários NÃO contam
  // como perda: só o recuo das bordas reduz a razão. Independe do bucket.
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function checkCoverage() {
    if (!depthReady || !snapBestBid || !snapBestAsk) { coverageEl.textContent = ''; return; }
    var lb = bestBid(), la = bestAsk();
    if (!lb || !la) return;
    var spanB = snapBestBid - snapMinBid, spanA = snapMaxAsk - snapBestAsk;
    if (!(spanB > MIN_SPAN_USD) || !(spanA > MIN_SPAN_USD)) {
      // Span original irrisório: não avalia razão (registra e segue).
      if (coverageWarnedSeq !== bootSeq) {
        coverageWarnedSeq = bootSeq;
        console.log('[orderbook] span original irrisório, cobertura por span desativada neste ciclo');
      }
      coverageEl.textContent = '';
      return;
    }
    var cb = clamp01((lb - snapMinBid) / spanB);
    var ca = clamp01((snapMaxAsk - la) / spanA);
    if (cb < COVERAGE_MIN_RATIO || ca < COVERAGE_MIN_RATIO) {
      coverageEl.textContent = '· profundidade limitada';
      startResync('cobertura bid=' + cb.toFixed(2) + ' ask=' + ca.toFixed(2));
    } else {
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
        connectKlineSocket();
        queueRender(); // cabeçalho pinta no ciclo de render (preço único)
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
    klineConns++; klineLastChange = Date.now();
    ws.onmessage = function (evt) {
      try {
        var p = JSON.parse(evt.data), k = p.k;
        if (!k) return;
        var c = { time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c };
        var last = candles[candles.length - 1];
        if (last && last.time === c.time) candles[candles.length - 1] = c;
        else { candles.push(c); candles = candles.slice(-MAX_CANDLES); }
        currentPrice = c.close; // preço exclusivamente do kline (exibido no render)
        queueRender();
      } catch (e) {}
    };
    ws.onclose = function () {
      // Mesmo guarda do depth: socket trocado de propósito não reagenda.
      if (klineSocket !== ws) return;
      klineCloses++; klineLastChange = Date.now();
      clearTimeout(klineTimer); klineTimer = setTimeout(connectKlineSocket, RECONNECT_MS);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  // P1 item 12 + P2 item 13: UMA variável de preço por ciclo de render
  // (cabeçalho, linha, etiqueta do eixo e separador "PREÇO" sempre iguais).
  function paintPrice() {
    priceEl.textContent = displayPrice
      ? 'US$ ' + displayPrice.toLocaleString('pt-BR', { maximumFractionDigits: 0 })
      : '—';
  }

  // ================= VALIDAÇÃO PERIÓDICA (REST × local, P1 item 6) =================
  // Amostra 5–10 níveis do topo por lado (snapshot leve limit=100 → peso 5;
  // doc oficial: 5/10/20/50→2, 100→5, 500→10, 1000→20). As capturas ocorrem
  // em momentos diferentes: compara COM TOLERÂNCIA e prioriza níveis locais
  // estáveis (intocados há +VALIDATE_STABLE_MS). Absolutos disparam na hora;
  // divergência de topo/estável só após N strikes consecutivos.
  function validateBook() {
    if (!depthReady || syncing || document.hidden) return; // item 8: pausa oculta
    var seq = bootSeq; // P0 item 2: corrida pertence ao ciclo → respeita bootSeq
    fetch(VALIDATE_URL, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (snap) {
        if (seq !== bootSeq) { noteStale('validacao descartada'); return; }
        if (!snap || !Array.isArray(snap.bids) || !Array.isArray(snap.asks) || !snap.bids.length || !snap.asks.length) return;
        var rb = parseFloat(snap.bids[0][0]), ra = parseFloat(snap.asks[0][0]);
        if (!(rb < ra)) return; // REST inconsistente: ignora (timing)
        var lb = bestBid(), la = bestAsk();
        if (lb && la && !(lb < la)) { startResync('book cruzado'); return; } // absoluto
        if (storedQtyInvalid()) { startResync('quantidade inválida'); return; } // absoluto
        if (levelOutOfCoverage()) { startResync('nível fora da cobertura'); return; } // absoluto
        // Só compara dentro do range que o snapshot de validação cobre.
        var rMinB = +snap.bids[snap.bids.length - 1][0];
        var rMaxA = +snap.asks[snap.asks.length - 1][0];
        var mism = countSideMismatch(snap.bids, bids, rMinB, Infinity) +
                   countSideMismatch(snap.asks, asks, -Infinity, rMaxA) +
                   countLocalAbsent(snap.bids, bids, rMinB, Infinity) +
                   countLocalAbsent(snap.asks, asks, -Infinity, rMaxA);
        if (mism > VALIDATE_MAX_MISMATCH) {
          validateStrikes++;
          valStruck++;
          console.log('[orderbook] validacao divergente (' + mism + ' níveis), strike ' +
            validateStrikes + '/' + VALIDATE_STRIKES_TO_RESYNC);
          if (validateStrikes >= VALIDATE_STRIKES_TO_RESYNC) {
            validateStrikes = 0;
            startResync('divergência de topo persistente');
          }
        } else if (mism === 0) { validateStrikes = 0; valPassed++; }
        valRuns++;
      })
      .catch(function () {});
  }

  // Conta divergências qty em até VALIDATE_LEVELS níveis do topo, pulando
  // níveis locais alterados há pouco (timing). Nível do REST ausente no
  // local conta como divergência, sem tolerância de preço (presença binária).
  function countSideMismatch(restLevels, localMap, lo, hi) {
    var mism = 0, checked = 0, now = Date.now();
    for (var i = 0; i < restLevels.length && checked < VALIDATE_LEVELS; i++) {
      var p = String(restLevels[i][0]), q = parseFloat(restLevels[i][1]);
      var pv = +p;
      if (!(pv >= lo && pv <= hi)) continue;
      if (!localMap.has(p)) { mism++; checked++; continue; } // ausente no local
      if (now - (levelTs.get(p) || 0) < VALIDATE_STABLE_MS) continue; // mudou há pouco
      checked++;
      var lq = localMap.get(p);
      var denom = Math.max(Math.abs(q), Math.abs(lq), 1e-12);
      if (Math.abs(q - lq) / denom > VALIDATE_QTY_TOL) mism++;
    }
    return mism;
  }

  // Nível local estável dentro do range e AUSENTE no REST também diverge
  // (sem tolerância de preço). Recém-alterados são pulados (timing).
  function countLocalAbsent(restLevels, localMap, lo, hi) {
    var restSet = {}, i, extra = 0, checked = 0, now = Date.now();
    for (i = 0; i < restLevels.length; i++) restSet[String(restLevels[i][0])] = 1;
    var keys = Array.from(localMap.keys());
    for (i = 0; i < keys.length && checked < VALIDATE_LEVELS * 4; i++) {
      var p = keys[i], pv = +p;
      if (!(pv >= lo && pv <= hi)) continue;
      if (now - (levelTs.get(p) || 0) < VALIDATE_STABLE_MS) continue;
      checked++;
      if (!restSet[p]) extra++;
    }
    return extra;
  }

  function storedQtyInvalid() {
    var bad = false;
    bids.forEach(function (q, p) { if (!(q > 0) || !(+p > 0)) bad = true; });
    if (!bad) asks.forEach(function (q, p) { if (!(q > 0) || !(+p > 0)) bad = true; });
    return bad;
  }

  function levelOutOfCoverage() {
    if (!snapMinBid || !snapMaxAsk) return false;
    var out = false;
    bids.forEach(function (_, p) { if (+p < snapMinBid) out = true; });
    if (!out) asks.forEach(function (_, p) { if (+p > snapMaxAsk) out = true; });
    return out;
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
    displayPrice = currentPrice; // P1 item 12: preço único fixado 1x por ciclo
    paintPrice();
    checkCoverage(); // cobertura por span avaliada no ritmo do render
    drawCandles();
    drawBuckets();
    drawThermo(); // termômetro: só leitura do book, mesmo ciclo, sem pisca
    // Auditoria do preço único: lê de volta o que foi pintado no ciclo.
    var midTxt = (typeof midEl !== 'undefined' && midEl) ? midEl.textContent : null;
    var hNum = (priceEl.textContent.match(/[\d.]+/) || [])[0] || null;
    var mNum = (midTxt && midTxt.match(/[\d.]+/) || [])[0] || null;
    var tNum = displayPrice ? fmtAxis(displayPrice) : null;
    lastPriceCheck = { at: new Date().toISOString(), header: priceEl.textContent,
      mid: midTxt, tag: tNum, equal: !!(hNum && mNum && tNum && hNum === mNum && mNum === tNum) };
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
    var sig = vis.length + '|' + lo + '|' + hi + '|' + last.time + '|' + last.close + '|' + displayPrice + '|' + Math.round(w);
    if (sig === lastCandleSig) return;
    lastCandleSig = sig;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // setTransform (não scale: scale acumula e desloca)
    ctx.clearRect(0, 0, w, h);
    var pad = 8;
    var timeGutter = 16; // faixa inferior p/ rótulos de horário (P2 item 14)
    var plotH = h - timeGutter;
    function y(p) { return pad + (1 - (p - lo) / (hi - lo)) * (plotH - pad * 2); }
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
    // P2 item 14: marcas ARREDONDADAS no eixo Y (ex.: 86.800, 86.600) +
    // rótulos de horário no eixo X.
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    var step = niceStep((hi - lo) / 4), tv;
    for (tv = Math.ceil(lo / step) * step; tv <= hi + 1e-9; tv += step) {
      var py = y(tv);
      ctx.strokeStyle = 'rgba(255,255,255,.07)';
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(plotW, py); ctx.stroke();
      ctx.fillStyle = '#888';
      ctx.fillText(fmtAxis(tv), plotW + 5, py);
    }
    ctx.textAlign = 'center';
    var xi;
    for (xi = 0; xi < 4; xi++) {
      var ci = Math.min(vis.length - 1, Math.round(xi * (vis.length - 1) / 3));
      var tLbl = fmtClock(vis[ci].time);
      // (i) primeiro rótulo era cortado ("6:20" em vez de "06:20"):
      // prende o centro dentro da área do gráfico.
      var cx = 5 + ci * cw + cw / 2;
      var tw = ctx.measureText(tLbl).width;
      if (cx - tw / 2 < 2) cx = 2 + tw / 2;
      if (cx + tw / 2 > plotW - 2) cx = plotW - 2 - tw / 2;
      ctx.fillStyle = '#666';
      ctx.fillText(tLbl, cx, h - 7);
    }
    ctx.textAlign = 'left';
    if (displayPrice >= lo && displayPrice <= hi) {
      var cpy = y(displayPrice);
      ctx.strokeStyle = 'rgba(247,147,26,.8)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(0, cpy); ctx.lineTo(plotW, cpy); ctx.stroke();
      ctx.setLineDash([]);
      // Etiqueta do preço atual no gutter do eixo.
      var tag = fmtAxis(displayPrice);
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

  // Passo "bonito" 1/2/5×10^n para o eixo Y (P2 item 14).
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / p;
    return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
  }

  function fmtClock(ms) {
    var d = new Date(ms);
    var hh = d.getHours(), mm = d.getMinutes();
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  // Mensagens de estado: só tocam o DOM na TRANSIÇÃO (nunca a cada render).
  function showRowsMsg(kind, html) {
    if (rowsMsg === kind) return;
    rowsMsg = kind;
    rowsEl.innerHTML = html;
    askRowEls.clear(); bidRowEls.clear();
    partAskPool.forEach(function (e) { e.el.remove(); });
    partBidPool.forEach(function (e) { e.el.remove(); });
    partAskPool.clear(); partBidPool.clear();
    midEl = null;
  }

  function drawBuckets() {
    var scale = canvas._yScale;
    if (!depthReady || !scale || !displayPrice) {
      showRowsMsg('loading', '<div class="ob__loading">Carregando book…</div>');
      return;
    }
    autoEvaluate(); // Auto-faixa: pode ajustar bucketSize antes de agregar
    // Painel INDEPENDENTE do timeframe/gráfico: agrega TODOS os níveis do
    // book; o único limite é a regra de borda do snapshot
    // (snapshotMinBid / snapshotMaxAsk). Níveis além da borda vão para os
    // mapas de omitidas (parcial de borda + auditoria), nunca descartados
    // pelo range dos candles.
    // P1 item 11: bucket de COMPRAS só se bucketLow >= snapMinBid; de VENDAS
    // só se bucketHigh <= snapMaxAsk. Fora disso: OMITIDO (nunca parcial).
    // Agrega por bucket, separando bids e asks. Cada bucket mantém DOIS
    // totais (Etapa 2, só apresentação): usd = preço × quantidade (exato
    // como antes) e btc = soma das quantidades (o book já cotiza em BTC).
    // A unidade é escolhida SOMENTE no render; trocar não toca no book.
    var bidBuckets = new Map(), askBuckets = new Map();
    var omitBid = new Map(), omitAsk = new Map(); // borda omitida: só p/ auditoria
    function addToBucket(map, bLo, price, q) {
      var e = map.get(bLo);
      if (!e) { e = { usd: 0, btc: 0 }; map.set(bLo, e); }
      e.usd += price * q;
      e.btc += q;
    }
    bids.forEach(function (q, p) {
      var price = +p;
      var bLo = Math.floor(price / bucketSize) * bucketSize;
      if (!(bLo >= snapMinBid)) { addToBucket(omitBid, bLo, price, q); return; } // borda → OMITIDO (P1 item 11)
      addToBucket(bidBuckets, bLo, price, q);
    });
    asks.forEach(function (q, p) {
      var price = +p;
      var bLo = Math.floor(price / bucketSize) * bucketSize;
      if (!(bLo + bucketSize <= snapMaxAsk)) { addToBucket(omitAsk, bLo, price, q); return; } // borda → OMITIDO (P1 item 11)
      addToBucket(askBuckets, bLo, price, q);
    });
    if (!bidBuckets.size && !askBuckets.size && !omitBid.size && !omitAsk.size) {
      showRowsMsg('nobuckets', '<div class="ob__empty">Sem buckets completos no snapshot.</div>');
      return;
    }
    // Saímos de um estado de mensagem: limpa UMA vez e recomeça o pool.
    if (rowsMsg !== 'data') {
      rowsMsg = 'data';
      rowsEl.innerHTML = '';
      askRowEls.clear(); bidRowEls.clear();
      partAskPool.forEach(function (e) { e.el.remove(); });
      partBidPool.forEach(function (e) { e.el.remove(); });
      partAskPool.clear(); partBidPool.clear();
      midEl = null;
    }
    // Escala ÚNICA por unidade: 100% = maior bucket entre os EXIBIDOS
    // (os N mais próximos do preço, de cada lado, na unidade selecionada).
    // Seleção primeiro, escala depois — proporções sempre honestas.
    // Faixa parcial de borda: só aparece quando o lado tem menos de 5
    // completas; entra na escala pelo valor-piso, nunca leva o chip, e o
    // total por lado nunca excede 5 barras.
    var askFull = askBuckets.size, bidFull = bidBuckets.size;
    var askNear = Array.from(askBuckets.keys()).sort(function (a, b) { return a - b; })
      .slice(0, VISIBLE_BANDS_PER_SIDE);
    var bidNear = Array.from(bidBuckets.keys()).sort(function (a, b) { return b - a; })
      .slice(0, VISIBLE_BANDS_PER_SIDE);
    var partAskK = null, partBidK = null;
    if (askFull < VISIBLE_BANDS_PER_SIDE && omitAsk.size) {
      partAskK = Math.min.apply(null, Array.from(omitAsk.keys()));
    }
    if (bidFull < VISIBLE_BANDS_PER_SIDE && omitBid.size) {
      partBidK = Math.max.apply(null, Array.from(omitBid.keys()));
    }
    var partAskE = partAskK === null ? null : omitAsk.get(partAskK);
    var partBidE = partBidK === null ? null : omitBid.get(partBidK);
    var peakUSD = 0, peakBTC = 0;
    function trackPeak(e) {
      if (e.usd > peakUSD) peakUSD = e.usd;
      if (e.btc > peakBTC) peakBTC = e.btc;
    }
    askNear.forEach(function (k) { trackPeak(askBuckets.get(k)); });
    bidNear.forEach(function (k) { trackPeak(bidBuckets.get(k)); });
    if (partAskE) trackPeak(partAskE);
    if (partBidE) trackPeak(partBidE);
    var peak = unit === 'BTC' ? peakBTC : peakUSD;
    if (!peak) return;
    function valOf(e) { return unit === 'BTC' ? e.btc : e.usd; }
    // Maior concentração de cada lado, NA UNIDADE SELECIONADA (entre as exibidas).
    var maxAskK = null, maxAskV = -1, maxBidK = null, maxBidV = -1;
    askNear.forEach(function (k) { var v = valOf(askBuckets.get(k)); if (v > maxAskV) { maxAskV = v; maxAskK = k; } });
    bidNear.forEach(function (k) { var v = valOf(bidBuckets.get(k)); if (v > maxBidV) { maxBidV = v; maxBidK = k; } });
    // Cópia p/ o hook de QA (bucketsSnapshot): usd+btc do último cálculo.
    lastBuckets = { unit: unit, peakUSD: peakUSD, peakBTC: peakBTC,
      ask: copyBuckets(askBuckets), bid: copyBuckets(bidBuckets) };
    lastOmitted = { ask: copyBuckets(omitAsk), bid: copyBuckets(omitBid) };
    // Ordem de exibição: asks desc (maior no topo), bids desc (maior em cima).
    var askKeys = askNear.slice().sort(function (a, b) { return b - a; });
    var bidKeys = bidNear.slice().sort(function (a, b) { return b - a; });
    lastShown = { ask: askKeys.slice(), bid: bidKeys.slice() };
    if (partAskK !== null) lastShown.ask.push(partAskK);
    if (partBidK !== null) lastShown.bid.push(partBidK);
    lastPartial = { ask: partAskK, bid: partBidK }; // parciais exibidas (rótulo "≥")
    // Rótulo "só N faixas completas" quando algum lado exibir menos de 5.
    // O único limite possível agora é o snapshot (nunca o gráfico).
    var shortTxt = '';
    if (askFull < VISIBLE_BANDS_PER_SIDE || bidFull < VISIBLE_BANDS_PER_SIDE) {
      var parts = [];
      if (bidFull < VISIBLE_BANDS_PER_SIDE) parts.push('só ' + bidFull + ' faixas completas em compras');
      if (askFull < VISIBLE_BANDS_PER_SIDE) parts.push('só ' + askFull + ' faixas completas em vendas');
      shortTxt = parts.join(' · ');
    }
    setText(shortEl, shortTxt);
    if (!midEl) {
      midEl = document.createElement('div');
      midEl.className = 'ob__midline';
      rowsEl.appendChild(midEl);
    }
    // Linha persistente: cria uma vez, depois só atualiza largura/texto/chip
    // quando mudam. Mover nó existente (insertBefore/appendChild) não pisca.
    function syncRow(pool, key, bLo, entry, side, isMax, isPartial) {
      var usd = entry.usd, btc = entry.btc;
      var val = valOf(entry);
      var pct = (val / peak * 100).toFixed(1);
      var valTxt = (isPartial ? '≥ ' : '') + fmtVal(usd, btc);
      var e = pool.get(key);
      if (!e) {
        var d = document.createElement('div');
        d.className = 'ob__row';
        d.innerHTML = '<span class="ob__bucket"></span>' +
          '<span class="ob__bar-track"><span class="ob__bar-fill ' +
          (side === 'ask' ? 'ob__bar-fill--ask' : 'ob__bar-fill--bid') + '"></span></span>' +
          '<span class="ob__usd"></span>';
        e = { el: d, bucket: d.querySelector('.ob__bucket'), fill: d.querySelector('.ob__bar-fill'),
              track: d.querySelector('.ob__bar-track'),
              usdEl: d.querySelector('.ob__usd'), data: null, bs: 0, un: '', w: '', c: '', html: '', chipHtml: '', chip: null };
        d.addEventListener('mousemove', function (ev) {
          var dt = e.data; if (!dt) return;
          tipEl.style.display = 'block';
          tipEl.style.left = (ev.clientX + 12) + 'px';
          tipEl.style.top = (ev.clientY + 12) + 'px';
          tipEl.innerHTML = tipHTML(dt.bLo, dt.usd, dt.btc, dt.side, dt.partial);
        });
        d.addEventListener('mouseleave', function () { tipEl.style.display = 'none'; });
        pool.set(key, e);
      }
      e.data = { bLo: bLo, usd: usd, btc: btc, side: side, partial: !!isPartial };
      if (e.bs !== bucketSize || e.un !== unit) {
        e.bs = bucketSize; e.un = unit;
        e.bucket.textContent = bLo.toLocaleString('pt-BR') + '–' + (bLo + bucketSize).toLocaleString('pt-BR');
      }
      var wStr = pct + '%';
      if (e.w !== wStr) { e.fill.style.width = wStr; e.w = wStr; }
      var cls = 'ob__bar-fill ' + (side === 'ask' ? 'ob__bar-fill--ask' : 'ob__bar-fill--bid') +
        (val === peak && !isPartial ? ' ob__bar-fill--top' : '') +
        (isPartial ? ' ob__bar-fill--partial' : '');
      if (e.c !== cls) { e.fill.className = cls; e.c = cls; }
      var html = valTxt;
      if (e.html !== html) { e.usdEl.innerHTML = html; e.html = html; }
      // Etiqueta de máxima DENTRO do gráfico: overlay no início da trilha
      // (ponta da barra livre). Nunca aponta para parcial.
      var chipTxt = (isMax && !isPartial)
        ? bLo.toLocaleString('pt-BR') + ' | ' + valTxt +
          (side === 'ask' ? ' (VENDAS)' : ' (COMPRAS)')
        : '';
      if ((e.chipHtml || '') !== chipTxt) {
        e.chipHtml = chipTxt;
        if (e.chip) { e.chip.remove(); e.chip = null; }
        if (isMax) {
          var em = document.createElement('em');
          em.className = 'ob__max ' + (side === 'ask' ? 'ob__max--ask' : 'ob__max--bid');
          em.textContent = chipTxt;
          e.track.appendChild(em);
          e.chip = em;
        }
      }
      return e.el;
    }
    // Remove do DOM as faixas que sumiram (ou saíram do top-N visível).
    var askShown = {}, bidShown = {}, si;
    for (si = 0; si < askKeys.length; si++) askShown[askKeys[si]] = 1;
    for (si = 0; si < bidKeys.length; si++) bidShown[bidKeys[si]] = 1;
    askRowEls.forEach(function (e, k) { if (!askShown[k]) { e.el.remove(); askRowEls.delete(k); } });
    bidRowEls.forEach(function (e, k) { if (!bidShown[k]) { e.el.remove(); bidRowEls.delete(k); } });
    // Reposiciona na ordem (mover não recria: sem pisca).
    askKeys.forEach(function (k) { rowsEl.insertBefore(syncRow(askRowEls, k, k, askBuckets.get(k), 'ask', k === maxAskK, false), midEl); });
    // Parcial de venda: acima das completas (é a faixa mais alta).
    // Poda a parcial obsoleta (ex.: mudou o bucket ou sumiu a borda).
    partAskPool.forEach(function (e, k) {
      if (partAskK === null || k !== 'p' + partAskK) { e.el.remove(); partAskPool.delete(k); }
    });
    if (partAskK !== null && partAskE) {
      var firstAsk = askKeys.length ? askRowEls.get(askKeys[0]).el : midEl;
      rowsEl.insertBefore(syncRow(partAskPool, 'p' + partAskK, partAskK, partAskE, 'ask', false, true), firstAsk);
    } else {
      partAskPool.forEach(function (e) { e.el.remove(); });
      partAskPool.clear();
    }
    var midTxt = 'PREÇO US$ ' + displayPrice.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
    if (midEl.textContent !== midTxt) midEl.textContent = midTxt;
    bidKeys.forEach(function (k) { rowsEl.appendChild(syncRow(bidRowEls, k, k, bidBuckets.get(k), 'bid', k === maxBidK, false)); });
    // Parcial de compra: abaixo das completas (é a faixa mais baixa).
    partBidPool.forEach(function (e, k) {
      if (partBidK === null || k !== 'p' + partBidK) { e.el.remove(); partBidPool.delete(k); }
    });
    if (partBidK !== null && partBidE) {
      rowsEl.appendChild(syncRow(partBidPool, 'p' + partBidK, partBidK, partBidE, 'bid', false, true));
    } else {
      partBidPool.forEach(function (e) { e.el.remove(); });
      partBidPool.clear();
    }
  }

  // ================= TERMÔMETRO compras × vendas (só apresentação) =================
  // Lê os NÍVEIS individuais do book local (não os buckets). Janela com
  // distância IGUAL nos dois lados, dos extremos CONGELADOS do snapshot:
  //   bidSpan = bestBid − snapshotMinBid; askSpan = snapshotMaxAsk − bestAsk
  //   D = min(bidSpan, askSpan), em US$ de preço, independente da unidade.
  // Compras: bestBid − D <= preço <= bestBid.
  // Vendas: bestAsk <= preço <= bestAsk + D.
  // O preço do kline NÃO entra no cálculo (só exibição). Spread nunca vira
  // volume: a faixa (bestBid, bestAsk) não pertence a nenhum lado. Níveis
  // fora de [snapshotMinBid, snapshotMaxAsk] não entram. Book cruzado
  // (bestBid >= bestAsk) → vazio. Percentuais SEMPRE de btc (invariantes à
  // unidade); valores exibidos seguem a unidade (fmtUSD/fmtBTC aprovados).
  function computeThermo() {
    if (!depthReady) return { empty: true, reason: 'book-ausente' };
    var lb = bestBid(), la = bestAsk();
    if (!lb || !la) return { empty: true, reason: 'best-ausente' };
    if (lb >= la) return { empty: true, reason: 'cruzado' };
    if (!snapMinBid || !snapMaxAsk) return { empty: true, reason: 'sem-snapshot' };
    var bidSpan = lb - snapMinBid, askSpan = snapMaxAsk - la;
    var D = Math.min(bidSpan, askSpan);
    if (!(D > 0) || D < THERMO_MIN_D_USD) return { empty: true, reason: 'janela-curta' };
    var buyBtc = 0, buyUsd = 0, sellBtc = 0, sellUsd = 0, nBid = 0, nAsk = 0;
    var buyLo = lb - D, sellHi = la + D;
    bids.forEach(function (q, p) {
      var v = +p;
      if (v < buyLo || v > lb) return;
      if (v < snapMinBid) return; // fora da janela do snapshot: fora
      buyBtc += q; buyUsd += v * q; nBid++;
    });
    asks.forEach(function (q, p) {
      var v = +p;
      if (v < la || v > sellHi) return;
      if (v > snapMaxAsk) return; // fora da janela do snapshot: fora
      sellBtc += q; sellUsd += v * q; nAsk++;
    });
    var tot = buyBtc + sellBtc;
    if (!(tot > 0)) return { empty: true, reason: 'sem-volume' };
    var t = { empty: false, bestBid: lb, bestAsk: la, price: displayPrice,
      bidSpan: bidSpan, askSpan: askSpan, D: D,
      buyBtc: buyBtc, sellBtc: sellBtc, buyUsd: buyUsd, sellUsd: sellUsd,
      buyPct: buyBtc / tot * 100, sellPct: sellBtc / tot * 100,
      nBid: nBid, nAsk: nAsk, unit: unit,
      buyTop: lb, buyBottom: buyLo, sellBottom: la, sellTop: sellHi,
      bands: buildBands(lb - D, lb, la, la + D) };
    return t;
  }

  // Faixas dentro de ±D com totais e marcação p/ __obAudit. Campos
  // mutuamente claros: shown = linha exibida no painel; partial = exibida
  // como parcial de borda (rótulo "≥"); omittedByEdge = NÃO exibida por
  // borda do snapshot. Completa fora do top-N: os três em false. Sem
  // nenhum campo ligado a recorte de gráfico (o painel não usa o range
  // dos candles).
  function buildBands(bidLo, bidHi, askLo, askHi) {
    var out = { bid: [], ask: [] };
    function push(side, store, shownKeys, wLo, wHi, isOmittedStore) {
      Object.keys(store).forEach(function (ks) {
        var k = +ks, e = store[ks];
        var bLo = k, bHi = k + bucketSize;
        var overlaps = bLo <= wHi && bHi >= wLo;
        if (!overlaps) return;
        var isShown = shownKeys.indexOf(k) >= 0;
        var isPartial = isOmittedStore && lastPartial[side] === k;
        out[side].push({ lo: bLo, hi: bHi, usd: e.usd, btc: e.btc,
          shown: isShown, partial: isPartial,
          omittedByEdge: isOmittedStore && !isPartial });
      });
      out[side].sort(function (a, b) { return a.lo - b.lo; });
    }
    if (lastBuckets) {
      push('bid', lastBuckets.bid, lastShown.bid, bidLo, bidHi, false);
      push('ask', lastBuckets.ask, lastShown.ask, askLo, askHi, false);
    }
    if (lastOmitted) {
      push('bid', lastOmitted.bid, lastShown.bid, bidLo, bidHi, true);
      push('ask', lastOmitted.ask, lastShown.ask, askLo, askHi, true);
    }
    return out;
  }

  function fmtD(d) {
    return '±US$ ' + d.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  }

  // Desenha no mesmo ciclo de render, sem rebuild: só larguras e textos.
  // Altura reservada no CSS mesmo vazia (sem salto de layout).
  function drawThermo() {
    var t = computeThermo();
    lastThermo = t;
    if (t.empty) {
      setThermoBar(0, 0);
      setText(thermoBuyEl, '—');
      setText(thermoSellEl, '');
      setText(thermoLegend, '—');
      setText(thermoDiff, '');
      thermoBar.removeAttribute('title');
      return;
    }
    setThermoBar(t.buyPct, t.sellPct);
    var buyTxt = unit === 'BTC' ? fmtBTC(t.buyBtc) : fmtUSD(t.buyUsd);
    var sellTxt = unit === 'BTC' ? fmtBTC(t.sellBtc) : fmtUSD(t.sellUsd);
    // (iii) rótulos alinhados a cada cor: compras à esquerda (azul),
    // vendas à direita (vermelho), mesmo texto de antes.
    setText(thermoBuyEl, 'Compras ' + buyTxt + ' · ' + Math.round(t.buyPct) + '%');
    setText(thermoSellEl, Math.round(t.sellPct) + '% · ' + sellTxt + ' Vendas');
    setText(thermoLegend,
      'calculado em ' + fmtD(t.D) + ' do melhor preço de compra e de venda (independente da faixa escolhida)');
    // Marca central em 50%: diferença calculada a partir dos percentuais
    // EXIBIDOS (arredondados), nunca da distância até 50%.
    var rb = Math.round(t.buyPct), rs = Math.round(t.sellPct);
    var lead = rb >= rs ? 'compras' : 'vendas';
    var diffPp = Math.abs(rb - rs);
    setText(thermoDiff, diffPp === 0 ? 'equilíbrio' : lead + ' +' + diffPp + ' p.p.');
    thermoBar.setAttribute('title',
      'Soma das ordens limite do book até esta distância. Não é pressão garantida: ' +
      'ordens podem ser canceladas e paredes grandes podem ser spoofing. Não são liquidações.');
  }

  function setThermoBar(buyPct, sellPct) {
    var bw = buyPct.toFixed(1) + '%', sw = sellPct.toFixed(1) + '%';
    if (thermoBid.style.width !== bw) thermoBid.style.width = bw;
    if (thermoAsk.style.width !== sw) thermoAsk.style.width = sw;
  }

  function setText(el, txt) {
    if (el.textContent !== txt) el.textContent = txt;
  }

  // ---- Boot (lazy: só quando visível; não toca nos sockets Spot) ----
  function boot() {
    restartKline();
    bootDepth();
    // P1 item 7: watchdog configurável (0 = desativado). Monta em 2º plano e
    // troca de uma vez (swap atômico, sem pisca); só com stream saudável e
    // aba visível.
    if (WATCHDOG_RESYNC_MS > 0) {
      watchdogTimer = setInterval(function () {
        if (!depthReady || syncing || document.hidden) return;
        startResync('watchdog', { quiet: true });
      }, WATCHDOG_RESYNC_MS);
    }
    validateTimer = setInterval(validateBook, VALIDATE_MS);
  }
  // Auditoria SOMENTE LEITURA (sem enviar nada para fora): devolve e imprime
  // o estado operacional do widget — p/ o teste operacional de 30 min.
  window.__obAudit = function () {
    var now = Date.now();
    var lb = 0, la = 0;
    try { lb = bestBid(); la = bestAsk(); } catch (e) {}
    var cov = null;
    if (snapBestBid && snapBestAsk && (snapBestBid - snapMinBid) > MIN_SPAN_USD &&
        (snapMaxAsk - snapBestAsk) > MIN_SPAN_USD && lb && la) {
      cov = {
        bid: +clamp01((lb - snapMinBid) / (snapBestBid - snapMinBid)).toFixed(4),
        ask: +clamp01((snapMaxAsk - la) / (snapMaxAsk - snapBestAsk)).toFixed(4)
      };
    }
    var out = {
      uptimeMin: +((now - bootTime) / 60000).toFixed(1),
      resyncs: { total: resyncStats.total, coalesced: resyncStats.coalesced,
        byHour: resyncStats.byHour, log: resyncLog.slice() },
      staleDiscards: staleDiscards,
      validations: { runs: valRuns, passed: valPassed, struck: valStruck,
        strikesNow: validateStrikes },
      coverage: { bid: cov && cov.bid, ask: cov && cov.ask,
        badge: coverageEl.textContent || null,
        snap: { bestBid: snapBestBid, minBid: snapMinBid, bestAsk: snapBestAsk, maxAsk: snapMaxAsk } },
      priceCheck: lastPriceCheck,
      thermometer: lastThermo,
      auto: { mode: autoMode ? 'auto' : 'manual', bucket: bucketSize, lastSwitch: lastAutoSwitch,
        upStreak: autoUpStreak, minUpMs: AUTO_MIN_UP_MS },
      book: { bids: bids.size, asks: asks.size, bestBid: lb, bestAsk: la,
        ready: depthReady, syncing: syncing, applied: appliedCount },
      sockets: {
        depth: { connected: !!(depthSocket && depthSocket.readyState === 1),
          conns: depthConns, closes: depthCloses, lastChange: depthLastChange },
        kline: { connected: !!(klineSocket && klineSocket.readyState === 1),
          conns: klineConns, closes: klineCloses, lastChange: klineLastChange }
      }
    };
    try { console.log('[orderbook:audit] ' + JSON.stringify(out)); } catch (e) {}
    return out;
  };
  // Gancho de QA (harness node, critérios de aceite): expõe o mínimo para
  // injetar eventos e observar estado. Para NÃO alterar o comportamento em
  // produção nem permitir escrita no estado pelo console, só existe quando
  // window.__OB_ALLOW_TEST__ === true ANTES do carregamento do script.
  // Sem a flag, window.__OB_TEST__ é undefined (verificação do item 4).
  if (window.__OB_ALLOW_TEST__ === true) {
  window.__OB_TEST__ = {
    injectDepth: function (ev) { onDepthMessage(ev, depthSocket); },
    socketClose: function () { if (depthSocket && depthSocket.onclose) depthSocket.onclose(); },
    startResync: startResync,
    bootDepth: bootDepth,
    runValidation: validateBook,
    fmtBTC: fmtBTC, // formatação pura, só leitura
    tipHTML: tipHTML, // tooltip puro a partir de (bLo, usd, btc, side)
    thermo: function () { // último cálculo (cópia); vazio registrado como vazio
      return lastThermo ? JSON.parse(JSON.stringify(lastThermo)) : null;
    },
    bucketsSnapshot: function () { return lastBuckets ? JSON.parse(JSON.stringify(lastBuckets)) : null; },
    setUnit: function (v) {
      if ((v === 'USD' || v === 'BTC') && unit !== v) {
        unit = v;
        var btns = unitSeg.children, i;
        for (i = 0; i < btns.length; i++) {
          var on = (i === (v === 'BTC' ? 1 : 0));
          btns[i].className = on ? 'ativo' : '';
          btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        queueRender();
      }
    },
    setBucket: function (v) {
      // Espelha o clique manual: desliga o Auto e aplica a faixa.
      if (BUCKET_CHOICES.indexOf(v) >= 0) applyBucketManual(v);
    },
    setAuto: function (on) { setAutoMode(!!on); },
    setAutoMinUpMs: function (ms) { // QA: acelera o portão de tempo (default 25000 em produção)
      if (typeof ms === 'number' && ms >= 0) { AUTO_MIN_UP_MS = ms; autoUpStreak = 0; autoUpSince = 0; }
    },
    state: function () {
      return { depthReady: depthReady, syncing: syncing, lastUpdateId: lastUpdateId,
        bids: bids.size, asks: asks.size, applied: appliedCount, prevU: prevU,
        fetches: fetchSnapshots, strikes: validateStrikes,
        resyncTotal: resyncStats.total, coalesced: resyncStats.coalesced,
        bootSeq: bootSeq, price: displayPrice, bucket: bucketSize, auto: autoMode,
        bestBid: bestBid(), bestAsk: bestAsk(),
        snap: { bestBid: snapBestBid, minBid: snapMinBid, bestAsk: snapBestAsk, maxAsk: snapMaxAsk } };
    }
  };
  } // fim do if __OB_ALLOW_TEST__ (item 4: hook só existe com a flag)
  if ('IntersectionObserver' in window) {
    var obs = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) { obs.disconnect(); boot(); }
    }, { rootMargin: '200px' });
    obs.observe(root);
  } else {
    boot();
  }
})();
