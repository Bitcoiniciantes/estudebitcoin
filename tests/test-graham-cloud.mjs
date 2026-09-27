/* Testes do GrahamCloud (persistência do histórico, SÓ logados).
 * Roda com: node --test test-graham-cloud.mjs
 * Firebase + EstudeAuth stubados; sem DOM, sem rede.
 * Regras: anônimo (null ou anonymous:true) nunca escreve; login faz pull;
 * logout limpa a visão; tudo com falha silenciosa. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../assets/js/portfolio/graham.js');

const PATH = 'users/uid-A/panels/graham';
const store = {};
let currentUser = null;
let view = null; // o que a UI renderizou por último via setHistory

globalThis.firebase = {
  apps: [{}],
  database: () => ({
    ref: (path) => ({
      set: (val) => { store[path] = JSON.parse(JSON.stringify(val)); return Promise.resolve(); },
      once: () => Promise.resolve({ val: () => (path in store ? store[path] : null) }),
    }),
  }),
};
globalThis.EstudeAuth = { getUser: () => currentUser };

function wire() {
  view = 'untouched';
  G.Cloud._test.reset();
  G.Cloud.init({
    getHistory: () => wire.hist,
    setHistory: (list) => { view = list; },
  });
  wire.hist = [];
}
wire.hist = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const entry = (t) => ({ ticker: t, name: t + ' SA', currentUSD: 10, fairBRL: 50, fairUSD: 10, upside: 1, at: '2026-01-01T00:00:00.000Z' });

describe('GrahamCloud', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    currentUser = null;
    wire();
  });

  it('1. anônimo (null) não escreve e pull não busca', async () => {
    wire.hist = [entry('PETR4')];
    G.Cloud.pushSoon();
    await sleep(100);
    assert.ok(!(PATH in store), 'nada escrito');
    G.Cloud.pull();
    await sleep(50);
    assert.equal(view, 'untouched', 'sem setHistory');
  });

  it('2. sessão anonymous:true também não escreve', async () => {
    currentUser = { id: 'uid-X', anonymous: true };
    wire.hist = [entry('PETR4')];
    G.Cloud.pushSoon();
    await sleep(100);
    assert.ok(!(PATH in store), 'anônimo não persiste');
  });

  it('3. login faz pull da nuvem (substitui visão local)', async () => {
    store[PATH] = { items: [entry('VALE3')], updatedAt: '2026-01-02T00:00:00.000Z' };
    currentUser = { id: 'uid-A', anonymous: false };
    G.Cloud.onAuthChange(currentUser);
    await sleep(50);
    assert.equal(view.length, 1);
    assert.equal(view[0].ticker, 'VALE3');
  });

  it('4. push grava itens + updatedAt (debounce)', async () => {
    currentUser = { id: 'uid-A', anonymous: false };
    wire.hist = [entry('PETR4'), entry('ITUB4')];
    G.Cloud.pushSoon();
    await sleep(2300);
    assert.ok(PATH in store, 'escreveu após debounce');
    assert.equal(store[PATH].items.length, 2);
    assert.ok(store[PATH].updatedAt, 'carimba updatedAt');
  });

  it('5. logout limpa a visão local', () => {
    view = [entry('PETR4')];
    G.Cloud.onAuthChange(null);
    assert.deepEqual(view, []);
  });

  it('6. troca de conta repuxa (não mistura uids)', async () => {
    store[PATH] = { items: [entry('VALE3')], updatedAt: 'x' };
    currentUser = { id: 'uid-A', anonymous: false };
    G.Cloud.onAuthChange(currentUser);
    await sleep(50);
    assert.equal(view[0].ticker, 'VALE3');
    // outro uid sem nada na nuvem
    currentUser = { id: 'uid-B', anonymous: false };
    G.Cloud.onAuthChange(currentUser);
    await sleep(50);
    assert.deepEqual(view, [], 'nuvem vazia do uid-B → visão vazia');
  });

  it('7. cleanItems: cap 50, descarta lixo, preserva campos', () => {
    const big = [];
    for (let i = 0; i < 60; i++) big.push(entry('T' + i));
    big.push(null, 'x', {}, { ticker: '' }, { ticker: 'OK', name: '  Nome  ', currentUSD: -5, fairUSD: 'abc', upside: NaN });
    const cleaned = G.Cloud._test.cleanItems(big);
    assert.equal(cleaned.length, 50, 'cap');
    assert.ok(cleaned.every((h) => h.ticker), 'sem ticker vazio');
  });

  it('8. falha do SDK é silenciosa (sem firebase)', async () => {
    const keep = globalThis.firebase;
    delete globalThis.firebase;
    currentUser = { id: 'uid-A', anonymous: false };
    wire.hist = [entry('PETR4')];
    G.Cloud.pushSoon();
    G.Cloud.pull();
    await sleep(100);
    globalThis.firebase = keep;
    assert.ok(true, 'não lançou');
  });
});
