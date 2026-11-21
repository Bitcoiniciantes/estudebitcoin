/**
 * P0 — Validação controlada do painel Risk Engine Multicripto (UI real, sem demo/ticker ao vivo).
 * Modelo definitivo: Capital depositado + P/L acumulado = Patrimônio atual.
 * Run: node --test tests/test-risk-portfolio-p0-controlled.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const PAGE = new URL('../index.html', import.meta.url).href;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

function approx(a, b, eps = 0.02) { return Math.abs(a - b) <= eps; }
function parseMoney(txt) {
  let s = String(txt).replace(/\u00a0/g, ' ').replace(/US\$/g, '').replace(/x/g, '').trim();
  const neg = s.includes('-');
  s = s.replace(/-/g, '').trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return neg ? -Math.abs(n) : n;
}

async function openControlled(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.routeWebSocket('**/*', ws => ws.close());
  await page.addInitScript(() => { window.__panelStore = {}; window.__panelSaves = []; });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.RiskPortfolioPanel && window.RiskPortfolioAdapter && window.RiskPortfolioEngine && window.PanelSync, { timeout: 15000 });
  await page.evaluate(() => {
    const PS = window.PanelSync;
    PS.saveLocal = function (panel, params) {
      const uid = (window.EstudeAuth && window.EstudeAuth.getUser && window.EstudeAuth.getUser() && window.EstudeAuth.getUser().id) || '__guest__';
      window.__panelStore[panel + '::' + uid] = { params: JSON.parse(JSON.stringify(params)), owner: uid === '__guest__' ? null : uid, updatedAt: new Date().toISOString() };
      window.__panelSaves.push({ panel, uid, params: JSON.parse(JSON.stringify(params)) });
      return true;
    };
    PS.loadLocal = function (panel) {
      const uid = (window.EstudeAuth && window.EstudeAuth.getUser && window.EstudeAuth.getUser() && window.EstudeAuth.getUser().id) || '__guest__';
      const rec = window.__panelStore[panel + '::' + uid];
      return rec ? { params: JSON.parse(JSON.stringify(rec.params)), owner: rec.owner, updatedAt: rec.updatedAt } : null;
    };
  });
  await page.waitForTimeout(150);
  return { page, errors };
}

async function setQuotes(page, quotes) {
  for (const [symbol, price] of Object.entries(quotes)) {
    await page.evaluate(({ symbol, price }) => {
      window.dispatchEvent(new CustomEvent('estudebitcoin:ticker-price', { detail: { symbol, price, source: 'test' } }));
    }, { symbol, price });
  }
  await page.waitForTimeout(120);
}

async function setState(page, state) {
  await page.evaluate((st) => {
    window.RiskPortfolioPanel.applyState(st);
    const s = window.RiskPortfolioPanel.getState();
    const bal = document.getElementById('rp-balance');
    if (bal) bal.value = (s.referenceBalance != null) ? s.referenceBalance.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
    const pw = document.getElementById('rp-power');
    if (pw) pw.value = (s.settings && s.settings.tradingPower != null) ? s.settings.tradingPower : '';
    window.RiskPortfolioAdapter.configure({ referenceBalance: s.referenceBalance, referencePrices: s.referencePrices, positions: s.positions, equityBasis: s.equityBasis || 'deposited' });
  }, state);
  await page.waitForTimeout(150);
}

async function read(page) {
  const txt = async (id) => (await page.locator('#' + id).textContent()).trim();
  const out = {
    equity: await txt('rp-equity'),
    pnl: await txt('rp-pnl'),
    exposure: await txt('rp-exposure'),
    leverage: await txt('rp-leverage'),
    drop: await txt('rp-drop'),
    risk: await txt('rp-risk'),
  };
  return { ...out, n: { equity: parseMoney(out.equity), pnl: parseMoney(out.pnl), exposure: parseMoney(out.exposure), leverage: parseMoney(out.leverage), drop: parseMoney(out.drop) } };
}

