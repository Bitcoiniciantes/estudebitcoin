/**
 * P0 — Consistência contábil definitiva (Capital depositado + P/L acumulado = Patrimônio atual).
 * Mesmas entradas visíveis (depositado, posições, cotações, parâmetros) => mesmos resultados.
 * Sem migração de legado: persistência antiga do Risk Engine Multicripto pode ser reinicializada.
 *
 * Execução: node --test assets/js/risk-engine/risk-portfolio-consistency.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const Engine = (await import("./risk-portfolio-engine.js")).default;
const panelSrc = fs.readFileSync(path.join(dir, "risk-portfolio-panel.js"), "utf8");

function approx(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b)); }
function ne(actual, expected, msg) { assert.ok(approx(actual, expected), (msg || "") + ` expected ${expected} got ${actual}`); }

/* ---------- Engine: base capital depositado (modelo definitivo) ---------- */
describe("P0 engine — capital depositado + P/L acumulado = patrimônio", () => {
  it("referências históricas não interferem (critério decisivo, 2 contas mesmos dados)", () => {
    const pos = [{ symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 100, currentPrice: 90 }];
    const r1 = Engine.calculate({ referenceBalance: 3000, equityBasis: "deposited", referencePrices: { BTC: 100 }, positions: pos });
    const r2 = Engine.calculate({ referenceBalance: 3000, equityBasis: "deposited", referencePrices: { BTC: 95 }, positions: pos });
    const r3 = Engine.calculate({ referenceBalance: 3000, equityBasis: "deposited", referencePrices: { BTC: 90 }, positions: pos });
    const r4 = Engine.calculate({ referenceBalance: 3000, equityBasis: "deposited", referencePrices: {}, positions: pos });
    [r1, r2, r3, r4].forEach((r) => {
      ne(r.pnlTotal, -10, "pnl");
      ne(r.variationAfterReference, -10, "varRef");
      ne(r.equity, 2990, "equity");
      ne(r.exposure, 90, "exposure");
      assert.equal(r.equityBasis, "deposited");
      assert.equal(r.referenceComplete, true);
    });
    ne(r1.leverage, r2.leverage); ne(r2.leverage, r3.leverage);
    ne(r1.additionalLossSupported, 2990);
  });

  it("demonstração: base por referência histórica divergia; base depositada é idêntica", () => {
    const pos = [{ symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 100, currentPrice: 90 }];
    const oldRef95 = Engine.calculate({ referenceBalance: 3000, referencePrices: { BTC: 95 }, positions: pos });
    const oldRef90 = Engine.calculate({ referenceBalance: 3000, referencePrices: { BTC: 90 }, positions: pos });
    ne(oldRef95.equity, 2995); ne(oldRef90.equity, 3000);
    assert.notEqual(oldRef95.equity, oldRef90.equity);
    const dep95 = Engine.calculate({ referenceBalance: 3000, equityBasis: "deposited", referencePrices: { BTC: 95 }, positions: pos });
    const dep90 = Engine.calculate({ referenceBalance: 3000, equityBasis: "deposited", referencePrices: { BTC: 90 }, positions: pos });
    ne(dep95.equity, 2990); ne(dep90.equity, 2990);
  });

  it("invariantes: equity = depositado + PnL; leverage/exposição/quebra uniforme", () => {
    const cases = [
      { dep: 1000, pos: [{ symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 6012, currentPrice: 5184 }] },
      { dep: 3000, pos: [{ symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 100, currentPrice: 90 }] },
      { dep: 5000, pos: [
        { symbol: "BTC", side: "LONG", quantity: 0.1, averagePrice: 50000, currentPrice: 48000 },
        { symbol: "ETH", side: "SHORT", quantity: 2, averagePrice: 3000, currentPrice: 2800 },
      ]},
    ];
    for (const c of cases) {
      const r = Engine.calculate({ referenceBalance: c.dep, equityBasis: "deposited", referencePrices: { BTC: 1, ETH: 999 }, positions: c.pos });
      ne(r.equity, c.dep + r.pnlTotal, "equity == depositado + pnl");
      ne(r.equity - c.dep, r.pnlTotal, "equity - depositado == pnl");
      ne(r.variationAfterReference, r.pnlTotal, "varRef == pnl");
      if (r.equity > 0) ne(r.leverage, r.exposure / r.equity, "leverage");
      ne(r.additionalLossSupported, Math.max(r.equity, 0), "additionalLoss");
      const dir = r.positions.reduce((s, p) => s + (p.side === "LONG" ? 1 : -1) * p.marketValue, 0);
      if (dir > 0 && r.equity > 0) {
        const expected = (r.equity / dir) * 100;
        if (expected > 100) assert.equal(r.uniformDropToZero, null);
        else ne(r.uniformDropToZero, expected, "uniform drop");
      }
    }
  });

  it("exposição superior ao capital preservada (alavancagem)", () => {
    const r = Engine.calculate({ referenceBalance: 1000, equityBasis: "deposited", referencePrices: {}, positions: [
      { symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 6012, currentPrice: 5184 }
    ]});
    ne(r.equity, 172); ne(r.exposure, 5184); ne(r.leverage, 5184 / 172);
    assert.ok(r.leverage > 30);
  });

  it("equity <= 0 => LIMITE TEÓRICO ATINGIDO, sem divisões inválidas", () => {
    const zero = Engine.calculate({ referenceBalance: 828, equityBasis: "deposited", referencePrices: {}, positions: [
      { symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 6012, currentPrice: 5184 }
    ]});
    ne(zero.equity, 0); assert.equal(zero.leverage, null); ne(zero.additionalLossSupported, 0);
    assert.equal(zero.riskState, "LIMITE TEÓRICO ATINGIDO"); assert.ok(Number.isFinite(zero.pnlTotal));

    const neg = Engine.calculate({ referenceBalance: 100, equityBasis: "deposited", referencePrices: {}, positions: [
      { symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 6012, currentPrice: 5184 }
    ]});
    ne(neg.equity, -728); assert.equal(neg.leverage, null); ne(neg.additionalLossSupported, 0);
    assert.equal(neg.riskState, "LIMITE TEÓRICO ATINGIDO"); assert.equal(neg.uniformDropToZero, null);
  });

  it("LONG/SHORT: cálculos preservados (5 ativos mistos, 2 contas idênticas)", () => {
    const positions = [
      { symbol: "BTC", side: "LONG", quantity: 0.05, averagePrice: 60000, currentPrice: 58000 },
      { symbol: "ETH", side: "SHORT", quantity: 1, averagePrice: 3000, currentPrice: 3100 },
      { symbol: "SOL", side: "LONG", quantity: 10, averagePrice: 100, currentPrice: 95 },
      { symbol: "LINK", side: "SHORT", quantity: 50, averagePrice: 15, currentPrice: 14 },
      { symbol: "AVAX", side: "LONG", quantity: 20, averagePrice: 30, currentPrice: 28 },
    ];
    const acc1 = Engine.calculate({ referenceBalance: 5000, equityBasis: "deposited", referencePrices: { BTC: 59000, ETH: 3050, SOL: 97, LINK: 14.5, AVAX: 29 }, positions });
    const acc2 = Engine.calculate({ referenceBalance: 5000, equityBasis: "deposited", referencePrices: { BTC: 58000, ETH: 3100, SOL: 95, LINK: 14, AVAX: 28 }, positions });
    ne(acc1.equity, acc2.equity); ne(acc1.pnlTotal, acc2.pnlTotal);
    ne(acc1.leverage, acc2.leverage); ne(acc1.exposure, acc2.exposure);
    assert.equal(acc1.riskState, acc2.riskState);
    ne(acc1.additionalLossSupported, acc2.additionalLossSupported);
    ne(acc1.equity, 5000 + acc1.pnlTotal);
  });

  it("motor preserva cálculo por base de referência (equityBasis != deposited) sem afetar modelo depositado", () => {
    const r = Engine.calculate({
      referenceBalance: 1000,
      referencePrices: { BTC: 110, ETH: 200 },
      positions: [
        { symbol: "BTC", side: "LONG", quantity: 2, averagePrice: 90, currentPrice: 110 },
        { symbol: "ETH", side: "SHORT", quantity: 1, averagePrice: 220, currentPrice: 200 },
      ]
    });
    ne(r.pnlTotal, 60); ne(r.variationAfterReference, 0); ne(r.equity, 1000);
  });
});

