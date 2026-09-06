/**
 * Testes do adapter + view-model do painel (§9, §11–§14).
 *
 * O adapter é exercitado sem DOM (updateRiskPrice direto + eventos simulados
 * no mesmo formato de `estudebitcoin:ticker-price`), provando:
 * - §11: sequências LONG/SHORT preço → engine → resultado;
 * - §12: posição constante enquanto só o preço muda;
 * - §13: alavancagem na "UI" (via adapter) não move o Pliq;
 * - §14: entradas inválidas → sucesso===false, view-model sem campos de sucesso;
 * - §9:  mapeamento completo de campos, sem recalcular nada na UI.
 *
 * Execução: `node --test assets/js/risk-engine/risk-engine-adapter.test.mjs`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Adapter from "./risk-engine-adapter.js";
import Panel from "./risk-engine-panel.js";

const { buildViewModel } = Panel;

function paramsLong(over = {}) {
  return {
    simbolo: "BTC",
    moedaConta: "USD",
    saldoCorretora: 30000,
    alavancagem: 10,
    ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }],
    fundingCustoAcumulado: 0,
    mmr: 0,
    lado: "LONG",
    ...over,
  };
}

// Simula o ticker: dispara o evento no formato real via updateRiskPrice.
function tick(preco) {
  return Adapter.updateRiskPrice(preco);
}

describe("§11 — produção via adapter (LONG)", () => {
  it("60000→61000→62000→59000→40000→30000", () => {
    Adapter.configure(paramsLong());
    const vms = [];
    for (const p of [60000, 61000, 62000, 59000, 40000, 30000]) {
      const r = tick(p);
      assert.equal(r.sucesso, true);
      vms.push(buildViewModel(r));
    }
    assert.deepEqual(
      vms.map((v) => v.pnlNaoRealizado),
      [0, 1000, 2000, -1000, -20000, -30000],
    );
    assert.equal(vms[0].precoLiquidacao, 30000);
    assert.equal(vms[5].estadoRisco, "LIQUIDACAO");
    assert.ok(vms.every((v) => v.ok === true));
  });
});

describe("§11 — produção via adapter (SHORT)", () => {
  it("60000→61000→75000→90000→95000", () => {
    Adapter.configure(paramsLong({ lado: "SHORT" }));
    const estados = [];
    let pliq = null;
    for (const p of [60000, 61000, 75000, 90000, 95000]) {
      const r = tick(p);
      assert.equal(r.sucesso, true);
      pliq = r.precoLiquidacao;
      estados.push(r.estadoRisco);
    }
    assert.equal(pliq, 90000);
    assert.deepEqual(estados, ["SEGURO", "SEGURO", "SEGURO", "LIQUIDACAO", "LIQUIDACAO"]);
  });
});

describe("§12 — continuidade: só o preço muda", () => {
  it("Pliq/margem iguais; PnL/equity/distância/estado acompanham", () => {
    Adapter.configure(paramsLong());
    const a = tick(60000);
    const b = tick(59000);
    assert.equal(a.precoLiquidacao, b.precoLiquidacao);
    assert.equal(a.margemRetida, b.margemRetida);
    assert.equal(a.margemLivre, b.margemLivre);
    assert.equal(a.precoMedio, b.precoMedio);
    assert.equal(a.quantidadeAtivo, b.quantidadeAtivo);
    assert.notEqual(a.pnlNaoRealizado, b.pnlNaoRealizado);
    assert.notEqual(a.equityAtual, b.equityAtual);
    assert.notEqual(a.distanciaLiquidacaoPercentual, b.distanciaLiquidacaoPercentual);
    // adapter guarda o último resultado (única "memória", só leitura):
    assert.deepEqual(Adapter.getLastResult(), b);
    assert.equal(Adapter.getLastPrice(), 59000);
  });
});

describe("§13 — alavancagem na UI não move o Pliq", () => {
  it("2x/5x/10x/20x/50x: Pliq igual, margens diferentes", () => {
    const pliqs = new Set();
    const rets = new Set();
    for (const lev of [2, 5, 10, 20, 50]) {
      Adapter.configure(paramsLong({ alavancagem: lev }));
      const vm = buildViewModel(tick(60000));
      assert.equal(vm.ok, true);
      pliqs.add(vm.precoLiquidacao);
      rets.add(vm.margemRetida);
    }
    assert.equal(pliqs.size, 1);
    assert.equal([...pliqs][0], 30000);
    assert.equal(rets.size, 5);
  });
});

describe("§14 — erros nunca produzem números silenciosos", () => {
  it("FATAL_01..FATAL_10 → view-model { ok:false } sem campos de sucesso", () => {
    const invalidos = [
      paramsLong({ ordens: [{ moeda: "USD", preco: 0, valor: 1 }] }), // FATAL_01
      paramsLong({ ordens: [] }), // FATAL_02
      paramsLong({ ordens: [{ moeda: "EUR", preco: 1, valor: 1 }] }), // FATAL_03
      paramsLong({ saldoCorretora: 0 }), // FATAL_04
      paramsLong({ alavancagem: 0.5 }), // FATAL_05
      paramsLong({ lado: "LONG" }), // base válida; preço inválido abaixo
    ];
    const cods = ["FATAL_01", "FATAL_02", "FATAL_03", "FATAL_04", "FATAL_05"];
    invalidos.slice(0, 5).forEach((p, i) => {
      Adapter.configure(p);
      const vm = buildViewModel(tick(60000));
      assert.equal(vm.ok, false);
      assert.equal(vm.codigo, cods[i]);
      assert.equal(typeof vm.mensagem, "string");
      assert.equal("precoLiquidacao" in vm, false);
      assert.equal("pnlNaoRealizado" in vm, false);
    });
    // preço inválido chega pelo tick (FATAL_06), não pelos parâmetros:
    Adapter.configure(paramsLong());
    const vm6 = buildViewModel(tick(0));
    assert.equal(vm6.ok, false);
    assert.equal(vm6.codigo, "FATAL_06");
    // margem > saldo (FATAL_09) e overflow (FATAL_10):
    Adapter.configure(paramsLong({ alavancagem: 1, saldoCorretora: 30000 }));
    const vm9 = buildViewModel(tick(60000)); // M=60000 > 30000
    assert.equal(vm9.codigo, "FATAL_09");
  });
});

describe("§9 — mapeamento completo sem recalcular", () => {
  it("view-model espelha 1:1 os campos do motor", () => {
    Adapter.configure(paramsLong());
    const r = tick(61000);
    const vm = buildViewModel(r);
    for (const k of [
      "quantidadeAtivo", "precoMedio", "margemRetida", "margemLivre",
      "pnlNaoRealizado", "equityAtual", "precoLiquidacao",
      "distanciaLiquidacaoPercentual", "resultadoEquityPercentual",
      "estadoRisco",
    ]) {
      assert.deepEqual(vm[k], r[k], "campo " + k);
    }
    assert.equal(vm.pnlNaoRealizado, 1000);
    assert.equal(vm.equityAtual, 31000);
  });
});

describe("adapter não contém matemática", () => {
  it("sem parâmetros → null (sem inventar FATAL); listeners recebem o objeto do motor", () => {
    Adapter.configure(null);
    assert.equal(Adapter.updateRiskPrice(60000), null);
    Adapter.configure(paramsLong());
    let recebido = null;
    const cb = (r) => {
      recebido = r;
    };
    Adapter.onResult(cb);
    const direto = tick(60000);
    assert.deepEqual(recebido, direto);
    Adapter.offResult(cb);
  });
});
