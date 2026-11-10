/* Login obrigatório — amostra visual sem sessão autenticada.
 * Roda com: node --test test-login-mandatory.mjs
 * Verifica boot em vm real com mocks de EstudeAuth/FirebasePortfolio.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const dir = new URL('../assets/js/portfolio/', import.meta.url);
const SOURCES = ['portfolioCalculator.js', 'portfolioStorage.js', 'portfolioService.js', 'painel-ativos-ui.js']
  .map((f) => fs.readFileSync(new URL('./' + f, dir), 'utf8'));

function mountAuth({ user, whenReadyUser = user, remoteAssets = [], loadResult = null }) {
  const store = { eb_portfolio_v2: JSON.stringify({ version: 1, portfolio: { name: 't', currency: 'USD', updatedAt: null }, assets: [{ id: 'a1', ticker: 'BTC', name: 'Bitcoin', type: 'CRYPTO', quantity: 0.5, averagePrice: 60000, currentPrice: 67000, dailyVariation: 1.5 }] }) };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); localStorage.writes++; },
    removeItem: (k) => { delete store[k]; },
    _store: store,
    writes: 0,
  };
  const winTarget = new EventTarget();
  let tickerListeners = 0;
  const els = {};
  const mkEl = (overrides = {}) => ({
    addEventListener(type, fn) { (this._events ||= {})[type] = fn; }, querySelectorAll: () => [], style: {}, textContent: '', innerHTML: '', value: '', disabled: false, setAttribute: () => {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} }, ...overrides
  });
  // Pre-create critical els with full mock
  els['painel-ativos'] = mkEl({ querySelectorAll: () => [] });
  els['pa-mode-badge'] = mkEl({ textContent: '', title: '' });
  els['pa-locked'] = mkEl({ style: {} });
  els['pa-demo-notice'] = mkEl({ style: {} });
  els['pa-auth-hint'] = mkEl({ textContent: '' });
  els['pa-count-sub'] = mkEl({ textContent: '' });
  els['pa-add-toggle'] = mkEl({ style: {} });
  els['pa-login-cta'] = mkEl({});
  els['pa-form-wrap'] = mkEl({ style: {} });
  els['pa-form-close'] = mkEl({});
  els['pa-submit'] = mkEl({});
  els['pa-cancel-edit'] = mkEl({});
  els['pa-tbody'] = mkEl({ innerHTML: '' });
  els['pa-empty'] = mkEl({ style: {} });
  els['pa-table-wrap'] = mkEl({ style: {} });
  els['pa-tfoot'] = mkEl({ style: {} });
  els['pa-total'] = mkEl({ textContent: '' });
  els['pa-count'] = mkEl({ textContent: '' });
  els['pa-pl'] = mkEl({ textContent: '', className: '' });
  els['pa-pl-sub'] = mkEl({ textContent: '', className: '' });
  els['pa-day'] = mkEl({ textContent: '', className: '' });
  els['pa-sum-invested'] = mkEl({ textContent: '' });
  els['pa-sum-current'] = mkEl({ textContent: '' });
  els['pa-sum-pl'] = mkEl({ textContent: '', className: '' });
  els['pa-sum-day'] = mkEl({ textContent: '', className: '' });
  els['pa-updated'] = mkEl({ textContent: '' });
  els['pa-demo-badge'] = mkEl({ style: {} });
  els['pa-clear-demo'] = mkEl({ style: {} });
  els['pa-empty-add'] = mkEl({});
  els['pa-refresh-quote'] = mkEl({});
  els['pa-type-crypto'] = mkEl({});
  els['pa-type-stock'] = mkEl({});
  els['pa-side-buy'] = mkEl({});
  els['pa-side-sell'] = mkEl({});
  els['pa-f-ticker'] = mkEl({ value: '' });
  els['pa-f-name'] = mkEl({ value: '' });
  els['pa-f-qty'] = mkEl({ value: '' });
  els['pa-f-avg'] = mkEl({ value: '' });
  els['pa-f-cur'] = mkEl({ value: '' });
  els['pa-f-day'] = mkEl({ value: '' });
  els['pa-quote-src'] = mkEl({ textContent: '' });
  els['pa-merge-info'] = mkEl({ style: {}, textContent: '' });
  els['pa-err'] = mkEl({ textContent: '' });
  els['pa-sort'] = mkEl({ value: 'value_desc', addEventListener: () => {} });
  els['pa-donut-svg'] = mkEl({ innerHTML: '' });
  els['pa-donut-top'] = mkEl({ textContent: '' });
  els['pa-donut-sub'] = mkEl({ textContent: '' });
  els['pa-legend'] = mkEl({ innerHTML: '' });
  els['pa-ico-pl'] = mkEl({ className: '' });
  els['pa-ico-day'] = mkEl({ className: '' });
  els['pa-foot-current'] = mkEl({ textContent: '' });
  els['pa-foot-pl'] = mkEl({ textContent: '', className: '' });
  els['pa-foot-day'] = mkEl({ textContent: '', className: '' });

  let authUser = user;
  let ensureAnonymousCalled = false;
  let signInAnonymouslyCalled = false;
  let loadCalled = 0;
  let lastLoadUid = null;

  const fakeAuth = {
    whenReady: () => Promise.resolve(whenReadyUser),
    getUser: () => authUser,
    onAuthChange: (fn) => { fakeAuth._onAuth = fn; return fn; },
    ensureAnonymous: () => { ensureAnonymousCalled = true; return Promise.resolve(authUser); },
    openModal: () => { fakeAuth._openModal = (fakeAuth._openModal || 0) + 1; },
    _trigger: (u) => { authUser = u; if (fakeAuth._onAuth) fakeAuth._onAuth(u); }
  };
  const fakeFirebase = {
    isConfigured: () => true,
    warmup: () => true,
    coolDown: () => true,
    friendlyError: (e) => String(e && e.message || e),
    load: () => { loadCalled++; lastLoadUid = authUser && authUser.id; return loadResult ? loadResult() : Promise.resolve({ assets: remoteAssets, portfolio: { currency: 'USD' } }); },
    migrateLocal: () => Promise.resolve({ status: 'empty' }),
    add: () => Promise.resolve({ status: 'ok' }),
    update: () => Promise.resolve({ status: 'ok' }),
    remove: () => Promise.resolve({ status: 'ok' }),
    currentUid: () => authUser && authUser.id,
  };
  // Track signInAnonymously if ever called via firebase directly
  const fakeFirebaseAuth = {
    signInAnonymously: () => { signInAnonymouslyCalled = true; return Promise.resolve({ user: { uid: 'anon123', isAnonymous: true } }); }
  };

  const sandbox = {
    console,
    localStorage,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    setInterval: () => 1,
    window: {
      addEventListener: (t, f, o) => { if (t === 'estudebitcoin:ticker-price') tickerListeners++; },
      dispatchEvent: () => true,
      confirm: () => false,
    },
    document: {
      readyState: 'complete',
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') fn(); },
      getElementById: (id) => els[id] || mkEl(),
      querySelector: (sel) => {
        if (sel.includes('.pa-toolbar')) return { style: {} };
        if (sel.includes('.pa-grid')) return { style: {} };
        return null;
      },
      createElement: () => mkEl(),
    },
    BI: { normalizeSymbol: (s) => String(s).trim().toUpperCase().replace(/USDT$/, '') },
    firebase: { auth: () => fakeFirebaseAuth },
  };
  sandbox.globalThis = sandbox;
  sandbox.BI_CONFIG = { firebase: { apiKey: 'k', authDomain: 'd', databaseURL: 'https://x' } };
  // Predefine globals for auth/portfolio
  sandbox.EstudeAuth = fakeAuth;
  sandbox.FirebasePortfolio = fakeFirebase;
  // Also via globalThis for getRoot()
  sandbox.window.EstudeAuth = fakeAuth;
  sandbox.window.FirebasePortfolio = fakeFirebase;

  vm.createContext(sandbox);
  for (const src of SOURCES) vm.runInContext(src, sandbox, { filename: 'painel.js' });

  // Allow async boot to settle (whenReady microtask)
  return new Promise((resolve) => setTimeout(() => {
    const PA = sandbox.PainelAtivos;
    resolve({
      PA, els, sandbox, store, localStorage,
      getCalls: () => ({ ensureAnonymousCalled, signInAnonymouslyCalled, loadCalled, lastLoadUid, tickerListeners }),
      triggerAuth: (u) => fakeAuth._trigger(u),
      fakeAuth, fakeFirebase
    });
  }, 20));
}

describe('login obrigatório', () => {
  it('sem sessão não cria usuário anônimo', async () => {
    const { getCalls, store } = await mountAuth({ user: null, whenReadyUser: null });
    const c = getCalls();
    assert.equal(c.ensureAnonymousCalled, false, 'não chama ensureAnonymous');
    assert.equal(c.signInAnonymouslyCalled, false, 'não chama signInAnonymously');
    // não apaga storage anonimo existente, não migra
    assert.ok(store.eb_portfolio_v2, 'localStorage preservado');
  });

  it('sem sessão mostra somente BTC e NVDA ilustrativos, sem gravar', async () => {
    const { PA, els, localStorage, getCalls } = await mountAuth({ user: null, whenReadyUser: null });
    assert.equal(PA.getUI().mode, 'demo');
    assert.equal(els['pa-mode-badge'].textContent, 'EXEMPLO');
    assert.equal(els['pa-auth-hint'].textContent, 'Carteira ilustrativa. Entre para criar e acompanhar a sua.');
    assert.equal(els['pa-demo-notice'].style.display, '');
    assert.equal(els['pa-add-toggle'].style.display, '');
    assert.equal(els['pa-count'].textContent, '2');
    assert.equal(els['pa-count-sub'].textContent, '2 ativos ilustrativos');
    assert.equal(els['pa-sum-invested'].textContent, '$ 7.300,00');
    assert.equal(els['pa-sum-current'].textContent, '$ 7.640,00');
    assert.match(els['pa-sum-pl'].textContent, /\+\$ 340,00.*4,66%/);
    assert.match(els['pa-sum-day'].textContent, /-\$ 66,20/);
    assert.equal((els['pa-tbody'].innerHTML.match(/<tr>/g) || []).length, 2);
    assert.match(els['pa-tbody'].innerHTML, /BTC/);
    assert.match(els['pa-tbody'].innerHTML, /NVDA/);
    assert.doesNotMatch(els['pa-tbody'].innerHTML, /data-act=/);
    assert.equal(els['pa-updated'].textContent, '');
    assert.equal(PA.getService(), null);
    assert.equal(localStorage.writes, 0);
    assert.equal(getCalls().loadCalled, 0);
  });

  it('sessão autenticada entra em Nuvem e carrega users/{uid}/carteira', async () => {
    const user = { id: 'uid123', anonymous: false, email: 'a@b.com' };
    const { PA, els, getCalls } = await mountAuth({ user, whenReadyUser: user });
    assert.equal(PA.getUI().mode, 'remote', 'mode remote');
    assert.equal(PA.getUI().mode !== 'locked', true);
    // Badge Nuvem
    assert.equal(els['pa-mode-badge'].textContent, 'Nuvem', 'badge Nuvem');
    const c = getCalls();
    assert.equal(c.loadCalled, 1, 'load chamado');
    assert.equal(c.lastLoadUid, 'uid123', 'UID autenticado usado');
  });

  it('UID autenticado é usado no caminho RTDB', async () => {
    const user = { id: 'realUid999', anonymous: false };
    const { getCalls } = await mountAuth({ user, whenReadyUser: user });
    const c = getCalls();
    assert.equal(c.lastLoadUid, 'realUid999');
    assert.equal(c.ensureAnonymousCalled, false);
  });

  it('usuário anônimo antigo vê apenas a amostra, sem Nuvem', async () => {
    const anon = { id: 'anon-old', anonymous: true };
    const { PA, els, store, getCalls } = await mountAuth({ user: anon, whenReadyUser: anon });
    assert.equal(PA.getUI().mode, 'demo', 'anônimo vê exemplo, não carteira remota');
    assert.notEqual(els['pa-mode-badge'].textContent, 'Nuvem', 'nunca Nuvem para anonimo');
    assert.ok(store.eb_portfolio_v2, 'storage anonimo preservado');
    assert.equal(getCalls().loadCalled, 0, 'não carrega carteira de anonimo como se fosse do usuário');
  });

  it('adicionar ativo abre login e não grava a demonstração', async () => {
    const { PA, store, els, fakeAuth } = await mountAuth({ user: null, whenReadyUser: null });
    const before = store.eb_portfolio_v2;
    els['pa-add-toggle']._events.click();
    assert.equal(fakeAuth._openModal, 1);
    assert.equal(els['pa-form-wrap'].style.display, 'none');
    PA.persistLiveLocal();
    assert.equal(store.eb_portfolio_v2, before);
    assert.equal(PA.getUI().mode, 'demo');
  });

  it('login com carteira vazia remove o exemplo; logout restaura só o exemplo', async () => {
    const { PA, els, triggerAuth } = await mountAuth({ user: null, whenReadyUser: null });
    triggerAuth({ id: 'uid123', anonymous: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(PA.getUI().mode, 'remote');
    assert.equal(els['pa-mode-badge'].textContent, 'Nuvem');
    assert.equal(els['pa-count'].textContent, '0');
    assert.doesNotMatch(els['pa-tbody'].innerHTML, /NVDA/);
    assert.equal(els['pa-demo-notice'].style.display, 'none');
    triggerAuth(null);
    assert.equal(PA.getUI().mode, 'demo');
    assert.equal(els['pa-count'].textContent, '2');
    assert.match(els['pa-tbody'].innerHTML, /NVDA/);
  });

  it('conta com uma posição mostra somente a posição real', async () => {
    const real = { id: 'eth-real', ticker: 'ETH', name: 'Ethereum', type: 'CRYPTO', quantity: 1, averagePrice: 2000, currentPrice: 2200, dailyVariation: 1 };
    const { PA, els } = await mountAuth({ user: { id: 'uid123', anonymous: false }, remoteAssets: [real] });
    assert.equal(PA.getUI().mode, 'remote');
    assert.equal(els['pa-count'].textContent, '1');
    assert.match(els['pa-tbody'].innerHTML, /ETH/);
    assert.doesNotMatch(els['pa-tbody'].innerHTML, /NVDA|BTC/);
    assert.match(els['pa-tbody'].innerHTML, /data-act="edit"/);
  });

  it('resposta antiga da nuvem não substitui a amostra após logout', async () => {
    let resolveLoad;
    const pending = new Promise((resolve) => { resolveLoad = resolve; });
    const { PA, els, store, triggerAuth } = await mountAuth({ user: null, loadResult: () => pending });
    delete store.eb_portfolio_v2;
    triggerAuth({ id: 'uid123', anonymous: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(PA.getUI().loading, true);
    assert.equal(els['pa-table-wrap'].style.display, 'none');
    triggerAuth(null);
    const snapshot = JSON.stringify(store);
    resolveLoad({ assets: [{ id: 'eth-real', ticker: 'ETH', name: 'Ethereum', type: 'CRYPTO', quantity: 1, averagePrice: 2000, currentPrice: 2200, dailyVariation: 1 }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(PA.getUI().mode, 'demo');
    assert.match(els['pa-tbody'].innerHTML, /BTC.*NVDA/s);
    assert.doesNotMatch(els['pa-tbody'].innerHTML, /ETH/);
    assert.equal(JSON.stringify(store), snapshot);
  });

  it('falha no carregamento não usa exemplos como fallback', async () => {
    const user = { id: 'uid123', anonymous: false };
    const { PA, els } = await mountAuth({ user, loadResult: () => Promise.reject(new Error('Falha')) });
    assert.equal(PA.getUI().mode, 'locked');
    assert.equal(els['pa-mode-badge'].textContent, 'Login necessário');
    assert.equal(els['pa-table-wrap'].style.display, 'none');
    assert.equal(els['pa-demo-notice'].style.display, 'none');
  });

  it('exemplo não entra no universo de cotações; alternâncias não duplicam listener', async () => {
    const { PA, sandbox, triggerAuth, getCalls } = await mountAuth({ user: null });
    const liveSource = fs.readFileSync(new URL('./portfolioLive.js', dir), 'utf8');
    vm.runInContext(liveSource, sandbox, { filename: 'portfolioLive.js' });
    assert.equal(PA.getService(), null);
    assert.equal(sandbox.PortfolioLive._test.getUniverse().length, 0);
    triggerAuth({ id: 'uid123', anonymous: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    triggerAuth(null);
    triggerAuth({ id: 'uid123', anonymous: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    triggerAuth(null);
    assert.equal(sandbox.PortfolioLive._test.getUniverse().length, 0);
    assert.equal(getCalls().tickerListeners, 1);
  });
});
