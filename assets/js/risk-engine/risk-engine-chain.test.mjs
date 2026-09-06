/**
 * Teste da cadeia completa com window simulada (§11, evidência executável).
 *
 * Contexto: o browser headless disponível nesta sandbox NÃO executa scripts
 * da página (provado por probe: nem `<script>` inline executa — `window`
 * permanece sem globals em qualquer página local). Logo, a prova DOM em
 * browser real fica pendente; este teste carrega os ARQUIVOS REAIS
 * (adapter + engine + panel) com uma `window` simulada instalada sobre
 * `globalThis`, cobrindo:
 *
 *   dispatch "estudebitcoin:ticker-price" (formato exato do ticker-widget.js)
 *        ↓ adapter.attach()/handleTickerEvent
 *   RiskEngine.calcularRisco (código real)
 *        ↓ notify → onResult + broadcast "riskengine:result"
 *   Panel.buildViewModel (código real, guarda sucesso===false)
 *
 * Execução: `node --test assets/js/risk-engine/risk-engine-chain.test.mjs`
 */
import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Adapter from "./risk-engine-adapter.js";
import Panel from "./risk-engine-panel.js";

const DIR = new URL("./", import.meta.url);

function fakeWindow() {
  const listeners = {};
  const w = {
    RiskEngine: null, // preenchido abaixo (evita ciclo de import)
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    addEventListener: (t, f) => {
      listeners[t] = listeners[t] || [];
      listeners[t].push(f);
    },
    removeEventListener: (t, f) => {
      listeners[t] = (listeners[t] || []).filter((g) => g !== f);
    },
    dispatchEvent: (e) => {
      (listeners[e.type] || []).slice().forEach((f) => f(e));
      return true;
    },
    __count: (t) => (listeners[t] || []).length,
  };
  return w;
}

const win = fakeWindow();
win.RiskEngine = (await import("./risk-engine.js")).default;

const INSTALLED = [
  "RiskEngine",
  "CustomEvent",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
];
const backup = {};

before(() => {
  for (const k of INSTALLED) {
    backup[k] = globalThis[k];
    globalThis[k] = win[k];
  }
  Adapter.detach();
});

afterEach(() => {
  Adapter.detach();
  Adapter.configure(null);
});

describe("cadeia ticker → adapter → engine → painel (arquivos reais)", () => {
  it("attach registra 1 listener; evento do ticker atualiza tudo (LONG 61000)", () => {
    Adapter.configure({
      simbolo: "BTC", moedaConta: "USD", saldoCorretora: 30000,
      alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }],
      fundingCustoAcumulado: 0, mmr: 0, lado: "LONG",
    });
    assert.equal(Adapter.attach(), true);
    assert.equal(win.__count("estudebitcoin:ticker-price"), 1);

    const received = [];
    const cb = (r) => received.push(r);
    Adapter.onResult(cb);
    const broadcast = [];
    win.addEventListener("riskengine:result", (e) => broadcast.push(e.detail));

    // formato EXATO emitido por ticker-widget.js updateLivePrice:
    win.dispatchEvent(
      new win.CustomEvent("estudebitcoin:ticker-price", {
        detail: { symbol: "BTC", price: 61000 },
      }),
    );

    const r = Adapter.getLastResult();
    assert.equal(r.sucesso, true);
    assert.equal(r.pnlNaoRealizado, 1000);
    assert.equal(r.equityAtual, 31000);
    assert.equal(r.precoLiquidacao, 30000);
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], r);
    assert.equal(broadcast.length, 1);
    Adapter.offResult(cb);

    const vm = Panel.buildViewModel(r);
    assert.equal(vm.ok, true);
    assert.equal(vm.pnlNaoRealizado, 1000);
    assert.equal(vm.estadoRisco, "SEGURO");
  });

  it("símbolo diferente é ignorado; sequência até LIQUIDACAO", () => {
    Adapter.configure({
      simbolo: "BTC", moedaConta: "USD", saldoCorretora: 30000,
      alavancagem: 10, ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }],
      lado: "LONG",
    });
    Adapter.attach();
    const antes = Adapter.getLastResult();
    const precoAntes = Adapter.getLastPrice();
    win.dispatchEvent(
      new win.CustomEvent("estudebitcoin:ticker-price", {
        detail: { symbol: "ETH", price: 99999 },
      }),
    );
    assert.equal(Adapter.getLastResult(), antes);
    assert.equal(Adapter.getLastPrice(), precoAntes);

    const estados = [];
    for (const p of [60000, 59000, 40000, 30000]) {
      win.dispatchEvent(
        new win.CustomEvent("estudebitcoin:ticker-price", {
          detail: { symbol: "BTC", price: p },
        }),
      );
      estados.push(Adapter.getLastResult().estadoRisco);
    }
    assert.deepEqual(estados, ["SEGURO", "SEGURO", "SEGURO", "LIQUIDACAO"]);
  });

  it("ticker-widget.js contém o dispatch no formato esperado", () => {
    const src = fs.readFileSync(new URL("../ticker-widget.js", DIR), "utf8");
    assert.ok(src.includes("estudebitcoin:ticker-price"));
    assert.ok(src.includes("new CustomEvent"));
    assert.ok(src.includes("detail: { symbol: symbol, price: price }"));
    // sem segundo WebSocket/polling/fetch adicionado:
    assert.equal((src.match(/new WebSocket/g) || []).length, 1);
  });
});
