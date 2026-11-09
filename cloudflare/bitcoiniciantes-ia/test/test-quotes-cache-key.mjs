import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
const cache = new Map();
const upstream = [];
const failing = new Set();
const scripted = new Map();
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
    const outcome = scripted.get(symbol)?.shift();
    if (failing.has(symbol) || outcome?.fail) return { ok: false, status: 503 };
    const time = Math.floor(Date.now() / 1000);
    return {
      ok: true,
      json: async () => ({ chart: { result: [{
        meta: { symbol, shortName: `${symbol} name`, currency: 'USD' },
        timestamp: [time - 86400, time],
        indicators: { quote: [{ close: [10, outcome?.price ?? 11], volume: [100, 110] }] },
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
  assert.equal(upstream.length, 5, 'duplicate occurrences fetch independently');

  const otherWindow = await quotes('TSLA,NVDA', '7d');
  assert.equal(otherWindow.window, '7d');
  assert.equal(upstream.length, 7);

  const freshDuplicate = await quotes('AAPL,AAPL');
  assert.deepEqual(freshDuplicate.quotes.map((quote) => quote.symbol), ['AAPL', 'AAPL']);
  assert.equal(upstream.length, 9);
  const sameSet = await quotes('AAPL');
  assert.deepEqual(sameSet.quotes, [freshDuplicate.quotes[0]]);
  assert.equal(upstream.length, 10, 'duplicate request did not populate unique-symbol cache');
});

test('equivalent concurrent requests without duplicates share Yahoo work and keep individual order', async () => {
  const beforeCalls = upstream.length;
  let release;
  stalled = new Promise((resolve) => { release = resolve; });
  try {
    const first = quotes('COALA1,COALA2');
    const second = quotes('COALA2,COALA1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(upstream.length - beforeCalls, 2);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a.quotes.map((quote) => quote.symbol), ['COALA1', 'COALA2']);
    assert.deepEqual(b.quotes.map((quote) => quote.symbol), ['COALA2', 'COALA1']);
    assert.equal(upstream.length - beforeCalls, 2);
  } finally {
    release();
    stalled = null;
  }
});

test('repeated symbol preserves separate Yahoo values and the legacy JSON shape', async () => {
  scripted.set('DUPVALUE', [{ price: 11 }, { price: 12 }]);
  const beforeCalls = upstream.length;
  const first = await quotes('DUPVALUE,DUPVALUE');
  assert.deepEqual(first.quotes.map((quote) => quote.price), [11, 12]);
  assert.equal(upstream.length - beforeCalls, 2);
  assert.deepEqual(Object.keys(first), ['window', 'updatedAt', 'quotes']);
  assert.equal(first.window, '24h');
  assert.equal(typeof first.updatedAt, 'string');
  assert.deepEqual(Object.keys(first.quotes[0]), [
    'symbol', 'name', 'price', 'changePct', 'volume', 'currency', 'closes', 'baseClose', 'baseTime',
  ]);
  assert.deepEqual(Object.keys(first.quotes[1]), Object.keys(first.quotes[0]));
  assert.equal(typeof first.quotes[0].changePct, 'number');
  assert.equal(typeof first.quotes[0].volume, 'number');
  assert.equal(typeof first.quotes[0].currency, 'string');
  assert.ok(Array.isArray(first.quotes[0].closes));
});

test('repeated symbol preserves a successful occurrence after another fails', async () => {
  scripted.set('DUPFAIL', [{ fail: true }, { price: 12 }]);
  const beforeCalls = upstream.length;
  const body = await quotes('LEFT1,DUPFAIL,DUPFAIL,RIGHT1');
  assert.deepEqual(body.quotes.map((quote) => quote.symbol), ['LEFT1', 'DUPFAIL', 'RIGHT1']);
  assert.deepEqual(body.quotes.map((quote) => quote.price), [11, 12, 11]);
  assert.equal(upstream.length - beforeCalls, 4);
  scripted.set('DUPFAIL', [{ price: 13 }, { price: 14 }]);
  const retry = await quotes('LEFT1,DUPFAIL,DUPFAIL,RIGHT1');
  assert.deepEqual(retry.quotes.map((quote) => quote.price), [11, 13, 14, 11]);
});

test('simultaneous equivalent duplicate requests keep their own Yahoo occurrences', async () => {
  const beforeCalls = upstream.length;
  scripted.set('DUPSIM', [{ price: 11 }, { price: 12 }, { price: 13 }, { price: 14 }]);
  const [a, b] = await Promise.all([
    quotes('DUPSIM,DUPSIM'),
    quotes('DUPSIM,DUPSIM'),
  ]);
  assert.deepEqual(a.quotes.map((quote) => quote.price), [11, 12]);
  assert.deepEqual(b.quotes.map((quote) => quote.price), [13, 14]);
  assert.equal(upstream.length - beforeCalls, 4);
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

test('pending limit keeps equivalent tracked requests coalesced and serves overflow directly', async () => {
  const beforeCalls = upstream.length;
  let release;
  stalled = new Promise((resolve) => { release = resolve; });
  const tracked = Array.from({ length: 64 }, (_, i) => quotes(`PEND${String(i).padStart(2, '0')}`));
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(upstream.length - beforeCalls, 64);
    const overflowA = quotes('OVERFLOW1');
    const overflowB = quotes('OVERFLOW1');
    const trackedAgain = quotes('PEND00');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(upstream.length - beforeCalls, 66, 'existing key coalesces; both overflow requests run directly');
    release();
    const bodies = await Promise.all([...tracked, overflowA, overflowB, trackedAgain]);
    assert.ok(bodies.every((body) => body.quotes.length === 1));
  } finally {
    release();
    stalled = null;
    await Promise.allSettled(tracked);
  }
  await quotes('OVERFLOW1');
  assert.equal(upstream.length - beforeCalls, 67, 'overflow response was not cached');
  await quotes('OVERFLOW1');
  assert.equal(upstream.length - beforeCalls, 67, 'subsequent tracked response is cached');
});

test('pending slots are released after failed work and allow a later coalesced retry', async () => {
  const symbols = Array.from({ length: 64 }, (_, i) => `PFAIL${String(i).padStart(2, '0')}`);
  for (const symbol of symbols) failing.add(symbol);
  let release;
  stalled = new Promise((resolve) => { release = resolve; });
  const pending = symbols.map((symbol) => quotes(symbol));
  try {
    release();
    const bodies = await Promise.all(pending);
    assert.ok(bodies.every((body) => body.quotes.length === 0));
  } finally {
    release();
    stalled = null;
    for (const symbol of symbols) failing.delete(symbol);
    await Promise.allSettled(pending);
  }
  const beforeRetry = upstream.length;
  let releaseRetry;
  stalled = new Promise((resolve) => { releaseRetry = resolve; });
  try {
    const first = quotes('PFAIL00');
    const second = quotes('PFAIL00');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(upstream.length - beforeRetry, 1, 'freed slot coalesces the retry');
    releaseRetry();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a.quotes, b.quotes);
    assert.equal(a.quotes.length, 1);
  } finally {
    releaseRetry();
    stalled = null;
  }
});
