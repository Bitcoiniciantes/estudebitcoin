import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const PAGE = new URL('../index.html', import.meta.url).href;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

test('Risk Engine Multiativos: STOCKS é adicionado, cotado pelo Worker e compartilhado no limite de dez', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    let nvdaRequests = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith('file:')) return route.continue();
      if (url.includes('/api/quotes?') && url.includes('NVDA')) {
        nvdaRequests += 1;
        if (nvdaRequests > 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ window: '24h', updatedAt: '2026-11-27T15:08:35.000Z', quotes: [{ symbol: 'NVDA', price: 263.37, currency: 'USD' }] }) });
      }
      return route.abort();
    });
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { document.getElementById('rp-painel').open = true; });
    assert.ok((await page.evaluate(() => window.RiskPortfolioPanel.getState().positions)).every(p => p.market === 'CRYPTO'), 'cenário somente CRIPTO preservado');
    await page.click('#rp-add-toggle');
    await page.click('#rp-tab-stocks');
    await page.fill('#rp-stock-symbol', 'nvda');
    await page.fill('#rp-quantity', '2.5');
    await page.fill('#rp-average', '240');
    await page.click('#rp-add');
    await page.click('#rp-refresh');
    await page.waitForTimeout(120);
    const row = await page.locator('#rp-positions .rp-row').filter({ hasText: 'NVDA' }).textContent();
    assert.match(row, /STOCKS/);
    assert.match(row, /263,37/);
    const state = await page.evaluate(() => window.RiskPortfolioPanel.getState());
    assert.equal(state.schemaVersion, 3);
    assert.equal(state.positions.find(p => p.symbol === 'NVDA').market, 'STOCKS');
    assert.ok(state.positions.some(p => p.market === 'CRYPTO') && state.positions.some(p => p.market === 'STOCKS'), 'carteira mista preserva os dois mercados');
    await page.click('#rp-refresh');
    await page.waitForTimeout(80);
    assert.match(await page.locator('#rp-updated').textContent(), /atrasada/i, 'falha de STOCKS preserva a última cotação e sinaliza atraso');
    assert.match(await page.locator('#rp-positions .rp-row').filter({ hasText: 'NVDA' }).textContent(), /atrasada/i);

    await page.click('#rp-demo-clear');
    await page.click('#rp-add-toggle');
    await page.click('#rp-tab-stocks');
    await page.fill('#rp-stock-symbol', 'NVDA');
    await page.fill('#rp-quantity', '1');
    await page.fill('#rp-average', '240');
    await page.click('#rp-add');
    assert.deepEqual(await page.evaluate(() => window.RiskPortfolioPanel.getState().positions.map(p => p.market)), ['STOCKS'], 'carteira somente STOCKS aceita posição fracionária ou inteira');

    const ten = Array.from({ length: 10 }, (_, i) => ({ id: 'rp-CRYPTO-X' + i, market: 'CRYPTO', symbol: 'X' + i, side: 'LONG', quantity: 1, averagePrice: 1 }));
    const applied = await page.evaluate((positions) => window.RiskPortfolioPanel.applyState({ schemaVersion: 3, equityBasis: 'deposited', model: 'quantfury-account-balance-simulation', referenceBalance: 100, referenceTimestamp: 't', referencePrices: {}, settings: {}, positions }), ten);
    assert.equal(applied, true);
    await page.evaluate(() => {
      const state = window.RiskPortfolioPanel.getState();
      window.RiskPortfolioAdapter.configure({ referenceBalance: state.referenceBalance, referencePrices: state.referencePrices, positions: state.positions, equityBasis: state.equityBasis });
      Array.from({ length: 10 }, (_, i) => window.dispatchEvent(new CustomEvent('estudebitcoin:ticker-price', { detail: { symbol: 'X' + i, price: 1, source: 'test' } })));
    });
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#rp-add-toggle').isDisabled(), true);
    assert.match(await page.locator('#rp-count').textContent(), /10 de 10/);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
