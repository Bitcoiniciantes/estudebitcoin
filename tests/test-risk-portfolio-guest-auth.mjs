/** Persistência visitante × autenticado e apresentação de saldo do Risk Engine Multicripto.
 * Run: node --test tests/test-risk-portfolio-guest-auth.mjs
 * Sem Firebase real: PanelSync.saveLocal/loadLocal são substituídos em memória.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const PAGE = new URL('../index.html', import.meta.url).href;

async function open(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.routeWebSocket('**/*', ws => ws.close());
  await page.addInitScript(() => {
    window.__panelWrites = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (/^eb_panel_/.test(String(key))) window.__panelWrites.push(String(key));
      return original.call(this, key, value);
    };
  });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { document.getElementById('rp-painel').open = true; });
  await page.waitForTimeout(150);
  return { page, errors };
}

/* Substitui a persistência real por memória com dono 'u1'. */
async function instrument(page) {
  await page.evaluate(() => {
    window.__saves = [];
    window.__mem = {};
    window.PanelSync.saveLocal = function (panel, params) {
      window.__saves.push(JSON.parse(JSON.stringify(params)));
      window.__mem[panel] = JSON.parse(JSON.stringify(params));
      return true;
    };
    window.PanelSync.loadLocal = function (panel) {
      return window.__mem[panel]
        ? { params: window.__mem[panel], owner: 'u1', updatedAt: new Date().toISOString() }
        : null;
    };
  });
}

const auth = (page, id) => page.evaluate((id) => {
  window.dispatchEvent(new CustomEvent('estudebitcoin:auth-change', {
    detail: { user: id ? { id, email: id + '@test.local' } : null }
  }));
}, id);

