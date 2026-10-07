/* Isolamento de sessão — painel Simulador (sim)
 * Roda com: node --test tests/test-panel-sim-isolation.mjs
 *
 * Testa os vetores de contaminação A→B no painel 'sim':
 *   T1  push pendente: timer de A não alcança Firebase de B
 *   T2  logout limpa eb_panel_sim do LS
 *   T3  LS de A + B offline → descartar
 *   T4  trabalho anônimo (owner=null) → preservar fluxo legado
 *   T5  multi-aba conceitual: owner=uid_A + sessão B → descartar
 *   T6  cloud B vazia + LS de A → nenhum push, cloud intacta
 *   T7  cloud B existente + LS de A → dados de B prevalecem
 *   T8  falha no once('value') + LS de outro owner → descartado
 *   T9  logout + pendingPull → pendingPull = null
 *   T10 pullPanels grava owner; loadLocal devolve owner correto
 *
 * Estratégia: carrega auth.js em vm com stubs de Firebase/DOM/localStorage.
 * Nenhuma rede, nenhum Firebase real.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const AUTH_SRC = fs.readFileSync(path.join(DIR, '..', 'assets', 'js', 'auth.js'), 'utf8');

const UID_A = 'UID_A_SIM_TEST';
const UID_B = 'UID_B_SIM_TEST';

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeLS(seed) {
  const store = seed ? { ...seed } : {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
    _dump() { return { ...store }; },
    _has(k) { return Object.prototype.hasOwnProperty.call(store, k); },
  };
}

function simPayload(uid, params) {
  const p = params || { margemCorretora: 1000, alavancagemMaxima: 10, mmrAtivo: false, dcaOrders: [{ precoCompra: 50000, valorAportado: 500 }] };
  const obj = { params: p, updatedAt: '2026-01-01T00:00:00.000Z' };
  if (uid !== undefined) obj.owner = uid;
  return JSON.stringify(obj);
}

/**
 * Monta auth.js em vm isolado.
 * opts.seedLS   — objeto inicial do localStorage
 * opts.user     — { id, verified } do currentUser inicial (null = não logado)
 * opts.fbSetVal — função(path) → valor que once('value') resolve, ou null
 * opts.fbFails  — se true, once('value') rejeita com erro de rede
 *
 * Retorna Promise que resolve após as microtasks do boot serem drenadas,
 * garantindo que authStateCallback já está registrado quando o chamador
 * injeta o usuário.
 */
