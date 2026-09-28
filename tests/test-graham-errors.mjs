/* Testes de erros HTTP do Graham (UX/disparo — sem tocar no cálculo).
 * Roda com: node --test tests/test-graham-errors.mjs
 * fetch global é stubado por URL (Worker x brapi anônima); sem DOM, sem rede.
 * Cobre: 429+rate_limited, precedência sobre o 404 do fallback, 404,
 * 5xx, preservação de err.status/err.code e cálculo intacto com dados válidos. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../assets/js/portfolio/graham.js');

function resStub({ ok, status, body, jsonFails = false }) {
  return {
    ok,
    status,
    json: () => (jsonFails ? Promise.reject(new Error('bad json')) : Promise.resolve(body)),
  };
}

// handlers: { worker, anon, search }
function stubFetch(handlers) {
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/tickers/search')) {
      const r = (handlers.search || notFound)(u);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }
    if (u.includes('/api/fundamentals')) return Promise.resolve(handlers.worker(u));
    if (u.includes('brapi.dev')) {
      const r = handlers.anon(u);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }
    return Promise.reject(new Error('URL inesperada: ' + u));
  };
}

const notFound = () => resStub({ ok: false, status: 404, body: { error: 'not found' } });

beforeEach(() => {
  G._test.clearCache();
});

describe('fetchJSON preserva status/code (_test)', () => {
  it('4a. 429 com corpo JSON {code:"rate_limited"} → err.status + err.code', async () => {
    stubFetch({
      worker: () => resStub({ ok: false, status: 429, body: { error: 'rate limit exceeded', code: 'rate_limited' } }),
      anon: notFound,
    });
    await assert.rejects(G._test.fetchJSON('https://x/api/fundamentals?symbol=AAPL'), (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.code, 'rate_limited');
      return true;
    });
  });
  it('4b. 503 com corpo não-JSON → err.status preservado, sem code', async () => {
    stubFetch({
      worker: () => resStub({ ok: false, status: 503, body: '<html>erro</html>', jsonFails: true }),
      anon: notFound,
    });
    await assert.rejects(G._test.fetchJSON('https://x/api/fundamentals?symbol=AAPL'), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, undefined);
      return true;
    });
  });
});

describe('getFundamentals classifica o erro', () => {
  it('1. Worker 429 + anônima 404 → rate_limited (mensagem do limite)', async () => {
    stubFetch({
      worker: () => resStub({ ok: false, status: 429, body: { error: 'rate limit exceeded', code: 'rate_limited' } }),
      anon: notFound,
    });
    await assert.rejects(G.getFundamentals('AAPL'), (err) => {
      assert.equal(err.kind, 'rate_limited');
      assert.equal(err.status, 429);
      assert.equal(err.code, 'rate_limited');
      assert.equal(G.messageForKind(err.kind), 'Muitas consultas hoje, tente novamente mais tarde.');
      return true;
    });
  });
  it('1b. precedência: Worker 429 vence mesmo com anônima 404 (nunca "Verifique ticker")', async () => {
    stubFetch({
      worker: () => resStub({ ok: false, status: 429, body: { error: 'x', code: 'rate_limited' } }),
      anon: () => resStub({ ok: false, status: 404, body: {} }),
    });
    const err = await G.getFundamentals('MSFT').catch((e) => e);
    assert.equal(err.kind, 'rate_limited');
    assert.notEqual(G.messageForKind(err.kind), 'Verifique ticker.');
  });
  it('2. Worker 404 + anônima 404 → not_found ("Verifique ticker")', async () => {
    stubFetch({ worker: notFound, anon: notFound });
    await assert.rejects(G.getFundamentals('NDVA'), (err) => {
      assert.equal(err.kind, 'not_found');
      assert.equal(G.messageForKind(err.kind), 'Verifique ticker.');
      return true;
    });
  });
  it('2b. Worker 200 sem dados + anônima 404 → null (ticker sem cobertura, modal explica)', async () => {
    stubFetch({
      worker: () => resStub({ ok: true, status: 200, body: { symbol: 'ZZZ1', price: 10, currency: 'BRL' } }),
      anon: notFound,
    });
    assert.equal(await G.getFundamentals('ZZZ1'), null);
  });
  it('3. Worker 500 + anônima inacessível → transient (falha temporária)', async () => {
    stubFetch({
      worker: () => resStub({ ok: false, status: 500, body: {}, jsonFails: true }),
      anon: () => new Error('rede fora'),
    });
    await assert.rejects(G.getFundamentals('PETR4'), (err) => {
      assert.equal(err.kind, 'transient');
      assert.equal(G.messageForKind(err.kind), 'Não foi possível carregar os dados. Tente novamente.');
      return true;
    });
  });
});

describe('cálculo intacto com dados válidos', () => {
  it('8. Worker 200 com LPA/VPA → resolve dados e o justo confere', async () => {
    stubFetch({
      worker: () => resStub({ ok: true, status: 200, body: { name: 'Apple Inc.', lpa: 6.5, vpa: 4.2, price: 200, currency: 'USD' } }),
      anon: notFound,
    });
    const fund = await G.getFundamentals('AAPL');
    assert.equal(fund.name, 'Apple Inc.');
    assert.equal(G.calcularPrecoJustoGraham(fund.lpa, fund.vpa), Math.sqrt(22.5 * 6.5 * 4.2));
  });
});

describe('lookupTickerName (ao vivo: search, sem rate limit)', () => {
  const catalog = () => resStub({
    ok: true,
    status: 200,
    body: {
      query: 'PETR',
      results: [
        { ticker: 'PETR4', name: 'Petróleo Brasileiro S.A. - Petrobras' },
        { ticker: 'PETR3', name: 'Petróleo Brasileiro S.A. - Petrobras ON' },
      ],
      fetchedAt: '2026-01-01T00:00:00.000Z',
    },
  });
  it('9. match exato retorna o nome via /api/tickers/search (nunca fundamentals)', async () => {
    const seen = [];
    globalThis.fetch = (url) => {
      seen.push(String(url));
      return Promise.resolve(catalog());
    };
    assert.equal(await G.lookupTickerName('PETR4'), 'Petróleo Brasileiro S.A. - Petrobras');
    assert.ok(seen.length >= 1 && seen.every((u) => u.includes('/api/tickers/search?name=')), `urls: ${seen}`);
    assert.ok(!seen.some((u) => u.includes('fundamentals')), 'search não toca fundamentals');
  });
  it('10. sem match exato → null (EUA fora do catálogo, sem erro)', async () => {
    stubFetch({ worker: notFound, anon: notFound, search: catalog });
    assert.equal(await G.lookupTickerName('AAPL'), null);
    assert.equal(await G.lookupTickerName('PETR'), null); // parcial não é exato
  });
  it('11. <2 letras → null sem fetch', async () => {
    let n = 0;
    globalThis.fetch = () => { n++; return Promise.reject(new Error('não deveria chamar')); };
    assert.equal(await G.lookupTickerName('P'), null);
    assert.equal(await G.lookupTickerName(''), null);
    assert.equal(n, 0);
  });
  it('12. falha de rede → null (nunca quebra a digitação)', async () => {
    globalThis.fetch = () => Promise.reject(new Error('rede fora'));
    assert.equal(await G.lookupTickerName('PETR4'), null);
  });
});