const change = (page, id, value) => page.evaluate(({ id, value }) => {
  const el = document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, { id, value });

const tickAll = async (page) => {
  for (const [symbol, price] of Object.entries({ AVAX: 6.57, ETH: 1637.65, LINK: 8.449, BTC: 59022.01, SOL: 69.22 })) {
    await page.evaluate(({ symbol, price }) => {
      window.dispatchEvent(new CustomEvent('estudebitcoin:ticker-price', { detail: { symbol, price, source: 'test' } }));
    }, { symbol, price });
  }
  await page.waitForTimeout(80);
};

const state = (page) => page.evaluate(() => window.RiskPortfolioPanel.getState());
const positions = async (page) => (await state(page)).positions;
const text = (page, id) => page.locator('#' + id).textContent();

test('Visitante nunca grava: editar e limpar exemplo ficam só na memória', async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, errors } = await open(browser);
    await instrument(page);
    await tickAll(page);

    assert.equal(await page.evaluate(() => window.__saves.length), 0, 'nenhum save no carregamento');
    assert.equal(await page.evaluate(() => localStorage.getItem('eb_panel_risk_portfolio')), null);

    // Edição temporária.
    await page.fill('.rp-row[data-index="0"] input[data-field="quantity"]', '5');
    await page.locator('.rp-row[data-index="0"] input[data-field="quantity"]').blur();
    assert.equal((await positions(page))[0].quantity, 5, 'edição vale na sessão');
    assert.equal(await page.evaluate(() => window.__saves.length), 0, 'edição de visitante não salva');
    assert.deepEqual(await page.evaluate(() => window.__panelWrites), [], 'nenhuma chave eb_panel_* gravada');

    // Limpar exemplo também é só memória.
    await page.click('#rp-demo-clear');
    assert.equal((await positions(page)).length, 0);
    assert.equal(await page.evaluate(() => window.__saves.length), 0, 'limpar exemplo não salva');
    assert.deepEqual(await page.evaluate(() => window.__panelWrites), [], 'nada gravado ao limpar');
    assert.equal(await page.evaluate(() => localStorage.getItem('eb_panel_risk_portfolio')), null);

    // Recarregar restaura os cinco exemplos originais com saldo demonstrativo em memória.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { document.getElementById('rp-painel').open = true; });
    assert.deepEqual(await page.evaluate(() => window.RiskPortfolioPanel.getState().positions.map(p => p.symbol)),
      ['AVAX', 'ETH', 'LINK', 'BTC', 'SOL']);
    assert.equal(await page.evaluate(() => window.RiskPortfolioPanel.getState().positions[0].quantity), 109.5678);
    assert.equal(await page.evaluate(() => window.RiskPortfolioPanel.getState().referenceBalance), 3000, 'visitante vê saldo de exemplo US$ 3.000,00');
    assert.equal(await page.locator('#rp-demo').isVisible(), true);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Autenticado: sem gravação automática do exemplo, persiste após edição e isola usuários', async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, errors } = await open(browser);
    await instrument(page);
    await tickAll(page);

    // Login sem carteira salva: mostra o exemplo, sem gravar.
    await auth(page, 'u1');
    assert.equal((await positions(page)).length, 5);
    assert.equal(await page.evaluate(() => window.__saves.length), 0, 'exemplo não é salvo automaticamente');
    assert.equal(await page.evaluate(() => Object.keys(window.__mem).length), 0);
    assert.match(await page.locator('#rp-demo-text').textContent(), /ainda não foram salvas/);

    // Alteração intencional persiste.
    await page.fill('.rp-row[data-index="0"] input[data-field="quantity"]', '2,5');
    await page.locator('.rp-row[data-index="0"] input[data-field="quantity"]').blur();
    assert.equal(await page.evaluate(() => window.__saves.length), 1, 'edição do usuário salva');
    assert.equal((await page.evaluate(() => window.__mem.risk_portfolio.positions))[0].quantity, 2.5);
    assert.equal(await page.locator('#rp-demo').isVisible(), false, 'aviso de exemplo sai ao assumir a carteira');

    // Atualização de cotação não grava.
    await tickAll(page);
    assert.equal(await page.evaluate(() => window.__saves.length), 1, 'cotação não gera gravação');

    // Logout mostra o exemplo; novo login recupera a carteira editada.
    await auth(page, null);
    assert.equal((await positions(page))[0].quantity, 109.5678, 'logout exibe o exemplo, não carteira vazia');
    assert.equal(await page.locator('#rp-demo').isVisible(), true);
    await auth(page, 'u1');
    assert.equal((await positions(page))[0].quantity, 2.5, 'novo login recupera os dados');

    // Outro usuário não herda a carteira do anterior.
    await auth(page, 'u2');
    assert.equal((await positions(page))[0].quantity, 109.5678, 'isolamento entre usuários');
    assert.equal(await page.evaluate(() => window.__saves.length), 1, 'troca de usuário não grava');

    await auth(page, 'u1');
    assert.equal((await positions(page))[0].quantity, 2.5);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('Demo com US$ 3.000,00; saldo vazio sem falso CRÍTICO; saldo zero explícito usa a matemática', async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, errors } = await open(browser);
    await tickAll(page);

    // Visitante: exemplo informado com US$ 3.000,00 em memória, patrimônio parte dessa referência.
    assert.equal(await page.evaluate(() => window.RiskPortfolioPanel.getState().referenceBalance), 3000);
    assert.notEqual((await text(page, 'rp-equity')).trim(), 'Aguardando saldo');
    assert.notEqual((await text(page, 'rp-risk')).trim(), 'Saldo não informado');

    // Sem depósito informado: apresentação neutra, ativos continuam calculados.
    await page.evaluate(() => {
      const demo = [
        { id: 'rp-AVAX', symbol: 'AVAX', side: 'LONG', quantity: 109.5678, averagePrice: 8.21 },
        { id: 'rp-ETH', symbol: 'ETH', side: 'LONG', quantity: 0.25273989, averagePrice: 1978.32 },
        { id: 'rp-LINK', symbol: 'LINK', side: 'LONG', quantity: 126.1869, averagePrice: 9.906 },
        { id: 'rp-BTC', symbol: 'BTC', side: 'LONG', quantity: 0.03489119, averagePrice: 65919.21 },
        { id: 'rp-SOL', symbol: 'SOL', side: 'LONG', quantity: 13.2609, averagePrice: 80.16 }
      ];
      window.RiskPortfolioPanel.applyState({ schemaVersion: 2, equityBasis: 'deposited', model: 'quantfury-account-balance-simulation', referenceBalance: 0, referenceTimestamp: null, referencePrices: { AVAX: 8.21, ETH: 1978.32, LINK: 9.906, BTC: 65919.21, SOL: 80.16 }, settings: {}, positions: demo });
      const st = window.RiskPortfolioPanel.getState();
      window.RiskPortfolioAdapter.configure({ referenceBalance: st.referenceBalance, referencePrices: st.referencePrices, positions: st.positions, equityBasis: st.equityBasis });
    });
    await tickAll(page);
    assert.equal((await text(page, 'rp-equity')).trim(), 'Aguardando depósito');
    assert.equal((await text(page, 'rp-leverage')).trim(), 'Indisponível');
    assert.equal((await text(page, 'rp-drop')).trim(), 'Indisponível');
    assert.equal((await text(page, 'rp-loss')).trim(), 'Indisponível');
    assert.equal((await text(page, 'rp-risk')).trim(), 'Depósito não informado');
    assert.notEqual((await text(page, 'rp-risk')).trim(), 'CRÍTICO');
    assert.notEqual((await text(page, 'rp-risk')).trim(), 'LIMITE TEÓRICO ATINGIDO');
    for (const id of ['rp-invested', 'rp-market', 'rp-pnl', 'rp-table-pnl']) {
      assert.notEqual((await text(page, id)).trim(), '—', id + ' segue calculado sem depósito');
    }

    // Depósito zero explícito: patrimônio = depósito + PnL acumulado (regra matemática).
    await change(page, 'rp-balance', '0');
    const pnlText = (await text(page, 'rp-pnl')).trim();
    const equityAfterZero = (await text(page, 'rp-equity')).trim();
    assert.equal(equityAfterZero, pnlText, 'depósito zero => patrimônio igual ao PnL acumulado');
    assert.equal((await text(page, 'rp-risk')).trim(), 'LIMITE TEÓRICO ATINGIDO', 'patrimônio não positivo: limite teórico atingido');

    // Depósito positivo: patrimônio = depositado + PnL acumulado.
    await change(page, 'rp-balance', '1.000,00');
    assert.notEqual((await text(page, 'rp-risk')).trim(), 'Depósito não informado');
    const expected = await page.evaluate(() => {
      const st = window.RiskPortfolioPanel.getState();
      const q = window.RiskPortfolioAdapter.getQuotes();
      const res = window.RiskPortfolioEngine.calculate({ referenceBalance: st.referenceBalance, referencePrices: st.referencePrices, positions: st.positions.map(p => ({ ...p, currentPrice: q[p.symbol].price })), equityBasis: st.equityBasis || 'deposited' });
      return res.equity.toLocaleString('pt-BR', { style: 'currency', currency: 'USD' });
    });
    assert.equal((await text(page, 'rp-equity')).trim(), expected);

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
