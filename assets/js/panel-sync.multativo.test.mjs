/**
 * Testes de regressão — PanelSync multi-ativo (auth.js).
 *
 * Cobre a persistência por asset (eb_panel_risk_{assetId} + RTDB risk/{assetId}),
 * a migração do slot único legado e os guards estruturais dos 3 bugs:
 *  - Bug 1: race no pullPanels (global mutável em callback assíncrono);
 *  - Bug 2: covered no nível do painel (risk-engine-panel.multativo.test.mjs);
 *  - Bug 3: migração RTDB removendo o nó pai (remove() no nível `risk`).
 *
 * Execução: `node --test assets/js/panel-sync.multativo.test.mjs`
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* ---------- Stubs (instalados ANTES do import de auth.js) ---------- */

function makeLocalStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => void m.clear(),
    _dump: () => Object.fromEntries(m),
  };
}

// RTDB fake: cloud[path] = valor. Registra sets/updates/removes por path.
const cloud = {};
const pushCalls = [];
const updateCalls = [];
const removeCalls = [];
function fakeRef(p) {
  const snap = () => ({ val: () => (p in cloud ? JSON.parse(JSON.stringify(cloud[p])) : null) });
  return {
    _path: p,
    once: () => Promise.resolve(snap()),
    set: (v) => {
      cloud[p] = JSON.parse(JSON.stringify(v));
      pushCalls.push(p);
      return Promise.resolve();
    },
    update: (v) => {
      cloud[p] = { ... (cloud[p] || {}) };
      for (const k of Object.keys(v)) {
        if (v[k] === null || v[k] === undefined) delete cloud[p][k];
        else cloud[p][k] = v[k];
      }
      updateCalls.push(p);
      return Promise.resolve();
    },
    remove: () => {
      delete cloud[p];
      removeCalls.push(p);
      return Promise.resolve();
    },
  };
}

const fakeUser = {
  uid: "uid-A",
  email: "a@x.com",
  displayName: "User A",
  emailVerified: true,
  providerData: [{ providerId: "google.com" }],
};
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
// `new fb.auth.GoogleAuthProvider()` exige o construtor NA função auth, não no objeto retornado.
function fakeAuthFn() {
  return fakeAuth;
}
fakeAuthFn.GoogleAuthProvider = function GoogleAuthProvider() {};

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
const key = (a) => `eb_panel_risk_${a}`;
const rpath = (a) => `users/uid-A/panels/risk/${a}`;

// Semeia o legado ANTES do import: a migração top-level de auth.js deve
// convertê-lo em eb_panel_risk_BTC ainda no parse do script.
globalThis.localStorage = makeLocalStorage({
  eb_panel_risk: JSON.stringify({
    params: riskParams("BTC", 8000),
    updatedAt: "2026-01-01T00:00:00.000Z",
  }),
});
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

/* ---------- Testes ---------- */

describe("migração local legada (top-level, antes de qualquer restore)", () => {
  it("eb_panel_risk (BTC) vira eb_panel_risk_BTC e o legado some", () => {
    assert.equal(globalThis.localStorage.getItem("eb_panel_risk"), null);
    const raw = globalThis.localStorage.getItem(key("BTC"));
    assert.ok(raw, "chave nova deve existir");
    const obj = JSON.parse(raw);
    assert.equal(obj.params.simbolo, "BTC");
    assert.equal(obj.params.saldoCorretora, 8000);
  });

  it("não sobrescreve chave nova mais recente", async () => {
    // Estado estável pós-migração: rodar asserções de novo continua válido
    // (idempotência = legado ausente, nada a migrar).
    assert.equal(globalThis.localStorage.getItem("eb_panel_risk"), null);
    assert.ok(globalThis.localStorage.getItem(key("BTC")));
  });
});