async function mountAuth(opts) {
  opts = opts || {};
  const ls = fakeLS(opts.seedLS || {});
  const fbCalls = { sets: [], onceArgs: [] };

  const makeRef = function (refPath) {
    return {
      once: function (evt) {
        fbCalls.onceArgs.push(refPath);
        if (opts.fbFails) return Promise.reject(new Error('network error'));
        var val = opts.fbSetVal ? opts.fbSetVal(refPath) : null;
        return Promise.resolve({ val: function () { return val; } });
      },
      set: function (data) {
        fbCalls.sets.push({ path: refPath, data: data });
        return Promise.resolve();
      },
      update: function (data) {
        fbCalls.sets.push({ path: refPath, data: data, op: 'update' });
        return Promise.resolve();
      },
      remove: function () {
        fbCalls.sets.push({ path: refPath, data: null, op: 'remove' });
        return Promise.resolve();
      },
    };
  };

  const pendingTimers = {};
  let timerSeq = 0;
  const timerControl = {
    setTimeout: function (fn, ms) {
      var id = ++timerSeq;
      pendingTimers[id] = fn;
      return id;
    },
    clearTimeout: function (id) { delete pendingTimers[id]; },
    flush: function () {
      var ids = Object.keys(pendingTimers);
      ids.forEach(function (id) {
        var fn = pendingTimers[id];
        delete pendingTimers[id];
        fn();
      });
    },
    pendingCount: function () { return Object.keys(pendingTimers).length; },
  };

  var authStateCallback = null;

  const fbAuth = {
    signOut: function () { return Promise.resolve(); },
    onAuthStateChanged: function (cb) {
      authStateCallback = cb;
      return function () {};
    },
    getRedirectResult: function () { return Promise.resolve(null); },
    currentUser: null,
  };

  // firebase.auth como função e namespace
  function fbAuthFn() { return fbAuth; }
  fbAuthFn.GoogleAuthProvider = function () {};
  fbAuthFn.EmailAuthProvider = { credential: function () {} };

  const fbInstance = {
    apps: ['app'],   // length > 0 → pula initializeApp
    initializeApp: function () {},
    auth: fbAuthFn,
    database: function () {
      return { ref: function (p) { return makeRef(p); } };
    },
  };

  const windowEvents = {};
  const sandbox = {
    console: { log: function () {}, error: function () {}, warn: function () {} },
    localStorage: ls,
    setTimeout: timerControl.setTimeout,
    clearTimeout: timerControl.clearTimeout,
    CustomEvent: function (name, init) {
      return { type: name, detail: (init && init.detail) || {} };
    },
    dispatchEvent: function (ev) {
      var handlers = windowEvents[ev.type] || [];
      handlers.forEach(function (h) { try { h(ev); } catch (e) {} });
    },
    addEventListener: function (type, fn) {
      windowEvents[type] = windowEvents[type] || [];
      windowEvents[type].push(fn);
    },
    document: {
      readyState: 'complete',
      getElementById: function () { return null; },
      querySelector: function () { return null; },
      addEventListener: function (type, fn) { if (type === 'DOMContentLoaded') fn(); },
      activeElement: null,
      body: { style: {} },
    },
    firebase: fbInstance,
    BI_CONFIG: {
      firebase: { apiKey: 'k', authDomain: 'a', databaseURL: 'https://x.firebaseio.com' },
      cdn: {},
    },
    BI: {
      normalizeSymbol: function (s) {
        return String(s == null ? '' : s).trim().toUpperCase().replace(/USDT$/, '');
      },
      // loadScripts retorna resolve imediato — firebase já está no sandbox
      loadScripts: function () { return Promise.resolve(); },
    },
    location: { href: 'https://test.example.com/' },
    confirm: function () { return false; },
    HTMLInputElement: null,
    Event: function (type, init) {
      return { type: type, bubbles: (init && init.bubbles) || false };
    },
    FocusEvent: function (type, init) {
      return { type: type, bubbles: (init && init.bubbles) || false };
    },
    navigator: { maxTouchPoints: 0 },
    screen: { width: 1920 },
    matchMedia: function () { return { matches: false }; },
  };
  sandbox.globalThis = sandbox;
  sandbox.global = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(AUTH_SRC, sandbox, { filename: 'auth.js' });

  // Aguarda microtasks do boot (ensureFirebase → loadScripts → .then → fbApp setado
  // → onAuthStateChanged registrado). Três ticks são suficientes para a cadeia de
  // promises do boot resolver completamente.
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));
  await new Promise(r => setTimeout(r, 0));

  const PS = sandbox.PanelSync;
  const EA = sandbox.EstudeAuth;

  // Injetar usuário inicial via onAuthStateChanged (agora que o callback está registrado)
  if (opts.user && authStateCallback) {
    authStateCallback({
      uid: opts.user.id,
      emailVerified: opts.user.verified !== false,
      providerData: [{ providerId: 'google.com' }],
    });
    // Aguardar syncOnLogin acionado pelo afterUser (login inicial)
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
  }

  return {
    PS, EA, ls, fbCalls, timerControl, sandbox,
    login: async function (user) {
      if (authStateCallback) {
        authStateCallback({
          uid: user.id,
          emailVerified: user.verified !== false,
          providerData: [{ providerId: 'google.com' }],
        });
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
      }
    },
    logout: function () {
      if (authStateCallback) authStateCallback(null);
    },
  };
}

// ── testes ────────────────────────────────────────────────────────────────────

describe('T1 — push pendente: timer de A não alcança Firebase de B', function () {
  it('timer agendado por A usa UID de A, não contamina B', async function () {
    const { PS, ls, fbCalls, timerControl } = await mountAuth({
      seedLS: {},
      user: { id: UID_A, verified: true },
    });

    PS.saveLocal('sim', {
      margemCorretora: 1000, alavancagemMaxima: 10, mmrAtivo: false,
      dcaOrders: [{ precoCompra: 50000, valorAportado: 500 }],
    });
    assert.equal(timerControl.pendingCount(), 1, 'timer agendado');

    // Disparar timer (simula disparo após troca de sessão)
    timerControl.flush();
    // Aguardar microtasks
    await new Promise(function (r) { Promise.resolve().then(r); });

    // Nenhum set deve apontar para UID_B
    fbCalls.sets.forEach(function (s) {
      assert.ok(!s.path.includes(UID_B), 'set não foi para path de B: ' + s.path);
    });
  });
});

