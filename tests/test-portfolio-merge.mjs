/* Testes do merge DCA (preço médio ponderado) — PortfolioService.
 * Roda com: node --test test-portfolio-merge.mjs
 * Usa adapter em memória (sem localStorage, sem DOM, sem rede). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const svcMod = require('../assets/js/portfolio/portfolioService.js');

function memAdapter(seed) {
  let state = seed || { version: 1, portfolio: { name: 't', currency: 'USD', updatedAt: null }, assets: [] };
  return {
    load: () => JSON.parse(JSON.stringify(state)),
    save: (s) => { state = JSON.parse(JSON.stringify(s)); return { ok: true, persistent: false }; },
    clear: () => { state.assets = []; return { ok: true }; }
  };
}

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

describe('merge DCA', () => {
  it('exemplo do usuário: 0,5@55000 + 0,51345678@30000', () => {
    const svc = svcMod.createService(memAdapter());
    svc.add({ ticker: 'BTC', name: 'Bitcoin', type: 'CRYPTO', quantity: 0.5, averagePrice: 55000, currentPrice: 67000, dailyVariation: 2 });
    const r = svc.add({ ticker: 'btc', name: 'Bitcoin', type: 'CRYPTO', quantity: 0.51345678, averagePrice: 30000, currentPrice: 31000, dailyVariation: 1 }, { merge: true });
    assert.equal(r.ok, true);
    assert.equal(r.merged, true);
    assert.ok(approx(r.asset.quantity, 1.01345678, 1e-9));
    assert.ok(approx(r.asset.averagePrice, 42903.7034 / 1.01345678, 1e-6), 'avg=' + r.asset.averagePrice);
    // cotação mais recente sobrescreve
    assert.equal(r.asset.currentPrice, 31000);
    assert.equal(r.asset.dailyVariation, 1);
    assert.equal(svc.getState().assets.length, 1); // não duplicou
  });

  it('sem flag merge: duplicata retorna erro + preview', () => {
    const svc = svcMod.createService(memAdapter());
    svc.add({ ticker: 'ETH', type: 'CRYPTO', quantity: 1, averagePrice: 2000, currentPrice: 2500 });
    const r = svc.add({ ticker: 'eth', type: 'CRYPTO', quantity: 1, averagePrice: 2000, currentPrice: 2500 });
    assert.equal(r.ok, false);
    assert.equal(r.duplicate, true);
    assert.ok(r.preview && r.preview.duplicate);
  });

  it('previewMerge: sem duplicata → duplicate:false', () => {
    const svc = svcMod.createService(memAdapter());
    const p = svc.previewMerge({ ticker: 'SOL', type: 'CRYPTO', quantity: 1, averagePrice: 100, currentPrice: 110 });
    assert.equal(p.ok, true);
    assert.equal(p.duplicate, false);
  });

  it('quantidade zero soma sem quebrar o médio', () => {
    const svc = svcMod.createService(memAdapter());
    svc.add({ ticker: 'AAPL', type: 'STOCK', quantity: 10, averagePrice: 170, currentPrice: 195 });
    const r = svc.add({ ticker: 'AAPL', type: 'STOCK', quantity: 0, averagePrice: 999, currentPrice: 200 }, { merge: true });
    assert.equal(r.asset.quantity, 10);
    assert.equal(r.asset.averagePrice, 170);
    assert.equal(r.asset.currentPrice, 200);
  });

  it('update continua sobrescrevendo (correção, não soma)', () => {
    const svc = svcMod.createService(memAdapter());
    const a = svc.add({ ticker: 'NVDA', type: 'STOCK', quantity: 10, averagePrice: 120, currentPrice: 140 });
    const r = svc.update(a.asset.id, { ticker: 'NVDA', type: 'STOCK', quantity: 5, averagePrice: 100, currentPrice: 140 });
    assert.equal(r.asset.quantity, 5);
    assert.equal(r.asset.averagePrice, 100);
  });

  it('identidade por ticker: update/find aceitam ticker (estável local↔nuvem)', () => {
    const svc = svcMod.createService(memAdapter());
    svc.add({ ticker: 'ETH', name: 'Ethereum', type: 'CRYPTO', quantity: 5, averagePrice: 2200, currentPrice: 2500 });
    // update pelo ticker (como a UI faz após transição de estado)
    const r = svc.update('eth', { ticker: 'ETH', name: 'Ethereum', type: 'CRYPTO', quantity: 5, averagePrice: 2200, currentPrice: 2600 });
    assert.equal(r.ok, true);
    assert.equal(r.asset.currentPrice, 2600);
    // findByTicker exclui por ticker (preview não acusa o próprio ativo)
    const found = svc.findByTicker('ETH');
    assert.equal(found.ticker, 'ETH');
  });
});
