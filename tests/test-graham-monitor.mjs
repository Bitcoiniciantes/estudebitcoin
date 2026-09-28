/* Estados do botão Monitorar no modal Graham (sem rede, sem API).
 * Roda com: node --test test-graham-monitor.mjs
 * DOM e fetch stubados; exercita Graham.open() de verdade:
 * 29 monitorados → Monitorar habilitado; 30 → desabilitado com a mensagem
 * do limite; já monitorado → "Já monitorado"; sem justo → desabilitado;
 * consulta nunca salva sozinha (sem onMonitor chamado no load). */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../assets/js/portfolio/graham.js');

function mkEl() {
  const el = {
    children: [],
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    title: '',
    style: {},
    innerHTML: '',
    handlers: {},
    setAttribute(k, v) { el[k] = v; },
    removeAttribute(k) { delete el[k]; },
    addEventListener(t, f) { (el.handlers[t] = el.handlers[t] || []).push(f); },
    removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    insertBefore(c) { el.children.push(c); return c; },
    querySelector() { return null; },
  };
  return el;
}

// Monta o "document" mínimo que open() precisa, com seletores resolvidos.
function mountDoc() {
  const parts = {
    card: mkEl(), body: mkEl(), close: mkEl(), footBtn: mkEl(),
    monitor: mkEl(), h3: mkEl(),
  };
  const resolve = (sel) => {
    if (sel === '.gb-card') return parts.card;
    if (sel === '.gb-body') return parts.body;
    if (sel === '.gb-close') return parts.close;
    if (sel === '.gb-primary') return parts.monitor;
    if (sel === '.gb-head h3') return parts.h3;
    if (sel === '.gb-foot .gb-btn:not(.gb-primary)') return parts.footBtn;
    if (sel === '.gb-name') return null;
    return null;
  };
  const doc = {
    body: mkEl(),
    _parts: parts,
    createElement: () => {
      const el = mkEl();
      el.querySelector = resolve;
      return el;
    },
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  };
  return doc;
}

// fundamentals por ticker, sem rede.
let fundByTicker = {};
function stubFetch() {
  globalThis.fetch = async (url) => {
    const m = String(url).match(/symbol=([^&]+)/);
    const t = m ? decodeURIComponent(m[1]) : 'X';
    const f = fundByTicker[t] || null;
    if (!f) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => f };
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const goodFund = {
  lpa: 10, vpa: 40, price: 100, currency: 'USD', name: 'Empresa X',
  source: 'worker', fetchedAt: '2026-01-01T00:00:00.000Z',
};

async function openModal(ticker, opts) {
  const doc = mountDoc();
  globalThis.document = doc;
  G.open(ticker, opts);
  await sleep(50);
  return { doc, monitor: doc._parts.monitor };
}

describe('botão Monitorar (sem API)', () => {
  beforeEach(() => {
    stubFetch();
    fundByTicker = { T1: goodFund };
    G._test.clearCache();
  });

  it('1. consulta sozinha não salva (sem onMonitor no load)', async () => {
    let saved = 0;
    const { monitor } = await openModal('T1', {
      isMonitored: () => false,
      monitorInfo: () => ({ count: 0, limit: 30 }),
      onMonitor: () => { saved++; },
    });
    await sleep(20);
    assert.equal(saved, 0, 'load não salva');
    assert.equal(monitor.disabled, false, 'habilitado com 0/30');
    assert.equal(monitor.textContent, 'Monitorar');
  });

  it('2. com 29 monitorados, Monitorar funciona e salva 1×', async () => {
    let saved = null;
    const { monitor } = await openModal('T1', {
      isMonitored: () => false,
      monitorInfo: () => ({ count: 29, limit: 30 }),
      onMonitor: (r) => { saved = r; },
    });
    assert.equal(monitor.disabled, false);
    monitor.handlers.click.forEach((f) => f());
    assert.ok(saved && saved.ticker === 'T1', 'Monitorar chamou onMonitor 1×');
  });

  it('3. com 30 monitorados, desabilitado com a mensagem do limite', async () => {
    let saved = 0;
    const { monitor } = await openModal('T1', {
      isMonitored: () => false,
      monitorInfo: () => ({ count: 30, limit: 30 }),
      onMonitor: () => { saved++; },
    });
    assert.equal(monitor.disabled, true);
    assert.equal(monitor.textContent, 'Monitorar');
    assert.equal(monitor.title, 'Limite de 30 ativos: remova um para adicionar.');
    monitor.handlers.click.forEach((f) => f());
    assert.equal(saved, 0, 'clique com tabela cheia não salva');
  });

  it('4. já monitorado: "Já monitorado" desabilitado', async () => {
    const { monitor } = await openModal('T1', {
      isMonitored: (t) => t === 'T1',
      monitorInfo: () => ({ count: 5, limit: 30 }),
      onMonitor: () => { throw new Error('não deve salvar'); },
    });
    assert.equal(monitor.disabled, true);
    assert.equal(monitor.textContent, 'Já monitorado');
  });

  it('5. sem justo (fonte sem LPA/VPA): desabilitado com motivo', async () => {
    fundByTicker.T2 = { lpa: null, vpa: null, price: 50, currency: 'USD', name: 'Y', source: 'worker' };
    const { monitor } = await openModal('T2', {
      isMonitored: () => false,
      monitorInfo: () => ({ count: 0, limit: 30 }),
      onMonitor: () => { throw new Error('não deve salvar'); },
    });
    assert.equal(monitor.disabled, true);
    assert.ok(monitor.title.includes('fonte não forneceu'), `title: ${monitor.title}`);
  });

  it('6. LPA negativo: desabilitado com motivo de prejuízo', async () => {
    fundByTicker.T3 = { lpa: -2, vpa: 40, price: 50, currency: 'USD', name: 'Z', source: 'worker' };
    const { monitor } = await openModal('T3', {
      isMonitored: () => false,
      monitorInfo: () => ({ count: 0, limit: 30 }),
      onMonitor: () => { throw new Error('não deve salvar'); },
    });
    assert.equal(monitor.disabled, true);
    assert.ok(monitor.title.includes('negativos'), `title: ${monitor.title}`);
  });
});
