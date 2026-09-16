// Teste do motor independente da carteira (portfolioLive) — contrato de evento.
// Roda com: node test-portfolio-live.mjs
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

// ---- Harness de browser mínimo ----
const seen = [];
globalThis.CustomEvent = function (type, opts) { this.type = type; this.detail = (opts && opts.detail) || null; };
let mockService = null;
globalThis.PainelAtivos = { getService: () => mockService };
const dispatched = [];
globalThis.dispatchEvent = (ev) => { dispatched.push(ev); return true; };
globalThis.document = { hidden: false, addEventListener: () => {} };
globalThis.WebSocket = undefined; // força fallback REST (sem WS no Node)

const src = readFileSync(new URL('../assets/js/portfolio/portfolioLive.js', import.meta.url), 'utf8');
// Impede auto-start (interval) de segurar o processo: avalia com setInterval mockado.
const _setInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
const mod = await import('../assets/js/portfolio/portfolioLive.js');
globalThis.setInterval = _setInterval;
const Live = globalThis.PortfolioLive;
ok('expõe window.PortfolioLive', !!Live && typeof Live.resync === 'function');

// ---- Mock fetch: Worker + Binance ----
const workerQuotes = {
  quotes: [
    { symbol: 'SLV', price: 58.12, changePct: 1.08 },
    { symbol: 'MSTR', price: 130.97, changePct: 1.87 },
    // GEMI ausente de propósito (desconhecido → sem dispatch)
  ]
};
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/quotes')) {
    return { ok: true, json: async () => workerQuotes };
  }
  if (String(url).includes('api.binance.com')) {
    if (String(url).includes('BNBUSDT')) {
      return { ok: true, json: async () => ({ lastPrice: '724.86', priceChangePercent: '1.80' }) };
    }
    return { ok: false, status: 400, json: async () => ({}) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

mockService = {
  query: () => ({
    assets: [
      { ticker: 'SLV', type: 'STOCK' },
      { ticker: 'MSTR', type: 'STOCK' },
      { ticker: 'GEMI', type: 'STOCK' },
      { ticker: 'BNB', type: 'CRYPTO' },
    ]
  })
};

const T = Live._test;
ok('cryptoPair BNB→BNBUSDT', T.cryptoPair('BNB') === 'BNBUSDT');
ok('cryptoPair POL→POLUSDT', T.cryptoPair('POL') === 'POLUSDT');
ok('isUsdtBrl detecta USDT-BRL', T.isUsdtBrl('USDT-BRL') === true);

dispatched.length = 0;
await Live.resync();
await new Promise((r) => setTimeout(r, 50));

const details = dispatched.map((e) => e.detail);
const keys = new Set();
for (const d of details) Object.keys(d || {}).forEach((k) => keys.add(k));
ok('evento usa changePct (não change24h)', keys.has('changePct') && !keys.has('change24h'), [...keys].join(','));
ok('symbol é ticker puro (BNB, não BNBUSDT)', details.some((d) => d.symbol === 'BNB') && !details.some((d) => d.symbol === 'BNBUSDT'));
ok('SLV via Worker vira snapshot', details.some((d) => d.symbol === 'SLV' && d.source === 'snapshot' && d.price === 58.12 && d.changePct === 1.08));
ok('BNB via Binance vira snapshot (sem WS no Node)', details.some((d) => d.symbol === 'BNB' && d.price === 724.86 && d.changePct === 1.8));
ok('GEMI desconhecida não emite (sem dot)', !details.some((d) => d.symbol === 'GEMI'));
ok('price>0 em todos os dispatches', details.every((d) => Number.isFinite(Number(d.price)) && Number(d.price) > 0));

// ---- 11. Backoff com jitter + reset após mensagem válida ----
{
  const d0 = T.wsDelayFor(0), d1 = T.wsDelayFor(1), d2 = T.wsDelayFor(2), dCap = T.wsDelayFor(20);
  ok('backoff cresce com jitter (1s→2s→4s)', d0 >= 500 && d0 <= 1000 && d1 >= 1000 && d1 <= 2000 && d2 >= 2000 && d2 <= 4000, `${d0}/${d1}/${d2}`);
  ok('backoff respeita teto 30s', dCap <= 30000, String(dCap));
}

// Mock WebSocket para os testes 12–13.
function MockWS(url) {
  MockWS.instances.push(this);
  this.url = url;
  this.closed = false;
  this.close = () => { if (!this.closed) { this.closed = true; MockWS.closes++; } };
}
MockWS.instances = [];
MockWS.closes = [];
MockWS.closes = 0;
globalThis.WebSocket = MockWS;

// ---- 12. Aba oculta fecha WS; ao voltar reabre 1 conexão (sem duplicar) ----
Live.start(); // liga polling+WS (será desligado no fim do teste)
await new Promise((r) => setTimeout(r, 1300)); // debounce do resync inicial
const openBefore = MockWS.instances.filter((w) => !w.closed).length;
ok('WS aberto após start', openBefore >= 1, `open=${openBefore}`);
globalThis.document.hidden = true;
T.onVisibility(globalThis.document);
ok('aba oculta fecha WS', T.isWsOpen() === false && MockWS.closes >= 1, `closes=${MockWS.closes}`);
const instancesAfterHide = MockWS.instances.length;
globalThis.document.hidden = false;
T.onVisibility(globalThis.document);
await new Promise((r) => setTimeout(r, 1400)); // debounce do resync de volta
const newInstances = MockWS.instances.length - instancesAfterHide;
const openAfter = MockWS.instances.filter((w) => !w.closed).length;
ok('aba visível reabre exatamente 1 WS (sem duplicar)', newInstances === 1 && openAfter === 1, `new=${newInstances} open=${openAfter}`);

// ---- 13. Debounce de resync: 5 chamadas rápidas = 1 batch Worker ----
{
  // Simula 2 falhas de WS para validar reset do backoff na sequência.
  const inst = MockWS.instances[MockWS.instances.length - 1];
  if (inst && inst.onclose) { inst.onclose(); inst.onclose(); }
  const failsBefore = T.getWsFails();
  const validEv = { data: JSON.stringify({ stream: 'bnbusdt@ticker', data: { c: '700.5', P: '1.5' } }) };
  const handled = T.handleWsMessage(validEv, { bnbusdt: 'BNB' });
  ok('backoff reseta após mensagem válida', handled === true && failsBefore >= 1 && T.getWsFails() === 0, `fails=${failsBefore}→${T.getWsFails()}`);

  let workerCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    if (String(url).includes('/api/quotes')) workerCalls++;
    return realFetch(url, ...rest);
  };
  await Promise.all([Live.resync(), Live.resync(), Live.resync(), Live.resync(), Live.resync()]);
  await new Promise((r) => setTimeout(r, 200));
  globalThis.fetch = realFetch;
  ok('debounce: 5 resyncs rápidos = 1 batch Worker', workerCalls === 1, `calls=${workerCalls}`);
}
Live.stop();

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
