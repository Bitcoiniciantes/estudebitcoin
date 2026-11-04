import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { computeQuote, rsiWilder, QUOTE_WINDOWS } from '../cloudflare/bitcoiniciantes-ia/src/index.js';

const TICKER_SRC = fs.readFileSync(new URL('../assets/js/ticker-widget.js', import.meta.url), 'utf8');
const WORKER_SRC = fs.readFileSync(new URL('../cloudflare/bitcoiniciantes-ia/src/index.js', import.meta.url), 'utf8');
const HTML_SRC = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const B3_SYMBOLS = ['VALE3.SA', 'PETR4.SA', 'ITUB4.SA', 'BBDC4.SA', 'BPAC11.SA', 'BBAS3.SA', 'WEGE3.SA', 'USIM5.SA'];
const TZ_B3 = 'America/Sao_Paulo';
const NOW = Date.parse('2026-11-02T20:00:00Z');

// Série clássica de Wilder (33 fechamentos) — referência de cálculo do RSI.
const WILDER_CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89,
  46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25,
  45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
];

function ts(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

function weeklyPoints(count, lastIso = '2026-10-30T13:30:00Z') {
  const last = Date.parse(lastIso);
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(last - (count - 1 - index) * 7 * 24 * 60 * 60 * 1000).toISOString();
    return { time: ts(time), close: 100 + index * 0.5 };
  });
}

