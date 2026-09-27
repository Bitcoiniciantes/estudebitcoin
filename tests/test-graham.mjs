/* Testes do Graham (Preço Justo de Benjamin Graham).
 * Roda com: node --test test-graham.mjs
 * Só a função pura, o veredito e o mapeamento de payload — sem DOM, sem rede.
 * Rede/cache são exercitados no QA headless, não aqui. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../assets/js/portfolio/graham.js');

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

describe('calcularPrecoJustoGraham (pura)', () => {
  it('1. caso realista: sqrt(22.5 × LPA × VPA)', () => {
    // LPA 10.348 (PETR4 na brapi) × VPA 40 → sqrt(22.5×10.348×40) ≈ 96.516
    const r = G.calcularPrecoJustoGraham(10.348, 40);
    assert.ok(approx(r, Math.sqrt(22.5 * 10.348 * 40), 1e-9), `fair=${r}`);
  });
  it('2. LPA negativo → null (nunca finge resultado)', () => {
    assert.equal(G.calcularPrecoJustoGraham(-2.5, 40), null);
  });
  it('3. VPA negativo → null', () => {
    assert.equal(G.calcularPrecoJustoGraham(10.348, -1), null);
  });
  it('4. zero → null', () => {
    assert.equal(G.calcularPrecoJustoGraham(0, 40), null);
    assert.equal(G.calcularPrecoJustoGraham(10.348, 0), null);
  });
  it('5. ausentes / NaN / não-numéricos → null', () => {
    assert.equal(G.calcularPrecoJustoGraham(null, 40), null);
    assert.equal(G.calcularPrecoJustoGraham(10.348, undefined), null);
    assert.equal(G.calcularPrecoJustoGraham(NaN, 40), null);
    assert.equal(G.calcularPrecoJustoGraham('abc', 40), null);
  });
  it('6. valores gigantes não quebram (finito > 0)', () => {
    const r = G.calcularPrecoJustoGraham(1e9, 1e9);
    assert.ok(Number.isFinite(r) && r > 0);
  });
});

describe('verdict', () => {
  it('7. abaixo do justo → subvalorizado', () => {
    assert.equal(G.verdict(90, 100), 'subvalorizado');
  });
  it('8. acima do justo → sobrevalorizado', () => {
    assert.equal(G.verdict(110, 100), 'sobrevalorizado');
  });
  it('9. dentro de ±2% → justo', () => {
    assert.equal(G.verdict(99, 100), 'justo');
    assert.equal(G.verdict(101, 100), 'justo');
    assert.equal(G.verdict(100, 100), 'justo');
  });
  it('10. sem preço ou sem justo → null', () => {
    assert.equal(G.verdict(null, 100), null);
    assert.equal(G.verdict(90, null), null);
    assert.equal(G.verdict(0, 100), null);
  });
});

describe('mapPayload (_test)', () => {
  it('11. payload brapi cru (results[]) → lpa/vpa/moeda/nome', () => {
    const m = G._test.mapPayload('PETR4', {
      results: [{ symbol: 'PETR4', longName: 'Petróleo Brasileiro S.A. - Petrobras', earningsPerShare: 10.3482633, regularMarketPrice: 47.99, currency: 'BRL' }]
    }, 'brapi-anon');
    assert.equal(m.ticker, 'PETR4');
    assert.equal(m.name, 'Petróleo Brasileiro S.A. - Petrobras');
    assert.ok(approx(m.lpa, 10.3482633, 1e-9));
    assert.equal(m.vpa, null); // anônima não traz VPA
    assert.equal(m.currency, 'BRL');
  });
  it('12. payload do Worker normalizado passa direto', () => {
    const m = G._test.mapPayload('AAPL', { name: 'Apple Inc.', lpa: 6.5, vpa: 4.2, price: 200, currency: 'USD' }, 'worker');
    assert.equal(m.name, 'Apple Inc.');
    assert.equal(m.lpa, 6.5);
    assert.equal(m.vpa, 4.2);
  });
  it('13. payload vazio/inválido → null ou sem lpa/vpa', () => {
    assert.equal(G._test.mapPayload('X', null, 'worker'), null);
    const m = G._test.mapPayload('X', {}, 'worker');
    assert.equal(m.lpa, null);
    assert.equal(m.vpa, null);
  });
});

describe('símbolos e moeda (_test)', () => {
  it('14. normTicker padroniza', () => {
    assert.equal(G._test.normTicker(' petr4 '), 'PETR4');
    assert.equal(G._test.normTicker('aapl'), 'AAPL');
  });
  it('15. looksB3 distingue B3 de EUA', () => {
    assert.equal(G._test.looksB3('PETR4'), true);
    assert.equal(G._test.looksB3('VALE3'), true);
    assert.equal(G._test.looksB3('AAPL'), false);
    assert.equal(G._test.looksB3('^GSPC'), false);
  });
  it('16. toUSD converte BRL com taxa e preserva USD', () => {
    G._test.setRate(5);
    assert.equal(G._test.toUSD(100, 'BRL'), 20);
    assert.equal(G._test.toUSD(100, 'USD'), 100);
    assert.equal(G._test.toUSD(100, null), 100);
    G._test.setRate(null);
    assert.equal(G._test.toUSD(100, 'BRL'), null); // sem taxa: sem conversão
  });
});
