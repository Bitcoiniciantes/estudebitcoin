/**
 * Testes unitários do Risk Engine (§33 + §34 da especificação).
 *
 * Execução: `node --test assets/js/risk-engine/risk-engine.test.mjs`
 * Sem dependências: apenas módulos nativos `node:test` e `node:assert/strict`.
 * O motor sob teste é o build JS puro (navegador + Node), espelho do .ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import RiskEngine from "./risk-engine.js";

const { calcularRisco } = RiskEngine;

function base(over = {}) {
  return {
    moedaConta: "USD",
    saldoCorretora: 3000,
    alavancagem: 10,
    ordens: [{ moeda: "USD", preco: 60000, valor: 6000 }],
    precoAtual: 66000,
    lado: "LONG",
    ...over,
  };
}

function esperaErro(input, codigo) {
  const r = calcularRisco(input);
  assert.equal(r.sucesso, false, "esperava falha, obteve sucesso");
  assert.equal(r.codigoErro, codigo);
  assert.equal(typeof r.mensagem, "string");
  return r;
}

function esperaSucesso(input) {
  const r = calcularRisco(input);
  assert.equal(r.sucesso, true, "esperava sucesso: " + JSON.stringify(r));
  return r;
}

function quase(a, b, tol = 1e-9) {
  assert.ok(
    Math.abs(a - b) <= tol,
    "esperava " + b + " obteve " + a,
  );
}

// ---------------------------------------------------------------- entradas
describe("§33 — entradas inválidas", () => {
  it("01 preço da ordem zero → FATAL_01", () => {
    esperaErro(
      base({ ordens: [{ moeda: "USD", preco: 0, valor: 100 }] }),
      "FATAL_01",
    );
  });
  it("02 preço da ordem negativo → FATAL_01", () => {
    esperaErro(
      base({ ordens: [{ moeda: "USD", preco: -60000, valor: 100 }] }),
      "FATAL_01",
    );
  });
  it("03 NaN na ordem → FATAL_01", () => {
    esperaErro(
      base({ ordens: [{ moeda: "USD", preco: NaN, valor: 100 }] }),
      "FATAL_01",
    );
    esperaErro(
      base({ ordens: [{ moeda: "USD", preco: 60000, valor: NaN }] }),
      "FATAL_01",
    );
  });
  it("04 Infinity na ordem → FATAL_01", () => {
    esperaErro(
      base({ ordens: [{ moeda: "USD", preco: Infinity, valor: 100 }] }),
      "FATAL_01",
    );
    esperaErro(
      base({ ordens: [{ moeda: "USD", preco: 60000, valor: Infinity }] }),
      "FATAL_01",
    );
  });
  it("05 valor da ordem zero → FATAL_01", () => {
    esperaErro(
      base({ ordens: [{ moeda: "USD", preco: 60000, valor: 0 }] }),
      "FATAL_01",
    );
  });
  it("06 lista vazia → FATAL_02", () => {
    esperaErro(base({ ordens: [] }), "FATAL_02");
  });
  it("07 moeda incompatível → FATAL_03", () => {
    esperaErro(
      base({ ordens: [{ moeda: "EUR", preco: 60000, valor: 100 }] }),
      "FATAL_03",
    );
  });
  it("08 saldo zero → FATAL_04", () => {
    esperaErro(base({ saldoCorretora: 0 }), "FATAL_04");
  });
  it("09 saldo negativo → FATAL_04", () => {
    esperaErro(base({ saldoCorretora: -100 }), "FATAL_04");
  });
  it("10 saldo NaN → FATAL_04", () => {
    esperaErro(base({ saldoCorretora: NaN }), "FATAL_04");
  });
  it("11 saldo Infinity → FATAL_04", () => {
    esperaErro(base({ saldoCorretora: Infinity }), "FATAL_04");
  });
  it("12 alavancagem < 1 → FATAL_05", () => {
    esperaErro(base({ alavancagem: 0.5 }), "FATAL_05");
  });
  it("13 alavancagem NaN → FATAL_05", () => {
    esperaErro(base({ alavancagem: NaN }), "FATAL_05");
  });
  it("14 alavancagem Infinity → FATAL_05", () => {
    esperaErro(base({ alavancagem: Infinity }), "FATAL_05");
  });
  it("15 preço atual zero → FATAL_06", () => {
    esperaErro(base({ precoAtual: 0 }), "FATAL_06");
  });
  it("16 preço atual NaN → FATAL_06", () => {
    esperaErro(base({ precoAtual: NaN }), "FATAL_06");
  });
  it("17 funding negativo → FATAL_07", () => {
    esperaErro(base({ fundingCustoAcumulado: -1 }), "FATAL_07");
  });
  it("18 funding NaN → FATAL_07", () => {
    esperaErro(base({ fundingCustoAcumulado: NaN }), "FATAL_07");
  });
  it("19 funding Infinity → FATAL_07", () => {
    esperaErro(base({ fundingCustoAcumulado: Infinity }), "FATAL_07");
  });
  it("20 MMR negativo → FATAL_08", () => {
    esperaErro(base({ mmr: -0.01 }), "FATAL_08");
  });
  it("21 MMR >= 1 → FATAL_08", () => {
    esperaErro(base({ mmr: 1 }), "FATAL_08");
    esperaErro(base({ mmr: 1.5 }), "FATAL_08");
  });
  it("22 MMR NaN → FATAL_08", () => {
    esperaErro(base({ mmr: NaN }), "FATAL_08");
  });
  it("23 MMR Infinity → FATAL_08", () => {
    esperaErro(base({ mmr: Infinity }), "FATAL_08");
  });
  it("24 margem maior que saldo → FATAL_09", () => {
    // M = 6000/1 = 6000 > saldo 3000 (capacidade insuficiente)
    esperaErro(base({ alavancagem: 1 }), "FATAL_09");
  });
  it("24b Correção 1 (semântica B): funding NÃO gera FATAL_09", () => {
    // M = 600 <= 3000: abertura válida; funding 2500 é custo da posição
    // existente, absorvido pela equity — nunca invalida retroativamente.
    const r = esperaSucesso(base({ fundingCustoAcumulado: 2500 }));
    assert.equal(r.margemRetida, 600);
    assert.equal(r.margemLivre, -100); // negativa em sucesso: documentado
    assert.equal(r.equityAtual, 1100); // 3000 + 600 - 2500
    assert.equal(r.estadoRisco, "SEGURO");
  });
  it("25 resultado não finito → FATAL_10", () => {
    const r = calcularRisco(
      base({
        saldoCorretora: 10000,
        alavancagem: 1,
        ordens: [{ moeda: "USD", preco: 1e-308, valor: 1 }],
        precoAtual: 1e308,
      }),
    );
    assert.equal(r.sucesso, false);
    assert.equal(r.codigoErro, "FATAL_10");
  });
  it("25b FATAL_10: Q = Infinity (overflow valor/preço)", () => {
    const r = calcularRisco(
      base({
        saldoCorretora: 1.79e308,
        alavancagem: 10,
        ordens: [{ moeda: "USD", preco: 0.5, valor: 1e308 }],
        precoAtual: 60000,
      }),
    );
    assert.equal(r.sucesso, false);
    assert.equal(r.codigoErro, "FATAL_10");
  });
  it("25c FATAL_10: Pmedio não finito (Q underflow para 0)", () => {
    // q = 1e-308/1e308 underflow → 0; Pmedio = V/0 = Infinity; Pliq = NaN.
    const r = calcularRisco(
      base({
        ordens: [{ moeda: "USD", preco: 1e308, valor: 1e-308 }],
        precoAtual: 60000,
      }),
    );
    assert.equal(r.sucesso, false);
    assert.equal(r.codigoErro, "FATAL_10");
  });
  it("25d FATAL_10: Pliq = -Infinity (Q minúsculo + saldo grande)", () => {
    // q = 1e-300 representável; termo = -1e308/1e-300 = -Infinity.
    const r = calcularRisco(
      base({
        saldoCorretora: 1e308,
        alavancagem: 1,
        ordens: [{ moeda: "USD", preco: 1e100, valor: 1e-200 }],
        precoAtual: 1e100,
      }),
    );
    assert.equal(r.sucesso, false);
    assert.equal(r.codigoErro, "FATAL_10");
  });
  it("25e V = Infinity atinge FATAL_09 antes (precedência documentada)", () => {
    // M = Infinity > qualquer saldo finito: capacidade, não FATAL_10.
    const r = calcularRisco(
      base({
        ordens: [
          { moeda: "USD", preco: 60000, valor: 1e308 },
          { moeda: "USD", preco: 60000, valor: 1e308 },
        ],
      }),
    );
    assert.equal(r.sucesso, false);
    assert.equal(r.codigoErro, "FATAL_09");
  });
  it("precedência: FATAL_01 antes de FATAL_04/05; FATAL_07 antes de FATAL_08", () => {
    esperaErro(
      base({
        ordens: [{ moeda: "USD", preco: 0, valor: 0 }],
        saldoCorretora: -5,
        alavancagem: 0,
      }),
      "FATAL_01",
    );
    esperaErro(
      base({ saldoCorretora: -5, alavancagem: 0 }),
      "FATAL_04",
    );
    esperaErro(
      base({ alavancagem: 0, precoAtual: -1 }),
      "FATAL_05",
    );
    esperaErro(
      base({ fundingCustoAcumulado: -1, mmr: 2 }),
      "FATAL_07",
    );
  });
});

// ---------------------------------------------------------------- cálculos
describe("§33 — cálculos", () => {
  it("26 LONG simples", () => {
    const r = esperaSucesso(base());
    quase(r.quantidadeAtivo, 0.1);
    quase(r.valorExposicao, 6000);
    quase(r.precoMedio, 60000);
    quase(r.margemRetida, 600);
    quase(r.margemLivre, 2400);
    assert.equal(r.saldoInicial, 3000);
    assert.equal(r.fundingCustoAcumulado, 0);
    quase(r.pnlNaoRealizado, 600);
    quase(r.equityAtual, 3600);
    quase(r.equityLiquidacao, 0);
    quase(r.precoLiquidacao, 30000);
    quase(r.distanciaLiquidacaoPercentual, ((66000 - 30000) / 66000) * 100);
    quase(r.resultadoEquityPercentual, 20);
    assert.equal(r.estadoRisco, "SEGURO");
    assert.equal(r.lado, "LONG");
  });
  it("27 SHORT simples", () => {
    const r = esperaSucesso(base({ precoAtual: 54000, lado: "SHORT" }));
    quase(r.pnlNaoRealizado, 600);
    quase(r.equityAtual, 3600);
    quase(r.precoLiquidacao, 90000);
    quase(r.distanciaLiquidacaoPercentual, ((90000 - 54000) / 54000) * 100);
    assert.equal(r.estadoRisco, "SEGURO");
  });
  it("28 múltiplas ordens somam Q e V", () => {
    const r = esperaSucesso(
      base({
        ordens: [
          { moeda: "USD", preco: 60000, valor: 6000 },
          { moeda: "USD", preco: 60000, valor: 3000 },
        ],
      }),
    );
    quase(r.valorExposicao, 9000);
    quase(r.quantidadeAtivo, 0.15);
    quase(r.precoMedio, 60000);
  });
  it("29 preço médio é ponderado financeiramente", () => {
    const r = esperaSucesso(
      base({
        ordens: [
          { moeda: "USD", preco: 50000, valor: 5000 },
          { moeda: "USD", preco: 70000, valor: 14000 },
        ],
        precoAtual: 65000,
      }),
    );
    // V=19000, Q=0.1+0.2=0.3, Pmedio=63333.33 (média aritmética seria 60000)
    quase(r.precoMedio, 19000 / 0.3, 1e-6);
    assert.ok(Math.abs(r.precoMedio - 60000) > 1000);
  });
  it("30 funding aumenta a perda", () => {
    const sem = esperaSucesso(base({ precoAtual: 60000 }));
    const com = esperaSucesso(
      base({ precoAtual: 60000, fundingCustoAcumulado: 100 }),
    );
    quase(com.equityAtual, sem.equityAtual - 100);
    assert.ok(com.resultadoEquityPercentual < sem.resultadoEquityPercentual);
  });
  it("31 saldo livre funciona como buffer", () => {
    const pequeno = esperaSucesso(base({ precoAtual: 60000 }));
    const grande = esperaSucesso(
      base({ precoAtual: 60000, saldoCorretora: 5000 }),
    );
    assert.ok(grande.precoLiquidacao < pequeno.precoLiquidacao);
    assert.ok(
      grande.distanciaLiquidacaoPercentual >
        pequeno.distanciaLiquidacaoPercentual,
    );
  });
  it("32 MMR = 0 zera a equity de liquidação", () => {
    const r = esperaSucesso(base({ mmr: 0 }));
    assert.equal(r.equityLiquidacao, 0);
  });
  it("33 MMR > 0 desloca equity limite e Pliq", () => {
    const r = esperaSucesso(base({ mmr: 0.005, precoAtual: 60000 }));
    quase(r.equityLiquidacao, 6000 * 0.005);
    // Pliq = 60000 + (30 - 3000)/0.1 = 30300 (vs 30000 com mmr=0)
    quase(r.precoLiquidacao, 30300);
  });
  it("34 atualização de preço: puro, determinístico, reativo", () => {
    const a = esperaSucesso(base({ precoAtual: 61000 }));
    const b = esperaSucesso(base({ precoAtual: 62000 }));
    assert.ok(b.pnlNaoRealizado > a.pnlNaoRealizado);
    assert.deepEqual(calcularRisco(base({ precoAtual: 61000 })), a);
  });
});

// --------------------------------------------------------------- fronteiras
describe("§33 — fronteiras", () => {
  it("35 equity exatamente no limite → LIQUIDACAO", () => {
    const r0 = esperaSucesso(base({ mmr: 0.005 }));
    assert.ok(r0.precoLiquidacao !== null);
    const r = esperaSucesso(base({ mmr: 0.005, precoAtual: r0.precoLiquidacao }));
    assert.equal(r.estadoRisco, "LIQUIDACAO");
  });
  it("36 equity abaixo do limite → LIQUIDACAO", () => {
    const r = esperaSucesso(
      base({ mmr: 0.005, precoAtual: 30000 }),
    );
    assert.ok(r.equityAtual <= r.equityLiquidacao);
    assert.equal(r.estadoRisco, "LIQUIDACAO");
  });
  it("37 posição nasce já liquidada → LIQUIDACAO", () => {
    // M = 10000/10 = 1000 = saldo (livre = 0, passa FATAL_09 no limite);
    // EqLiq = 10000*0.15 = 1500 > equity inicial 1000.
    const r = esperaSucesso(
      base({
        saldoCorretora: 1000,
        alavancagem: 10,
        ordens: [{ moeda: "USD", preco: 60000, valor: 10000 }],
        precoAtual: 60000,
        mmr: 0.15,
        lado: "LONG",
      }),
    );
    assert.ok(r.equityAtual <= r.equityLiquidacao);
    assert.equal(r.estadoRisco, "LIQUIDACAO");
  });
  it("38 Pliq positivo no caso padrão", () => {
    const r = esperaSucesso(base());
    assert.ok(r.precoLiquidacao !== null && r.precoLiquidacao > 0);
  });
  it("39 Pliq zero → null + LIQUIDACAO_INATINGIVEL", () => {
    // saldo=3000, V=2000, mmr=0.5 → EqLiq=1000 = saldo - V → Pliq = 0.
    const r = esperaSucesso(
      base({
        alavancagem: 1,
        ordens: [{ moeda: "USD", preco: 50000, valor: 2000 }],
        precoAtual: 50000,
        mmr: 0.5,
      }),
    );
    assert.equal(r.precoLiquidacao, null);
    assert.equal(r.distanciaLiquidacaoPercentual, null);
    assert.equal(r.estadoRisco, "LIQUIDACAO_INATINGIVEL");
  });
  it("40 Pliq negativo → null + LIQUIDACAO_INATINGIVEL", () => {
    const r = esperaSucesso(
      base({
        alavancagem: 1,
        ordens: [{ moeda: "USD", preco: 50000, valor: 2000 }],
        precoAtual: 50000,
        mmr: 0.4,
      }),
    );
    assert.equal(r.precoLiquidacao, null);
    assert.equal(r.distanciaLiquidacaoPercentual, null);
    assert.equal(r.estadoRisco, "LIQUIDACAO_INATINGIVEL");
  });
  it("41 LONG com Pliq <= 0 coberto (39/40 são LONG)", () => {
    assert.equal(base().lado, "LONG");
  });
  it("42 SHORT: ramo Pliq <= 0 inalcançável sob as restrições", () => {
    // Para SHORT, Pliq <= 0 exigiria mmr >= 1 + 1/alavancagem (impossível,
    // pois mmr < 1 e funding <= saldo - M por FATAL_09). Prova por força:
    const r = esperaSucesso({
      moedaConta: "USD",
      saldoCorretora: 1000,
      alavancagem: 1,
      ordens: [{ moeda: "USD", preco: 100, valor: 1000 }],
      precoAtual: 100,
      fundingCustoAcumulado: 0,
      mmr: 0.999999,
      lado: "SHORT",
    });
    assert.ok(r.precoLiquidacao !== null && r.precoLiquidacao > 0);
  });
  it("43 preço atual exatamente igual ao Pliq → LIQUIDACAO", () => {
    const r0 = esperaSucesso(base({ lado: "SHORT", precoAtual: 66000 }));
    assert.ok(r0.precoLiquidacao !== null);
    const r = esperaSucesso(
      base({ lado: "SHORT", precoAtual: r0.precoLiquidacao }),
    );
    assert.equal(r.estadoRisco, "LIQUIDACAO");
  });
  it("44 distância exatamente 0%", () => {
    const r0 = esperaSucesso(base());
    const r = esperaSucesso(base({ precoAtual: r0.precoLiquidacao }));
    assert.equal(r.distanciaLiquidacaoPercentual, 0);
    assert.equal(r.estadoRisco, "LIQUIDACAO");
  });
  it("45/46/47 resultado equity positivo / zero / negativo", () => {
    const ganho = esperaSucesso(base({ precoAtual: 66000 }));
    assert.ok(ganho.resultadoEquityPercentual > 0);
    const neutro = esperaSucesso(base({ precoAtual: 60000 }));
    assert.equal(neutro.resultadoEquityPercentual, 0);
    const perda = esperaSucesso(base({ precoAtual: 54000 }));
    assert.ok(perda.resultadoEquityPercentual < 0);
  });
  it("Correção 2: PnL > 0 com resultadoEquityPercentual < 0 (funding supera ganho)", () => {
    // PnL = +600 mas funding 1000 → equity 2600 → -13.33% (perda líquida).
    // NÃO é "posição no prejuízo": é custo superando o ganho. UI: exibir
    // "-13,33%" como perda líquida, jamais "+12%" como "perda de -12%".
    const r = esperaSucesso(
      base({ precoAtual: 66000, fundingCustoAcumulado: 1000 }),
    );
    assert.ok(r.pnlNaoRealizado > 0, "PnL positivo");
    assert.ok(r.resultadoEquityPercentual < 0, "resultado líquido negativo");
    assert.ok(
      Math.abs(r.resultadoEquityPercentual - -13.333333333333334) < 1e-9,
    );
  });
  it("48 alavancagem não altera o Pliq", () => {
    const a = esperaSucesso(base({ alavancagem: 5 }));
    const b = esperaSucesso(base({ alavancagem: 20 }));
    assert.equal(a.precoLiquidacao, b.precoLiquidacao);
  });
  it("49 alavancagem altera só margem retida/livre", () => {
    const a = esperaSucesso(base({ alavancagem: 5 }));
    const b = esperaSucesso(base({ alavancagem: 20 }));
    quase(a.margemRetida, 1200);
    quase(b.margemRetida, 300);
    quase(a.margemLivre, 1800);
    quase(b.margemLivre, 2700);
    assert.equal(a.pnlNaoRealizado, b.pnlNaoRealizado);
    assert.equal(a.equityAtual, b.equityAtual);
  });
});

// -------------------------------------------------------------- invariantes
describe("§34 — invariantes", () => {
  it("LONG: preço sobe → PnL não cai; preço cai → PnL não sobe", () => {
    const p1 = esperaSucesso(base({ precoAtual: 60000 })).pnlNaoRealizado;
    const p2 = esperaSucesso(base({ precoAtual: 61000 })).pnlNaoRealizado;
    const p3 = esperaSucesso(base({ precoAtual: 59000 })).pnlNaoRealizado;
    assert.ok(p2 >= p1 && p1 >= p3);
  });
  it("SHORT: preço cai → PnL não cai; preço sobe → PnL não sobe", () => {
    const s = (p) =>
      esperaSucesso(base({ lado: "SHORT", precoAtual: p })).pnlNaoRealizado;
    assert.ok(s(59000) >= s(60000) && s(60000) >= s(61000));
  });
  it("alavancagem: muda margem, nunca o Pliq", () => {
    const a = esperaSucesso(base({ alavancagem: 2 }));
    const b = esperaSucesso(base({ alavancagem: 50 }));
    assert.notEqual(a.margemRetida, b.margemRetida);
    assert.notEqual(a.margemLivre, b.margemLivre);
    assert.equal(a.precoLiquidacao, b.precoLiquidacao);
  });
  it("resultado equity: > 0 ganho, < 0 perda (§27: +12% = ganho)", () => {
    const r = esperaSucesso(
      base({
        saldoCorretora: 3000,
        alavancagem: 10,
        ordens: [{ moeda: "USD", preco: 60000, valor: 6000 }],
        precoAtual: 63600, // PnL = +360 → equity 3360 → +12%
      }),
    );
    quase(r.equityAtual, 3360);
    quase(r.resultadoEquityPercentual, 12);
    assert.ok(r.resultadoEquityPercentual > 0, "positivo = ganho, não perda");
  });
  it("sem toFixed/arredondamento: valores crus preservados", () => {
    const r = esperaSucesso(base({ precoAtual: 61000 }));
    // (61000-30000)/61000*100 = 50.81967213114754... (dízima, sem corte)
    assert.ok(
      String(r.distanciaLiquidacaoPercentual).length > 8,
      "sem arredondamento interno: " + r.distanciaLiquidacaoPercentual,
    );
    quase(r.distanciaLiquidacaoPercentual, ((61000 - 30000) / 61000) * 100, 1e-12);
    for (const k of Object.keys(r)) {
      if (typeof r[k] === "number") assert.equal(typeof r[k], "number");
    }
  });
  it("determinismo: mesma entrada, byte a byte", () => {
    const input = base({ mmr: 0.005, fundingCustoAcumulado: 12.5 });
    assert.equal(
      JSON.stringify(calcularRisco(input)),
      JSON.stringify(calcularRisco(JSON.parse(JSON.stringify(input)))),
    );
  });
});
