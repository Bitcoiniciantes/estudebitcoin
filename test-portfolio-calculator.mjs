/* Testes do PortfolioCalculator — 8 casos do §22.
 * Roda com: node --test test-portfolio-calculator.mjs
 * Não toca DOM, storage ou rede. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const calc = require('./assets/js/portfolio/portfolioCalculator.js');

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

describe('portfolioCalculator', () => {
  it('1. ativo com lucro (BTC do exemplo)', () => {
    const r = calc.enrichPosition({ quantity: 0.5, averagePrice: 300000, currentPrice: 350000, dailyVariation: 2.31 });
    assert.equal(r.invested, 150000);
    assert.equal(r.current, 175000);
    assert.equal(r.profit, 25000);
    assert.ok(approx(r.profitability, 16.6666666667, 1e-6));
  });

  it('2. ativo com prejuízo', () => {
    const r = calc.enrichPosition({ quantity: 10, averagePrice: 100, currentPrice: 80, dailyVariation: -1 });
    assert.equal(r.invested, 1000);
    assert.equal(r.current, 800);
    assert.equal(r.profit, -200);
    assert.ok(approx(r.profitability, -20));
  });

  it('3. vários ativos + totais ponderados (não média de %)', () => {
    const a = calc.enrichPosition({ quantity: 0.5, averagePrice: 300000, currentPrice: 350000 });
    const b = calc.enrichPosition({ quantity: 20, averagePrice: 900, currentPrice: 1020 });
    const t = calc.calcTotals([a, b]);
    assert.equal(t.invested, 150000 + 18000);
    assert.equal(t.current, 175000 + 20400);
    assert.equal(t.profit, 27400);
    // ponderada: 195400/168000 - 1 = 16.3095...% (≠ média de 16.67 e 13.33)
    assert.ok(approx(t.profitability, (195400 / 168000 - 1) * 100, 1e-9));
  });

  it('4. carteira com um único ativo → alocação 100%', () => {
    const a = calc.enrichPosition({ quantity: 1, averagePrice: 10, currentPrice: 12 });
    calc.applyAllocations([a], 12);
    assert.equal(a.allocation, 100);
  });

  it('5. CRYPTO + STOCK: alocação por valor atual soma 100%', () => {
    const list = [
      calc.enrichPosition({ quantity: 1, averagePrice: 40000, currentPrice: 40000 }),
      calc.enrichPosition({ quantity: 1, averagePrice: 25000, currentPrice: 25000 }),
      calc.enrichPosition({ quantity: 1, averagePrice: 20000, currentPrice: 20000 }),
      calc.enrichPosition({ quantity: 1, averagePrice: 15000, currentPrice: 15000 })
    ];
    const t = calc.calcTotals(list);
    calc.applyAllocations(list, t.current);
    const sum = list.reduce((s, x) => s + x.allocation, 0);
    assert.ok(approx(sum, 100, 1e-9));
    assert.ok(approx(list[0].allocation, 40));
    assert.ok(approx(list[1].allocation, 25));
  });

  it('6. quantidade decimal de cripto', () => {
    const r = calc.enrichPosition({ quantity: 0.12345678, averagePrice: 350000, currentPrice: 360000 });
    assert.ok(approx(r.current, 0.12345678 * 360000, 1e-6));
    assert.ok(Number.isFinite(r.profit) && Number.isFinite(r.profitability));
  });

  it('7. preço médio igual ao atual → lucro 0, rent 0', () => {
    const r = calc.enrichPosition({ quantity: 5, averagePrice: 100, currentPrice: 100 });
    assert.equal(r.profit, 0);
    assert.equal(r.profitability, 0);
  });

  it('8. carteira vazia → zeros, sem NaN/Infinity', () => {
    const t = calc.calcTotals([]);
    for (const k of ['invested', 'current', 'profit', 'profitability', 'dailyDelta']) {
      assert.equal(t[k], 0, k);
      assert.ok(Number.isFinite(t[k]), k);
    }
    assert.equal(t.count, 0);
    const out = calc.applyAllocations([], 0);
    assert.deepEqual(out, []);
  });

  it('extra: entradas inválidas nunca geram NaN/Infinity', () => {
    const r = calc.enrichPosition({ quantity: NaN, averagePrice: Infinity, currentPrice: 'x' });
    for (const k of ['invested', 'current', 'profit', 'profitability', 'dailyDelta', 'allocation']) {
      assert.ok(Number.isFinite(r[k]), k);
    }
  });
});
