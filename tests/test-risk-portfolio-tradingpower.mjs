/** Preservação de tradingPower no Risk Engine Multiativos.
 * Run: node --test tests/test-risk-portfolio-tradingpower.mjs
 * Garante que a compactação visual não altera/preserva tradingPower no estado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const PAGE = new URL('../index.html', import.meta.url).href;
const VALUES = [5000, 1234.56, 0, null];

async function open(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.routeWebSocket('**/*', ws => ws.close());
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(150);
  return { page, errors };
}

async function installMemSync(page) {
  await page.evaluate(() => {
    window.__tpMem = null;
    window.__tpSaves = [];
    window.PanelSync.saveLocal = function (panel, params) {
      const clone = JSON.parse(JSON.stringify(params));
      window.__tpSaves.push(clone);
      window.__tpMem = clone;
      return true;
    };
    window.PanelSync.loadLocal = function (panel) {
      if (panel !== 'risk_portfolio' || !window.__tpMem) return null;
      return { params: JSON.parse(JSON.stringify(window.__tpMem)), owner: 'u1', updatedAt: new Date().toISOString() };
    };
  });
}

const auth = (page, id) => page.evaluate((uid) => {
  window.dispatchEvent(new CustomEvent('estudebitcoin:auth-change', {
    detail: { user: uid ? { id: uid, email: uid + '@test.local' } : null }
  }));
}, id);

test('tradingPower preservado após load → edit → save → reload para 5000, 1234.56, 0, null', async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  });
  try {
    for (const tradingPower of VALUES) {
      const { page, errors } = await open(browser);
      await installMemSync(page);

      // Carrega estado com tradingPower controlado e autentica para permitir save.
      await page.evaluate((tp) => {
        window.RiskPortfolioPanel.applyState({
          schemaVersion: 3,
          equityBasis: 'deposited',
          model: 'quantfury-account-balance-simulation',
          referenceBalance: 3000,
          referenceTimestamp: '2026-01-01T00:00:00Z',
          referencePrices: {},
          settings: { initialWealth: null, tradingPower: tp },
          positions: [
            { id: 'rp-CRYPTO-BTC', market: 'CRYPTO', symbol: 'BTC', side: 'LONG', quantity: 0.01, averagePrice: 60000 }
          ]
        });
      }, tradingPower);
      await auth(page, 'u1');
      await page.waitForTimeout(100);

      // Edita uma posição (dispara save via change).
      await page.fill('.rp-row[data-index="0"] input[data-field="quantity"]', '0,02');
      await page.locator('.rp-row[data-index="0"] input[data-field="quantity"]').dispatchEvent('change');
      await page.waitForTimeout(150);

      const saves = await page.evaluate(() => window.__tpSaves);
      assert.ok(saves.length >= 1, `deve salvar após edição (tp=${tradingPower})`);
      const lastSave = saves[saves.length - 1];
      assert.equal(lastSave.settings.tradingPower, tradingPower, `payload salvo deve preservar tradingPower=${tradingPower}`);

      // Recarrega, reinstala sync em memória com o estado salvo e reautentica.
      const savedPayload = await page.evaluate(() => JSON.parse(JSON.stringify(window.__tpMem)));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
      await page.evaluate((saved) => {
        window.__tpMem = saved;
        window.__tpSaves = [];
        window.PanelSync.saveLocal = function (panel, params) {
          const clone = JSON.parse(JSON.stringify(params));
          window.__tpSaves.push(clone);
          window.__tpMem = clone;
          return true;
        };
        window.PanelSync.loadLocal = function (panel) {
          if (panel !== 'risk_portfolio' || !window.__tpMem) return null;
          return { params: JSON.parse(JSON.stringify(window.__tpMem)), owner: 'u1', updatedAt: new Date().toISOString() };
        };
      }, savedPayload);
      await auth(page, 'u1');
      await page.waitForTimeout(150);

      const state = await page.evaluate(() => window.RiskPortfolioPanel.getState());
      assert.equal(state.settings.tradingPower, tradingPower, `tradingPower deve permanecer ${tradingPower} após reload`);
      assert.equal(state.positions[0].quantity, 0.02, `edição deve persistir (tp=${tradingPower})`);

      // Salva novamente após reload para garantir round-trip estável.
      await page.fill('.rp-row[data-index="0"] input[data-field="averagePrice"]', '61000');
      await page.locator('.rp-row[data-index="0"] input[data-field="averagePrice"]').dispatchEvent('change');
      await page.waitForTimeout(150);
      const saves2 = await page.evaluate(() => window.__tpSaves);
      assert.ok(saves2.length >= 1);
      assert.equal(saves2[saves2.length - 1].settings.tradingPower, tradingPower, `round-trip 2 preserva tradingPower=${tradingPower}`);

      assert.deepEqual(errors.filter(e => !/ERR_FAILED|Failed to fetch|Klines error/i.test(e)), [], `sem erros inesperados (tp=${tradingPower})`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