function makeRaw(points, meta = {}) {
  return {
    chart: {
      result: [
        {
          meta: { exchangeTimezoneName: TZ_B3, currency: 'BRL', ...meta },
          timestamp: points.map((item) => item.time),
          indicators: {
            quote: [
              {
                close: points.map((item) => item.close),
                volume: points.map(() => 1000),
              },
            ],
          },
        },
      ],
    },
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function widgetButton(attrs) {
  const set = new Set();
  return {
    attrs,
    hidden: false,
    listeners: {},
    classList: {
      toggle(cls, on) { if (on) set.add(cls); else set.delete(cls); },
      contains(cls) { return set.has(cls); },
      add(cls) { set.add(cls); },
      remove(cls) { set.delete(cls); },
    },
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    click() { (this.listeners.click || []).forEach((fn) => fn({ target: this })); },
  };
}

// Monta o ticker-widget REAL num contexto vm com DOM mínimo, com os três
// painéis (CRIPTO/STOCKS/B3) e a legenda do RSI. O payload do Worker é criado
// DENTRO do contexto para que o objeto observado seja o mesmo que o widget usa.
function mountTicker() {
  const requests = [];
  const events = [];
  const intervals = [];
  const pendingRsi = { resolve: null };
  const buttons = {
    '1h': widgetButton({ 'data-window': '1h' }),
    '24h': widgetButton({ 'data-window': '24h' }),
    '7d': widgetButton({ 'data-window': '7d' }),
    '30d': widgetButton({ 'data-window': '30d' }),
    '90d': widgetButton({ 'data-window': '90d', 'data-only-tab': 'stocks,b3' }),
    '1y': widgetButton({ 'data-window': '1y', 'data-only-tab': 'stocks,b3' }),
    '3y': widgetButton({ 'data-window': '3y', 'data-only-tab': 'stocks,b3' }),
  };
  const windowButtons = Object.values(buttons);
  const tabs = {
    crypto: widgetButton({ 'data-tab': 'crypto' }),
    stocks: widgetButton({ 'data-tab': 'stocks' }),
    b3: widgetButton({ 'data-tab': 'b3' }),
  };
  const tabButtons = Object.values(tabs);
  tabs.crypto.classList.add('active');
  buttons['24h'].classList.add('active');

  const grid = {
    innerHTML: '',
    style: {},
    parentNode: { insertBefore() {} },
    nextSibling: null,
    addEventListener() {},
    querySelector() { return null; },
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0 }; },
  };
  const status = { textContent: '' };
  const legend = { hidden: true, id: 'tq-rsi-legend' };
  const generic = () => ({
    value: '', textContent: '', title: '', style: {}, hidden: false, innerHTML: '',
    addEventListener() {}, querySelectorAll: () => [], setAttribute() {}, appendChild() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  });
  const els = { 'ticker-grid': grid, 'ticker-status': status, 'tq-rsi-legend': legend };

  const sandbox = {
    console,
    navigator: {},
    CustomEvent: class {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    WebSocket: class { constructor() {} close() {} },
    fetch: (url) => {
      const target = String(url);
      if (target.includes('api.binance.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            [1, '100', '110', '90', '100', '1000'],
            [2, '110', '115', '100', '110', '1000'],
            [3, '121', '122', '115', '121', '1000'],
          ]),
        });
      }
      if (!target.includes('/api/quotes')) return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
      const assets = decodeURIComponent((/[?&]assets=([^&]+)/.exec(target) || [])[1] || '');
      const win = (/[?&]window=([^&]+)/.exec(target) || [])[1] || '24h';
      requests.push({ url: target, assets, window: win });
      if (win === '1wk' && sandbox.__pendingRsi) {
        return new Promise((resolve) => { pendingRsi.resolve = () => resolve({ ok: true, json: () => Promise.resolve(sandbox.__payload(assets, win)) }); });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(sandbox.__payload(assets, win)) });
    },
    document: {
      readyState: 'complete',
      body: { appendChild() {}, removeChild() {} },
      getElementById: (id) => els[id] || (els[id] = generic()),
      querySelector: (sel) => {
        const m = /data-window="([^"]+)"/.exec(sel);
        return m ? buttons[m[1]] || null : null;
      },
      querySelectorAll: (sel) => {
        if (sel === '.ticker-window button') return windowButtons;
        if (sel === '.ticker-tabs button') return tabButtons;
        return [];
      },
      addEventListener() {},
      createElement: () => generic(),
    },
    window: {
      innerHeight: 800,
      addEventListener() {},
      dispatchEvent(event) { events.push({ type: event.type, detail: event.detail }); },
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.__now = NOW;
  sandbox.__payloadMode = 'ok';
  vm.createContext(sandbox);
  vm.runInContext('Date.now = function () { return __now; };', sandbox);

  // Dados do Worker: 8 papéis da B3, 24 STOCKS e RSI semanal por segmento.
  vm.runInContext(`
    globalThis.__B3 = [
      ["VALE3.SA", 60.00, 1.5],
      ["PETR4.SA", 38.42, 2.0],
      ["ITUB4.SA", 35.10, 3.2],
      ["BBDC4.SA", 15.20, -1.4],
      ["BPAC11.SA", 42.00, 0.4],
      ["BBAS3.SA", 27.30, -2.2],
      ["WEGE3.SA", 52.00, 5.0],
      ["USIM5.SA", 6.10, 0]
    ];
    globalThis.__RSI = {
      "VALE3.SA": 39.9,
      "PETR4.SA": 40,
      "ITUB4.SA": 45.9,
      "BBDC4.SA": 46,
      "BPAC11.SA": 70.9,
      "BBAS3.SA": 71,
      "WEGE3.SA": 70,
      "USIM5.SA": null
    };
    globalThis.__b3Quotes = function (withRsi) {
      return __B3.map(function (item) {
        var q = {
          symbol: item[0],
          name: "NOME SUJO DA FONTE",
          price: item[1],
          changePct: item[2],
          volume: 1000,
          closes: [1, 2, 3],
          currency: "BRL"
        };
        if (withRsi && __RSI[item[0]] !== null) q.rsi = __RSI[item[0]];
        return q;
      });
    };
    globalThis.__payload = function (assets, win) {
      if (win === "1wk") {
        if (__payloadMode === "wrongWindow") return { window: "24h", quotes: __b3Quotes(false) };
        var list = assets.split(",");
        if (__payloadMode === "lowStocks" && list.indexOf("VALE3.SA") !== -1) {
          var lowB3 = __b3Quotes(true);
          lowB3[0].rsi = 24.5;
          return { window: "1wk", quotes: lowB3 };
        }
        if (list.indexOf("VALE3.SA") !== -1) return { window: "1wk", quotes: __b3Quotes(true) };
        if (__payloadMode === "lowStocks") return { window: "1wk", quotes: [
          { symbol: "NVDA", name: "NVIDIA", price: 204.64, changePct: 55.3, volume: 1000, closes: [1, 2, 3], currency: "USD", rsi: 30.5 },
        ] };
        return { window: "1wk", quotes: [
          { symbol: "NVDA", name: "NVIDIA", price: 204.64, changePct: 55.3, volume: 1000, closes: [1, 2, 3], currency: "USD", rsi: 68.5 },
          { symbol: "^GSPC", name: "S&P 500", price: 5000, changePct: 0.5, volume: 1000, closes: [1, 2, 3], currency: "USD" },
        ] };
      }
      var list = assets.split(",");
      if (list.indexOf("VALE3.SA") !== -1) return { window: win, quotes: __b3Quotes(false) };
      return {
        window: win,
        quotes: [
          { symbol: "NVDA", name: "NVIDIA", price: 204.64, changePct: 55.3, volume: 1000, closes: [1, 2, 3], currency: "USD" },
          { symbol: "^GSPC", name: "S&P 500", price: 5000, changePct: 0.5, volume: 1000, closes: [1, 2, 3], currency: "USD" }
        ]
      };
    };
  `, sandbox);

  const source = fs.readFileSync(new URL('../assets/js/ticker-widget.js', import.meta.url), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'ticker-widget.js' });

  return {
    grid,
    legend,
    events,
    requests,
    intervals,
    buttons,
    sandbox,
    clickTab: (name) => tabs[name].click(),
    clickWindow: (name) => buttons[name].click(),
    tick5s: () => intervals[0].fn(),
    pendingRsi,
  };
}