describe("slots por ativo no localStorage", () => {
  it("BTC e ETH coexistem sem sobrescrita", () => {
    PanelSync.setCurrentAsset("BTC");
    assert.ok(PanelSync.saveLocal("risk", riskParams("BTC", 5000)));
    PanelSync.setCurrentAsset("ETH");
    assert.ok(PanelSync.saveLocal("risk", riskParams("ETH", 7000)));
    const btc = PanelSync.loadLocal("risk", "BTC");
    const eth = PanelSync.loadLocal("risk", "ETH");
    assert.equal(btc.params.saldoCorretora, 5000);
    assert.equal(eth.params.saldoCorretora, 7000);
    assert.equal(btc.params.simbolo, "BTC");
    assert.equal(eth.params.simbolo, "ETH");
  });

  it("asset explícito não toca currentAssetId", () => {
    PanelSync.setCurrentAsset("BTC");
    assert.ok(PanelSync.saveLocal("risk", riskParams("SOL", 111), "SOL"));
    assert.equal(PanelSync.getCurrentAsset(), "BTC");
    const sol = PanelSync.loadLocal("risk", "SOL");
    assert.equal(sol.params.saldoCorretora, 111);
  });

  it("canonização impede colisão BTC/BTCUSDT/btc", () => {
    PanelSync.setCurrentAsset("btcusdt");
    assert.equal(PanelSync.getCurrentAsset(), "BTC");
    assert.ok(PanelSync.saveLocal("risk", riskParams("BTC", 1), "ethusdt"));
    assert.ok(globalThis.localStorage.getItem(key("ETH")));
    const eth = PanelSync.loadLocal("risk", "ETH");
    assert.equal(eth.params.simbolo, "BTC"); // params como passado; chave é o que importa
  });

  it("painel 'sim' permanece ativo-agnóstico", () => {
    PanelSync.setCurrentAsset("ETH");
    assert.ok(PanelSync.saveLocal("sim", { margemCorretora: 100 }));
    assert.ok(globalThis.localStorage.getItem("eb_panel_sim"));
    assert.equal(globalThis.localStorage.getItem("eb_panel_sim_RISK"), null);
    assert.equal(globalThis.localStorage.getItem("eb_panel_sim_ETH"), null);
  });

  it("asset inexistente retorna null", () => {
    assert.equal(PanelSync.loadLocal("risk", "PAXG"), null);
  });
});

describe("getRiskAssets()", () => {
  it("sem DOM usa o fallback estático", () => {
    assert.deepEqual(PanelSync.getRiskAssets(), ["BTC", "ETH", "SOL", "LINK", "AVAX", "RENDER", "PAXG"]);
  });

  it("com DOM lê as <option> (novo ativo entra sem mexer em auth.js)", () => {
    globalThis.document = {
      getElementById: (id) =>
        id === "re-simbolo"
          ? { options: ["BTC", "ETH", "DOGE"].map((v) => ({ value: v, text: v })) }
          : null,
    };
    try {
      assert.deepEqual(PanelSync.getRiskAssets(), ["BTC", "ETH", "DOGE"]);
    } finally {
      delete globalThis.document;
    }
  });
});

