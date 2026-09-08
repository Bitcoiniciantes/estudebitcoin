/**
 * Testes de regressão — risk-engine-panel multi-ativo.
 *
 * Carrega o CÓDIGO REAL de risk-engine-panel.js num sandbox `vm` (ramo
 * browser do UMD) com DOM/adapter/PanelSync falsos, exercitando o fluxo
 * de produção de ponta a ponta: bind() → restore → input/change → pull.
 *
 * Cobre:
 *  - Bug 2: troca BTC→ETH sem contaminar a chave do novo ativo;
 *  - ordem input-antes-change (save do anterior, nunca do novo);
 *  - ativo sem estado → defaults isolados (Cenário E);
 *  - BTC→ETH→BTC com estados independentes (Cenários A/B);
 *  - pull de asset inativo ignorado (Cenário D no nível da UI);
 *  - reload restaura o último ativo (eb_last_risk_asset);
 *  - migração legada local (segunda linha de defesa);
 *  - painel funciona sem PanelSync (não-regressão).
 *
 * Execução: `node --test assets/js/risk-engine/risk-engine-panel.multativo.test.mjs`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const panelSrc = fs.readFileSync(path.join(dir, "risk-engine-panel.js"), "utf8");

const ASSETS = ["BTC", "ETH", "SOL", "LINK", "AVAX", "RENDER", "PAXG"];

/* ---------- Fakes ---------- */

function makeField(value) {
  const f = {
    value: value !== undefined ? value : "",
    _text: "",
    _sets: [], // histórico de textContent (p/ provar limpeza de status)
    style: {},
    options: [],
    _listeners: {},
    addEventListener(t, fn) {
      (this._listeners[t] = this._listeners[t] || []).push(fn);
    },
    setAttribute() {},
    fire(t, arg) {
      (this._listeners[t] || []).forEach((fn) => fn.call(this, arg));
    },
  };
  Object.defineProperty(f, "textContent", {
    get() { return this._text; },
    set(v) { this._text = v; this._sets.push(v); },
    configurable: true,
  });
  return f;
}

function makeDocument(initial) {
  const fields = {};
  const get = (id) => {
    if (!fields[id]) {
      fields[id] = makeField();
      if (id === "re-simbolo") {
        fields[id].value = (initial && initial.simbolo) || "BTC";
        fields[id].options = ASSETS.map((v) => ({ value: v, text: v }));
      } else if (id === "re-lado") {
        fields[id].value = "LONG";
        fields[id].options = ["LONG", "SHORT"].map((v) => ({ value: v, text: v }));
      } else if (initial && Object.prototype.hasOwnProperty.call(initial, id)) {
        fields[id].value = initial[id];
      }
    }
    return fields[id];
  };
  return {
    readyState: "complete",
    getElementById: get,
    addEventListener() {},
    _fields: fields,
  };
}

function makePanelSync(store) {
  const calls = [];
  return {
    calls,
    _current: null,
    setCurrentAsset(a) {
      this._current = a;
    },
    getCurrentAsset() {
      return this._current;
    },
    saveLocal(panel, params, asset) {
      const a = asset || this._current;
      calls.push(["save", panel, params && params.simbolo, a]);
      store.set(panel + ":" + a, JSON.parse(JSON.stringify(params)));
      this.schedulePush(panel, a); // espelha auth.js: save agenda push
      return true;
    },
    schedulePush(panel, asset) {
      calls.push(["schedule", panel, asset || this._current]);
    },
    pushPanel(panel, asset) {
      calls.push(["push", panel, asset || this._current]);
      return false;
    },
    loadLocal(panel, asset) {
      const a = asset || this._current;
      const v = store.get(panel + ":" + a);
      return v ? { params: JSON.parse(JSON.stringify(v)), updatedAt: "t" } : null;
    },
    saveLastAsset(a) {
      store.set("__last", a);
    },
    loadLastAsset() {
      return store.get("__last") || null;
    },
  };
}

function makeAdapter() {
  return {
    configured: [],
    attached: false,
    _lastPrice: null,
    configure(p) {
      this.configured.push(JSON.parse(JSON.stringify(p)));
    },
    getLastPrice() {
      return this._lastPrice;
    },
    attach() {
      this.attached = true;
      return true;
    },
    onResult() {},
  };
}

