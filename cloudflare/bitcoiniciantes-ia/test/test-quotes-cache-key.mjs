import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
const cache = new Map();
const upstream = [];
const failing = new Set();
let stalled = null;

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
    if (stalled) await stalled;
    if (failing.has(symbol)) return { ok: false, status: 503 };
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
  assert.deepEqual(Object.keys(reversed).sort(), ['quotes', 'updatedAt', 'window']);
  assert.equal(typeof reversed.window, 'string');
  assert.equal(typeof reversed.updatedAt, 'string');
  assert.ok(Array.isArray(reversed.quotes));
  assert.deepEqual(Object.keys(reversed.quotes[0]).sort(), [
    'baseClose', 'baseTime', 'changePct', 'closes', 'currency', 'name', 'price', 'symbol', 'volume',
  ]);
  assert.equal(typeof reversed.quotes[0].price, 'number');
  assert.ok(Array.isArray(reversed.quotes[0].closes));
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

test('equivalent concurrent requests share Yahoo work and keep individual response order', async () => {
  const beforeCalls = upstream.length;
  let release;
  stalled = new Promise((resolve) => { release = resolve; });
  try {
    const first = quotes('COALA1,COALA2');
    const second = quotes('COALA2,COALA1,COALA2');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(upstream.length - beforeCalls, 2);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a.quotes.map((quote) => quote.symbol), ['COALA1', 'COALA2']);
    assert.deepEqual(b.quotes.map((quote) => quote.symbol), ['COALA2', 'COALA1', 'COALA2']);
    assert.equal(upstream.length - beforeCalls, 2);
  } finally {
    release();
    stalled = null;
  }
});

test('failed quotes are not cached and a later request retries', async () => {
  failing.add('FAIL1');
  const beforeCalls = upstream.length;
  try {
    assert.deepEqual((await quotes('FAIL1')).quotes, []);
    assert.deepEqual((await quotes('FAIL1')).quotes, []);
    assert.equal(upstream.length - beforeCalls, 2);
  } finally {
    failing.delete('FAIL1');
  }
  assert.deepEqual((await quotes('FAIL1')).quotes.map((quote) => quote.symbol), ['FAIL1']);
  assert.equal(upstream.length - beforeCalls, 3);
});

test('partial Yahoo failure does not lock a missing symbol into cache', async () => {
  failing.add('PART2');
  try {
    assert.deepEqual((await quotes('PART1,PART2')).quotes.map((quote) => quote.symbol), ['PART1']);
  } finally {
    failing.delete('PART2');
  }
  assert.deepEqual((await quotes('PART2,PART1')).quotes.map((quote) => quote.symbol), ['PART2', 'PART1']);
});

test('common, 3y, and 1wk windows retain their respective TTLs', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    for (const [symbol, window, ttl] of [
      ['TTL20', '24h', 20_000],
      ['TTL3Y', '3y', 60_000],
      ['TTL1W', '1wk', 3_600_000],
    ]) {
      const beforeCalls = upstream.length;
      await quotes(symbol, window);
      now += ttl - 1;
      await quotes(symbol, window);
      assert.equal(upstream.length - beforeCalls, 1, `${window} cache remains valid`);
      now += 1;
      await quotes(symbol, window);
      assert.equal(upstream.length - beforeCalls, 2, `${window} cache expires`);
    }
  } finally {
    Date.now = realNow;
  }
});

test('isolate cache evicts old entries after its size limit', async () => {
  const beforeCalls = upstream.length;
  await quotes('CAP00');
  for (let i = 1; i <= 64; i += 1) await quotes(`CAP${String(i).padStart(2, '0')}`);
  assert.equal(upstream.length - beforeCalls, 65);
  await quotes('CAP64');
  assert.equal(upstream.length - beforeCalls, 65);
  await quotes('CAP00');
  assert.equal(upstream.length - beforeCalls, 66);
});
