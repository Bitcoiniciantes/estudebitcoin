/* Testes do teto anti-abuso da carteira (50 posições distintas).
 * Roda com: node --test test-portfolio-cap.mjs
 * Sem DOM, sem rede, sem Firebase — só as funções puras.
 * Regra: só a CRIAÇÃO de ticker novo é limitada; aporte em posição
 * existente e edição seguem liberados (sem "grandfather lock-out"). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const svcMod = require('../assets/js/portfolio/portfolioService.js');
const { test: T } = require('../assets/js/portfolio/firebasePortfolio.js');

const NOW = 1700000000000;

function memAdapter() {
  let state = { version: 1, portfolio: { name: 't', currency: 'USD', updatedAt: null }, assets: [] };
  return {
    load: () => JSON.parse(JSON.stringify(state)),
    save: (s) => { state = JSON.parse(JSON.stringify(s)); return { ok: true, persistent: false }; },
    clear: () => { state.assets = []; return { ok: true }; }
  };
}

function localInput(t) {
  return { ticker: t, name: t, type: 'STOCK', quantity: 1, averagePrice: 10, currentPrice: 11, dailyVariation: 0 };
}

function remoteInput(t) {
  return { ticker: t, name: t, type: 'STOCK', quantity: 1, purchasePrice: 10, currentPrice: 11, dailyVariation: 0 };
}

describe('teto local (portfolioService, 50)', () => {
  it('1. cria 50 posições distintas', () => {
    const svc = svcMod.createService(memAdapter());
    for (let i = 0; i < 50; i++) {
      const r = svc.add(localInput('T' + i));
      assert.equal(r.ok, true, 'T' + i + ': ' + JSON.stringify(r.errors));
    }
    assert.equal(svc.getState().assets.length, 50);
  });

  it('2. 51ª posição nova é bloqueada', () => {
    const svc = svcMod.createService(memAdapter());
    for (let i = 0; i < 50; i++) svc.add(localInput('T' + i));
    const r = svc.add(localInput('EXTRA'));
    assert.equal(r.ok, false);
    assert.match(String((r.errors || []).join(' ')), /50/);
    assert.equal(svc.getState().assets.length, 50);
  });

  it('3. aporte em posição existente com 50 liberado (merge)', () => {
    const svc = svcMod.createService(memAdapter());
    for (let i = 0; i < 50; i++) svc.add(localInput('T' + i));
    const r = svc.add({ ticker: 'T0', name: 'T0', type: 'STOCK', quantity: 5, averagePrice: 20, currentPrice: 22, dailyVariation: 0 }, { merge: true });
    assert.equal(r.ok, true);
    assert.equal(r.merged, true);
    assert.equal(svc.getState().assets.length, 50);
  });

  it('4. edição de posição existente com 50 liberada', () => {
    const svc = svcMod.createService(memAdapter());
    for (let i = 0; i < 50; i++) svc.add(localInput('T' + i));
    const r = svc.update('T0', { ticker: 'T0', name: 'Renomeada', type: 'STOCK', quantity: 1, averagePrice: 10, currentPrice: 12, dailyVariation: 0 });
    assert.equal(r.ok, true);
  });
});

describe('teto remoto (opAddAsset RTDB, 50)', () => {
  it('5. cria 50 posições distintas', () => {
    let cart = null;
    for (let i = 0; i < 50; i++) {
      const r = T.opAddAsset(cart, remoteInput('R' + i), NOW);
      assert.ok(!r.error, 'R' + i + ': ' + r.error);
      cart = r.carteira;
    }
    assert.equal(Object.keys(cart.assets).length, 50);
  });

  it('6. 51ª posição nova é bloqueada', () => {
    let cart = null;
    for (let i = 0; i < 50; i++) cart = T.opAddAsset(cart, remoteInput('R' + i), NOW).carteira;
    const r = T.opAddAsset(cart, remoteInput('EXTRA'), NOW);
    assert.ok(r.error);
    assert.match(String(r.error), /50/);
  });

  it('7. aporte em posição existente com 50 liberado', () => {
    let cart = null;
    for (let i = 0; i < 50; i++) cart = T.opAddAsset(cart, remoteInput('R' + i), NOW).carteira;
    const r = T.opAddAsset(cart, remoteInput('R0'), NOW);
    assert.ok(!r.error, r.error);
    assert.equal(r.action, 'updated');
  });
});