test('Risk Engine Multicripto: cotação ao vivo destacada e alerta de possível liquidação reversível', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  try {
    const { page, errors } = await openControlled(browser);
    const state = {
      schemaVersion: 2, equityBasis: 'deposited', model: 'quantfury-account-balance-simulation',
      referenceBalance: 10, referenceTimestamp: 't', referencePrices: { BTC: 100 }, settings: {},
      positions: [{ id: 'rp-BTC', symbol: 'BTC', side: 'LONG', quantity: 1, averagePrice: 100, invested: 100 }]
    };

    await setQuotes(page, { BTC: 90 });
    await setState(page, state);
    const quote = await page.locator('[data-live="price"]').evaluate((el) => {
      const style = getComputedStyle(el);
      return { text: el.textContent.trim(), color: style.color, weight: style.fontWeight };
    });
    assert.equal(quote.text, (90).toLocaleString('pt-BR', { style: 'currency', currency: 'USD' }));
    assert.equal(quote.color, 'rgb(249, 115, 22)');
    assert.equal(quote.weight, '700');
    assert.equal(await page.locator('#rp-liquidation-alert').isVisible(), true, 'alerta exibido com patrimônio zero');
    assert.equal(await page.locator('#rp-liquidation-alert').textContent(), 'Possível liquidação');

    await setQuotes(page, { BTC: 91 });
    assert.equal(await page.locator('#rp-liquidation-alert').isVisible(), false, 'alerta removido quando patrimônio fica positivo');
    await setQuotes(page, { BTC: 89 });
    assert.equal(await page.locator('#rp-equity').evaluate((el) => getComputedStyle(el).color), 'rgb(255, 107, 112)', 'patrimônio negativo em vermelho');
    assert.deepEqual(errors, [], 'sem erros JS: ' + errors.join(';'));
  } finally { await browser.close(); }
});

test('P0 controlado: 2 contas mesmos dados => resultados idênticos; refs antigas não interferem; recálculo estável', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  try {
    const { page, errors } = await openControlled(browser);
    const quotes = { BTC: 90 };

    const mkState = (refPrice) => ({
      schemaVersion: 2, equityBasis: 'deposited', model: 'quantfury-account-balance-simulation',
      referenceBalance: 3000, referenceTimestamp: '2026-01-01T00:00:00Z',
      referencePrices: { BTC: refPrice }, settings: { initialWealth: null, tradingPower: null },
      positions: [{ id: 'rp-BTC', symbol: 'BTC', side: 'LONG', quantity: 1, averagePrice: 100, invested: 100 }]
    });

    // "Conta 1" com ref histórica 95 no payload (se presente) — painel normaliza para avg; resultado correto
    await setQuotes(page, quotes);
    await setState(page, mkState(95));
    const r1 = await read(page);
    assert.ok(approx(r1.n.equity, 2990), 'c1 equity ' + r1.equity);
    assert.ok(approx(r1.n.pnl, -10), 'c1 pnl ' + r1.pnl);
    assert.ok(approx(r1.n.exposure, 90), 'c1 exposure ' + r1.exposure);

    // "Conta 2" com ref histórica 90 no payload — mesmos dados visíveis => idêntico
    await setQuotes(page, quotes);
    await setState(page, mkState(90));
    const r2 = await read(page);
    assert.ok(approx(r2.n.equity, 2990), 'c2 equity ' + r2.equity);
    assert.ok(approx(r2.n.pnl, -10), 'c2 pnl ' + r2.pnl);
    assert.ok(approx(r2.n.exposure, 90), 'c2 exposure ' + r2.exposure);
    assert.equal(r1.equity, r2.equity, 'patrimônio idêntico');
    assert.equal(r1.pnl, r2.pnl, 'pnl idêntico');
    assert.equal(r1.leverage, r2.leverage, 'alavancagem idêntica');
    assert.equal(r1.drop, r2.drop, 'queda idêntica');
    assert.equal(r1.risk, r2.risk, 'risco idêntico');

    // Estado legado (v1) não é aceito — sem migração, evita reinterpretação de refs antigas
    const legacyAccepted = await page.evaluate(() => window.RiskPortfolioPanel.applyState({ schemaVersion: 1, model: 'quantfury-account-balance-simulation', referenceBalance: 3000, referenceTimestamp: 't', referencePrices: { BTC: 95 }, settings: {}, positions: [{ id: 'rp-BTC', symbol: 'BTC', side: 'LONG', quantity: 1, averagePrice: 100 }] }));
    assert.equal(legacyAccepted, false, 'estado legado v1 rejeitado (reset de persistência)');

    // Recalcular repetidamente sem alterar patrimônio
    await setState(page, mkState(100));
    for (let i = 0; i < 3; i++) {
      await page.click('#rp-reference');
      await page.waitForTimeout(200);
      const rr = await read(page);
      assert.ok(approx(rr.n.equity, 2990), 'recalc ' + i + ' equity ' + rr.equity);
      assert.ok(approx(rr.n.pnl, -10), 'recalc ' + i + ' pnl ' + rr.pnl);
    }
    await setQuotes(page, quotes);
    const rf = await read(page);
    assert.ok(approx(rf.n.equity, 2990), 'cotação igual equity ' + rf.equity);

    assert.deepEqual(errors, [], 'sem erros JS: ' + errors.join(';'));
  } finally { await browser.close(); }
});