// Cotações da B3 (preço/variação). O request de `1wk` é só do RSI e nunca
// alimenta card, então fica de fora.
function b3Requests(requests) {
  return requests.filter((item) => item.window !== '1wk' && item.assets.includes('VALE3.SA'));
}

function rsiRequests(requests) {
  return requests.filter((item) => item.window === '1wk');
}

function cardSegment(html, symbol) {
  const start = html.indexOf('data-tq="' + symbol + '"');
  assert.ok(start >= 0, 'card de ' + symbol + ' existe no grid');
  const cardStart = html.lastIndexOf('<div', start);
  const next = html.indexOf('data-tq="', start + 10);
  return html.slice(cardStart, next === -1 ? html.length : next);
}

describe('RSI semanal no Worker', () => {
  it('1. 1wk é janela interna: 5y de velas semanais e período 14', () => {
    const cfg = QUOTE_WINDOWS['1wk'];
    assert.ok(cfg, 'janela 1wk registrada');
    assert.equal(cfg.range, '5y');
    assert.equal(cfg.interval, '1wk');
    assert.equal(cfg.rsi, 14);
    assert.equal(cfg.windowMs, 7 * 24 * 60 * 60 * 1000);
    assert.equal(QUOTE_WINDOWS['1wk'].fallbacks, undefined, 'sem fallback silencioso para diário');
  });

  it('2. rsiWilder reproduz a série clássica de Wilder', () => {
    assert.equal(Number(rsiWilder(WILDER_CLOSES.slice(0, 15), 14).toFixed(2)), 70.46);
    assert.equal(Number(rsiWilder(WILDER_CLOSES, 14).toFixed(2)), 37.79);
  });

  it('3. rsiWilder exige period + 1 fechamentos', () => {
    assert.equal(rsiWilder(WILDER_CLOSES.slice(0, 14), 14), null);
    assert.equal(rsiWilder([], 14), null);
    assert.equal(rsiWilder(null, 14), null);
  });

  it('4. rsiWilder trata alta pura, série plana e buracos na série', () => {
    const ramp = Array.from({ length: 20 }, (_, i) => 10 + i);
    assert.equal(rsiWilder(ramp, 14), 100, 'sem perdas = 100');
    assert.equal(rsiWilder(new Array(20).fill(10), 14), null, 'sem ganho nem perda = null');
    const withNull = WILDER_CLOSES.slice();
    withNull[4] = null;
    assert.equal(rsiWilder(withNull, 14), null, 'null na série invalida');
    const withNaN = WILDER_CLOSES.slice();
    withNaN[4] = NaN;
    assert.equal(rsiWilder(withNaN, 14), null, 'NaN na série invalida');
  });

  it('5. rsiWilder cai em 14 quando o período é inválido', () => {
    assert.equal(Number(rsiWilder(WILDER_CLOSES, 0).toFixed(2)), 37.79);
    assert.equal(Number(rsiWilder(WILDER_CLOSES, 'x').toFixed(2)), 37.79);
  });

  it('6. computeQuote anexa rsi só quando a janela pede', () => {
    const raw = makeRaw(weeklyPoints(262));
    const withRsi = computeQuote(raw, 'VALE3.SA', QUOTE_WINDOWS['1wk'], NOW);
    assert.equal(typeof withRsi.rsi, 'number');
    assert.ok(Number.isFinite(withRsi.rsi));

    const withoutRsi = computeQuote(raw, 'VALE3.SA', QUOTE_WINDOWS['24h'], NOW);
    assert.equal('rsi' in withoutRsi, false, 'janelas de preço não carregam rsi');
  });

  it('7. RSI sai da série crua (262 velas), não do downsample de 40', () => {
    // Série semanal oscilante: o downsample espaça as amostras e desloca o RSI.
    const points = weeklyPoints(262).map((item, index) => ({
      ...item,
      close: 100 + Math.sin(index / 3) * 8 + Math.cos(index / 7) * 4 + index * 0.1,
    }));
    const quote = computeQuote(makeRaw(points), 'VALE3.SA', QUOTE_WINDOWS['1wk'], NOW);
    assert.equal(quote.closes.length, 40, 'closes do gráfico continuam reduzidos');
    assert.equal(
      quote.rsi,
      rsiWilder(points.map((item) => item.close), 14),
      'rsi usa a série completa',
    );
    // O RSI da série reduzida é diferente: é exatamente o erro que a janela evita.
    assert.notEqual(Number(rsiWilder(quote.closes.slice(), 14).toFixed(2)), Number(quote.rsi.toFixed(2)));
  });

  it('8. RSI é calculado antes do fillLastCandle', () => {
    const points = weeklyPoints(60);
    const withHole = points.map((item, index) => (index === points.length - 1 ? { ...item, close: null } : item));
    const meta = {
      regularMarketPrice: 999.99,
      regularMarketTime: ts('2026-10-30T18:00:00Z'),
    };
    const quote = computeQuote(makeRaw(withHole, meta), 'VALE3.SA', QUOTE_WINDOWS['1wk'], NOW);
    assert.equal(quote.price, 999.99, 'preço vivo preenche a última vela');
    assert.equal(
      quote.rsi,
      rsiWilder(points.slice(0, -1).map((item) => item.close), 14),
      'o ponto preenchido não entra no RSI',
    );
  });

  it('9. 1wk tem TTL próprio de 1h (não rebaixa tudo a cada minuto)', () => {
    assert.ok(WORKER_SRC.includes('const QUOTE_CACHE_TTL_1WK_MS = 60 * 60 * 1000;'));
    assert.ok(WORKER_SRC.includes('windowKey === "1wk"'));
  });

  it('10. 1wk nunca vira botão de janela na UI', () => {
    assert.equal(HTML_SRC.includes('data-window="1wk"'), false);
    assert.equal(HTML_SRC.includes('data-window=\\"1wk\\"'), false);
  });
});