// Sobe o painel REAL no sandbox. Retorna os handles para dirigir o teste.
function loadPanel({ initial, store, panelSync, adapter, localStorage, bi } = {}) {
  store = store || new Map();
  panelSync = panelSync || makePanelSync(store);
  adapter = adapter || makeAdapter();
  const doc = makeDocument(initial);
  const hostListeners = {};
  const sandbox = {
    document: doc,
    RiskEngineAdapter: adapter,
    PanelSync: panelSync,
    addEventListener: (t, fn) => {
      hostListeners[t] = fn;
    },
  };
  if (bi !== false) {
    sandbox.BI = {
      normalizeSymbol: (s) => String(s == null ? "" : s).trim().toUpperCase().replace(/USDT$/, "") || null,
    };
  }
  if (localStorage) sandbox.localStorage = localStorage;
  vm.createContext(sandbox);
  vm.runInContext(panelSrc, sandbox, { filename: "risk-engine-panel.js" });
  return { doc, store, panelSync, adapter, hostListeners, panel: sandbox.RiskEnginePanel };
}

function savedOf(store, asset) {
  return store.get("risk:" + asset) || null;
}

/* ---------- Testes ---------- */

describe("boot / restore", () => {
  it("restaura BTC salvo e fixa a identidade", () => {
    const store = new Map([
      ["risk:BTC", { simbolo: "BTC", moedaConta: "USD", saldoCorretora: 5000, alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "LONG" }],
      ["__last", "BTC"],
    ]);
    const { doc, adapter, panelSync, panel } = loadPanel({ store });
    assert.ok(panel, "RiskEnginePanel exposto no sandbox");
    assert.equal(doc._fields["re-simbolo"].value, "BTC");
    assert.equal(doc._fields["re-saldo"].value, "5.000,00");
    assert.equal(panelSync._current, "BTC");
    assert.equal(adapter.configured[adapter.configured.length - 1].simbolo, "BTC");
    assert.ok(adapter.attached);
  });

  it("sem dados: mantém defaults, sem throw", () => {
    const { doc, adapter } = loadPanel({});
    assert.equal(doc._fields["re-simbolo"].value, "BTC");
    assert.equal(adapter.configured[adapter.configured.length - 1].simbolo, "BTC");
  });

  it("reload restaura o último ativo (eb_last_risk_asset)", () => {
    const store = new Map([
      ["risk:ETH", { simbolo: "ETH", moedaConta: "USD", saldoCorretora: 7000, alavancagem: 3, ordens: [{ moeda: "USD", preco: 2400, valor: 7000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "SHORT" }],
      ["__last", "ETH"],
    ]);
    const { doc } = loadPanel({ store });
    assert.equal(doc._fields["re-simbolo"].value, "ETH");
    assert.equal(doc._fields["re-lado"].value, "SHORT");
  });
});

describe("troca de ativo (Bug 2)", () => {
  it("BTC→ETH virgem: NADA é salvo; form com defaults, sem contaminação", () => {
    const store = new Map([
      ["risk:BTC", { simbolo: "BTC", moedaConta: "USD", saldoCorretora: 5000, alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "LONG" }],
      ["__last", "BTC"],
    ]);
    const { doc, panelSync, adapter } = loadPanel({ store });
    const sel = doc._fields["re-simbolo"];
    const n0 = panelSync.calls.length;
    sel.value = "ETH";
    sel.fire("change");
    // ZERO persistência na troca: nenhum save/schedule/push foi emitido.
    assert.deepEqual(panelSync.calls.slice(n0), []);
    // Anterior preservado sob a chave do anterior:
    assert.equal(savedOf(store, "BTC").saldoCorretora, 5000);
    // Novo ativo isolado: form com defaults, nunca valores de BTC;
    // nenhuma chave ETH criada:
    assert.equal(doc._fields["re-saldo"].value, "3.000,00");
    assert.equal(doc._fields["re-alavancagem"].value, "5");
    assert.equal(store.has("risk:ETH"), false, "troca não cria estado");
    // Adapter agora filtra ETH; identidade rastreada = ETH; seleção salva:
    assert.equal(adapter.configured[adapter.configured.length - 1].simbolo, "ETH");
    assert.equal(panelSync._current, "ETH");
    assert.equal(store.get("__last"), "ETH");
  });

  it("ETH→BTC recupera o estado EXATO de BTC (Cenários A/B)", () => {
    const store = new Map([
      ["risk:BTC", { simbolo: "BTC", moedaConta: "USD", saldoCorretora: 5000, alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "LONG" }],
      ["risk:ETH", { simbolo: "ETH", moedaConta: "USD", saldoCorretora: 7000, alavancagem: 3, ordens: [{ moeda: "USD", preco: 2400, valor: 7000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "SHORT" }],
      ["__last", "BTC"],
    ]);
    const { doc } = loadPanel({ store });
    const sel = doc._fields["re-simbolo"];
    sel.value = "ETH";
    sel.fire("change");
    assert.equal(doc._fields["re-saldo"].value, "7.000,00");
    assert.equal(doc._fields["re-lado"].value, "SHORT");
    sel.value = "BTC";
    sel.fire("change");
    assert.equal(doc._fields["re-saldo"].value, "5.000,00");
    assert.equal(doc._fields["re-lado"].value, "LONG");
    // Coexistem, independentes:
    assert.equal(savedOf(store, "BTC").saldoCorretora, 5000);
    assert.equal(savedOf(store, "ETH").saldoCorretora, 7000);
  });

  it("input no select não persiste mais (só change trata a troca)", () => {
    const store = new Map([
      ["risk:BTC", { simbolo: "BTC", moedaConta: "USD", saldoCorretora: 5000, alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "LONG" }],
      ["__last", "BTC"],
    ]);
    const { doc, panelSync } = loadPanel({ store });
    const sel = doc._fields["re-simbolo"];
    const n0 = panelSync.calls.length;
    sel.value = "ETH"; // select já mudou, campos ainda são de BTC
    sel.fire("input"); // browser pode disparar antes do change: deve ser no-op
    assert.deepEqual(panelSync.calls.slice(n0), [], "input no select não persiste");
    assert.equal(store.has("risk:ETH"), false, "input não pode criar a chave do novo ativo");
    assert.equal(savedOf(store, "BTC").saldoCorretora, 5000);
    assert.equal(panelSync._current, "BTC", "identidade intacta após input");
    sel.fire("change");
    assert.equal(doc._fields["re-saldo"].value, "3.000,00", "change reseta para defaults");
    assert.deepEqual(panelSync.calls.slice(n0), [], "change também não persiste");
  });
});

describe("pull da nuvem na UI (Cenário D)", () => {
  it("pull de asset inativo é ignorado; do ativo aplica", () => {
    const store = new Map([
      ["risk:BTC", { simbolo: "BTC", moedaConta: "USD", saldoCorretora: 5000, alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "LONG" }],
      ["__last", "BTC"],
    ]);
    const { doc, hostListeners } = loadPanel({ store });
    const onPull = hostListeners["estudebitcoin:panel-pull"];
    assert.ok(onPull, "listener de pull registrado");
    onPull({ detail: { panel: "risk", asset: "ETH", params: { simbolo: "ETH", moedaConta: "USD", saldoCorretora: 9999, alavancagem: 3, ordens: [{ moeda: "USD", preco: 2400, valor: 9999 }], fundingCustoAcumulado: 0, mmr: 0, lado: "SHORT" }, updatedAt: "t" } });
    assert.equal(doc._fields["re-saldo"].value, "5.000,00", "form de BTC intocado pelo pull de ETH");
    onPull({ detail: { panel: "risk", asset: "BTC", params: { simbolo: "BTC", moedaConta: "USD", saldoCorretora: 5555, alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "LONG" }, updatedAt: "t" } });
    assert.equal(doc._fields["re-saldo"].value, "5.555,00", "pull do ativo aplica");
  });
});

describe("migração legada local (segunda linha de defesa)", () => {
  function makeLs(legacyParams) {
    return {
      _m: new Map([
        ["eb_panel_risk", JSON.stringify({ params: legacyParams, updatedAt: "t" })],
      ]),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); },
    };
  }
  function ethLegacy(saldo) {
    return { simbolo: "ETH", moedaConta: "USD", saldoCorretora: saldo, alavancagem: 2, ordens: [{ moeda: "USD", preco: 2400, valor: saldo }], fundingCustoAcumulado: 0, mmr: 0, lado: "SHORT" };
  }
  function btcSaved(saldo) {
    return { simbolo: "BTC", moedaConta: "USD", saldoCorretora: saldo, alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: saldo }], fundingCustoAcumulado: 0, mmr: 0, lado: "LONG" };
  }

  it("eb_panel_risk (ETH) migra, aplica e some", () => {
    const ls = makeLs(ethLegacy(4321));
    const store = new Map();
    const { doc, panelSync } = loadPanel({ store, localStorage: ls });
    assert.equal(doc._fields["re-simbolo"].value, "ETH");
    assert.equal(doc._fields["re-saldo"].value, "4.321,00");
    assert.equal(ls._m.has("eb_panel_risk"), false, "legado removido");
    assert.equal(savedOf(store, "ETH").saldoCorretora, 4321);
    assert.equal(panelSync._current, "ETH");
  });

  it("item 1: legado ETH + chave BTC genuína — legado vence, BTC não sobrescreve", () => {
    const ls = makeLs(ethLegacy(4321));
    const store = new Map([
      ["risk:BTC", btcSaved(9999)],
      ["__last", "BTC"],
    ]);
    const { doc, panelSync } = loadPanel({ store, localStorage: ls });
    assert.equal(doc._fields["re-simbolo"].value, "ETH");
    assert.equal(doc._fields["re-saldo"].value, "4.321,00", "valor do legado, não o 9999 de BTC");
    assert.equal(panelSync._current, "ETH");
    assert.equal(savedOf(store, "BTC").saldoCorretora, 9999, "BTC genuíno preservado");
  });

  it("item 2: legado sem simbolo cai em eb_panel_risk_BTC, sem perda", () => {
    const noSymbol = { moedaConta: "USD", saldoCorretora: 2500, alavancagem: 5, ordens: [{ moeda: "USD", preco: 52000, valor: 2500 }], fundingCustoAcumulado: 0, mmr: 0, lado: "LONG" };
    const ls = makeLs(noSymbol);
    const store = new Map();
    const { doc } = loadPanel({ store, localStorage: ls });
    const btc = savedOf(store, "BTC");
    assert.ok(btc, "migrado para a chave de BTC");
    assert.equal(btc.saldoCorretora, 2500);
    assert.equal(doc._fields["re-simbolo"].value, "BTC");
    assert.equal(ls._m.has("eb_panel_risk"), false, "legado removido");
  });
});