test('P0 controlado: 5 ativos mistos, invariantes, depósito/cotação, persistência e equity<=0', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  try {
    const { page, errors } = await openControlled(browser);
    const quotes = { BTC: 58000, ETH: 3100, SOL: 95, LINK: 14, AVAX: 28 };
    const positions = [
      { id: 'rp-BTC', symbol: 'BTC', side: 'LONG', quantity: 0.05, averagePrice: 60000, invested: 3000 },
      { id: 'rp-ETH', symbol: 'ETH', side: 'SHORT', quantity: 1, averagePrice: 3000, invested: 3000 },
      { id: 'rp-SOL', symbol: 'SOL', side: 'LONG', quantity: 10, averagePrice: 100, invested: 1000 },
      { id: 'rp-LINK', symbol: 'LINK', side: 'SHORT', quantity: 50, averagePrice: 15, invested: 750 },
      { id: 'rp-AVAX', symbol: 'AVAX', side: 'LONG', quantity: 20, averagePrice: 30, invested: 600 },
    ];
    const base = { schemaVersion: 2, equityBasis: 'deposited', model: 'quantfury-account-balance-simulation', referenceBalance: 5000, referenceTimestamp: 't', settings: {}, positions };
    await setQuotes(page, quotes);

    await setState(page, { ...base, referencePrices: { BTC: 59000, ETH: 3050, SOL: 97, LINK: 14.5, AVAX: 29 } });
    const a = await read(page);
    await setState(page, { ...base, referencePrices: { BTC: 58000, ETH: 3100, SOL: 95, LINK: 14, AVAX: 28 } });
    const b = await read(page);
    assert.equal(a.equity, b.equity, '5 ativos equity igual');
    assert.equal(a.pnl, b.pnl, '5 ativos pnl igual');
    assert.equal(a.leverage, b.leverage, '5 ativos leverage igual');
    assert.ok(approx(a.n.equity, 5000 + a.n.pnl), 'invariante eq=depositado+pnl: ' + JSON.stringify(a.n));

    const st = await page.evaluate(() => window.RiskPortfolioPanel.getState());
    assert.equal(st.equityBasis, 'deposited');
    assert.equal(st.schemaVersion, 2);

    // Alteração de depósito: 5000 -> 7000 => patrimônio +2000, pnl inalterado
    const beforeEq = a.n.equity;
    await page.fill('#rp-balance', '7.000,00');
    await page.click('#rp-reference');
    await page.waitForTimeout(250);
    const afterDep = await read(page);
    assert.ok(approx(afterDep.n.equity, beforeEq + 2000), 'depósito +2000: ' + afterDep.equity);
    assert.ok(approx(afterDep.n.pnl, a.n.pnl), 'pnl inalterado');

    await page.click('#rp-reference');
    await page.waitForTimeout(200);
    const afterRecalc = await read(page);
    assert.ok(approx(afterRecalc.n.equity, beforeEq + 2000), 'recalc estável');

    // Cotação congelada e depois atualizada
    await setQuotes(page, { ...quotes, BTC: 60000 }); // BTC sobe: LONG ganha 0.05*(60000-58000)=100
    const up = await read(page);
    assert.ok(approx(up.n.pnl, a.n.pnl + 100), 'pnl sobe com cotação: ' + up.n.pnl);
    assert.ok(approx(up.n.equity, 7000 + up.n.pnl), 'invariante mantida após update');
    await setQuotes(page, quotes);
    const back = await read(page);
    assert.ok(approx(back.n.equity, beforeEq + 2000), 'volta ao estado');

    // Equity <= 0 => LIMITE TEÓRICO ATINGIDO
    await setState(page, { schemaVersion: 2, equityBasis: 'deposited', model: 'quantfury-account-balance-simulation', referenceBalance: 828, referenceTimestamp: 't', referencePrices: { BTC: 6012 }, settings: {}, positions: [{ id: 'rp-BTC', symbol: 'BTC', side: 'LONG', quantity: 1, averagePrice: 6012, invested: 6012 }] });
    await setQuotes(page, { BTC: 5184 });
    const lim = await read(page);
    assert.ok(approx(lim.n.equity, 0), 'equity 0: ' + lim.equity);
    assert.equal(lim.risk, 'LIMITE TEÓRICO ATINGIDO', 'limite teórico atingido');

    assert.deepEqual(errors, [], 'sem erros JS: ' + errors.join(';'));
  } finally { await browser.close(); }
});

