/* Gate de propriedade da migração (maybeMigrate).
 * Roda com: node --test tests/test-migrate-ownership.mjs
 * UIDs 100% fictícios ('UID_A', 'UID_B') — nenhum dado real, nenhuma rede,
 * nenhum Firebase. Parte 1 usa o portfolioStorage REAL com localStorage fake.
 * Parte 2 carrega o painel-ativos-ui.js REAL em vm (mesmo harness do
 * test-maybe-migrate-retry) com FirebasePortfolio + localStorage fakes.
 *
 * Regra definitiva:
 *  owner === sessão  → migra | owner !== sessão → bloqueia (silencioso,
 *  preserva local) | legado com dados e sem carimbo → bloqueia (silencioso,
 *  preserva local) | sem dados locais → segue (migrateLocal dá 'empty').
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// portfolioStorage.js é CommonJS (module.exports) → namespace.default.
const { default: Storage } = await import(pathToFileURL(path.join(DIR, '..', 'assets', 'js', 'portfolio', 'portfolioStorage.js')).href);

const UID_A = 'UID_A_FICTICIO';
const UID_B = 'UID_B_FICTICIO';

function fakeLS(seed) {
  const store = seed ? { ...seed } : {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    _dump() { return { ...store }; },
  };
}

function localPayload(owner, tickers) {
  const o = {
    version: 1,
    portfolio: { name: 't', currency: 'USD', updatedAt: null },
    assets: (tickers || ['BTC']).map((t, i) => ({
      id: 'a' + i, ticker: t, name: t, type: 'CRYPTO',
      quantity: 1, averagePrice: 10, currentPrice: 11, dailyVariation: 0,
    })),
  };
  if (owner) o.ownerUid = owner;
  return JSON.stringify(o);
}

describe('storage: carimbo ownerUid', () => {
  it('(1) save carimba o dono vigente; load devolve round-trip', () => {
    const ls = fakeLS();
    const g = globalThis;
    const realLS = g.localStorage;
    g.localStorage = ls;
    try {
      Storage.setOwner(UID_A);
      const st = Storage.blankState();
      st.assets.push({
        id: 'a1', ticker: 'BTC', name: 'Bitcoin', type: 'CRYPTO',
        quantity: 0.5, averagePrice: 60000, currentPrice: 67000, dailyVariation: 1.5,
      });
      assert.ok(Storage.LocalPortfolioStorage.save(st).ok);
      const raw = JSON.parse(ls.getItem('eb_portfolio_v2'));
      assert.equal(raw.ownerUid, UID_A);
      Storage.setOwner(null);
      const back = Storage.LocalPortfolioStorage.load();
      assert.equal(back.ownerUid, UID_A, 'load preserva o carimbo');
    } finally {
      if (realLS === undefined) delete g.localStorage; else g.localStorage = realLS;
      Storage.setOwner(null);
    }
  });

  it('(2) sem dono, save mantém o formato legado (sem chave ownerUid)', () => {
    const ls = fakeLS();
    const g = globalThis;
    const realLS = g.localStorage;
    g.localStorage = ls;
    try {
      Storage.setOwner(null);
      assert.ok(Storage.LocalPortfolioStorage.save(Storage.blankState()).ok);
      const raw = JSON.parse(ls.getItem('eb_portfolio_v2'));
      assert.ok(!Object.prototype.hasOwnProperty.call(raw, 'ownerUid'));
    } finally {
      if (realLS === undefined) delete g.localStorage; else g.localStorage = realLS;
    }
  });

  it('(3) legado sem chave carrega normal (sem dono = bloqueado depois)', () => {
    const ls = fakeLS({
      eb_portfolio_v2: JSON.stringify({
        version: 1, portfolio: { name: 't', currency: 'USD', updatedAt: null }, assets: [],
      }),
    });
    const g = globalThis;
    const realLS = g.localStorage;
    g.localStorage = ls;
    try {
      const back = Storage.LocalPortfolioStorage.load();
      assert.ok(!back.ownerUid, 'legado não ganha dono sozinho');
    } finally {
      if (realLS === undefined) delete g.localStorage; else g.localStorage = realLS;
    }
  });

  it('(4) CRUD re-salva preservando o carimbo (reload idem)', () => {
    const ls = fakeLS();
    const g = globalThis;
    const realLS = g.localStorage;
    g.localStorage = ls;
    try {
      Storage.setOwner(UID_A);
      const st = Storage.LocalPortfolioStorage.load();
      st.assets.push({
        id: 'a9', ticker: 'ETH', name: 'Ethereum', type: 'CRYPTO',
        quantity: 2, averagePrice: 2000, currentPrice: 2100, dailyVariation: 0,
      });
      assert.ok(Storage.LocalPortfolioStorage.save(st).ok);
      assert.equal(JSON.parse(ls.getItem('eb_portfolio_v2')).ownerUid, UID_A);
      assert.equal(Storage.LocalPortfolioStorage.load().ownerUid, UID_A);
    } finally {
      if (realLS === undefined) delete g.localStorage; else g.localStorage = realLS;
      Storage.setOwner(null);
    }
  });
});

// ---------- Parte 2: gate no painel real ----------
const SRC = fs.readFileSync(path.join(DIR, '..', 'assets', 'js', 'portfolio', 'painel-ativos-ui.js'), 'utf8');

function mountPanel({ seedLocal, sessionUid, withCurrentUid = true }) {
  const calls = { migrate: 0, clear: 0 };
  let session = sessionUid;
  const ls = fakeLS(seedLocal);
  const fakeFb = {
    migrateLocal() { calls.migrate++; return Promise.resolve({ status: 'empty' }); },
    clearLocal() { calls.clear++; },
    friendlyError() { return 'erro-x'; },
    load() { return Promise.resolve({ assets: [] }); },
  };
  if (withCurrentUid) fakeFb.currentUid = () => session;
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    localStorage: ls,
    document: {
      readyState: 'complete',
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    FirebasePortfolio: fakeFb,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = undefined;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'painel-ativos-ui.js' });
  const PA = sandbox.PainelAtivos;
  assert.ok(PA && typeof PA.maybeMigrate === 'function', 'hook maybeMigrate exposto');
  PA.getUI().mode = 'remote';
  return { PA, calls, ls, setSession: (u) => { session = u; } };
}

describe('gate maybeMigrate: propriedade do snapshot', () => {
  it('(5) owner igual à sessão → migração permitida', async () => {
    const seed = { eb_portfolio_v2: localPayload(UID_A) };
    const { PA, calls } = mountPanel({ seedLocal: seed, sessionUid: UID_A });
    await PA.maybeMigrate();
    assert.equal(calls.migrate, 1, 'dono igual migra');
  });

  it('(6) owner diferente → bloqueia, preserva local, silencioso', async () => {
    const before = localPayload(UID_A, ['BTC', 'ETH']);
    const { PA, calls, ls } = mountPanel({
      seedLocal: { eb_portfolio_v2: before }, sessionUid: UID_B,
    });
    const r = await PA.maybeMigrate();
    assert.equal(r, null);
    assert.equal(calls.migrate, 0, 'não chamou migrateLocal');
    assert.equal(calls.clear, 0, 'não apagou o local');
    assert.equal(ls.getItem('eb_portfolio_v2'), before, 'snapshot de A intacto');
    const r2 = await PA.maybeMigrate();
    assert.equal(calls.migrate, 0, 'retry continua bloqueado');
    assert.equal(r2, null);
  });

  it('(7) legado com dados e sem carimbo → bloqueia e preserva', async () => {
    const before = localPayload(null, ['BTC']);
    const { PA, calls, ls } = mountPanel({
      seedLocal: { eb_portfolio_v2: before }, sessionUid: UID_A,
    });
    const r = await PA.maybeMigrate();
    assert.equal(r, null);
    assert.equal(calls.migrate, 0, 'legado não migra automaticamente');
    assert.equal(ls.getItem('eb_portfolio_v2'), before, 'legado preservado');
  });

  it('(8) local vazio → segue o fluxo (nada a bloquear)', async () => {
    const { PA, calls } = mountPanel({ seedLocal: {}, sessionUid: UID_A });
    await PA.maybeMigrate();
    assert.equal(calls.migrate, 1, 'sem dados locais, fluxo normal');
  });

  it('(9) sessão indeterminada + snapshot com dono → bloqueia', async () => {
    const before = localPayload(UID_A);
    const { PA, calls, ls } = mountPanel({
      seedLocal: { eb_portfolio_v2: before }, sessionUid: UID_A, withCurrentUid: false,
    });
    await PA.maybeMigrate();
    assert.equal(calls.migrate, 0, 'sem UID verificável, não migra');
    assert.equal(ls.getItem('eb_portfolio_v2'), before);
  });

  it('(10) logout A → login B sem contaminação; A de volta migra', async () => {
    const before = localPayload(UID_A, ['BTC']);
    const { PA, calls, ls, setSession } = mountPanel({
      seedLocal: { eb_portfolio_v2: before }, sessionUid: UID_B,
    });
    await PA.maybeMigrate();
    assert.equal(calls.migrate, 0, 'B não absorve dados de A');
    assert.equal(ls.getItem('eb_portfolio_v2'), before);
    setSession(UID_A); // A volta ao aparelho
    await PA.maybeMigrate();
    assert.equal(calls.migrate, 1, 'dono de volta migra normal');
  });
});
