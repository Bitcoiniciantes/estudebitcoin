import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
const cache = new Map();
const upstream = [];

before(() => {
  globalThis.caches = {
    default: {
      async match(key) { return cache.get(key)?.clone() || null; },
      async put(key, response) { cache.set(key, response.clone()); },
    },
  };
  globalThis.fetch = async (url) => {
    const symbol = decodeURIComponent(String(url).match(/\/chart\/([^?]+)/)?.[1] || '');
    upstream.push(symbol);
    const time = Math.floor(Date.now() / 1000);
    return {
      ok: true,
      json: async () => ({ chart: { result: [{
        meta: { symbol, shortName: `${symbol} name`, currency: 'USD' },
        timestamp: [time - 86400, time],
        indicators: { quote: [{ close: [10, 11], volume: [100, 110] }] },
      }] } }),
    };
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
});

async function quotes(assets, window = '24h') {
  const request = new Request(`https://test/api/quotes?assets=${encodeURIComponent(assets)}&window=${window}`);
  const response = await worker.fetch(request, {});
  assert.equal(response.status, 200);
  return response.json();
}

test('canonical key reuses equivalent sets while each response keeps requested order and duplicates', async () => {
  const first = await quotes('NVDA,TSLA');
  assert.deepEqual(first.quotes.map((quote) => quote.symbol), ['NVDA', 'TSLA']);
  assert.equal(upstream.length, 2);

  const reversed = await quotes('TSLA,NVDA');
  assert.deepEqual(reversed.quotes.map((quote) => quote.symbol), ['TSLA', 'NVDA']);
  assert.deepEqual(reversed.quotes[0], first.quotes[1]);
  assert.deepEqual(reversed.quotes[1], first.quotes[0]);
  assert.equal(reversed.updatedAt, first.updatedAt);
  assert.equal(upstream.length, 2);

  const duplicate = await quotes('NVDA,TSLA,NVDA');
  assert.deepEqual(duplicate.quotes.map((quote) => quote.symbol), ['NVDA', 'TSLA', 'NVDA']);
  assert.deepEqual(duplicate.quotes[0], duplicate.quotes[2]);
  assert.equal(upstream.length, 2);

  const otherWindow = await quotes('TSLA,NVDA', '7d');
  assert.equal(otherWindow.window, '7d');
  assert.equal(upstream.length, 4);

  const freshDuplicate = await quotes('AAPL,AAPL');
  assert.deepEqual(freshDuplicate.quotes.map((quote) => quote.symbol), ['AAPL', 'AAPL']);
  assert.equal(upstream.length, 6);
  const sameSet = await quotes('AAPL');
  assert.deepEqual(sameSet.quotes, [freshDuplicate.quotes[0]]);
  assert.equal(upstream.length, 6);
});
