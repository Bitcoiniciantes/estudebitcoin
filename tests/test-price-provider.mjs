/* priceProvider: STOCK via Worker (fallback Stooq) + name.
 * Roda com: node --test test-price-provider.mjs
 * Carrega o priceProvider REAL com fetch stub programável.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../assets/js/portfolio/priceProvider.js', import.meta.url), 'utf8');

function mount(fetchStub) {
  const sandbox = {
    console,
    fetch: fetchStub,
    AbortController,
    setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'priceProvider.js' });
  return sandbox.PriceProvider;
}

const okJson = (obj) => ({ ok: true, json: () => Promise.resolve(obj) });
const okText = (txt) => ({ ok: true, text: () => Promise.resolve(txt) });

describe('priceProvider STOCK', () => {
  it('usa o Worker (mesma fonte dos cards) e traz name', async () => {
    let url = '';
    const PP = mount((u) => { url = String(u); return Promise.resolve(okJson({ quotes: [{ symbol: 'AAPL', price: 220, changePct: 1.25, name: 'APPLE' }] })); });
    const q = await PP.getQuote('AAPL', 'STOCK');
    assert.ok(url.includes('/api/quotes?assets=AAPL'), 'chama o Worker: ' + url);
    assert.equal(q.price, 220);
    assert.equal(q.dailyVariation, 1.25);
    assert.equal(q.name, 'APPLE');
    assert.equal(q.source, 'worker');
  });

  it('Worker vazio -> fallback Stooq', async () => {
    const PP = mount((u) => {
      u = String(u);
      if (u.includes('stooq.com')) return Promise.resolve(okText('Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-09-11,22:00,218,221,217,220,1000'));
      return Promise.resolve(okJson({ quotes: [] }));
    });
    const q = await PP.getQuote('aapl', 'STOCK');
    assert.equal(q.price, 220);
    assert.equal(q.source, 'stooq');
  });

  it('Worker com símbolo divergente -> ignora e usa Stooq', async () => {
    const PP = mount((u) => {
      u = String(u);
      if (u.includes('stooq.com')) return Promise.resolve(okText('Symbol,Date,Time,Open,High,Low,Close,Volume\nMSTR.US,2026-09-11,22:00,130,135,129,133.5,1000'));
      return Promise.resolve(okJson({ quotes: [{ symbol: 'A', price: 999, changePct: 0.1, name: 'Agilent Technologies, Inc.' }] }));
    });
    const q = await PP.getQuote('MSTR', 'STOCK');
    assert.equal(q.source, 'stooq', 'quote errada do Worker descartada');
    assert.equal(q.price, 133.5);
    assert.notEqual(q.name, 'Agilent Technologies, Inc.');
  });

  it('tudo falha -> null (UI mantém manual)', async () => {
    const PP = mount(() => Promise.reject(new Error('net down')));
    assert.equal(await PP.getQuote('AAPL', 'STOCK'), null);
    assert.equal(await PP.getQuote('BTC', 'CRYPTO'), null);
  });

  it('CRYPTO segue Binance, sem name', async () => {
    const PP = mount(() => Promise.resolve(okJson({ lastPrice: '67000', priceChangePercent: '2.5' })));
    const q = await PP.getQuote('BTC', 'CRYPTO');
    assert.equal(q.price, 67000);
    assert.equal(q.dailyVariation, 2.5);
    assert.equal(q.source, 'binance');
  });
});
