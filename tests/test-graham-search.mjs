/* Testes de disparo da busca Graham no ticker-widget (UX — zero chamadas
 * ao digitar; exatamente 1 no Consultar/Enter; empresa preenchida no retorno).
 * Roda com: node --test tests/test-graham-search.mjs
 * Carrega o ticker-widget.js real num sandbox vm com DOM mínimo + timers
 * manuais; window.Graham é stubado com contadores. Sem rede, sem DOM real. */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../assets/js/portfolio/graham.js'); // só p/ messageForKind real
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function makeEl(id) {
  const el = {
    id: id || '',
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    title: '',
    className: '',
    style: {},
    nextSibling: null,
    _listeners: {},
    addEventListener(type, fn) { ((this._listeners[type] = this._listeners[type] || [])).push(fn); },
    removeEventListener() {},
    appendChild() { return null; },
    querySelector() { return null; },
    getAttribute() { return null; },
    setAttribute() {},
    removeAttribute() {},
    closest() { return null; },
  };
  el.parentNode = { insertBefore() {}, appendChild() {} };
  return el;
}

function loadWidget() {
  const els = {};
  const docListeners = {};
  const timers = [];
  const fetchUrls = [];
  const grahamStub = {
    openCalls: [],
    fundCalls: 0,
    lookupCalls: [],
    lookupResult: null,
    open(ticker, opts) { this.openCalls.push({ ticker, opts }); },
    getFundamentals(t) { this.fundCalls++; return Promise.resolve(null); },
    lookupTickerName(t) { this.lookupCalls.push(t); return Promise.resolve(this.lookupResult); },
    resolveTicker() { return Promise.resolve(null); },
    messageForKind: G.messageForKind,
  };
  const fakeDocument = {
    activeElement: null,
    body: makeEl('body'),
    getElementById(id) { return els[id] || (els[id] = makeEl(id)); },
    createElement() { return makeEl(''); },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { ((docListeners[type] = docListeners[type] || [])).push(fn); },
    removeEventListener() {},
  };
  const fakeWindow = {
    setTimeout(cb) { timers.push({ cb, cancelled: false }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    setInterval() { return 0; },
    addEventListener() {},
    dispatchEvent() { return true; },
    innerHeight: 800,
    Graham: grahamStub,
  };
  const sandbox = {
    console,
    document: fakeDocument,
    window: fakeWindow,
    fetch: (url) => { fetchUrls.push(String(url)); return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }); },
    Promise,
    JSON,
    encodeURIComponent,
    AbortController,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'assets/js/ticker-widget.js'), 'utf8');
  vm.runInContext(src, sandbox, { filename: 'ticker-widget.js' });
  return { els, timers, fetchUrls, grahamStub, fire, flush: () => new Promise((r) => setImmediate(r)), runTimers };

  function fire(el, type, extra) {
    const list = (el._listeners[type] || []).slice();
    for (const fn of list) fn(Object.assign({ preventDefault() {}, target: el }, extra));
  }

  // Dispara os timers pendentes do debounce, respeitando cancelamentos.
  function runTimers() {
    const pending = timers.splice(0, timers.length);
    for (const t of pending) if (!t.cancelled) t.cb();
  }
}

let H;
before(() => { H = loadWidget(); });

function typeTicker(v) {
  H.els['tq-graham-input'].value = v;
  H.fire(H.els['tq-graham-input'], 'input');
}