test('P0 controlado: cenário mandatário (1000, -828) estável; adição/edição/aporte/exclusão/reinclusão', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  try {
    const { page, errors } = await openControlled(browser);
    await setQuotes(page, { BTC: 5184, LINK: 10 });
    await setState(page, {
      schemaVersion: 2, equityBasis: 'deposited', model: 'quantfury-account-balance-simulation',
      referenceBalance: 1000, referenceTimestamp: 't',
      referencePrices: { BTC: 6012 }, settings: {},
      positions: [{ id: 'rp-BTC', symbol: 'BTC', side: 'LONG', quantity: 1, averagePrice: 6012, invested: 6012 }]
    });
    let r = await read(page);
    assert.ok(approx(r.n.equity, 172), 'eq 172: ' + r.equity);
    assert.ok(approx(r.n.pnl, -828), 'pnl -828: ' + r.pnl);

    for (let i = 0; i < 3; i++) { await page.click('#rp-reference'); await page.waitForTimeout(180); }
    r = await read(page);
    assert.ok(approx(r.n.equity, 172), 'recalc estável: ' + r.equity);
    assert.ok(approx(r.n.pnl, -828), 'recalc pnl estável: ' + r.pnl);

    // Inclusão de ativo (LINK) sem inflação
    await page.click('#rp-add-toggle');
    await page.waitForSelector('#rp-add-form:not([hidden])');
    await page.selectOption('#rp-symbol', 'LINK');
    await page.selectOption('#rp-side', 'LONG');
    await page.fill('#rp-quantity', '100');
    await page.fill('#rp-average', '10');
    await page.click('#rp-add');
    await page.waitForTimeout(250);
    await setQuotes(page, { BTC: 5184, LINK: 9.5 });
    r = await read(page);
    assert.ok(approx(r.n.pnl, -878), 'pnl com LINK: ' + r.pnl);
    assert.ok(approx(r.n.equity, 122), 'eq 122 sem inflação: ' + r.equity);
    assert.ok(approx(r.n.equity, 1000 + r.n.pnl), 'invariante');

    // Edição de preço médio (BTC avg 6012 -> 6500)
    await page.fill('#rp-positions .rp-row[data-index="0"] input[data-field="averagePrice"]', '6500');
    await page.dispatchEvent('#rp-positions .rp-row[data-index="0"] input[data-field="averagePrice"]', 'change');
    await page.waitForTimeout(250);
    r = await read(page);
    assert.ok(approx(r.n.pnl, -1316 - 50), 'pnl após editar avg: ' + r.pnl);
    assert.ok(approx(r.n.equity, 1000 + r.n.pnl), 'invariante após editar avg');

    // Aporte em LINK: +100 @ 11 => qty200 avg10.5, cur 9.5 => pnl -200
    await page.click('#rp-add-toggle');
    await page.waitForSelector('#rp-add-form:not([hidden])');
    await page.selectOption('#rp-symbol', 'LINK');
    await page.selectOption('#rp-side', 'LONG');
    await page.fill('#rp-quantity', '100');
    await page.fill('#rp-average', '11');
    await page.click('#rp-add');
    await page.waitForTimeout(250);
    r = await read(page);
    assert.ok(approx(r.n.pnl, -1316 + (-200)), 'pnl após aporte: ' + r.pnl);
    assert.ok(approx(r.n.equity, 1000 + r.n.pnl), 'invariante após aporte');

    // Exclusão e reinclusão
    const countBefore = await page.$$eval('#rp-positions .rp-row', els => els.length);
    await page.click('#rp-positions .rp-row[data-index="1"] [data-delete]');
    await page.waitForTimeout(200);
    const afterDel = await page.$$eval('#rp-positions .rp-row', els => els.length);
    assert.equal(afterDel, countBefore - 1, 'excluiu 1');
    r = await read(page);
    assert.ok(approx(r.n.pnl, -1316), 'pnl sem LINK');
    assert.ok(approx(r.n.equity, 1000 + r.n.pnl), 'invariante após exclusão');

    await page.click('#rp-add-toggle');
    await page.waitForSelector('#rp-add-form:not([hidden])');
    await page.selectOption('#rp-symbol', 'LINK');
    await page.selectOption('#rp-side', 'LONG');
    await page.fill('#rp-quantity', '10');
    await page.fill('#rp-average', '9');
    await page.click('#rp-add');
    await page.waitForTimeout(250);
    await setQuotes(page, { BTC: 5184, LINK: 9.5 });
    r = await read(page);
    assert.ok(approx(r.n.pnl, -1316 + 5), 'pnl após reinclusão: ' + r.pnl);
    assert.ok(approx(r.n.equity, 1000 + r.n.pnl), 'invariante após reinclusão');

    assert.deepEqual(errors, [], 'sem erros JS: ' + errors.join(';'));
  } finally { await browser.close(); }
});