describe("status de persistência (feedback visual)", () => {
  function statusOf(doc) {
    return doc._fields["re-save-status"].textContent;
  }

  it("save local carimba 'Salvo neste navegador'", () => {
    const { doc } = loadPanel({});
    doc._fields["re-saldo"].value = "5001";
    doc._fields["re-saldo"].fire("input");
    assert.match(statusOf(doc), /^Salvo neste navegador às \d{2}:\d{2}:\d{2}$/);
  });

  it("push-start → 'Sincronizando'; push-success → 'Sincronizado'", () => {
    const { doc, hostListeners } = loadPanel({});
    hostListeners["estudebitcoin:panel-push-start"]({ detail: { panel: "risk", asset: "BTC" } });
    assert.equal(statusOf(doc), "Sincronizando nuvem...");
    hostListeners["estudebitcoin:panel-push-success"]({ detail: { panel: "risk", asset: "BTC" } });
    assert.match(statusOf(doc), /^Sincronizado na nuvem às \d{2}:\d{2}:\d{2}$/);
    hostListeners["estudebitcoin:panel-push-error"]({ detail: { panel: "risk", asset: "BTC" } });
    assert.match(statusOf(doc), /^Falha na sincronização às \d{2}:\d{2}:\d{2}$/);
  });

  it("success atrasado de BTC não altera o status com ETH ativo", () => {
    const store = new Map([
      ["risk:BTC", { simbolo: "BTC", moedaConta: "USD", saldoCorretora: 5000, alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "LONG" }],
      ["__last", "BTC"],
    ]);
    const { doc, hostListeners } = loadPanel({ store });
    const sel = doc._fields["re-simbolo"];
    sel.value = "ETH";
    sel.fire("change");
    // Troca não persiste: status foi limpo e nada o re-carimbou.
    assert.equal(statusOf(doc), "");
    hostListeners["estudebitcoin:panel-push-success"]({ detail: { panel: "risk", asset: "BTC" } });
    hostListeners["estudebitcoin:panel-push-start"]({ detail: { panel: "risk", asset: "BTC" } });
    assert.equal(statusOf(doc), "", "status intacto (vazio) apesar dos eventos de BTC");
  });

  it("troca de ativo limpa imediatamente o status anterior", () => {
    const store = new Map([
      ["risk:BTC", { simbolo: "BTC", moedaConta: "USD", saldoCorretora: 5000, alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "LONG" }],
      ["__last", "BTC"],
    ]);
    const { doc } = loadPanel({ store });
    doc._fields["re-saldo"].value = "5001";
    doc._fields["re-saldo"].fire("input");
    const sets = doc._fields["re-save-status"]._sets;
    const before = sets.length;
    assert.match(sets[before - 1], /^Salvo neste navegador às /);
    const sel = doc._fields["re-simbolo"];
    sel.value = "ETH";
    sel.fire("change");
    const after = doc._fields["re-save-status"]._sets.slice(before);
    assert.ok(after.includes(""), "limpeza síncrona no início do change");
    assert.equal(after[after.length - 1], "", "nada re-carimba: troca não persiste");
  });
});

