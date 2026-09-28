/* Rate limit de /api/fundamentals (IP-only, fail-open, best-effort).
 * Roda com: node --test test-ratelimit.mjs
 * Importa o Worker REAL com KV (PUBLIC_MARKERS) e fetch stubados; sem rede.
 * Não provoca 429 em produção — tudo local. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { rlKeyFor, rlTtlSeconds, FUND_RL_LIMIT } from '../src/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Stubs ----
function makeKV({ failGet = false, failPut = false, delayMs = 0 } = {}) {
  const map = new Map();
  return {
    map,
    async get(k) {
      if (delayMs) await sleep(delayMs);
      if (failGet) throw new Error('kv-down');
      return map.has(k) ? map.get(k).v : null;
    },
    async put(k, v, opts) {
      if (delayMs) await sleep(delayMs);
      if (failPut) throw new Error('kv-down');
      map.set(k, { v, opts });
    },
  };
}

let upstreamCalls = 0;
function stubFetch() {
  upstreamCalls = 0;
  globalThis.fetch = async (url) => {
    upstreamCalls++;
    const u = String(url);
    if (u.includes('/api/quote/')) {
      return {
        ok: true,
        json: async () => ({ results: [{ symbol: 'PETR4', longName: 'Petróleo Brasileiro S.A.', earningsPerShare: 10, regularMarketPrice: 48, currency: 'BRL' }] }),
      };
    }
    if (u.includes('/stocks/statistics')) {
      return { ok: true, json: async () => ({ results: [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const IP = '9.9.9.9';
function req(symbol = 'PETR4', ip = IP) {
  return new Request(`https://test/api/fundamentals?symbol=${symbol}`, {
    headers: { 'CF-Connecting-IP': ip },
  });
}
function envFor(kv) {
  return { PUBLIC_MARKERS: kv, BRAPI_TOKEN: 'test-token' };
}

describe('rate limit /api/fundamentals', () => {
  beforeEach(() => { stubFetch(); });

  it('1. abaixo do limite: passa e incrementa', async () => {
    const kv = makeKV();
    const res = await worker.fetch(req(), envFor(kv));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'brapi');
    assert.equal(kv.map.size, 1);
    const [[key, stored]] = [...kv.map.entries()];
    assert.ok(key.startsWith('fund:rl:'), 'chave no padrão fund:rl:{data}:{ip}');
    assert.ok(key.endsWith(':' + IP), 'chave termina com o IP');
    assert.equal(stored.v, '1');
    assert.ok(upstreamCalls > 0, 'chamou upstream');
  });

  it('2. contador em 49: passa (vai a 50)', async () => {
    const kv = makeKV();
    const key = rlKeyFor(IP, Date.now());
    kv.map.set(key, { v: '49', opts: {} });
    const res = await worker.fetch(req(), envFor(kv));
    assert.equal(res.status, 200);
    assert.equal(kv.map.get(key).v, '50');
  });

  it('3. contador em 50: retorna 429', async () => {
    const kv = makeKV();
    const key = rlKeyFor(IP, Date.now());
    kv.map.set(key, { v: '50', opts: {} });
    const before = upstreamCalls;
    const res = await worker.fetch(req(), envFor(kv));
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: 'rate limit exceeded', code: 'rate_limited' });
    assert.equal(kv.map.get(key).v, '50', 'não incrementa no bloqueio');
    assert.equal(upstreamCalls, before, '429 não chama nenhum upstream');
  });

  it('4. cache hit não lê nem escreve KV', async () => {
    const kv = makeKV();
    let kvTouched = false;
    const guardKV = {
      async get() { kvTouched = true; throw new Error('must-not-read'); },
      async put() { kvTouched = true; throw new Error('must-not-write'); },
    };
    const cachedBody = { ticker: 'PETR4', lpa: 1, vpa: 2, source: 'brapi', fetchedAt: new Date().toISOString() };
    globalThis.caches = {
      default: {
        async match() {
          return { headers: { get: () => String(Date.now()) }, json: async () => cachedBody };
        },
        async put() {},
      },
    };
    try {
      const res = await worker.fetch(req(), envFor(guardKV));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), cachedBody);
      assert.equal(kvTouched, false, 'KV intocado no hit');
      assert.equal(upstreamCalls, 0, 'sem upstream no hit');
    } finally {
      delete globalThis.caches;
    }
  });

  it('5. GET do KV falhando: fail-open (segue p/ upstream)', async () => {
    const kv = makeKV({ failGet: true });
    const res = await worker.fetch(req(), envFor(kv));
    assert.equal(res.status, 200);
    assert.ok(upstreamCalls > 0);
  });

  it('6. PUT do KV falhando: fail-open (segue p/ upstream)', async () => {
    const kv = makeKV({ failPut: true });
    const res = await worker.fetch(req(), envFor(kv));
    assert.equal(res.status, 200);
    assert.ok(upstreamCalls > 0);
  });

  it('7. expirationTtl até a virada UTC (mínimo 60s)', () => {
    assert.equal(FUND_RL_LIMIT, 50);
    // Meio-dia UTC: ~12h restantes.
    const noon = Date.UTC(2026, 5, 15, 12, 0, 0);
    assert.equal(rlTtlSeconds(noon), 12 * 3600);
    // 10s antes da meia-noite UTC: mínimo de 60s (KV rejeita menos).
    const brink = Date.UTC(2026, 5, 15, 23, 59, 50);
    assert.equal(rlTtlSeconds(brink), 60);
    // 1s antes: também 60.
    assert.equal(rlTtlSeconds(Date.UTC(2026, 5, 15, 23, 59, 59)), 60);
    // Chave carrega data UTC + IP.
    assert.equal(rlKeyFor('1.2.3.4', noon), 'fund:rl:2026-06-15:1.2.3.4');
  });

  it('8. concorrência best-effort com stub lento (documenta não-atomicidade)', async () => {
    const kv = makeKV({ delayMs: 20 });
    const key = rlKeyFor(IP, Date.now());
    kv.map.set(key, { v: '48', opts: {} });
    const rs = await Promise.all([0, 1, 2, 3, 4].map(() => worker.fetch(req(), envFor(kv))));
    // Com GET lento, leituras concorrentes podem ver o mesmo valor: nenhuma
    // chamada pode quebrar; o contador final reflete incremento best-effort.
    assert.ok(rs.every((r) => r.status === 200 || r.status === 429));
    const final = Number(kv.map.get(key).v);
    assert.ok(final >= 49 && final <= 53, `contador final best-effort: ${final}`);
  });

  it('9. sem contador global (só IP)', async () => {
    const kv = makeKV();
    await worker.fetch(req(), envFor(kv));
    const keys = [...kv.map.keys()];
    assert.ok(keys.every((k) => k.startsWith('fund:rl:')), 'só chaves fund:rl:');
    assert.ok(!keys.some((k) => k.includes('global')), 'nenhuma chave global');
  });
});
