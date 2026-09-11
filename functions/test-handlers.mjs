/* Testes dos handlers (lógica transacional) com Firestore fake.
 * Roda com: node --test test-handlers.mjs  (a partir de functions/)
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeFakeAdmin, HttpsError } from './test-fake-firestore.js';

const require = createRequire(import.meta.url);

const fakeFns = { https: { onCall: (fn) => fn, HttpsError } };

let fns;
let fake;
function loadHandlers() {
  fake = makeFakeAdmin();
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'firebase-functions') return fakeFns;
    if (request === 'firebase-admin') return fake.admin;
    return origLoad.call(this, request, ...rest);
  };
  delete require.cache[require.resolve('./index.js')];
  fns = require('./index.js');
  Module._load = origLoad;
}

const UID = 'user1';
const ctx = () => ({ auth: { uid: UID } });
const approx = (a, b, eps = 1e-9) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

function assetDoc(ticker) {
  const d = fake.store.docs.get(`users/${UID}/assets/${ticker}`);
  assert.ok(d, 'asset ' + ticker + ' deveria existir');
  return d;
}

describe('handlers', () => {
  beforeEach(loadHandlers);

  it('unauthenticated é rejeitado', async () => {
    await assert.rejects(
      fns.adicionarOuConsolidarAtivo({ ticker: 'BTC' }, {}),
      (e) => e.code === 'unauthenticated');
  });

  it('compra cria asset + lot (action created)', async () => {
    const r = await fns.adicionarOuConsolidarAtivo({
      ticker: 'btc', name: 'Bitcoin', type: 'CRYPTO',
      quantity: 0.5, purchasePrice: 55000, currentPrice: 67000, dailyChangePercent: 2,
    }, ctx());
    assert.equal(r.action, 'created');
    assert.equal(r.quantity, 0.5);
    assert.equal(r.avgPrice, 55000);
    const d = assetDoc('BTC');
    assert.equal(d.type, 'crypto');
    assert.equal(d.priceSource, 'manual');
  });

  it('segundo aporte consolida (médio ponderado)', async () => {
    await fns.adicionarOuConsolidarAtivo({
      ticker: 'BTC', name: 'Bitcoin', type: 'crypto',
      quantity: 0.5, purchasePrice: 55000, currentPrice: 67000,
    }, ctx());
    const r = await fns.adicionarOuConsolidarAtivo({
      ticker: 'BTC', name: 'Bitcoin', type: 'crypto',
      quantity: 0.51345678, purchasePrice: 30000, currentPrice: 31000,
    }, ctx());
    assert.equal(r.action, 'updated');
    assert.ok(approx(r.quantity, 1.01345678, 1e-9));
    assert.ok(approx(r.avgPrice, 42903.7034 / 1.01345678, 1e-6));
    assert.equal(assetDoc('BTC').currentPrice, 31000);
  });

  it('venda desconta sem mexer no médio; além do saldo falha', async () => {
    await fns.adicionarOuConsolidarAtivo({
      ticker: 'ETH', name: 'Ethereum', type: 'crypto',
      quantity: 5, purchasePrice: 2200, currentPrice: 2500,
    }, ctx());
    const r = await fns.adicionarOuConsolidarAtivo({
      ticker: 'ETH', name: 'Ethereum', type: 'crypto',
      quantity: -2, purchasePrice: 2600, currentPrice: 2600,
    }, ctx());
    assert.equal(r.action, 'sold');
    assert.equal(r.quantity, 3);
    assert.equal(assetDoc('ETH').avgPrice, 2200);
    await assert.rejects(
      fns.adicionarOuConsolidarAtivo({
        ticker: 'ETH', name: 'Ethereum', type: 'crypto',
        quantity: -10, purchasePrice: 2600, currentPrice: 2600,
      }, ctx()),
      (e) => e.code === 'failed-precondition');
    assert.equal(assetDoc('ETH').quantity, 3); // sem escrita parcial
  });

  it('venda de inexistente falha sem escrever', async () => {
    await assert.rejects(
      fns.adicionarOuConsolidarAtivo({
        ticker: 'SOL', name: 'Solana', type: 'crypto',
        quantity: -1, purchasePrice: 100, currentPrice: 100,
      }, ctx()),
      (e) => e.code === 'failed-precondition');
    assert.equal(fake.store.docs.has('users/user1/assets/SOL'), false);
  });

  it('venda total fecha (closedAt) preservando lots', async () => {
    await fns.adicionarOuConsolidarAtivo({
      ticker: 'BTC', name: 'Bitcoin', type: 'crypto',
      quantity: 1, purchasePrice: 50000, currentPrice: 70000,
    }, ctx());
    const r = await fns.adicionarOuConsolidarAtivo({
      ticker: 'BTC', name: 'Bitcoin', type: 'crypto',
      quantity: -1, purchasePrice: 70000, currentPrice: 70000,
    }, ctx());
    assert.equal(r.action, 'closed');
    assert.equal(r.avgPrice, undefined);
    const d = assetDoc('BTC');
    assert.equal(d.quantity, 0);
    assert.ok(d.closedAt);
    const lots = [...fake.store.docs.keys()].filter((k) => k.includes('/lots/'));
    assert.equal(lots.length, 2); // compra + venda preservados
  });

  it('atualizarAtivo: só cadastro/cotação; manual-only; last-writer-wins', async () => {
    await fns.adicionarOuConsolidarAtivo({
      ticker: 'BTC', name: 'Bitcoin', type: 'crypto',
      quantity: 1, purchasePrice: 50000, currentPrice: 60000,
    }, ctx());
    const r = await fns.atualizarAtivo({
      ticker: 'BTC', name: 'Bitcoin Novo', type: 'crypto',
      currentPrice: 65000, manualPrice: 65000, dailyChangePercent: 1,
      priceSource: 'manual',
    }, ctx());
    assert.equal(r.status, 'ok');
    const d = assetDoc('BTC');
    assert.equal(d.name, 'Bitcoin Novo');
    assert.equal(d.quantity, 1); // intocado
    assert.equal(d.avgPrice, 50000); // intocado
    await assert.rejects(
      fns.atualizarAtivo({
        ticker: 'BTC', name: 'X', type: 'crypto',
        currentPrice: 1, manualPrice: 1, priceSource: 'api',
      }, ctx()),
      (e) => e.code === 'invalid-argument');
  });

  it('removerLote reconstrói; último lote fecha sem apagar', async () => {
    await fns.adicionarOuConsolidarAtivo({
      ticker: 'BTC', name: 'Bitcoin', type: 'crypto',
      quantity: 1, purchasePrice: 45000, currentPrice: 50000,
    }, ctx());
    await fns.adicionarOuConsolidarAtivo({
      ticker: 'BTC', name: 'Bitcoin', type: 'crypto',
      quantity: 0.5, purchasePrice: 60000, currentPrice: 50000,
    }, ctx());
    const lotIds = [...fake.store.docs.keys()]
      .filter((k) => k.includes('assets/BTC/lots/'))
      .map((k) => k.split('/').pop());
    assert.equal(lotIds.length, 2);
    // remove o lote 2 (0.5@60000) → volta a 1@45000
    await fns.removerLote({ ticker: 'BTC', lotId: lotIds[1] }, ctx());
    let d = assetDoc('BTC');
    assert.equal(d.quantity, 1);
    assert.equal(d.avgPrice, 45000);
    // remove o último → fecha (não apaga)
    await fns.removerLote({ ticker: 'BTC', lotId: lotIds[0] }, ctx());
    d = assetDoc('BTC');
    assert.equal(d.quantity, 0);
    assert.ok(d.closedAt);
  });

  it('removerAtivo apaga asset + lots', async () => {
    await fns.adicionarOuConsolidarAtivo({
      ticker: 'BTC', name: 'Bitcoin', type: 'crypto',
      quantity: 1, purchasePrice: 50000, currentPrice: 60000,
    }, ctx());
    const r = await fns.removerAtivo({ ticker: 'BTC' }, ctx());
    assert.equal(r.status, 'ok');
    const leftovers = [...fake.store.docs.keys()].filter((k) => k.includes('assets/BTC'));
    assert.deepEqual(leftovers, []);
  });

  it('migração: importa, cria lots mig_, marca flag; segunda vez already_migrated', async () => {
    const payload = {
      currency: 'USD',
      itens: [
        { ticker: 'btc', name: 'Bitcoin', type: 'CRYPTO', quantity: 0.5, purchasePrice: 55000, currentPrice: 67000, dailyChangePercent: 2 },
        { ticker: 'PETR4', name: 'Petrobras', type: 'STOCK', quantity: 10, purchasePrice: 40, currentPrice: 44 },
      ],
    };
    const r1 = await fns.migrarCarteiraLocal(payload, ctx());
    assert.equal(r1.status, 'migrated');
    assert.equal(r1.itens, 2);
    assert.equal(assetDoc('BTC').avgPrice, 55000);
    assert.equal(assetDoc('PETR4').type, 'stock');
    assert.ok(fake.store.docs.has('users/user1/assets/BTC/lots/mig_BTC'));
    assert.equal(fake.store.docs.get('users/user1').localMigrationCompleted, true);
    assert.equal(fake.store.docs.get('users/user1').currency, 'USD');
    const r2 = await fns.migrarCarteiraLocal(payload, ctx());
    assert.equal(r2.status, 'already_migrated');
  });

  it('migração: remote_exists em sobreposição; import aditivo sem sobreposição', async () => {
    await fns.adicionarOuConsolidarAtivo({
      ticker: 'BTC', name: 'Bitcoin', type: 'crypto',
      quantity: 1, purchasePrice: 50000, currentPrice: 60000,
    }, ctx());
    // Mesmo ticker no remoto → não mexe em nada.
    const r = await fns.migrarCarteiraLocal({
      itens: [{ ticker: 'btc', name: 'Bitcoin', type: 'CRYPTO', quantity: 0.5, purchasePrice: 55000, currentPrice: 67000 }],
    }, ctx());
    assert.equal(r.status, 'remote_exists');
    assert.equal(assetDoc('BTC').quantity, 1); // intocado
    // Ticker sem sobreposição → importação aditiva segura.
    const r2 = await fns.migrarCarteiraLocal({
      itens: [{ ticker: 'ETH', name: 'E', type: 'crypto', quantity: 1, purchasePrice: 1, currentPrice: 1 }],
    }, ctx());
    assert.equal(r2.status, 'migrated');
    assert.equal(assetDoc('ETH').quantity, 1);
    await assert.rejects(
      fns.migrarCarteiraLocal({
        itens: [
          { ticker: 'A', name: 'A', type: 'crypto', quantity: 1, purchasePrice: 1, currentPrice: 1 },
          { ticker: 'a', name: 'A', type: 'crypto', quantity: 1, purchasePrice: 1, currentPrice: 1 },
        ],
      }, ctx()),
      (e) => e.code === 'invalid-argument');
    const big = Array.from({ length: 201 }, (_, i) => ({
      ticker: 'T' + i, name: 'N', type: 'crypto', quantity: 1, purchasePrice: 1, currentPrice: 1,
    }));
    await assert.rejects(
      fns.migrarCarteiraLocal({ itens: big }, ctx()),
      (e) => e.code === 'out-of-range');
  });
});
