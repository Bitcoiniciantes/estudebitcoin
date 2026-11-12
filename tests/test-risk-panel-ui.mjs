/** Real Chromium QA: existing page, original engine, deterministic ticker events.
 * Run: node --test tests/test-risk-panel-ui.mjs
 * Screenshots: _archive_local/risk-redesign/ (not published).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../_archive_local/risk-redesign/', import.meta.url));
mkdirSync(output, { recursive: true });

test('Risk Engine: controls, original calculations, errors and responsive layout', async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const panelErrors = [];
    page.on('pageerror', e => { if (/risk-engine/i.test(e.stack || e.message)) panelErrors.push(e.message); });
    // Offline, reproducible test: no real account, cloud writes or market requests.
    await page.route('https://**/*', r => r.abort());
    await page.routeWebSocket('**/*', ws => ws.close());
    await page.goto(new URL('../index.html', import.meta.url).href, { waitUntil: 'domcontentloaded' });
    const field = id => page.locator('#' + id);
    const tick = (price, symbol = 'ETH') => page.evaluate(({ price, symbol }) => {
      window.dispatchEvent(new CustomEvent('estudebitcoin:ticker-price', { detail: { symbol, price } }));
    }, { price, symbol });
    const result = () => page.evaluate(() => window.RiskEngineAdapter.getLastResult());
    const compare = async () => {
      const pair = await page.evaluate(() => ({
        expected: window.RiskEngine.calcularRisco({ ...window.RiskEnginePanel.readParams(),
          precoAtual: window.RiskEngineAdapter.getLastPrice() }),
        actual: window.RiskEngineAdapter.getLastResult()
      }));
      assert.deepEqual(pair.actual, pair.expected, 'UI/adapter must preserve every raw engine field');
    };
    const fillBase = async () => {
      for (const [id, value] of Object.entries({ 're-saldo': '1.000,00', 're-alavancagem': '3',
        're-preco-entrada': '1.515,00', 're-valor': '2.500,00', 're-mmr': '0', 're-funding': '0,00' })) {
        await field(id).fill(value);
      }
      await field('re-lado').selectOption('LONG');
      await tick(2012.88);
    };
    assert.equal(await page.locator('#re-painel input, #re-painel select').count(), 8);
    assert.equal(await page.locator('#re-painel .re-cell').count(), 11);
    await field('re-simbolo').selectOption('ETH');
    await fillBase();
    await compare();
    const baseline = await result();
    assert.equal(baseline.precoLiquidacao, 909);
    assert.equal(await field('re-plq').textContent(), '$ 909,00');
    assert.equal(await field('re-estado').textContent(), 'SEGURO');
    assert.equal(await field('re-pnl').getAttribute('data-sign'), 'positive');

    for (const [id, value, property, expected] of [
      ['re-saldo', '1.200,50', 'saldoCorretora', 1200.5],
      ['re-alavancagem', '4', 'alavancagem', 4],
      ['re-preco-entrada', '1.600,12345678', 'entry', 1600.12345678],
      ['re-valor', '2.400,25', 'notional', 2400.25],
      ['re-mmr', '0,005', 'mmr', 0.005],
      ['re-funding', '12,1256789', 'fundingCustoAcumulado', 12.1256789]
    ]) {
      await field(id).fill(value);
      await field(id).blur();
      const params = await page.evaluate(() => window.RiskEnginePanel.readParams());
      const actual = property === 'entry' ? params.ordens[0].preco : property === 'notional' ? params.ordens[0].valor : params[property];
      assert.equal(actual, expected, id + ' must keep precision after blur');
      await compare();
    }
    await field('re-mmr').fill('0.005');
    await compare();
    assert.equal((await page.evaluate(() => window.RiskEnginePanel.readParams())).mmr, 0.005);
    await field('re-preco-entrada').fill('0,000000000000000000001');
    await field('re-preco-entrada').blur();
    assert.equal((await page.evaluate(() => window.RiskEnginePanel.readParams())).ordens[0].preco, 1e-21);
    await field('re-preco-entrada').fill('1.600,12345678');
    await field('re-lado').selectOption('SHORT');
    await compare();
    assert.equal((await result()).lado, 'SHORT');
    assert.equal(await field('re-pnl').getAttribute('data-sign'), 'negative');
    assert.equal(await field('re-res').getAttribute('data-sign'), 'negative');

    for (const [id, values, code] of [
      ['re-saldo', ['', '0', '-1', 'abc', '100abc', '1,2,3', '1.00,00'], 'FATAL_04'],
      ['re-alavancagem', ['', '0', '-2'], 'FATAL_05'],
      ['re-preco-entrada', ['', '0', '-1', 'NaN'], 'FATAL_01'],
      ['re-valor', ['', '0', '-1', 'Infinity'], 'FATAL_01'],
      ['re-mmr', ['', '-0,001', '1', '0.005abc'], 'FATAL_08'],
      ['re-funding', ['', '-10', '10USD'], 'FATAL_07']
    ]) {
      for (const value of values) {
        await fillBase();
        await field(id).fill(value);
        await compare();
        assert.equal((await result()).codigoErro, code, id + '=' + value);
        assert.equal(await field(id).getAttribute('aria-invalid'), 'true');
        assert.equal(await field('re-plq').textContent(), '—');
        assert.equal(await field('re-estado').getAttribute('data-estado'), '');
        assert.ok(await field('re-erro').isVisible());
      }
    }
    await fillBase();
    for (const [value, expected] of [['1.000', 1000], ['1000.25', 1000.25], ['1.000,25', 1000.25]]) {
      await field('re-saldo').fill(value);
      assert.equal((await page.evaluate(() => window.RiskEnginePanel.readParams())).saldoCorretora, expected);
    }
    await fillBase();
    // Typing leaves the cursor and string alone until confirmation.
    await field('re-saldo').focus();
    await field('re-saldo').evaluate(el => el.setSelectionRange(1, 1));
    await page.keyboard.type('2');
    assert.equal(await field('re-saldo').inputValue(), '12.000,00');
    assert.equal(await field('re-saldo').evaluate(el => el.selectionStart), 2);
    await fillBase();

    for (const [price, state, label] of [[1000, 'ATENCAO', 'ATENÇÃO'], [950, 'CRITICO', 'CRÍTICO'],
      [909, 'LIQUIDACAO', 'LIQUIDAÇÃO'], [2012.88, 'SEGURO', 'SEGURO']]) {
      await tick(price);
      await compare();
      assert.equal(await field('re-estado').getAttribute('data-estado'), state);
      assert.equal(await field('re-estado').textContent(), label);
    }
    await field('re-simbolo').selectOption('SOL');
    assert.match(await field('re-preco-atual').textContent(), /Aguardando/);
    await field('re-saldo').fill('4.000,00');
    await tick(2200, 'ETH');
    assert.match(await field('re-preco-atual').textContent(), /Aguardando/);
    await tick(150, 'SOL');
    assert.equal(await field('re-preco-atual').textContent(), '$ 150,00');
    await compare();
    await field('re-simbolo').selectOption('ETH');
    await fillBase();
    await field('re-saldo').blur();
    await page.locator('.re-help').focus();
    assert.equal(await field('re-mmr-help').isVisible(), true);
    await field('re-simbolo').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 're-lado');

    for (const width of [1920, 1366, 768, 390]) {
      await page.setViewportSize({ width, height: 1080 });
      await page.locator('#re-painel').scrollIntoViewIfNeeded();
      await field('re-lado').blur();
      const layout = await page.locator('#re-painel').evaluate(panel => {
        const box = panel.getBoundingClientRect();
        const cards = [...panel.querySelectorAll('.re-cell')].map(e => e.getBoundingClientRect());
        return {
          outside: [...panel.querySelectorAll('input,select,.re-cell,strong,label')].filter(e => {
            const r = e.getBoundingClientRect();
            return r.left < box.left - 1 || r.right > box.right + 1 || e.scrollWidth > e.clientWidth + 1;
          }).map(e => e.id || e.className),
          rows: cards.map(r => Math.round(r.top)),
          fields: [...panel.querySelectorAll('input,select')].map(e => e.getBoundingClientRect().height)
        };
      });
      assert.deepEqual(layout.outside, [], 'no clipping/overflow at ' + width);
      assert.ok(layout.fields.every(h => h >= 48), 'touch targets at ' + width);
      if (width >= 1200) {
        assert.equal(new Set(layout.rows.slice(0, 7)).size, 1);
        assert.equal(new Set(layout.rows.slice(7)).size, 1);
        assert.notEqual(layout.rows[0], layout.rows[7]);
      }
      // Fixed site navigation is outside the panel and would overlay a tall
      // element capture; hide it only in the screenshot, not during tests.
      await page.locator('#re-painel').screenshot({ path: output + '/risk-' + width + '.png',
        style: '.dash-header { visibility: hidden !important; }' });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await field('re-saldo').evaluate(e => getComputedStyle(e).transitionDuration), '0s');
    await page.clock.install();
    await tick(2012.88);
    await page.clock.fastForward(20000);
    await field('re-saldo').fill('1.200,00');
    await page.clock.fastForward(11000);
    assert.match(await field('re-erro').textContent(), /sem atualização/);
    assert.equal(await field('re-plq').textContent(), '—');
    await tick(2013);
    assert.equal(await field('re-preco-atual').textContent(), '$ 2.013,00');
    await compare();
    assert.deepEqual(panelErrors, []);
  } finally { await browser.close(); }
});
