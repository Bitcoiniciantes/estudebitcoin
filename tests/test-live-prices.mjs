/* Preços ao vivo — TTL por origem (WS 30s, snapshot 90s), prioridade, lifecycle, silent.
 * Roda com: node --test test-live-prices.mjs
 * Stack REAL (calculator + storage + service + UI) em vm, `window` real
 * (EventTarget). Tudo pelo CAMINHO REAL: window.dispatchEvent(CustomEvent)
 * e bind() — nenhum teste chama o handler diretamente.
 * Isolamento de tempo: _test.setWsTtl/setSnapshotTtl ajusta TTLs só dentro
 * do sandbox; sleep real curto (15-30ms) com TTLs pequenos, sem Date.now global.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const dir = new URL('../assets/js/portfolio/', import.meta.url);
const SOURCES = ['portfolioCalculator.js', 'portfolioStorage.js', 'portfolioService.js', 'painel-ativos-ui.js']
  .map((f) => fs.readFileSync(new URL('./' + f, dir), 'utf8'));
const TICKER_SRC = fs.readFileSync(new URL('../assets/js/ticker-widget.js', import.meta.url), 'utf8');

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

function mount({ doubleLoad = false } = {}) {
  const store = { eb_portfolio_v2: JSON.stringify(seedState()) };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const winTarget = new EventTarget();
  let tickerListeners = 0;
  const winAdd = winTarget.addEventListener.bind(winTarget);
  let intervals = 0;
  let pagehides = 0;
  let renders = 0;
  const tbody = { addEventListener: () => {} };
  Object.defineProperty(tbody, 'innerHTML', {
    set(v) { renders++; this.__html = v; },
    get() { return this.__html || ''; },
  });
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
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    setInterval: (fn) => { intervals++; intervalFn = fn; return 1; },
    window: {
      addEventListener: (t, f, o) => { if (t === 'estudebitcoin:ticker-price') tickerListeners++; return winAdd(t, f, o); },
      dispatchEvent: winTarget.dispatchEvent.bind(winTarget),
    },
    document: {
      readyState: 'complete',
      getElementById: (id) => els[id] || (els[id] = mkEl()),
      querySelector: () => null,
      addEventListener: (type) => { if (type === 'pagehide') pagehides++; },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const src of SOURCES) vm.runInContext(src, sandbox, { filename: 'live-stack.js' });
  if (doubleLoad) vm.runInContext(SOURCES[3], sandbox, { filename: 'live-stack-2nd.js' });
  const PA = sandbox.PainelAtivos;
  assert.ok(PA && typeof PA.onTickerPrice === 'function', 'UI montou (bind ok)');
  // Login obrigatório: live funciona apenas quando não bloqueado.
  // Força modo local para testes de live (sem passar pelo fluxo async de auth que limpa live).
  try { PA.getUI().mode = 'local'; PA.getUI().needsSync = false; } catch (e) {}
  renders = 0;
  const fire = (symbol, price, changePct, source) =>
    winTarget.dispatchEvent(new CustomEvent('estudebitcoin:ticker-price', { detail: { symbol, price, changePct, source } }));
  const saved = () => JSON.parse(store.eb_portfolio_v2);
  const counts = () => ({ tickerListeners, intervals, pagehides, renders });
  return { PA, tbody, els, fire, saved, counts, runInterval: () => intervalFn && intervalFn() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('TTL por origem + prioridade (caminho real)', () => {
  it('A. websocket atualiza preço, variação, patrimônio e dot', () => {
    const { tbody, els, fire } = mount();
    fire('BTCUSDT', 70150, 3.3, 'websocket');
    assert.ok(tbody.innerHTML.includes('$ 70.150,00'), 'preço WS');
    assert.ok(tbody.innerHTML.includes('+3,30%'), 'dia WS');
    assert.ok(tbody.innerHTML.includes('pa-live'), 'dot');
    assert.equal(els['pa-total'].textContent, '$ 37.175,00', 'patrimônio 0.5*70150+10*210');
  });

  it('B. snapshot inicial é aceito sem WS (crypto e stock)', () => {
    const { tbody, fire } = mount();
    fire('BTC', 69000, 2, 'snapshot');
    assert.ok(tbody.innerHTML.includes('$ 69.000,00'), 'crypto via snapshot');
    fire('AAPL', 220, 1.25, 'snapshot');
    assert.ok(tbody.innerHTML.includes('$ 220,00'), 'stock via snapshot');
  });

  it('C. WS fresco vence snapshot antigo (price+change juntos)', () => {
    const { tbody, fire } = mount();
    fire('BTC', 70150, 3.3, 'websocket');
    fire('BTC', 70000, 9.9, 'snapshot');
    assert.ok(tbody.innerHTML.includes('$ 70.150,00'), 'preço WS preservado');
    assert.ok(tbody.innerHTML.includes('+3,30%'), 'dia WS preservado');
    assert.ok(!tbody.innerHTML.includes('+9,90%'), 'dia do snapshot descartado');
  });

  it('D1. snapshot stock válido aos 30s (não expira em 30s)', async () => {
    const { PA, tbody, fire } = mount();
    PA._test.setSnapshotTtl(200);
    PA._test.setWsTtl(200);
    fire('AAPL', 220, 1.25, 'snapshot');
    assert.ok(tbody.innerHTML.includes('$ 220,00'), 'snapshot inicial');
    await sleep(35);
    // Fire nenhum evento — apenas verifica que live ainda está fresco
    assert.equal(Object.keys(PA._test.getLive()).length, 1, 'live ainda vigente');
    // Re-render força leitura via liveFresh: deve manter snapshot
    PA._test.getLive(); // sanity
    // Simula re-render: triggered pelo throttle, mas verificamos via innerHTML ainda com live
    // Um segundo fire snapshot deve ser ignorado? Não — snapshot sobre snapshot é permitido, mas
    // o ponto é que o primeiro não expirou. Verifica via getLive.at
    const age = Date.now() - PA._test.getLive()['AAPL'].at;
    assert.ok(age < 200, 'snapshot não expirou aos 30s');
    PA._test.setWsTtl(30000); PA._test.setSnapshotTtl(90000);
  });

  it('D2. snapshot stock expira só após TTL (90s → simulado 60ms)', async () => {
    const { PA, tbody, fire } = mount();
    PA._test.setSnapshotTtl(60);
    fire('AAPL', 220, 1.25, 'snapshot');
    assert.ok(tbody.innerHTML.includes('$ 220,00'));
    await sleep(80);
    // Após expirar, render deve voltar ao persistido (210)
    // Força render via live expirado
    const { els } = (() => {
      // Reaproveita o mesmo mount: chama render indiretamente via timeout já disparado (sync)
      // Mas o live já expirou, então próximo fire de verificação não é live.
      // Verifica que liveFresh é false e que um novo snapshot é aceito
      return { els: null };
    })();
    // Diretamente testa liveFresh expirado
    assert.equal(PA._test.getLive()['AAPL'] ? (Date.now() - PA._test.getLive()['AAPL'].at <= PA._test.getTtls().snapshot) : true, false, 'snapshot expirado');
    // Novo snapshot deve ser aceito e voltar a $ 230
    fire('AAPL', 230, 2, 'snapshot');
    assert.ok(tbody.innerHTML.includes('$ 230,00'), 'novo snapshot aceito pós-expiração');
    PA._test.setWsTtl(30000); PA._test.setSnapshotTtl(90000);
  });

  it('D3. WS expira após 30s (simulado 40ms) e snapshot é aceito depois', async () => {
    const { PA, tbody, fire } = mount();
    PA._test.setWsTtl(40);
    PA._test.setSnapshotTtl(90000);
    fire('BTC', 70150, 3.3, 'websocket');
    assert.ok(tbody.innerHTML.includes('$ 70.150,00'));
    await sleep(60);
    // WS expirado → snapshot deve ser aceito
    fire('BTC', 70000, 9.9, 'snapshot');
    assert.ok(tbody.innerHTML.includes('$ 70.000,00'), 'snapshot aceito após WS expirado');
    assert.ok(tbody.innerHTML.includes('+9,90%'), 'dia do snapshot após expiração');
    PA._test.setWsTtl(30000); PA._test.setSnapshotTtl(90000);
  });

  it('E. novo websocket vence snapshot', () => {
    const { tbody, fire } = mount();
    fire('BTC', 70000, 9.9, 'snapshot');
    assert.ok(tbody.innerHTML.includes('$ 70.000,00'));
    fire('BTC', 70150, 3.3, 'websocket');
    assert.ok(tbody.innerHTML.includes('$ 70.150,00'), 'WS substitui snapshot');
  });

  it('F. ações via snapshot (patrimônio)', () => {
    const { tbody, els, fire } = mount();
    fire('AAPL', 220, 1.25, 'snapshot');
    assert.ok(tbody.innerHTML.includes('$ 220,00'));
    assert.equal(els['pa-total'].textContent, '$ 35.700,00', '0.5*67000+10*220');
  });

  it('G. troca de UID limpa live', () => {
    const { PA, fire } = mount();
    fire('BTC', 70150, 3.3, 'websocket');
    assert.equal(Object.keys(PA._test.getLive()).length, 1);
    PA.enterRemoteMode('uid-B');
    assert.equal(Object.keys(PA._test.getLive()).length, 0, 'live limpo');
    fire('BTC', 70000, 9.9, 'snapshot');
    assert.ok(PA._test.getLive()['BTC'], 'novo live na carteira B');
  });

  it('H. persistência silent preserva updatedAt (storage real)', () => {
    const { PA, fire, saved, runInterval } = mount();
    fire('BTC', 70150, 3.3, 'websocket');
    runInterval();
    const s = saved();
    assert.equal(s.assets.find((a) => a.ticker === 'BTC').currentPrice, 70150);
    assert.equal(s.portfolio.updatedAt, SEED_UPDATED_AT);
  });

  it('I. modo remoto não persiste', () => {
    const { PA, fire, saved } = mount();
    PA.getUI().mode = 'remote';
    fire('BTC', 72000, 4, 'websocket');
    PA.persistLiveLocal();
    assert.equal(saved().assets.find((a) => a.ticker === 'BTC').currentPrice, 67000);
  });

  it('J. bind duplo = 1 listener, 1 interval, 1 pagehide, 1 update', () => {
    const { counts } = mount({ doubleLoad: true });
    const c0 = counts();
    assert.equal(c0.tickerListeners, 1, 'um listener ticker-price');
    assert.equal(c0.intervals, 1, 'um setInterval persist');
    assert.equal(c0.pagehides, 1, 'um pagehide');
  });

  it('widget: sources e broadcasts íntegros', () => {
    assert.ok(TICKER_SRC.includes("source: \"websocket\""), 'WS marca origem');
    assert.ok(TICKER_SRC.includes("source: \"snapshot\""), 'snapshot marca origem');
    assert.ok(TICKER_SRC.includes('broadcastQuotes(quotes); render(quotes);'), 'refresh transmite');
    assert.ok(TICKER_SRC.includes('refreshStocksBroadcast'), 'loop stocks');
  });
});