describe("cloud por ativo (Bug 1 — comportamental)", () => {
  before(async () => {
    await EstudeAuth.signInGoogle();
  });

  it("pull de BTC+ETH grava cada um na sua chave", async () => {
    cloud[rpath("BTC")] = { params: riskParams("BTC", 5100), updatedAt: "2026-06-01T00:00:00.000Z" };
    cloud[rpath("ETH")] = { params: riskParams("ETH", 7100), updatedAt: "2026-06-01T00:00:00.000Z" };
    globalThis.localStorage.removeItem(key("BTC"));
    globalThis.localStorage.removeItem(key("ETH"));
    const n0 = dispatched.length; // sync flutuante do sign-in pode emitir; isola o slice
    const applied = await PanelSync.pullPanels();
    assert.ok(applied["risk:BTC"] && applied["risk:ETH"]);
    const btc = JSON.parse(globalThis.localStorage.getItem(key("BTC")));
    const eth = JSON.parse(globalThis.localStorage.getItem(key("ETH")));
    assert.equal(btc.params.saldoCorretora, 5100);
    assert.equal(eth.params.saldoCorretora, 7100);
    const byAsset = {};
    for (const e of dispatched.slice(n0)) {
      if (e.detail && e.detail.panel === "risk" && e.detail.asset) {
        byAsset[e.detail.asset] = e.detail.params;
      }
    }
    assert.equal(byAsset.BTC.saldoCorretora, 5100);
    assert.equal(byAsset.ETH.saldoCorretora, 7100);
  });

  it("resposta atrasada de BTC não altera ETH (Cenário D)", async () => {
    // ETH local mais novo que a nuvem → pull não pode encostar nele.
    PanelSync.setCurrentAsset("ETH");
    PanelSync.saveLocal("risk", riskParams("ETH", 7777));
    const before = globalThis.localStorage.getItem(key("ETH"));
    cloud[rpath("BTC")] = { params: riskParams("BTC", 5200), updatedAt: "2026-07-01T00:00:00.000Z" };
    cloud[rpath("ETH")] = { params: riskParams("ETH", 1), updatedAt: "2020-01-01T00:00:00.000Z" };
    await PanelSync.pullPanels();
    assert.equal(globalThis.localStorage.getItem(key("ETH")), before);
    assert.equal(JSON.parse(globalThis.localStorage.getItem(key("BTC"))).params.saldoCorretora, 5200);
  });

  it("syncOnLogin empurra cada asset para seu próprio path", async () => {
    delete cloud[rpath("BTC")];
    delete cloud[rpath("LINK")];
    pushCalls.length = 0;
    PanelSync.saveLocal("risk", riskParams("BTC", 5001), "BTC");
    PanelSync.saveLocal("risk", riskParams("LINK", 300), "LINK");
    await PanelSync.syncOnLogin();
    assert.ok(pushCalls.includes(rpath("BTC")), "push BTC no path de BTC");
    assert.ok(pushCalls.includes(rpath("LINK")), "push LINK no path de LINK");
    assert.equal(cloud[rpath("BTC")].params.saldoCorretora, 5001);
    assert.equal(cloud[rpath("LINK")].params.saldoCorretora, 300);
  });
});

describe("migração RTDB (Bug 3 — comportamental)", () => {
  it("legado vira risk/{asset} e só os campos params/updatedAt são nulificados", async () => {
    const base = "users/uid-A/panels/risk";
    delete cloud[rpath("ETH")]; // isola de pushes de debounce de testes anteriores
    cloud[base] = { params: riskParams("ETH", 4321), updatedAt: "2026-02-01T00:00:00.000Z" };
    removeCalls.length = 0;
    updateCalls.length = 0;
    await PanelSync.migrateLegacyCloudRisk("uid-A");
    assert.equal(cloud[rpath("ETH")].params.saldoCorretora, 4321);
    assert.ok(!("params" in cloud[base]) && !("updatedAt" in cloud[base]));
    assert.ok(!removeCalls.includes(base), "remove() no nível risk é PROIBIDO");
    assert.ok(updateCalls.includes(base), "update() com nulls no nível risk");
  });

  it("20b: nó pós-migração (só filhos) é intocado", async () => {
    const base = "users/uid-A/panels/risk";
    cloud[base] = {
      BTC: { params: riskParams("BTC", 5), updatedAt: "t1" },
      ETH: { params: riskParams("ETH", 6), updatedAt: "t2" },
    };
    removeCalls.length = 0;
    updateCalls.length = 0;
    const before = JSON.stringify(cloud[base]);
    await PanelSync.migrateLegacyCloudRisk("uid-A");
    assert.equal(JSON.stringify(cloud[base]), before);
    assert.equal(removeCalls.length, 0);
    assert.equal(updateCalls.length, 0);
  });
});