/* ---------- Panel: formato canônico, reset de legado, determinismo ---------- */
function loadPanel() {
  const host = {
    document: {
      readyState: "complete",
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
    },
    addEventListener() {},
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  };
  const mod = { exports: {} };
  const context = vm.createContext({ globalThis: host, window: host, document: host.document, module: mod, exports: mod.exports });
  vm.runInContext(panelSrc, context, { filename: "risk-portfolio-panel.js" });
  return mod.exports && mod.exports.applyState ? mod.exports : host.RiskPortfolioPanel;
}

describe("P0 panel — formato canônico (depositado) e reset de legado", () => {
  it("rejeita estados legados/ambíguos (v1) — persistência pode ser reinicializada", () => {
    const P = loadPanel();
    const legacy = { schemaVersion: 1, model: "quantfury-account-balance-simulation", referenceBalance: 3000, referenceTimestamp: "t", referencePrices: { BTC: 95 }, settings: {}, positions: [{ id: "rp-BTC", symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 100 }] };
    assert.equal(P.applyState(legacy), false);
  });

  it("aceita apenas canônico v2 + equityBasis deposited; rejeita outros", () => {
    const base = { model: "quantfury-account-balance-simulation", referenceBalance: 100, referenceTimestamp: "t", referencePrices: {}, settings: {}, positions: [{ id: "rp-BTC", symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 10 }] };
    const P = loadPanel();
    assert.equal(P.applyState({ ...base, schemaVersion: 2, equityBasis: "deposited" }), true);
    assert.equal(P.applyState({ ...base, schemaVersion: 1 }), false);
    assert.equal(P.applyState({ ...base, schemaVersion: 2 }), false);
    assert.equal(P.applyState({ ...base, schemaVersion: 3, equityBasis: "deposited" }), false);
  });

  it("mesmos dados visíveis => estado e resultados idênticos (refs históricos ignorados/normalizados)", () => {
    const pos = [{ id: "rp-BTC", symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 100, invested: 100 }];
    const canonical = (refs) => ({ schemaVersion: 2, equityBasis: "deposited", model: "quantfury-account-balance-simulation", referenceBalance: 3000, referenceTimestamp: "t", referencePrices: refs, settings: {}, positions: pos });
    const A = loadPanel(), B = loadPanel();
    assert.equal(A.applyState(canonical({ BTC: 95 })), true);
    assert.equal(B.applyState(canonical({ BTC: 90 })), true);
    const sa = A.getState(), sb = B.getState();
    assert.deepEqual(JSON.parse(JSON.stringify(sa.positions)), JSON.parse(JSON.stringify(sb.positions)));
    assert.deepEqual(JSON.parse(JSON.stringify(sa.referencePrices)), JSON.parse(JSON.stringify(sb.referencePrices)));
    ne(sa.referencePrices.BTC, 100); ne(sb.referencePrices.BTC, 100);
    const calc = (s) => Engine.calculate({ ...s, positions: s.positions.map(p => ({ symbol: p.symbol, side: p.side, quantity: p.quantity, averagePrice: p.averagePrice, currentPrice: 90 })) });
    const ra = calc(sa), rb = calc(sb);
    ne(ra.equity, 2990); ne(rb.equity, 2990); ne(ra.pnlTotal, -10); ne(rb.pnlTotal, -10);
    ne(ra.leverage, rb.leverage); assert.equal(ra.riskState, rb.riskState);
  });

  it("5 ativos mistos: mesmos dados => resultados idênticos e invariantes", () => {
    const positions = [
      { id: "rp-BTC", symbol: "BTC", side: "LONG", quantity: 0.05, averagePrice: 60000 },
      { id: "rp-ETH", symbol: "ETH", side: "SHORT", quantity: 1, averagePrice: 3000 },
      { id: "rp-SOL", symbol: "SOL", side: "LONG", quantity: 10, averagePrice: 100 },
      { id: "rp-LINK", symbol: "LINK", side: "SHORT", quantity: 50, averagePrice: 15 },
      { id: "rp-AVAX", symbol: "AVAX", side: "LONG", quantity: 20, averagePrice: 30 },
    ];
    const state = (refs) => ({ schemaVersion: 2, equityBasis: "deposited", model: "quantfury-account-balance-simulation", referenceBalance: 5000, referenceTimestamp: "t", referencePrices: refs, settings: {}, positions });
    const A = loadPanel(), B = loadPanel();
    A.applyState(state({ BTC: 59000, ETH: 3050, SOL: 97, LINK: 14.5, AVAX: 29 }));
    B.applyState(state({ BTC: 58000, ETH: 3100, SOL: 95, LINK: 14, AVAX: 28 }));
    const sa = A.getState(), sb = B.getState();
    assert.deepEqual(JSON.parse(JSON.stringify(sa.referencePrices)), { BTC: 60000, ETH: 3000, SOL: 100, LINK: 15, AVAX: 30 });
    assert.deepEqual(JSON.parse(JSON.stringify(sa.referencePrices)), JSON.parse(JSON.stringify(sb.referencePrices)));
    const cur = { BTC: 58000, ETH: 3100, SOL: 95, LINK: 14, AVAX: 28 };
    const calc = (s) => Engine.calculate({ ...s, positions: s.positions.map(p => ({ ...p, currentPrice: cur[p.symbol] })) });
    const ra = calc(sa), rb = calc(sb);
    ne(ra.equity, rb.equity); ne(ra.pnlTotal, rb.pnlTotal); ne(ra.leverage, rb.leverage);
    ne(ra.equity, 5000 + ra.pnlTotal);
  });
});
