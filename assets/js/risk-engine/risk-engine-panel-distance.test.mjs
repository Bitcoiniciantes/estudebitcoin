import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Panel from "./risk-engine-panel.js";

describe("classificação visual da distância até liquidação", () => {
  const cases = [
    [35, "comfortable", "CONFORTÁVEL"],
    [30.01, "comfortable", "CONFORTÁVEL"],
    [30, "safe", "SEGURO"],
    [24.86, "safe", "SEGURO"],
    [20.01, "safe", "SEGURO"],
    [20, "attention", "ATENÇÃO"],
    [15, "attention", "ATENÇÃO"],
    [10.01, "attention", "ATENÇÃO"],
    [10, "elevated", "RISCO ELEVADO"],
    [8, "elevated", "RISCO ELEVADO"],
    [5.01, "elevated", "RISCO ELEVADO"],
    [5, "critical", "CRÍTICO"],
    [3, "critical", "CRÍTICO"],
    [0, "critical", "CRÍTICO"],
    [-1, "critical", "CRÍTICO"],
  ];

  for (const [value, key, label] of cases) {
    it(value.toFixed(2) + "% → " + label, () => {
      assert.deepEqual(Panel.classifyLiquidationDistance(value, "SEGURO"), { key, label });
    });
  }

  it("valor indisponível usa estado neutro", () => {
    assert.deepEqual(Panel.classifyLiquidationDistance(null, "SEGURO"),
      { key: "unavailable", label: "INDISPONÍVEL" });
    assert.deepEqual(Panel.classifyLiquidationDistance(NaN, "SEGURO"),
      { key: "unavailable", label: "INDISPONÍVEL" });
  });

  it("posição liquidada sempre usa sinalização crítica", () => {
    assert.deepEqual(Panel.classifyLiquidationDistance(null, "LIQUIDACAO"),
      { key: "critical", label: "CRÍTICO" });
    assert.deepEqual(Panel.classifyLiquidationDistance(99, "LIQUIDACAO"),
      { key: "critical", label: "CRÍTICO" });
  });
});
