/* Testes dos módulos compartilhados das Functions (Fase 2).
 * Roda com: node --test test-carteira-functions.mjs  (a partir de functions/)
 * Sem firebase-admin, sem rede, sem emulador.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizarTicker, normalizarTipo } = require('./carteira/normalizacao.js');
const { consolidarPosicao, reconstruirPosicaoDosLotes } = require('./carteira/calculos.js');
const { validarEntradaAporte } = require('./carteira/validacao.js');

const approx = (a, b, eps = 1e-9) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

describe('normalizacao', () => {
  it('ticker: trim + upper + / vira -', () => {
    assert.equal(normalizarTicker('btc'), 'BTC');
    assert.equal(normalizarTicker(' BTC/USDT '), 'BTC-USDT');
    assert.equal(normalizarTicker('petr4'), 'PETR4');
  });
  it('tipo: case-insensitive, resto null', () => {
    assert.equal(normalizarTipo('CRYPTO'), 'crypto');
    assert.equal(normalizarTipo('Stock'), 'stock');
    assert.equal(normalizarTipo('ACAO'), null);
    assert.equal(normalizarTipo(''), null);
  });
});

describe('consolidarPosicao', () => {
  it('compra pondera o médio', () => {
    const r = consolidarPosicao(
      { quantity: 0.5, avgPrice: 55000 },
      { quantity: 0.51345678, purchasePrice: 30000, currentPrice: 31000, dailyChangePercent: 1 });
    assert.ok(approx(r.quantity, 1.01345678, 1e-9));
    assert.ok(approx(r.averagePrice ?? r.avgPrice, 42903.7034 / 1.01345678, 1e-6));
    assert.equal(r.currentPrice, 31000);
  });
  it('venda desconta e mantém o médio', () => {
    const r = consolidarPosicao(
      { quantity: 1.5, avgPrice: 50000 },
      { quantity: -0.5, purchasePrice: 70000, currentPrice: 70000, dailyChangePercent: 0 });
    assert.equal(r.quantity, 1);
    assert.equal(r.avgPrice, 50000);
  });
  it('venda total zera (chamador fecha com closedAt)', () => {
    const r = consolidarPosicao(
      { quantity: 1, avgPrice: 50000 },
      { quantity: -1, purchasePrice: 70000, currentPrice: 70000, dailyChangePercent: 0 });
    assert.equal(r.quantity, 0);
    assert.equal(r.avgPrice, 0);
  });
  it('venda além do saldo joga erro', () => {
    assert.throws(() => consolidarPosicao(
      { quantity: 1, avgPrice: 50000 },
      { quantity: -1.5, purchasePrice: 70000, currentPrice: 70000, dailyChangePercent: 0 }),
      /Saldo insuficiente/);
  });
});

describe('reconstruirPosicaoDosLotes', () => {
  it('médio só sobre positivos', () => {
    const r = reconstruirPosicaoDosLotes([
      { quantity: 1, price: 45000 },
      { quantity: 0.5, price: 60000 },
      { quantity: -0.5, price: 70000 },
    ]);
    assert.equal(r.quantity, 1);
    assert.equal(r.avgPrice, 50000);
    assert.equal(r.closed, false);
  });
  it('zerou → closed', () => {
    const r = reconstruirPosicaoDosLotes([
      { quantity: 1, price: 45000 },
      { quantity: -1, price: 70000 },
    ]);
    assert.equal(r.quantity, 0);
    assert.equal(r.closed, true);
  });
  it('remoção que negativaria joga erro', () => {
    assert.throws(() => reconstruirPosicaoDosLotes([
      { quantity: -1, price: 70000 },
    ]), /negativo/);
  });
});

describe('validarEntradaAporte', () => {
  it('aceita CRYPTO/Fase 1 e normaliza', () => {
    const r = validarEntradaAporte({
      ticker: 'btc', name: 'Bitcoin', type: 'CRYPTO',
      quantity: 0.5, purchasePrice: 55000, currentPrice: 67000, dailyChangePercent: 2.31,
    });
    assert.deepEqual(r.erros, []);
    assert.equal(r.ticker, 'BTC');
    assert.equal(r.type, 'crypto');
  });
  it('aceita venda (negativo) e rejeita zero', () => {
    const ok = validarEntradaAporte({
      ticker: 'BTC', name: 'B', type: 'crypto',
      quantity: -1, purchasePrice: 70000, currentPrice: 70000,
    });
    assert.deepEqual(ok.erros, []);
    const zero = validarEntradaAporte({
      ticker: 'BTC', name: 'B', type: 'crypto',
      quantity: 0, purchasePrice: 70000, currentPrice: 70000,
    });
    assert.ok(zero.erros.some((e) => e.includes('quantity')));
  });
  it('dailyChangePercent ausente vira 0; undefined nunca passa', () => {
    const r = validarEntradaAporte({
      ticker: 'BTC', name: 'B', type: 'crypto',
      quantity: 1, purchasePrice: 1, currentPrice: 1,
    });
    assert.equal(r.dailyChangePercent, 0);
  });
});