describe('busca Graham ao vivo (search, sem rate limit)', () => {
  function reset() {
    H.grahamStub.openCalls.length = 0;
    H.grahamStub.fundCalls = 0;
    H.grahamStub.lookupCalls.length = 0;
    H.grahamStub.lookupResult = null;
    H.els['tq-graham-name'].value = '';
  }
  it('5a. 1 letra não consulta nem após o debounce', async () => {
    reset();
    typeTicker('G');
    H.runTimers();
    await H.flush();
    assert.equal(H.grahamStub.lookupCalls.length, 0, '<2 letras: nenhuma consulta');
    assert.equal(H.els['tq-graham-name'].value, '', 'campo intocado');
  });
  it('5b. digitar G/GO/GOO/GOOG/GOOGL dispara 1 lookup (debounce), ZERO fundamentals', async () => {
    reset();
    for (const v of ['G', 'GO', 'GOO', 'GOOG', 'GOOGL']) typeTicker(v);
    H.runTimers(); // só o último timer sobrevive ao debounce
    await H.flush();
    assert.deepEqual(H.grahamStub.lookupCalls, ['GOOGL'], '1 lookup com o texto final');
    assert.equal(H.grahamStub.openCalls.length, 0, 'open não dispara ao digitar');
    assert.equal(H.grahamStub.fundCalls, 0, 'getFundamentals não dispara ao digitar');
    assert.ok(!H.fetchUrls.some((u) => u.includes('fundamentals')), 'nenhum fetch a /api/fundamentals');
  });
  it('5c. match exato preenche; sem match o campo fica intocado', async () => {
    reset();
    H.grahamStub.lookupResult = 'Petróleo Brasileiro S.A. - Petrobras';
    typeTicker('PETR4');
    H.runTimers();
    await H.flush();
    assert.equal(H.els['tq-graham-name'].value, 'Petróleo Brasileiro S.A. - Petrobras');
    reset();
    H.grahamStub.lookupResult = null; // fora do catálogo / sem match
    typeTicker('AAPL');
    H.runTimers();
    await H.flush();
    assert.deepEqual(H.grahamStub.lookupCalls, ['AAPL'], 'consultou a search');
    assert.equal(H.els['tq-graham-name'].value, '', 'sem match: sem erro no campo');
    assert.ok(!H.fetchUrls.some((u) => u.includes('fundamentals')), 'sem match: ainda zero fundamentals');
  });
});

describe('busca Graham: Consultar/Enter (1 fundamentals)', () => {
  it('6. Consultar com ticker completo dispara EXATAMENTE uma consulta', async () => {
    H.grahamStub.openCalls.length = 0;
    H.els['tq-graham-input'].value = 'GOOGL';
    H.fire(H.els['tq-graham-go'], 'click');
    await H.flush();
    assert.equal(H.grahamStub.openCalls.length, 1);
    assert.equal(H.grahamStub.openCalls[0].ticker, 'GOOGL');
  });
  it('7. Enter com ticker completo dispara EXATAMENTE uma consulta', async () => {
    H.grahamStub.openCalls.length = 0;
    H.els['tq-graham-input'].value = 'AAPL';
    H.fire(H.els['tq-graham-input'], 'keydown', { key: 'Enter' });
    await H.flush();
    assert.equal(H.grahamStub.openCalls.length, 1);
    assert.equal(H.grahamStub.openCalls[0].ticker, 'AAPL');
  });
});

describe('busca Graham: campo empresa pós-Consultar', () => {
  it('preenche fund.name quando a consulta retorna', async () => {
    H.els['tq-graham-input'].value = 'GOOGL';
    H.els['tq-graham-name'].value = '';
    H.fire(H.els['tq-graham-go'], 'click');
    await H.flush();
    const opts = H.grahamStub.openCalls[H.grahamStub.openCalls.length - 1].opts;
    assert.ok(opts && typeof opts.onSettled === 'function', 'open recebe onSettled');
    opts.onSettled({ ticker: 'GOOGL', fund: { name: 'Alphabet Inc.', lpa: 7, vpa: 30 }, err: null });
    assert.equal(H.els['tq-graham-name'].value, 'Alphabet Inc.');
  });
  it('dados válidos sem nome → preenche o ticker (nunca erro)', async () => {
    H.els['tq-graham-input'].value = 'PETR4';
    H.fire(H.els['tq-graham-go'], 'click');
    await H.flush();
    const opts = H.grahamStub.openCalls[H.grahamStub.openCalls.length - 1].opts;
    opts.onSettled({ ticker: 'PETR4', fund: { name: null, lpa: 10.3, vpa: 40 }, err: null });
    assert.equal(H.els['tq-graham-name'].value, 'PETR4');
  });
  it('erro rate_limited → mensagem do limite (não "Verifique ticker")', async () => {
    H.els['tq-graham-input'].value = 'AAPL';
    H.fire(H.els['tq-graham-go'], 'click');
    await H.flush();
    const opts = H.grahamStub.openCalls[H.grahamStub.openCalls.length - 1].opts;
    opts.onSettled({ ticker: 'AAPL', fund: null, err: { kind: 'rate_limited' } });
    assert.equal(H.els['tq-graham-name'].value, 'Muitas consultas hoje, tente novamente mais tarde.');
  });
  it('erro not_found → "Verifique ticker"', async () => {
    H.els['tq-graham-input'].value = 'NDVA';
    H.fire(H.els['tq-graham-go'], 'click');
    await H.flush();
    const opts = H.grahamStub.openCalls[H.grahamStub.openCalls.length - 1].opts;
    opts.onSettled({ ticker: 'NDVA', fund: null, err: { kind: 'not_found' } });
    assert.equal(H.els['tq-graham-name'].value, 'Verifique ticker.');
  });
});