describe("troca sem alteração (zero persistência)", () => {
  function btcEthStore() {
    return new Map([
      ["risk:BTC", { simbolo: "BTC", moedaConta: "USD", saldoCorretora: 5000, alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "LONG" }],
      ["risk:ETH", { simbolo: "ETH", moedaConta: "USD", saldoCorretora: 7000, alavancagem: 3, ordens: [{ moeda: "USD", preco: 2400, valor: 7000 }], fundingCustoAcumulado: 0, mmr: 0, lado: "SHORT" }],
      ["__last", "BTC"],
    ]);
  }
  function kinds(ps, n0) {
    return ps.calls.slice(n0).map((c) => c[0]);
  }
  function snapshot(store) {
    return JSON.stringify([...store].filter(([k]) => k !== "__last"));
  }

  it("T1 — BTC→ETH sem alteração: zero save/schedule/push, ETH restaurado", () => {
    const store = btcEthStore();
    const { doc, panelSync, adapter } = loadPanel({ store });
    const before = snapshot(store);
    const n0 = panelSync.calls.length;
    const sel = doc._fields["re-simbolo"];
    sel.value = "ETH";
    sel.fire("change");
    assert.deepEqual(kinds(panelSync, n0), [], "nenhum save/schedule/push na troca");
    assert.equal(snapshot(store), before, "nenhum parâmetro tocado (só __last)");
    assert.equal(doc._fields["re-saldo"].value, "7.000,00", "form de ETH restaurado");
    assert.equal(doc._fields["re-lado"].value, "SHORT");
    assert.equal(adapter.configured[adapter.configured.length - 1].simbolo, "ETH");
    assert.equal(panelSync._current, "ETH");
  });

  it("T2 — ETH→BTC sem alteração: zero save/schedule/push, BTC preservado", () => {
    const store = btcEthStore();
    store.set("__last", "ETH");
    const { doc, panelSync, adapter } = loadPanel({ store });
    assert.equal(doc._fields["re-simbolo"].value, "ETH");
    const before = snapshot(store);
    const n0 = panelSync.calls.length;
    const sel = doc._fields["re-simbolo"];
    sel.value = "BTC";
    sel.fire("change");
    assert.deepEqual(kinds(panelSync, n0), [], "nenhum save/schedule/push no retorno");
    assert.equal(snapshot(store), before, "estado BTC preservado byte a byte");
    assert.equal(doc._fields["re-saldo"].value, "5.000,00");
    assert.equal(adapter.configured[adapter.configured.length - 1].simbolo, "BTC");
  });

  it("T3 — alteração real continua salvando (1 save + 1 schedule)", () => {
    const store = btcEthStore();
    const { doc, panelSync } = loadPanel({ store });
    const n0 = panelSync.calls.length;
    doc._fields["re-saldo"].value = "5001";
    doc._fields["re-saldo"].fire("input");
    assert.deepEqual(kinds(panelSync, n0), ["save", "schedule"]);
    assert.equal(JSON.parse(JSON.stringify(store.get("risk:BTC"))).saldoCorretora, 5001);
  });

  it("T4 — seleção continua persistindo (saveLastAsset ≠ saveLocal)", () => {
    const store = btcEthStore();
    const { doc, panelSync } = loadPanel({ store });
    const n0 = panelSync.calls.length;
    const sel = doc._fields["re-simbolo"];
    sel.value = "ETH";
    sel.fire("change");
    assert.deepEqual(kinds(panelSync, n0), [], "troca não chama saveLocal/schedule/pushPanel");
    assert.equal(store.get("__last"), "ETH", "mas a seleção foi registrada");
    assert.equal(panelSync._current, "ETH");
  });
});

describe("não-regressão", () => {
  it("painel funciona sem PanelSync (login opcional)", () => {
    const sandbox = {
      document: makeDocument(),
      RiskEngineAdapter: makeAdapter(),
      addEventListener: () => {},
    };
    vm.createContext(sandbox);
    assert.doesNotThrow(() => vm.runInContext(panelSrc, sandbox));
    const sel = sandbox.document._fields["re-simbolo"];
    sel.value = "ETH";
    assert.doesNotThrow(() => sel.fire("change"));
    assert.doesNotThrow(() => sel.fire("input"));
  });

  it("canonização do select (ethusdt → ETH)", () => {
    const { doc } = loadPanel({});
    const sel = doc._fields["re-simbolo"];
    sel.value = "ethusdt";
    sel.fire("change");
    assert.equal(sel.value, "ETH");
  });
});
