/**
 * Testes de regressão — guarda newer() no ramo risk de syncOnLogin (auth.js).
 *
 * Prova que o push pós-pull só acontece quando o local é REALMENTE mais novo:
 *  1. local mais novo → pushPanel executa, asset correto vai à nuvem;
 *  2. timestamps iguais → ZERO push (sem start/success), nuvem intacta;
 *  3. cloud mais nova → ZERO push (nuvem nunca sobrescrita; pull aplica no local);
 *  4. multi-asset: decisão individual por asset no mesmo syncOnLogin.
 *
 * Isolamento: processo próprio, semeadura direta no localStorage fake
 * (bypassa saveLocal → nenhum timer de debounce espúrio).
 *
 * Execução: `node --test assets/js/panel-sync-synconlogin.test.mjs`
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

const T_OLD = "2026-01-01T00:00:00.000Z";
const T_MID = "2026-06-01T00:00:00.000Z";
const T_NEW = "2026-09-08T12:00:00.000Z";

function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => void m.clear(),
  };
}

const cloud = {};
const pushCalls = [];
function fakeRef(p) {
  return {
    _path: p,
    once: () => Promise.resolve({ val: () => (p in cloud ? JSON.parse(JSON.stringify(cloud[p])) : null) }),
    set: (v) => {
      cloud[p] = JSON.parse(JSON.stringify(v));
      pushCalls.push(p);
      return Promise.resolve();
    },
    update: (v) => {
      cloud[p] = { ...(cloud[p] || {}) };
      for (const k of Object.keys(v)) {
        if (v[k] === null || v[k] === undefined) delete cloud[p][k];
        else cloud[p][k] = v[k];
      }
      return Promise.resolve();
    },
    remove: () => {
      delete cloud[p];
      return Promise.resolve();
    },
  };
}

const fakeUser = {
  uid: "uid-S",
  email: "s@x.com",
  displayName: "S",
  emailVerified: true,
  providerData: [{ providerId: "google.com" }],
};
function fakeAuthFn() {
  return fakeAuth;
}
fakeAuthFn.GoogleAuthProvider = function GoogleAuthProvider() {};
const fakeAuth = {
  signInWithPopup: () => Promise.resolve({ user: fakeUser }),
  signInWithRedirect: () => Promise.resolve(),
  signInWithEmailAndPassword: () => Promise.resolve({ user: fakeUser }),
  createUserWithEmailAndPassword: () =>
    Promise.resolve({ user: { ...fakeUser, sendEmailVerification: () => Promise.resolve() } }),
  signOut: () => Promise.resolve(),
  sendPasswordResetEmail: () => Promise.resolve(true),
  onAuthStateChanged: () => {},
  getRedirectResult: () => Promise.resolve(),
};

const dispatched = [];
function CustomEventFake(type, opts) {
  this.type = type;
  this.detail = (opts && opts.detail) || null;
}

function riskParams(simbolo, saldo) {
  return {
    simbolo,
    moedaConta: "USD",
    saldoCorretora: saldo,
    alavancagem: 5,
    ordens: [{ moeda: "USD", preco: 52000, valor: 15000 }],
    fundingCustoAcumulado: 0,
    mmr: 0,
    lado: "LONG",
  };
}
const lsKey = (a) => `eb_panel_risk_${a}`;
const rpath = (a) => `users/uid-S/panels/risk/${a}`;
function seedLocal(asset, params, updatedAt) {
  globalThis.localStorage.setItem(lsKey(asset), JSON.stringify({ params, updatedAt }));
}
function seedCloud(asset, params, updatedAt) {
  cloud[rpath(asset)] = { params: JSON.parse(JSON.stringify(params)), updatedAt };
}
function clearAsset(asset) {
  globalThis.localStorage.removeItem(lsKey(asset));
  delete cloud[rpath(asset)];
}
function pushEventsSince(n0, asset) {
  return dispatched
    .slice(n0)
    .filter(
      (e) =>
        e.detail &&
        e.detail.panel === "risk" &&
        String(e.type).indexOf("estudebitcoin:panel-push-") === 0 &&
        (!asset || e.detail.asset === asset),
    )
    .map((e) => String(e.type).replace("estudebitcoin:panel-push-", ""));
}

globalThis.localStorage = makeLocalStorage();
globalThis.BI = {
  normalizeSymbol: (s) => String(s == null ? "" : s).trim().toUpperCase().replace(/USDT$/, "") || null,
  loadScripts: () => Promise.resolve(),
};
globalThis.BI_CONFIG = {
  firebase: { apiKey: "x", authDomain: "y", databaseURL: "z" },
  cdn: {},
};
globalThis.firebase = {
  apps: [],
  initializeApp(cfg) {
    this.apps.push(cfg || {});
  },
  auth: fakeAuthFn,
  database: () => ({ ref: (p) => fakeRef(p) }),
};
globalThis.dispatchEvent = (e) => void dispatched.push(e);
globalThis.CustomEvent = CustomEventFake;

await import("./auth.js");
const { PanelSync, EstudeAuth } = globalThis;
assert.ok(PanelSync && EstudeAuth, "auth.js deve expor PanelSync e EstudeAuth");

describe("syncOnLogin — guarda newer() no ramo risk", () => {
  before(async () => {
    await EstudeAuth.signInGoogle();
    await new Promise((r) => setTimeout(r, 100)); // deixa o sync flutuante concluir
  });

  it("1. local mais novo → push executa com o asset correto", async () => {
    clearAsset("BTC");
    seedLocal("BTC", riskParams("BTC", 5101), T_NEW);
    seedCloud("BTC", riskParams("BTC", 100), T_OLD);
    const n0 = dispatched.length;
    await PanelSync.syncOnLogin();
    assert.equal(cloud[rpath("BTC")].params.saldoCorretora, 5101);
    assert.equal(cloud[rpath("BTC")].updatedAt, T_NEW);
    assert.deepEqual(pushEventsSince(n0, "BTC"), ["start", "success"]);
  });

  it("2. timestamps iguais → ZERO push, zero eventos, nuvem intacta", async () => {
    clearAsset("ETH");
    const params = riskParams("ETH", 7202);
    seedLocal("ETH", params, T_MID);
    seedCloud("ETH", params, T_MID);
    const before = JSON.stringify(cloud[rpath("ETH")]);
    const n0 = dispatched.length;
    await PanelSync.syncOnLogin();
    assert.deepEqual(pushEventsSince(n0, "ETH"), [], "nenhum start/success para timestamps iguais");
    assert.equal(JSON.stringify(cloud[rpath("ETH")]), before, "nuvem byte-idêntica");
  });

  it("3. cloud mais nova → ZERO push, nuvem nunca sobrescrita (pull aplica no local)", async () => {
    clearAsset("SOL");
    seedLocal("SOL", riskParams("SOL", 1), T_OLD);
    seedCloud("SOL", riskParams("SOL", 9300), T_NEW);
    const before = JSON.stringify(cloud[rpath("SOL")]);
    const n0 = dispatched.length;
    await PanelSync.syncOnLogin();
    assert.deepEqual(pushEventsSince(n0, "SOL"), [], "nenhum push contra nuvem mais nova");
    assert.equal(JSON.stringify(cloud[rpath("SOL")]), before, "nuvem preservada");
    const local = JSON.parse(globalThis.localStorage.getItem(lsKey("SOL")));
    assert.equal(local.params.saldoCorretora, 9300, "pull aplicou a nuvem no local");
  });

  it("4. multi-asset: decisão individual (AVAX sobe, LINK quieto)", async () => {
    clearAsset("AVAX");
    clearAsset("LINK");
    seedLocal("AVAX", riskParams("AVAX", 91), T_NEW);
    seedCloud("AVAX", riskParams("AVAX", 1), T_OLD);
    const linkParams = riskParams("LINK", 300);
    seedLocal("LINK", linkParams, T_MID);
    seedCloud("LINK", linkParams, T_MID);
    const linkBefore = JSON.stringify(cloud[rpath("LINK")]);
    const n0 = dispatched.length;
    await PanelSync.syncOnLogin();
    assert.equal(cloud[rpath("AVAX")].params.saldoCorretora, 91);
    assert.deepEqual(pushEventsSince(n0, "AVAX"), ["start", "success"]);
    assert.deepEqual(pushEventsSince(n0, "LINK"), [], "LINK igual: silencioso");
    assert.equal(JSON.stringify(cloud[rpath("LINK")]), linkBefore);
  });
});