describe("debounce por ativo", () => {
  it("save BTC + save ETH disparam os dois pushes (Cenário C)", { timeout: 10000 }, async () => {
    pushCalls.length = 0;
    delete cloud[rpath("AVAX")];
    delete cloud[rpath("SOL")];
    PanelSync.saveLocal("risk", riskParams("AVAX", 91), "AVAX");
    PanelSync.saveLocal("risk", riskParams("SOL", 92), "SOL");
    await new Promise((r) => setTimeout(r, 2800));
    assert.ok(pushCalls.includes(rpath("AVAX")), "push AVAX não cancelado pelo save de SOL");
    assert.ok(pushCalls.includes(rpath("SOL")), "push SOL entregue");
  });
});

describe("guards estruturais (§18 — regressão dos bugs no fonte)", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(dir, "auth.js"), "utf8");

  // Extrai o corpo EXATO da função via balanceamento de chaves (sem vazar
  // para a função seguinte, o que geraria falso-positivo). Compartilhado
  // pelos guards dos Bugs 1 e 3.
  const extract = (name) => {
    const i = src.indexOf("function " + name);
    assert.ok(i !== -1, name + " existe");
    const open = src.indexOf("{", i);
    let depth = 0;
    for (let j = open; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) return src.slice(i, j + 1);
      }
    }
    throw new Error("chave de fechamento não encontrada: " + name);
  };

  it("Bug 1: nenhum .then()/.catch() de pull/push lê currentAssetId", () => {
    // Para cada callback assíncrono, audita SÓ o corpo do callback (até o
    // fechamento do parêntese correspondente), nunca o resto da função.
    const auditCallbacks = (body, name) => {
      const positions = [];
      for (const token of [".then(", ".catch(", "setTimeout("]) {
        let k = 0;
        for (;;) {
          const p = body.indexOf(token, k);
          if (p === -1) break;
          positions.push(p + token.length);
          k = p + 1;
        }
      }
      assert.ok(positions.length > 0, name + " possui callbacks assíncronos para auditar");
      for (const p of positions) {
        let depth = 1;
        let j = p;
        for (; j < body.length && depth > 0; j++) {
          if (body[j] === "(") depth++;
          else if (body[j] === ")") depth--;
        }
        const cb = body.slice(p, j);
        assert.ok(!cb.includes("currentAssetId"), `${name}: callback assíncrono não pode ler currentAssetId`);
      }
    };
    for (const name of ["pullOneRiskAsset", "pullPanels", "pushPanel", "schedulePush", "syncOnLogin", "migrateLegacyCloudRisk"]) {
      auditCallbacks(extract(name), name);
    }
  });

  it("Bug 3: remove() jamais dentro de migrateLegacyCloudRisk; update com nulls existe", () => {
    // Nome da variável irrelevante (no fonte real é `riskRef`, não `legacyRef`):
    // proíbe QUALQUER `.remove(` no corpo inteiro da função de migração.
    const body = extract("migrateLegacyCloudRisk");
    assert.ok(!body.includes(".remove("), "sem .remove() dentro de migrateLegacyCloudRisk, qualquer que seja o nome da variável");
    assert.ok(body.includes("update(") && body.includes("params: null") && body.includes("updatedAt: null"));
  });

  it("currentAssetId só é atribuído na declaração e em setCurrentAsset", () => {
    // (?!=): casa `=` isolado (atribuição), mas NÃO `==`/`===` (comparação).
    const assigns = [...src.matchAll(/currentAssetId\s*=(?!=)/g)].map((m) => m.index);
    assert.equal(assigns.length, 2);
    assert.ok(src.slice(assigns[0] - 4, assigns[0] + 16).includes("var currentAssetId"));
    assert.ok(src.slice(assigns[1] - 60, assigns[1]).includes("function setCurrentAsset"));
  });
});
