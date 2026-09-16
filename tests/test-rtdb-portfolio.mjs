/* Testes das operações puras do adapter RTDB (Fase 2, pivot custo zero).
 * Roda com: node --test test-rtdb-portfolio.mjs
 * Sem Firebase, sem rede — só as funções puras op*.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { test: T } = require('../assets/js/portfolio/firebasePortfolio.js');

const NOW = 1700000000000;
const approx = (a, b, eps = 1e-9) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

function buy(ticker = 'BTC', q = 0.5, avg = 55000) {
  return T.opAddAsset(null,
    { ticker, name: ticker, type: 'CRYPTO', quantity: q, purchasePrice: avg, currentPrice: 67000, dailyVariation: 1 },
    NOW);
}

describe('opAddAsset (RTDB)', () => {
  it('compra cria asset + lote', () => {
    const r = buy();
    assert.equal(r.action, 'created');
    const a = r.carteira.assets.BTC;
    assert.equal(a.quantity, 0.5);
    assert.equal(a.avgPrice, 55000);
    assert.equal(a.type, 'crypto');
    assert.equal(Object.keys(a.lots).length, 1);
  });

  it('segundo aporte consolida (médio ponderado)', () => {
    const s1 = buy().carteira;
    const r = T.opAddAsset(s1,
      { ticker: 'btc', name: 'Bitcoin', type: 'CRYPTO', quantity: 0.51345678, purchasePrice: 30000, currentPrice: 31000, dailyVariation: 0 },
      NOW);
    assert.equal(r.action, 'updated');
    assert.ok(approx(r.quantity, 1.01345678, 1e-9));
    assert.ok(approx(r.carteira.assets.BTC.avgPrice, 42903.7034 / 1.01345678, 1e-6));
    assert.equal(r.carteira.assets.BTC.currentPrice, 31000);
  });

  it('venda desconta sem mexer no médio; além do saldo falha sem escrever', () => {
    const s1 = buy('ETH', 5, 2200).carteira;
    const r = T.opAddAsset(s1,
      { ticker: 'ETH', name: 'E', type: 'crypto', quantity: -2, purchasePrice: 2600, currentPrice: 2600, dailyVariation: 0 },
      NOW);
    assert.equal(r.action, 'sold');
    assert.equal(r.carteira.assets.ETH.quantity, 3);
    assert.equal(r.carteira.assets.ETH.avgPrice, 2200);
    const bad = T.opAddAsset(r.carteira,
      { ticker: 'ETH', name: 'E', type: 'crypto', quantity: -10, purchasePrice: 1, currentPrice: 1, dailyVariation: 0 },
      NOW);
    assert.ok(bad.error);
  });

  it('venda de inexistente falha', () => {
    const r = T.opAddAsset(null,
      { ticker: 'SOL', name: 'S', type: 'crypto', quantity: -1, purchasePrice: 1, currentPrice: 1, dailyVariation: 0 },
      NOW);
    assert.ok(r.error);
  });

  it('venda total fecha (closedAt) preservando lots', () => {
    const s1 = buy('BTC', 1, 50000).carteira;
    const r = T.opAddAsset(s1,
      { ticker: 'BTC', name: 'B', type: 'crypto', quantity: -1, purchasePrice: 70000, currentPrice: 70000, dailyVariation: 0 },
      NOW);
    assert.equal(r.action, 'closed');
    const a = r.carteira.assets.BTC;
    assert.equal(a.quantity, 0);
    assert.equal(a.closedAt, NOW);
    assert.equal(Object.keys(a.lots).length, 2);
  });

  it('compra reabre (remove closedAt)', () => {
    const s1 = buy('BTC', 1, 50000).carteira;
    const s2 = T.opAddAsset(s1,
      { ticker: 'BTC', name: 'B', type: 'crypto', quantity: -1, purchasePrice: 1, currentPrice: 1, dailyVariation: 0 },
      NOW).carteira;
    assert.ok(s2.assets.BTC.closedAt);
    const r = T.opAddAsset(s2,
      { ticker: 'BTC', name: 'B', type: 'crypto', quantity: 2, purchasePrice: 60000, currentPrice: 60000, dailyVariation: 0 },
      NOW);
    assert.equal(r.action, 'updated');
    assert.ok(!('closedAt' in r.carteira.assets.BTC));
    assert.equal(r.carteira.assets.BTC.quantity, 2);
  });
});

describe('opUpdateAsset / opRemoveAsset', () => {
  it('update só cadastro/cotação', () => {
    const s1 = buy().carteira;
    const r = T.opUpdateAsset(s1, 'BTC',
      { name: 'Bitcoin Novo', type: 'crypto', currentPrice: 70000, dailyVariation: 2 }, NOW);
    assert.equal(r.carteira.assets.BTC.name, 'Bitcoin Novo');
    assert.equal(r.carteira.assets.BTC.quantity, 0.5);
    assert.equal(r.carteira.assets.BTC.avgPrice, 55000);
  });

  it('remove apaga o ramo inteiro', () => {
    const s1 = buy().carteira;
    const r = T.opRemoveAsset(s1, 'BTC');
    assert.deepEqual(r.carteira.assets, {});
  });
});

describe('opRemoveLot', () => {
  it('reconstrói com médio só de positivos', () => {
    let s = buy('BTC', 1, 45000).carteira;
    s = T.opAddAsset(s,
      { ticker: 'BTC', name: 'B', type: 'crypto', quantity: 0.5, purchasePrice: 60000, currentPrice: 1, dailyVariation: 0 },
      NOW).carteira;
    const ids = Object.keys(s.assets.BTC.lots);
    assert.equal(ids.length, 2);
    const r = T.opRemoveLot(s, 'BTC', ids[1], NOW);
    assert.equal(r.carteira.assets.BTC.quantity, 1);
    assert.equal(r.carteira.assets.BTC.avgPrice, 45000);
  });

  it('último lote fecha sem apagar; remoção que negativaria falha', () => {
    let s = buy('BTC', 1, 45000).carteira;
    s = T.opAddAsset(s,
      { ticker: 'BTC', name: 'B', type: 'crypto', quantity: -1, purchasePrice: 1, currentPrice: 1, dailyVariation: 0 },
      NOW).carteira; // fechada: +1 e -1
    const ids = Object.keys(s.assets.BTC.lots);
    // remover a compra deixando só a venda → saldo -1 → rejeita
    const bad = T.opRemoveLot(s, 'BTC', ids[0], NOW);
    assert.ok(bad.error);
    // remover a venda → volta a 1@45000 e reabre
    const r = T.opRemoveLot(s, 'BTC', ids[1], NOW);
    assert.equal(r.carteira.assets.BTC.quantity, 1);
    assert.ok(!('closedAt' in r.carteira.assets.BTC));
  });
});

describe('opMigrate', () => {
  const itens = [
    { ticker: 'btc', name: 'Bitcoin', type: 'CRYPTO', quantity: 0.5, purchasePrice: 55000, currentPrice: 67000, dailyVariation: 2 },
    { ticker: 'PETR4', name: 'P', type: 'STOCK', quantity: 10, purchasePrice: 40, currentPrice: 44, dailyVariation: 0 },
  ];

  it('importa com lots mig_ + flag + currency', () => {
    const r = T.opMigrate(null, itens, 'USD', NOW);
    assert.equal(r.status, 'migrated');
    assert.equal(r.carteira.assets.BTC.avgPrice, 55000);
    assert.equal(r.carteira.assets.PETR4.type, 'stock');
    assert.ok(r.carteira.assets.BTC.lots.mig_BTC);
    assert.equal(r.carteira.localMigrationCompleted, true);
    assert.equal(r.carteira.currency, 'USD');
  });

  it('already_migrated / remote_exists / duplicados / >200', () => {
    const done = T.opMigrate(null, itens, 'USD', NOW).carteira;
    assert.equal(T.opMigrate(done, itens, 'USD', NOW).status, 'already_migrated');
    const remote = T.opMigrate({ assets: { BTC: { ticker: 'BTC' } } }, itens, 'USD', NOW);
    assert.equal(remote.status, 'remote_exists');
    const dup = T.opMigrate(null, [itens[0], { ...itens[0], ticker: 'BTC' }], 'USD', NOW);
    assert.ok(dup.error);
    const big = Array.from({ length: 201 }, (_, i) => ({ ...itens[0], ticker: 'T' + i }));
    assert.ok(T.opMigrate(null, big, 'USD', NOW).error);
  });
});

describe('parseNumber pt-BR (bug do form remoto)', () => {
  it('strings do formulário viram número', () => {
    assert.equal(T.parseNumber('0,1', NaN), 0.1);
    assert.equal(T.parseNumber('77.800,00', NaN), 77800);
    assert.equal(T.parseNumber('2,00', 0), 2);
    assert.equal(T.parseNumber('67000.5', NaN), 67000.5);
    assert.ok(Number.isNaN(T.parseNumber('', NaN)));
  });

  it('add aceita strings pt-BR (cenário do bug reportado)', () => {
    const s1 = T.opAddAsset(null,
      { ticker: 'BTC', name: 'Bitcoin', type: 'CRYPTO', quantity: 0.5, purchasePrice: 55000, currentPrice: 67000, dailyVariation: 0 },
      NOW).carteira;
    const r = T.opAddAsset(s1,
      { ticker: 'BTC', name: 'B', type: 'crypto', quantity: '0,1', purchasePrice: '77800,00', currentPrice: '77900,00', dailyVariation: '2,00' },
      NOW);
    assert.equal(r.action, 'updated');
    assert.ok(r.quantity > 0.5, 'quantidade somou, não zerou');
  });
});

describe('fromCloud', () => {
  it('mapeia para o formato UI (type maiúsculo, avgPrice→averagePrice)', () => {
    const v = T.fromCloud({
      currency: 'USD',
      assets: {
        BTC: { ticker: 'BTC', name: 'Bitcoin', type: 'crypto', quantity: 1, avgPrice: 50000, currentPrice: 60000, dailyChangePercent: 1 },
      },
    });
    assert.equal(v.assets.length, 1);
    assert.equal(v.assets[0].type, 'CRYPTO');
    assert.equal(v.assets[0].averagePrice, 50000);
    assert.equal(v.assets[0].dailyVariation, 1);
    assert.equal(v.assets[0].id, 'BTC');
  });
});
