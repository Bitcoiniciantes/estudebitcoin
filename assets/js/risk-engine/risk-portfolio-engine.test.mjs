import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Engine from "./risk-portfolio-engine.js";

const base = { referenceBalance: 1000, referencePrices: { BTC: 100, ETH: 200 }, positions: [
  { symbol: "BTC", side: "LONG", quantity: 2, averagePrice: 90, currentPrice: 110 },
  { symbol: "ETH", side: "SHORT", quantity: 1, averagePrice: 220, currentPrice: 200 },
] };

describe("RiskPortfolioEngine", () => {
  it("calcula PnL, patrimônio pela variação posterior à referência e exposição", () => {
    const r = Engine.calculate(base);
    assert.equal(r.success, true); assert.equal(r.pnlTotal, 60); assert.equal(r.variationAfterReference, 20);
    assert.equal(r.equity, 1020); assert.equal(r.exposure, 420); assert.equal(r.leverage, 420 / 1020);
  });
  it("não duplica PnL já presente no saldo de referência", () => {
    const r = Engine.calculate({ ...base, referencePrices: { BTC: 110, ETH: 200 } });
    assert.equal(r.equity, 1000); assert.equal(r.pnlTotal, 60);
  });
  it("processa o cenário histórico de cinco ativos sem forçar o valor investido", () => {
    const positions = [
      ["BTC", 0.03489119, 65919.21, 59022.01], ["ETH", 0.25273989, 1978.32, 1637.65],
      ["SOL", 13.2609, 80.16, 69.22], ["LINK", 126.1869, 9.906, 8.449], ["AVAX", 109.5678, 8.21, 6.57],
    ].map(([symbol, quantity, averagePrice, currentPrice]) => ({ symbol, side: "LONG", quantity, averagePrice, currentPrice }));
    const r = Engine.calculate({ referenceBalance: 2924.82, referencePrices: Object.fromEntries(positions.map(p => [p.symbol, p.currentPrice])), positions });
    assert.equal(r.success, true); assert.equal(r.positions.length, 5);
    assert.notEqual(r.investedTotal, 6013, "quantidade × preço médio não é sobrescrito pelo investimento nominal informado");
  });
  it("simula queda uniforme com long e short", () => {
    const r = Engine.simulate(base, { BTC: -10, ETH: -10 });
    assert.equal(r.success, true); assert.equal(r.additionalPnl, -2);
  });
  it("identifica limite isolado long e short", () => {
    const long = Engine.criticalPrice({ referenceBalance: 100, referencePrices: { BTC: 100 }, positions: [{ symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 100, currentPrice: 100 }] }, "BTC");
    assert.equal(long.price, 0);
    const short = Engine.criticalPrice({ referenceBalance: 100, referencePrices: { ETH: 100 }, positions: [{ symbol: "ETH", side: "SHORT", quantity: 1, averagePrice: 100, currentPrice: 100 }] }, "ETH");
    assert.equal(short.price, 200);
  });
  it("acumula compras pelo preço médio ponderado", () => {
    const p = Engine.addPurchase({ symbol: "BTC", quantity: 1, averagePrice: 100 }, 2, 130);
    assert.equal(p.quantity, 3); assert.equal(p.averagePrice, 120);
  });
  it("rejeita dados inválidos e não produz infinitos com patrimônio não positivo", () => {
    assert.equal(Engine.calculate({ referenceBalance: 1, positions: [{ symbol: "BTC", side: "LONG", quantity: 0, averagePrice: 1, currentPrice: 1 }] }).success, false);
    const r = Engine.calculate({ referenceBalance: 0, referencePrices: { BTC: 100 }, positions: [{ symbol: "BTC", side: "LONG", quantity: 1, averagePrice: 100, currentPrice: 100 }] });
    assert.equal(r.leverage, null); assert.equal(r.riskState, "CRÍTICO");
  });
});
