/** QA real do Risk Engine Multicripto: UI, persistência e paridade com o motor.
 * Run: node --test tests/test-risk-portfolio-panel-ui.mjs
 * Screenshots: _archive_local/risk-redesign/ (não publicados).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../_archive_local/risk-redesign/', import.meta.url));
mkdirSync(output, { recursive: true });

test('Risk Engine Multicripto: 5 posições, acúmulo, edição, limite e persistência', async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const panelErrors = [];
    page.on('pageerror', e => panelErrors.push(e.message));
    await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.goto(new URL('../index.html', import.meta.url).href, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { document.getElementById('rp-painel').open = true; });
    await page.waitForTimeout(150);

    // Exemplo pré-preenchido: 5 criptos, saldo demonstrativo US$ 3.000,00 em memória (nada salvo).
    assert.equal(await page.locator('#rp-demo').isVisible(), true, 'aviso de dados de exemplo visível');
    assert.deepEqual(await page.evaluate(() => window.RiskPortfolioPanel.getState().positions.map(p => p.symbol)),
      ['AVAX', 'ETH', 'LINK', 'BTC', 'SOL']);
    assert.equal(await page.evaluate(() => window.RiskPortfolioPanel.getState().referenceBalance), 3000);
    assert.equal(await page.evaluate(() => localStorage.getItem('eb_panel_risk_portfolio')), null, 'exemplo não grava na carteira');
    assert.match(await page.locator('label[for="rp-balance"] .rp-metric-top').textContent(), /Depositado na corretora \(USD\)/, 'campo principal com a nomenclatura pedida');
    assert.equal(await page.locator('#rp-initial').count(), 0, 'capital inicial removido da seção essencial');
    await page.click('#rp-demo-clear');
    assert.equal(await page.locator('#rp-demo').isVisible(), false);
    assert.equal(await page.evaluate(() => window.RiskPortfolioPanel.getState().positions.length), 0);
    assert.equal(await page.evaluate(() => window.RiskPortfolioPanel.getState().referenceBalance), 0);

    const change = (id, value) => page.evaluate(({ id, value }) => {
      const el = document.getElementById(id);
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, { id, value });
    const tick = (symbol, price) => page.evaluate(({ symbol, price }) => {
      window.dispatchEvent(new CustomEvent('estudebitcoin:ticker-price', { detail: { symbol, price, source: 'test' } }));
    }, { symbol, price });
    const add = async (symbol, side, quantity, average) => {
      await page.click('#rp-add-toggle');
      await page.selectOption('#rp-symbol', symbol);
      await page.selectOption('#rp-side', side);
      await page.fill('#rp-quantity', quantity);
      await page.fill('#rp-average', average);
      await page.click('#rp-add');
    };
    const state = () => page.evaluate(() => window.RiskPortfolioPanel.getState());

    for (const [s, p] of Object.entries({ BTC: 65000, ETH: 3000, SOL: 150, LINK: 15, AVAX: 30 })) await tick(s, p);

    // Acúmulo de compras no mesmo ativo: preço médio ponderado.
    await add('BTC', 'LONG', '1', '60000');
    await add('BTC', 'LONG', '1', '70000');
    let s = await state();
    assert.equal(s.positions.length, 1, 'aporte não cria posição duplicada');
    assert.equal(s.positions[0].quantity, 2);
    assert.equal(s.positions[0].averagePrice, 65000);

    // Inverter o lado na mesma posição é bloqueado.
    await add('BTC', 'SHORT', '1', '65000');
    assert.match(await page.locator('#rp-status').textContent(), /inverter/i);

    // Edição direta na tabela.
    await page.fill('.rp-row[data-index="0"] input[data-field="quantity"]', '3');
    await page.locator('.rp-row[data-index="0"] input[data-field="quantity"]').blur();
    s = await state();
    assert.equal(s.positions[0].quantity, 3);

    for (const [sym, qty, avg] of [['ETH', '2', '2500'], ['SOL', '10', '100'], ['LINK', '100', '12'], ['AVAX', '50', '25']]) await add(sym, 'LONG', qty, avg);
    s = await state();
    assert.equal(s.positions.length, 5);
    assert.equal(await page.locator('#rp-add-toggle').isDisabled(), true, 'limite de 5 bloqueia novo ativo');

    await change('rp-balance', '8.000,00');
    await page.waitForTimeout(100);
    const ui = await page.evaluate(() => {
      const t = id => document.getElementById(id).textContent.trim();
      return { invested: t('rp-invested'), market: t('rp-market'), pnl: t('rp-pnl'), equity: t('rp-equity'),
        rows: document.querySelectorAll('#rp-positions tr.rp-row').length };
    });
    assert.equal(ui.rows, 5);
    assert.equal(ui.invested, (3 * 65000 + 2 * 2500 + 10 * 100 + 100 * 12 + 50 * 25).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' }));

    const parity = await page.evaluate(() => {
      const st = window.RiskPortfolioPanel.getState();
      const q = window.RiskPortfolioAdapter.getQuotes();
      const res = window.RiskPortfolioEngine.calculate({ referenceBalance: st.referenceBalance,
        referencePrices: st.referencePrices, positions: st.positions.map(p => ({ ...p, currentPrice: q[p.symbol].price })) });
      return { engine: res.pnlTotal, ui: document.getElementById('rp-pnl').textContent.trim(), ok: res.success };
    });
    assert.equal(parity.ok, true);
    assert.equal(parity.ui, parity.engine.toLocaleString('pt-BR', { style: 'currency', currency: 'USD' }), 'UI mostra o P/L do motor');

    // Visitante: nada é persistido; ao recarregar, o exemplo volta com os valores originais.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { document.getElementById('rp-painel').open = true; });
    assert.equal(await page.evaluate(() => window.RiskPortfolioPanel.getState().positions.length), 5);
    assert.deepEqual(await page.evaluate(() => window.RiskPortfolioPanel.getState().positions.map(p => p.symbol)),
      ['AVAX', 'ETH', 'LINK', 'BTC', 'SOL'], 'visitante recarrega e vê os cinco exemplos');
    assert.equal(await page.evaluate(() => window.RiskPortfolioPanel.getState().positions[0].quantity), 109.5678);
    assert.equal(await page.evaluate(() => window.RiskPortfolioPanel.getState().referenceBalance), 3000, 'demo volta com saldo US$ 3.000,00 em memória');
    assert.equal(await page.locator('#rp-demo').isVisible(), true, 'exemplo volta após reload de visitante');
    assert.equal(await page.evaluate(() => localStorage.getItem('eb_panel_risk_portfolio')), null, 'nenhuma carteira gravada');

    // Exclusão.
    await page.click('#rp-positions tr.rp-row [data-delete]');
    assert.equal(await page.evaluate(() => window.RiskPortfolioPanel.getState().positions.length), 4);
    assert.equal(await page.locator('#rp-add-toggle').isDisabled(), false);

    // Sem overflow horizontal nas larguras pedidas.
    for (const width of [1440, 1280, 800, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth > window.innerWidth + 1,
        panel: document.getElementById('rp-painel').scrollWidth > document.getElementById('rp-painel').clientWidth + 1
      }));
      assert.deepEqual(overflow, { doc: false, panel: false }, 'sem overflow em ' + width + 'px');
    }

    assert.deepEqual(panelErrors, [], 'sem erros de JS do painel');
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('#rp-painel').screenshot({ path: output + 'rp-final-1440.png' });
  } finally {
    await browser.close();
  }
});