describe('aba B3 no ticker', () => {
  it('11. lista fixa dos 8 papéis, todos com sufixo .SA', () => {
    assert.ok(TICKER_SRC.includes('var B3 = ['));
    for (const symbol of B3_SYMBOLS) {
      assert.ok(TICKER_SRC.includes('"' + symbol + '"'), 'lista contém ' + symbol);
    }
    const declared = TICKER_SRC.match(/var B3 = \[([\s\S]*?)\n  \];/);
    assert.ok(declared, 'bloco B3 declarado');
    assert.equal((declared[1].match(/sym: "/g) || []).length, 8, 'exatamente 8 papéis');
  });

  it('12. B3 busca os 8 ativos numa chamada própria', async () => {
    const { requests, clickTab } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    const calls = b3Requests(requests);
    assert.equal(calls.length, 1, 'uma chamada para a aba B3');
    assert.equal(calls[0].assets.split(',').length, 8);
    assert.ok(calls[0].assets.split(',').every((s) => s.endsWith('.SA')));
  });

  it('13. B3 não usa a lista de STOCKS nem depende do teto de 26', async () => {
    const { requests, clickTab } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    const calls = b3Requests(requests);
    assert.ok(calls.every((call) => !call.assets.includes('NVDA')), 'sem ativos de STOCKS');
    assert.ok(TICKER_SRC.includes('B3_ASSETS.join(",")'), 'usa a lista própria');
  });

  it('14. cards da B3 usam BRL, rótulo sem .SA e markup exato', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    const expected = '<div class="tq up1 has-rsi" data-tq="VALE3.SA"><b class="tqSym">VALE3</b>' +
      '<span class="tq-rsi tq-rsi-verde" role="img" title="RSI 14 semanal: 39 — Compra"' +
      ' aria-label="RSI 39 — Compra">39</span>' +
      '<span class="tqPct">+1,50%</span><strong class="tqPrice">R$ 60,00</strong></div>';
    assert.ok(grid.innerHTML.includes(expected), 'card VALE3 idêntico ao esperado');
    assert.equal(grid.innerHTML.includes('VALE3.SA</b>'), false, 'rótulo sem o sufixo .SA');
    assert.equal(grid.innerHTML.includes('NOME SUJO DA FONTE'), false, 'nome fixo do front, não o da fonte');
    assert.ok(grid.innerHTML.includes('R$ 38,42'), 'preço em reais');
  });

  it('15. cards da B3 não têm sino nem botão Graham e mantêm selo acessível', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    for (const symbol of B3_SYMBOLS) {
      const segment = cardSegment(grid.innerHTML, symbol);
      assert.equal(segment.includes('tq-bell'), false, symbol + ' sem sino');
      assert.equal(segment.includes('tq-graham'), false, symbol + ' sem Graham');
    }
    assert.ok(cardSegment(grid.innerHTML, 'VALE3.SA').includes('role="img"'), 'selo com role=img');
  });

  it('16. CRIPTO mantém o markup e STOCKS exibe RSI quando disponível', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    const btc = '<div class="tq up5" data-tq="BTC"><b class="tqSym">BTC</b>' +
      '<button class="tq-bell" data-bell="BTC" aria-label="Dispensar alerta" title="Dispensar alerta">&#128276;</button>' +
      '<span class="tqPct">+21,00%</span><strong class="tqPrice tq-sm">$ 121,00</strong></div>';
    assert.ok(grid.innerHTML.includes(btc), 'card CRIPTO inalterado');

    clickTab('stocks');
    await settle();
    const nvda = '<div class="tq up5 has-rsi" data-tq="NVDA"><b class="tqSym">NVDA</b>' +
      '<button class="tq-graham" data-graham="NVDA" aria-label="Ver preço justo de NVDA"' +
      ' title="Preço justo (Graham)">&#9878;</button>' +
      '<span class="tq-rsi tq-rsi-neutro" role="img" title="RSI 14 semanal: 68 — Neutro"' +
      ' aria-label="RSI 68 — Neutro">68</span>' +
      '<span class="tqPct">+55,30%</span><strong class="tqPrice">204,64</strong></div>';
    assert.ok(grid.innerHTML.includes(nvda), 'card STOCKS com RSI quando disponível');
    assert.equal(cardSegment(grid.innerHTML, '^GSPC').includes('tq-rsi'), false, 'sem selo quando RSI ausente');
  });

  it('17. selo usa o inteiro exibido para classificar a faixa', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    const cases = [
      ['VALE3.SA', 'verde', 39],
      ['PETR4.SA', 'amarelo', 40],
      ['ITUB4.SA', 'amarelo', 45],
      ['BBDC4.SA', 'neutro', 46],
      ['BPAC11.SA', 'neutro', 70],
      ['BBAS3.SA', 'vermelho', 71],
      ['WEGE3.SA', 'neutro', 70],
    ];
    for (const [symbol, band, shown] of cases) {
      const segment = cardSegment(grid.innerHTML, symbol);
      assert.ok(segment.includes('tq-rsi-' + band), symbol + ' na faixa ' + band);
      assert.ok(segment.includes('>' + shown + '</span>'), symbol + ' exibe ' + shown);
    }
  });

  it('18. selo ausente quando o RSI é null', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    const segment = cardSegment(grid.innerHTML, 'USIM5.SA');
    assert.equal(segment.includes('tq-rsi'), false, 'USIM5 sem selo');
    assert.equal(segment.includes('has-rsi'), false, 'USIM5 sem a classe has-rsi');
    assert.equal(grid.innerHTML.includes('>undefined<'), false);
  });

  it('19. selo tem role=img e aria-label com o inteiro e a faixa', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    const segment = cardSegment(grid.innerHTML, 'BBAS3.SA');
    assert.ok(segment.includes('role="img"'));
    assert.ok(segment.includes('aria-label="RSI 71 — Venda"'));
    assert.ok(segment.includes('title="RSI 14 semanal: 71 — Venda"'));
  });

  it('20. legenda aparece em B3 e STOCKS, mas não em CRIPTO', async () => {
    const { legend, clickTab } = mountTicker();
    await settle();
    assert.equal(legend.hidden, true, 'CRIPTO esconde a legenda');
    clickTab('stocks');
    await settle();
    assert.equal(legend.hidden, false, 'STOCKS mostra a legenda');
    clickTab('b3');
    await settle();
    assert.equal(legend.hidden, false, 'B3 mostra a legenda');
    clickTab('crypto');
    await settle();
    assert.equal(legend.hidden, true, 'volta a esconder');
    clickTab('stocks');
    await settle();
    assert.equal(legend.hidden, false, 'STOCKS volta a mostrar');
  });

  it('21. legenda é irmã do grid no HTML (não filha)', () => {
    const gridTag = HTML_SRC.indexOf('<div class="ticker-grid"');
    const legendTag = HTML_SRC.indexOf('<div class="tq-rsi-legend"');
    assert.ok(gridTag > 0, 'grid existe');
    assert.ok(legendTag > gridTag, 'legenda vem depois do grid');
    const between = HTML_SRC.slice(gridTag, legendTag);
    const opens = (between.match(/<div\b/g) || []).length;
    const closes = (between.match(/<\/div>/g) || []).length;
    assert.ok(opens > 0 && opens === closes, 'todas as divs do grid fecham antes da legenda');
  });

  it('21a. legenda usa os quatro rótulos novos e nenhum termo antigo', () => {
    assert.ok(HTML_SRC.includes('&lt;40 Compra'));
    assert.ok(HTML_SRC.includes('40–45 Atenção'));
    assert.ok(HTML_SRC.includes('&gt;45–70 Neutro'));
    assert.ok(HTML_SRC.includes('&gt;70 Venda'));
    assert.equal(HTML_SRC.includes('sobrevendido'), false);
    assert.equal(HTML_SRC.includes('sobrecomprado'), false);
  });

  it('21b. selo e bolinha RSI têm dimensões e estilo computados', async () => {
    const browser = await chromium.launch({
      headless: true,
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    });
    try {
      const page = await browser.newPage();
      await page.goto(new URL('../index.html', import.meta.url).href, { waitUntil: 'domcontentloaded' });
      const style = await page.evaluate(() => {
        const badge = document.createElement('span');
        badge.className = 'tq-rsi tq-rsi-verde';
        badge.textContent = '39';
        document.body.appendChild(badge);
        const card = document.createElement('div');
        card.className = 'tq has-rsi';
        const symbol = document.createElement('b');
        symbol.className = 'tqSym';
        card.appendChild(symbol);
        document.body.appendChild(card);
        const dot = document.createElement('i');
        dot.className = 'tq-rsi-dot tq-rsi-verde';
        document.body.appendChild(dot);
        const computed = getComputedStyle(badge);
        const symbolComputed = getComputedStyle(symbol);
        const dotComputed = getComputedStyle(dot);
        return {
          backgroundColor: computed.backgroundColor,
          color: computed.color,
          borderTopWidth: computed.borderTopWidth,
          borderRightWidth: computed.borderRightWidth,
          borderBottomWidth: computed.borderBottomWidth,
          borderLeftWidth: computed.borderLeftWidth,
          width: computed.width,
          height: computed.height,
          fontSize: computed.fontSize,
          fontWeight: computed.fontWeight,
          symbolPaddingRight: symbolComputed.paddingRight,
          dotWidth: dotComputed.width,
          dotHeight: dotComputed.height,
          dotBorderWidth: dotComputed.borderTopWidth,
          dotBackgroundColor: dotComputed.backgroundColor,
        };
      });
      assert.equal(style.backgroundColor, 'rgb(255, 255, 255)');
      assert.equal(style.color, 'rgb(0, 0, 0)');
      assert.deepEqual([
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ], ['4px', '4px', '4px', '4px']);
      assert.equal(style.width, '28px');
      assert.equal(style.height, '28px');
      assert.equal(style.fontSize, '10px');
      assert.equal(style.fontWeight, '800');
      assert.equal(style.symbolPaddingRight, '16px');
      assert.equal(style.dotWidth, '14px');
      assert.equal(style.dotHeight, '14px');
      assert.equal(style.dotBorderWidth, '3px');
      assert.equal(style.dotBackgroundColor, 'rgb(255, 255, 255)');
    } finally {
      await browser.close();
    }
  });

  it('22. 90D/1Y/3Y continuam disponíveis na B3', async () => {
    const { buttons, requests, clickTab, clickWindow } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    for (const win of ['90d', '1y', '3y']) {
      assert.equal(buttons[win].hidden, false, win + ' visível na B3');
    }
    clickWindow('3y');
    await settle();
    const last = b3Requests(requests).at(-1);
    assert.equal(last.window, '3y', 'B3 pede a janela de 3 anos');
    assert.equal(buttons['24h'].classList.contains('active'), false);
    assert.equal(buttons['3y'].classList.contains('active'), true);
  });

  it('23. RSI é buscado uma vez e sobrevive ao refresh de 5s', async () => {
    const { requests, clickTab, clickWindow, tick5s } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    assert.equal(rsiRequests(requests).length, 1, 'um request de 1wk');

    const before = b3Requests(requests).length;
    tick5s();
    await settle();
    tick5s();
    await settle();
    assert.equal(rsiRequests(requests).length, 1, 'refresh de 5s não rebate no 1wk');
    assert.ok(b3Requests(requests).length > before, 'mas as cotações foram atualizadas');

    clickWindow('7d');
    await settle();
    assert.equal(rsiRequests(requests).length, 1, 'trocar de janela não rebate no 1wk');
  });

  it('24. RSI é rebuscado depois de 1h', async () => {
    const { requests, sandbox, clickTab, tick5s } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    assert.equal(rsiRequests(requests).length, 1);

    sandbox.__now += 61 * 60 * 1000;
    tick5s();
    await settle();
    assert.equal(rsiRequests(requests).length, 2, 'memo vencido rebusca');
  });

  it('25. payload de janela errada não apaga o RSI anterior', async () => {
    const { grid, requests, sandbox, clickTab, tick5s } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    assert.ok(grid.innerHTML.includes('tq-rsi-verde'));

    sandbox.__payloadMode = 'wrongWindow';
    sandbox.__now += 61 * 60 * 1000;
    tick5s();
    await settle();
    assert.ok(rsiRequests(requests).length >= 2, 'tentou rebuscar');
    assert.ok(grid.innerHTML.includes('tq-rsi-verde'), 'selo anterior preservado');
  });

  it('26. B3 não emite estudebitcoin:ticker-price', async () => {
    const { events, clickTab } = mountTicker();
    await settle();
    events.length = 0;
    clickTab('b3');
    await settle();
    const leaked = events.filter((event) => event.type === 'estudebitcoin:ticker-price' &&
      String(event.detail && event.detail.symbol).endsWith('.SA'));
    assert.equal(leaked.length, 0, 'nenhum preço em BRL vaza para o portfólio');
  });

  it('27. STOCKS continua emitindo ticker-price', async () => {
    const { events, clickTab } = mountTicker();
    await settle();
    events.length = 0;
    clickTab('stocks');
    await settle();
    const nvda = events.filter((event) => event.type === 'estudebitcoin:ticker-price' &&
      event.detail && event.detail.symbol === 'NVDA');
    assert.ok(nvda.length >= 1, 'STOCKS segue transmitindo');
    assert.equal(nvda[0].detail.price, 204.64);
  });

  it('28. trocar de aba não mistura RSI com STOCKS', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    assert.ok(grid.innerHTML.includes('tq-rsi'));
    clickTab('stocks');
    await settle();
    assert.ok(grid.innerHTML.includes('tq-rsi'), 'STOCKS com seu próprio RSI');
    assert.ok(grid.innerHTML.includes('data-tq="NVDA"'), 'cards de STOCKS renderizados');
    assert.ok(cardSegment(grid.innerHTML, 'NVDA').includes('tq-rsi-neutro'), 'RSI próprio de STOCKS');
    assert.equal(cardSegment(grid.innerHTML, 'NVDA').includes('tq-rsi-verde'), false, 'não usa RSI da B3');
  });

  it('29. janela ativa é preservada ao entrar na B3', async () => {
    const { requests, clickTab, clickWindow } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    clickWindow('1y');
    await settle();
    clickTab('b3');
    await settle();
    const last = b3Requests(requests).at(-1);
    assert.equal(last.window, '1y', 'B3 herda a janela permitida');
  });

  it('30. voltar para CRIPTO reseta janela longa', async () => {
    const { buttons, clickTab, clickWindow } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    clickWindow('3y');
    await settle();
    clickTab('crypto');
    await settle();
    assert.equal(buttons['3y'].hidden, true, '3Y oculto em CRIPTO');
    assert.equal(buttons['24h'].classList.contains('active'), true, 'volta para 24h');
  });

  it('31. STOCKS faz chamada semanal window=1wk ao ser ativada', async () => {
    const { requests, clickTab } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    assert.equal(rsiRequests(requests).length, 1);
  });

  it('32. chamada semanal de STOCKS contém os 24 símbolos atuais', async () => {
    const { requests, clickTab } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    const rsiReq = rsiRequests(requests)[0];
    assert.ok(rsiReq);
    const symbols = rsiReq.assets.split(',');
    assert.equal(symbols.length, 24);
    assert.ok(symbols.includes('NVDA'));
    assert.ok(symbols.includes('^GSPC'));
    assert.equal(symbols.includes('VALE3.SA'), false);
  });

  it('33. nenhuma chamada semanal excede 26 ativos', async () => {
    const { requests, clickTab } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    clickTab('stocks');
    await settle();
    for (const request of rsiRequests(requests)) assert.ok(request.assets.split(',').length <= 26);
  });

  it('34. cards STOCKS com RSI numérico exibem selo', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    const segment = cardSegment(grid.innerHTML, 'NVDA');
    assert.ok(segment.includes('tq-rsi'));
    assert.ok(segment.includes('has-rsi'));
  });

  it('35. cards STOCKS sem RSI não exibem selo', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    const segment = cardSegment(grid.innerHTML, '^GSPC');
    assert.equal(segment.includes('tq-rsi'), false);
    assert.equal(segment.includes('has-rsi'), false);
  });

  it('36. STOCKS usa seus próprios valores de RSI', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    const segment = cardSegment(grid.innerHTML, 'NVDA');
    assert.ok(segment.includes('>68</span>'));
    assert.ok(segment.includes('tq-rsi-neutro'));
  });

  it('37. RSI de B3 não aparece em STOCKS', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    clickTab('stocks');
    await settle();
    assert.equal(cardSegment(grid.innerHTML, 'NVDA').includes('>39</span>'), false);
    assert.equal(cardSegment(grid.innerHTML, 'NVDA').includes('>71</span>'), false);
  });

  it('38. RSI de STOCKS não aparece em B3', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    clickTab('b3');
    await settle();
    assert.equal(grid.innerHTML.includes('data-tq="NVDA"'), false);
    assert.equal(cardSegment(grid.innerHTML, 'VALE3.SA').includes('>68</span>'), false);
  });

  it('39. memo de B3 e STOCKS é independente', async () => {
    const { requests, clickTab, tick5s } = mountTicker();
    await settle();
    clickTab('b3');
    await settle();
    assert.equal(rsiRequests(requests).length, 1);
    clickTab('stocks');
    await settle();
    assert.equal(rsiRequests(requests).length, 2);
    tick5s();
    await settle();
    assert.equal(rsiRequests(requests).length, 2);
  });

  it('40. refresh de 5s não repete chamada semanal válida de STOCKS', async () => {
    const { requests, clickTab, tick5s } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    tick5s();
    tick5s();
    await settle();
    assert.equal(rsiRequests(requests).length, 1);
  });

  it('41. após expirar TTL, nova chamada semanal de STOCKS é permitida', async () => {
    const { requests, sandbox, clickTab, tick5s } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    sandbox.__now += 61 * 60 * 1000;
    tick5s();
    await settle();
    assert.equal(rsiRequests(requests).length, 2);
  });

  it('42. legenda aparece em STOCKS', async () => {
    const { legend, clickTab } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    assert.equal(legend.hidden, false);
  });

  it('43. legenda permanece escondida em CRIPTO', async () => {
    const { legend, clickTab } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    clickTab('crypto');
    await settle();
    assert.equal(legend.hidden, true);
  });

  it('44. CRIPTO continua sem selo', async () => {
    const { grid } = mountTicker();
    await settle();
    assert.equal(grid.innerHTML.includes('tq-rsi'), false);
  });

  it('45. STOCKS continua emitindo estudebitcoin:ticker-price', async () => {
    const { events, clickTab } = mountTicker();
    await settle();
    events.length = 0;
    clickTab('stocks');
    await settle();
    assert.ok(events.some((event) => event.type === 'estudebitcoin:ticker-price' && event.detail?.symbol === 'NVDA'));
  });

  it('46. STOCKS continua exibindo o botão Graham', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    assert.ok(grid.innerHTML.includes('tq-graham'));
    assert.ok(grid.innerHTML.includes('data-graham="NVDA"'));
  });

  it('47. chamadas semanais simultâneas de STOCKS são deduplicadas enquanto pendentes', async () => {
    const { requests, sandbox, clickTab, tick5s, pendingRsi } = mountTicker();
    sandbox.__pendingRsi = true;
    await settle();
    clickTab('stocks');
    tick5s();
    tick5s();
    await settle();
    assert.equal(rsiRequests(requests).length, 1);
    assert.equal(typeof pendingRsi.resolve, 'function');
    pendingRsi.resolve();
    await settle();
    assert.ok(rsiRequests(requests).length === 1);
  });

  it('48. B3 continua sem botão Graham após visitar STOCKS', async () => {
    const { grid, clickTab } = mountTicker();
    await settle();
    clickTab('stocks');
    await settle();
    clickTab('b3');
    await settle();
    assert.equal(grid.innerHTML.includes('tq-graham'), false);
  });

  it('49. B3 pulsa cards com RSI semanal abaixo de 25', async () => {
    const { grid, sandbox, clickTab } = mountTicker();
    sandbox.__payloadMode = 'lowStocks';
    await settle();
    clickTab('b3');
    await settle();
    assert.ok(cardSegment(grid.innerHTML, 'VALE3.SA').includes('rsi-low-pulse'), 'pulso exclusivo da B3');
  });

  it('50. STOCKS pulsa cards com RSI semanal abaixo de 31', async () => {
    const { grid, sandbox, clickTab } = mountTicker();
    sandbox.__payloadMode = 'lowStocks';
    await settle();
    clickTab('stocks');
    await settle();
    assert.ok(cardSegment(grid.innerHTML, 'NVDA').includes('rsi-low-pulse'), 'STOCKS com pulso');
  });

  it('51. pulso RSI é limitado a 20 ciclos e não reinicia indefinidamente', () => {
    assert.ok(TICKER_SRC.includes('RSI_LOW_PULSE_LIMIT = 20'));
    assert.ok(TICKER_SRC.includes('b3: 25, stocks: 31'));
    assert.ok(HTML_SRC.includes('tq-rsi-low-pulse 1.4s ease-in-out 20'));
    assert.ok(TICKER_SRC.includes('animationiteration'));
    assert.ok(TICKER_SRC.includes('animationend'));
  });
});