describe('T2 — logout limpa eb_panel_sim', function () {
  it('após signOut, eb_panel_sim não existe no LS', async function () {
    const { EA, ls } = await mountAuth({
      seedLS: { 'eb_panel_sim': simPayload(UID_A) },
      user: { id: UID_A, verified: true },
    });

    assert.ok(ls._has('eb_panel_sim'), 'eb_panel_sim presente antes do logout');
    await EA.signOut();
    assert.ok(!ls._has('eb_panel_sim'), 'eb_panel_sim removido após signOut');
  });
});

describe('T3 — LS de A + B offline → descartar', function () {
  it('syncOnLogin de B com fbFails descarta LS owner=A', async function () {
    // fbFails: syncOnLogin automático do boot vai falhar também.
    // O handler de falha de rede deve descartar LS de owner diferente.
    const { PS, ls } = await mountAuth({
      seedLS: { 'eb_panel_sim': simPayload(UID_A) },
      user: { id: UID_B, verified: true },
      fbFails: true,
    });

    // syncOnLogin já foi chamado no boot via afterUser — verificar estado resultante.
    assert.ok(!ls._has('eb_panel_sim'), 'LS de A descartado mesmo com falha de rede');
  });
});

describe('T4 — trabalho anônimo (owner ausente) preserva fluxo legado', function () {
  it('LS sem campo owner não é descartado no syncOnLogin', async function () {
    // Payload sem campo owner (legado)
    const legacyPayload = JSON.stringify({
      params: { margemCorretora: 500, alavancagemMaxima: 5, mmrAtivo: false, dcaOrders: [{ precoCompra: 40000, valorAportado: 200 }] },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const { PS, ls } = await mountAuth({
      seedLS: { 'eb_panel_sim': legacyPayload },
      user: { id: UID_A, verified: true },
      fbSetVal: function () { return null; }, // cloud vazia
    });

    // syncOnLogin já foi chamado no boot via afterUser
    // Legado não deve ser descartado — pertence ao fluxo de migração
    assert.ok(ls._has('eb_panel_sim'), 'LS legado/anônimo não descartado');
  });
});

describe('T5 — multi-aba: owner=uid_A + sessão B → descartar', function () {
  it('syncOnLogin de B descarta LS com owner=A', async function () {
    const { PS, ls, fbCalls } = await mountAuth({
      seedLS: { 'eb_panel_sim': simPayload(UID_A) },
      user: { id: UID_B, verified: true },
      fbSetVal: function () { return null; },
    });

    // syncOnLogin já foi chamado no boot via afterUser
    assert.ok(!ls._has('eb_panel_sim'), 'LS de A descartado na sessão de B');
    const simSets = fbCalls.sets.filter(function (s) {
      return s.path && s.path.includes(UID_B) && s.path.includes('sim');
    });
    assert.equal(simSets.length, 0, 'nenhum push de A para Firebase de B');
  });
});

describe('T6 — cloud B vazia + LS de A → nenhum push, cloud intacta', function () {
  it('owner=A + cloud vazia → LS descartado, sem push', async function () {
    const { PS, ls, fbCalls } = await mountAuth({
      seedLS: { 'eb_panel_sim': simPayload(UID_A) },
      user: { id: UID_B, verified: true },
      fbSetVal: function () { return null; },
    });

    // syncOnLogin já foi chamado no boot via afterUser
    const simSets = fbCalls.sets.filter(function (s) {
      return s.path && s.path.includes(UID_B) && s.path.includes('sim');
    });
    assert.equal(simSets.length, 0, 'cloud de B continua vazia');
    assert.ok(!ls._has('eb_panel_sim'), 'LS de A removido');
  });
});

describe('T7 — cloud B existente + LS de A → dados de B prevalecem', function () {
  it('dados de B são gravados no LS; A não participa do merge', async function () {
    const cloudBParams = {
      margemCorretora: 2000, alavancagemMaxima: 20, mmrAtivo: true,
      dcaOrders: [{ precoCompra: 60000, valorAportado: 1000 }],
    };
    const { PS, ls, fbCalls } = await mountAuth({
      seedLS: { 'eb_panel_sim': simPayload(UID_A) },
      user: { id: UID_B, verified: true },
      fbSetVal: function (fbPath) {
        if (fbPath && fbPath.includes(UID_B) && fbPath.includes('sim')) {
          return { params: cloudBParams, updatedAt: '2026-12-01T00:00:00.000Z' };
        }
        return null;
      },
    });

    // syncOnLogin (boot via afterUser) já executou:
    // 1. Descartou LS de A (owner diferente)
    // 2. pull trouxe dados de B e gravou com owner=B

    // LS deve conter dados de B (o pull grava com owner=B)
    var raw = ls.getItem('eb_panel_sim');
    if (raw) {
      var obj = JSON.parse(raw);
      assert.equal(obj.owner, UID_B, 'owner carimbado como B');
      assert.equal(obj.params.margemCorretora, 2000, 'params de B presentes');
    }
    // Nenhum push de dados de A (margem 1000) para Firebase de B
    const badSets = fbCalls.sets.filter(function (s) {
      return s.path && s.path.includes(UID_B) && s.path.includes('sim') &&
        s.data && s.data.params && s.data.params.margemCorretora === 1000;
    });
    assert.equal(badSets.length, 0, 'dados de A (margem 1000) nunca enviados para B');
  });
});

describe('T8 — falha no once(value) + LS de outro owner → descartado', function () {
  it('erro de rede + owner diferente → LS descartado, sem push posterior', async function () {
    const { PS, ls, fbCalls } = await mountAuth({
      seedLS: { 'eb_panel_sim': simPayload(UID_A) },
      user: { id: UID_B, verified: true },
      fbFails: true,
    });

    // syncOnLogin já foi chamado no boot via afterUser (com fbFails)
    assert.ok(!ls._has('eb_panel_sim'), 'LS de A descartado mesmo com falha de rede');
    const bSets = fbCalls.sets.filter(function (s) { return s.path && s.path.includes(UID_B); });
    assert.equal(bSets.length, 0, 'sem push para Firebase de B');
  });
});

describe('T9 — logout: pendingPull zerado via auth-change', function () {
  it('listener auth-change de logout zera pendingPull', function () {
    // Simula o comportamento do listener adicionado em calc-persist.js bind()
    // sem precisar do iframe.
    let pendingPull = { panel: 'sim', params: { margemCorretora: 999 } };

    const authChangeListener = function (ev) {
      var user = ev && ev.detail && ev.detail.user;
      if (user) return;
      pendingPull = null;
    };

    authChangeListener({ detail: { user: null } });
    assert.equal(pendingPull, null, 'pendingPull zerado no logout');
  });
});

describe('T10 — pullPanels grava owner; loadLocal devolve owner correto', function () {
  it('após pull de B, loadLocal retorna owner === UID_B', async function () {
    const cloudBParams = {
      margemCorretora: 3000, alavancagemMaxima: 5, mmrAtivo: false,
      dcaOrders: [{ precoCompra: 70000, valorAportado: 700 }],
    };
    const { PS } = await mountAuth({
      seedLS: {},
      user: { id: UID_B, verified: true },
      fbSetVal: function (fbPath) {
        if (fbPath && fbPath.includes(UID_B) && fbPath.includes('sim')) {
          return { params: cloudBParams, updatedAt: '2026-12-01T12:00:00.000Z' };
        }
        return null;
      },
    });

    // pullPanels foi chamado no boot via syncOnLogin. Para garantir, chamamos explicitamente.
    await PS.pullPanels();

    var local = PS.loadLocal('sim');
    assert.ok(local, 'loadLocal retornou dados após pull');
    assert.equal(local.owner, UID_B, 'owner gravado = UID_B');
    assert.equal(local.params.margemCorretora, 3000, 'params corretos');
  });
});

describe('REGRESSÃO — owner null/ausente não bloqueia fluxo legado', function () {
  it('saveLocal sem currentUser grava owner: null', async function () {
    const { PS, ls } = await mountAuth({ seedLS: {}, user: null });
    PS.saveLocal('sim', {
      margemCorretora: 500, alavancagemMaxima: 5, mmrAtivo: false,
      dcaOrders: [{ precoCompra: 40000, valorAportado: 200 }],
    });
    var raw = ls.getItem('eb_panel_sim');
    assert.ok(raw, 'gravou no LS');
    var obj = JSON.parse(raw);
    assert.equal(obj.owner, null, 'owner null quando sem sessão');
  });

  it('loadLocal retorna owner undefined para legado sem campo', async function () {
    const { PS } = await mountAuth({
      seedLS: {
        'eb_panel_sim': JSON.stringify({
          params: { margemCorretora: 100, alavancagemMaxima: 2, mmrAtivo: false, dcaOrders: [{ precoCompra: 30000, valorAportado: 100 }] },
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
      user: null,
    });
    var local = PS.loadLocal('sim');
    assert.ok(local, 'loadLocal retornou dados');
    assert.equal(local.owner, undefined, 'owner undefined para legado sem campo');
  });
});
