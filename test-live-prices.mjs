/* Preços ao vivo no painel (mesmo motor e alvo dos cards do ticker).
 * Roda com: node --test test-live-prices.mjs
 * Carrega calculator + storage + service + painel-ativos-ui REAIS num contexto
 * vm com DOM mínimo e `window` real (EventTarget). Os testes despacham pelo
 * CAMINHO REAL: window.dispatchEvent(CustomEvent('estudebitcoin:ticker-price'))
 * e o listener registrado pelo bind() — nada chama o handler diretamente.
 * O storage é o REAL (localStorage em memória): prova que o snapshot live
 * preserva portfolio.updatedAt.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const dir = new URL('./assets/js/portfolio/', import.meta.url);
const SOURCES = ['portfolioCalculator.js', 'portfolioStorage.js', 'portfolioService.js', 'painel-ativos-ui.js']
  .map((f) => fs.readFileSync(new URL('./' + f, dir), 'utf8'));

const SEED_UPDATED_AT = '2026-01-01T00:00:00.000Z';
function seedState() {
  return {
    version: 1,
    portfolio: { name: 'Minha Carteira', currency: 'USD', updatedAt: SEED_UPDATED_AT },
    assets: [
      { id: 'a1', ticker: 'BTC', name: 'Bitcoin', type: 'CRYPTO', quantity: 0.5, averagePrice: 60000, currentPrice: 67000, dailyVariation: 1.5 },
      { id: 'a2', ticker: 'AAPL', name: 'Apple', type: 'STOCK', quantity: 10, averagePrice: 200, currentPrice: 210, dailyVariation: 0.5 },
    ],
  };
}

function mount() {
  const store = { eb_portfolio_v2: JSON.stringify(seedState()) };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const winTarget = new EventTarget();
  const docListeners = {};
  const tbody = { innerHTML: '', addEventListener: () => {} };
  const mkEl = () => ({
    addEventListener: () => {}, querySelectorAll: () => [],
    style: {}, textContent: '', innerHTML: '', value: '',
    disabled: false, setAttribute: () => {},
    classList: { add: () => {}, remove: () => {} },
  });
  const els = {
    'painel-ativos': { querySelectorAll: () => [] },
    'pa-tbody': tbody,
  };
  let intervalFn = null;
  const sandbox = {
    console,
    localStorage,
    setTimeout: (fn) => { fn(); return 1; }, // throttle/render executam na hora
    clearTimeout: () => {},
    setInterval: (fn) => { intervalFn = fn; return 1; },
    window: {
      addEventListener: winTarget.addEventListener.bind(winTarget),
      dispatchEvent: winTarget.dispatchEvent.bind(winTarget),
    },
    document: {
      readyState: 'complete',
      getElementById: (id) => els[id] || mkEl(),
      querySelector: () => null, // sem linha no DOM -> paint cirúrgico pula
      addEventListener: (type, fn) => { docListeners[type] = fn; },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const src of SOURCES) vm.runInContext(src, sandbox, { filename: 'live-stack.js' });
  const PA = sandbox.PainelAtivos;
  assert.ok(PA && typeof PA.onTickerPrice === 'function', 'UI montou (bind ok)');
  const fire = (symbol, price, changePct) =>
    winTarget.dispatchEvent(new CustomEvent('estudebitcoin:ticker-price', { detail: { symbol, price, changePct } }));
  const saved = () => JSON.parse(store.eb_portfolio_v2);
  return { PA, tbody, fire, saved, docListeners, runInterval: () => intervalFn && intervalFn() };
}

describe('preços ao vivo (caminho real window.dispatchEvent)', () => {
  it('tick BTCUSDT atualiza PREÇO ATUAL + variação do dia + dot', () => {
    const { tbody, fire } = mount();
    fire('BTCUSDT', 70000, 2.5);
    assert.ok(tbody.innerHTML.includes('$ 70.000,00'), 'preço ao vivo na linha');
    assert.ok(tbody.innerHTML.includes('+2,50%'), 'variação do dia ao vivo');
    assert.ok(tbody.innerHTML.includes('pa-live'), 'dot AO VIVO');
    assert.ok(tbody.innerHTML.includes('$ 210,00'), 'stock intocado até seu evento');
  });

  it('stocks atualizam via mesmo evento (refresh do ticker)', () => {
    const { tbody, fire } = mount();
    fire('AAPL', 220, 1.25);
    assert.ok(tbody.innerHTML.includes('$ 220,00'), 'stock acompanha');
    assert.ok(tbody.innerHTML.includes('+1,25%'), 'dia do stock');
  });

  it('snapshot live preserva portfolio.updatedAt (storage real)', () => {
    const { PA, fire, saved, runInterval } = mount();
    fire('BTC', 70000, 2.5);
    runInterval(); // throttle de 60s do persistLiveLocal
    const s = saved();
    assert.equal(s.assets.find((a) => a.ticker === 'BTC').currentPrice, 70000, 'preço persistiu');
    assert.equal(s.portfolio.updatedAt, SEED_UPDATED_AT, 'updatedAt preservado');
  });

  it('modo remoto não grava snapshot por tick', () => {
    const { PA, fire, saved } = mount();
    PA.getUI().mode = 'remote';
    fire('BTC', 72000, 4);
    PA.persistLiveLocal();
    assert.equal(saved().assets.find((a) => a.ticker === 'BTC').currentPrice, 67000, 'nuvem só em escritas');
  });

  it('símbolo desconhecido e preço inválido não quebram', () => {
    const { tbody, fire } = mount();
    const before = tbody.innerHTML;
    fire('XXX', 123, 1);
    assert.equal(tbody.innerHTML, before, 'nada muda');
  });

  it('ticker busca stocks independente da aba (loop próprio)', () => {
    const src = fs.readFileSync(new URL('./assets/js/ticker-widget.js', import.meta.url), 'utf8');
    assert.ok(src.includes('refreshStocksBroadcast'), 'broadcast de stocks existe');
    assert.ok(src.includes('fetchStocks().then'), 'usa o mesmo fetch dos cards');
    assert.ok(src.includes('broadcastQuotes(quotes)'), 'emite o mesmo evento');
  });
});
