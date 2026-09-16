/* Login obrigatório — painel bloqueado sem sessão autenticada.
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

function mountAuth({ user, whenReadyUser = user }) {
  const store = { eb_portfolio_v2: JSON.stringify({ version: 1, portfolio: { name: 't', currency: 'USD', updatedAt: null }, assets: [{ id: 'a1', ticker: 'BTC', name: 'Bitcoin', type: 'CRYPTO', quantity: 0.5, averagePrice: 60000, currentPrice: 67000, dailyVariation: 1.5 }] }) };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    _store: store,
  };
  const winTarget = new EventTarget();
  let tickerListeners = 0;
  const els = {};
  const mkEl = (overrides = {}) => ({
    addEventListener: () => {}, querySelectorAll: () => [], style: {}, textContent: '', innerHTML: '', value: '', disabled: false, setAttribute: () => {}, classList: { add: () => {}, remove: () => {} }, ...overrides
  });
  // Pre-create critical els with full mock
  els['painel-ativos'] = mkEl({ querySelectorAll: () => [] });
  els['pa-mode-badge'] = mkEl({ textContent: '', title: '' });
  els['pa-locked'] = mkEl({ style: {} });
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
    load: () => { loadCalled++; lastLoadUid = authUser && authUser.id; return Promise.resolve({ assets: [], portfolio: { currency: 'USD' } }); },
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
      getCalls: () => ({ ensureAnonymousCalled, signInAnonymouslyCalled, loadCalled, lastLoadUid }),
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

  it('sem sessão painel fica bloqueado (badge Entrar, locked)', async () => {
    const { PA, els } = await mountAuth({ user: null, whenReadyUser: null });
    assert.equal(PA.getUI().mode, 'locked', 'mode locked');
    // badge deve ser Login necessário / Entrar, nunca Nuvem
    assert.ok(els['pa-mode-badge'].textContent.includes('Login') || els['pa-mode-badge'].textContent.includes('Entrar'), 'badge login');
    assert.equal(els['pa-locked'].style.display, '', 'locked visível');
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

  it('usuário anônimo antigo não é apagado automaticamente (permanece bloqueado, sem Nuvem)', async () => {
    const anon = { id: 'anon-old', anonymous: true };
    const { PA, els, store, getCalls } = await mountAuth({ user: anon, whenReadyUser: anon });
    assert.equal(PA.getUI().mode, 'locked', 'anonimo fica locked, não remote');
    assert.notEqual(els['pa-mode-badge'].textContent, 'Nuvem', 'nunca Nuvem para anonimo');
    assert.ok(store.eb_portfolio_v2, 'storage anonimo preservado');
    assert.equal(getCalls().loadCalled, 0, 'não carrega carteira de anonimo como se fosse do usuário');
  });

  it('bloqueado não permite gravar carteira local silenciosamente', async () => {
    const { PA, store } = await mountAuth({ user: null, whenReadyUser: null });
    const before = store.eb_portfolio_v2;
    // Simula tentativa de submit via onSubmit path local: deve bloquear
    // Como UI está locked, onSubmit deve setar erro e não alterar storage
    // Chamamos via PainelAtivos exposto: não há API direta, mas verificamos que service não foi usado para gravar
    // O teste verifica que persistLiveLocal não grava quando locked
    PA.persistLiveLocal();
    assert.equal(store.eb_portfolio_v2, before, 'persist bloqueado em locked');
    // Simulate add via service would be blocked by UI layer (onSubmit), not service itself
    // Ensure mode remains locked
    assert.equal(PA.getUI().mode, 'locked');
  });
});
