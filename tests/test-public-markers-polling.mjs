import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/js/conversor.js', import.meta.url), 'utf8');
const pullCode = source.slice(source.indexOf('  function pullPublicMarkers('), source.indexOf('  function isExternalStock() {'));
const visibilityCode = source.slice(source.indexOf("  document.addEventListener('visibilitychange',"), source.indexOf('  // --- EVENTOS FINAIS ---'));

function setup(hidden = false) {
  const timers = new Map();
  const listeners = new Map();
  const requests = [];
  let nextTimer = 1;
  let asset = 'pair:BTC:USD';
  let respond = () => Promise.resolve({ updatedAt: 0, markers: [] });
  const document = {
    hidden,
    addEventListener(name, callback) { listeners.set(name, callback); },
  };
  const context = vm.createContext({
    document,
    console: { warn() {} },
    markerLines: [],
    lastPublicMarkerUpdate: 0,
    publicMarkerPollTimer: null,
    publicMarkerWasHidden: hidden,
    pendingPublicMarkerPull: null,
    queuedPublicMarkerPull: false,
    markerStorageKey: () => asset,
    publicMarkersRequest(method, markers, key) { requests.push({ method, key }); return respond(); },
    isValidMarker: () => true,
    saveMarkers() {},
    renderBaseChart() {},
    setInterval(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(pullCode + visibilityCode, context);
  return {
    context, document, timers, requests,
    setAsset(value) { asset = value; },
    setResponder(value) { respond = value; },
    visibility(value) { document.hidden = value; listeners.get('visibilitychange')(); },
    tick() { for (const timer of [...timers.values()]) timer.callback(); },
  };
}

test('marcadores: 30 s visível, pausa oculta e uma leitura ao voltar', async () => {
  const h = setup();
  assert.equal(h.timers.size, 1);
  assert.equal([...h.timers.values()][0].delay, 30000);
  h.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 1);
  h.visibility(true);
  assert.equal(h.timers.size, 0);
  h.tick();
  assert.equal(h.requests.length, 1);
  h.visibility(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.length, 2);
  assert.equal(h.timers.size, 1);
  h.visibility(false);
  assert.equal(h.requests.length, 2);
});

test('marcadores: leitura pendente não concorre e troca de ativo usa a chave nova', async () => {
  const h = setup();
  const resolvers = [];
  h.setResponder(() => new Promise((resolve) => resolvers.push(resolve)));
  const first = vm.runInContext('pullPublicMarkers()', h.context);
  h.tick();
  assert.equal(h.requests.length, 1, 'timer não cria nova leitura enquanto há uma pendente');
  h.setAsset('stock:PETR4');
  vm.runInContext('pullPublicMarkers(true)', h.context);
  assert.equal(h.requests.length, 1);
  resolvers.shift()({ updatedAt: 1, markers: [{ price: 1 }] });
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.requests.map((request) => request.key), ['pair:BTC:USD', 'stock:PETR4']);
  assert.equal(h.context.markerLines.length, 0, 'resposta do ativo anterior é descartada');
  resolvers.shift()({ updatedAt: 2, markers: [{ price: 2 }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.context.markerLines.length, 1);
});
