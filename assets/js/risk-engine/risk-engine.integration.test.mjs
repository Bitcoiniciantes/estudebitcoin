/**
 * Teste de integração ticker → RiskEngine → UI (§10–§15).
 *
 * Simula EXATAMENTE a cadeia de produção sem tocar nos sistemas legados:
 *
 *   Binance WS payload ──parseFloat(data.c)──▶ precoAtual ──▶
 *   RiskEngine.calcularRisco({...params, precoAtual}) ──▶ ResultadoRisco
 *   ──▶ atualização do modelo da UI
 *
 * O ponto de extração do preço replica `ticker-widget.js`:
 * `updateLivePrice(symbol, parseFloat(payload.data.c))`.
 * A calculadora legada (`calculadora-liquidacao-dca/`, bundle fechado sem
 * API/bridge) NÃO foi modificada: este harness prova a cadeia com o motor
 * real; a conexão com a UI legada segue pendente (ver relatório §12).
 *
 * Parâmetros escolhidos para aritmética inteira exata em IEEE-754:
 * saldo 30000, ordem {preco 60000, valor 6000}… não — Q fracionária gera
 * poeira. Usa-se valor 60000 @ 60000: Q = 1, V = 60000, Pmedio = 60000,
 * M = 6000 (lev 10), mmr 0 → EqLiq 0, Pliq LONG = 30000 / SHORT = 90000.
 *
 * Execução: `node --test assets/js/risk-engine/risk-engine.integration.test.mjs`
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import RiskEngine from "./risk-engine.js";

const { calcularRisco } = RiskEngine;

const PARAMS_LONG = {
  moedaConta: "USD",
  saldoCorretora: 30000,
  alavancagem: 10,
  ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }],
  fundingCustoAcumulado: 0,
  mmr: 0,
  lado: "LONG",
};

const PARAMS_SHORT = { ...PARAMS_LONG, lado: "SHORT" };

// ---- Simula o ticker: extrai preço do payload WS e recalcula (§10).
function tickerTick(params, wsPayloadC, uiLog) {
  const precoAtual = parseFloat(wsPayloadC); // igual ao ticker-widget.js
  const resultado = calcularRisco({ ...params, precoAtual });
  uiLog.push({ precoAtual, resultado }); // "atualização da UI"
  return resultado;
}

function ok(r) {
  assert.equal(r.sucesso, true, "falha inesperada: " + JSON.stringify(r));
  return r;
}

describe("§13 — cadeia preço → engine → LIQUIDACAO (LONG)", () => {
  it("60000 → Pliq 30000; 45000 → PnL/equity menores; 30000 → LIQUIDACAO; 25000 → LIQUIDACAO", () => {
    const ui = [];
    const r60 = ok(tickerTick(PARAMS_LONG, "60000", ui));
    assert.equal(r60.precoLiquidacao, 30000);
    assert.equal(r60.pnlNaoRealizado, 0);
    assert.equal(r60.equityAtual, 30000);

    const r45 = ok(tickerTick(PARAMS_LONG, "45000", ui));
    assert.equal(r45.pnlNaoRealizado, -15000);
    assert.equal(r45.equityAtual, 15000);
    assert.ok(r45.pnlNaoRealizado < r60.pnlNaoRealizado);
    assert.ok(r45.equityAtual < r60.equityAtual);
    assert.equal(r45.estadoRisco, "SEGURO");

    const r30 = ok(tickerTick(PARAMS_LONG, "30000", ui));
    assert.equal(r30.equityAtual, r30.equityLiquidacao);
    assert.equal(r30.estadoRisco, "LIQUIDACAO");

    const r25 = ok(tickerTick(PARAMS_LONG, "25000", ui));
    assert.ok(r25.equityAtual < r25.equityLiquidacao);
    assert.equal(r25.estadoRisco, "LIQUIDACAO");

    assert.equal(ui.length, 4); // 4 ticks → 4 atualizações de UI
  });
});

describe("§13 — cadeia inversa (SHORT)", () => {
  it("60000 → Pliq 90000; 75000 → PnL/equity menores; 90000 → LIQUIDACAO; 95000 → LIQUIDACAO", () => {
    const ui = [];
    const r60 = ok(tickerTick(PARAMS_SHORT, "60000", ui));
    assert.equal(r60.precoLiquidacao, 90000);

    const r75 = ok(tickerTick(PARAMS_SHORT, "75000", ui));
    assert.equal(r75.pnlNaoRealizado, -15000);
    assert.equal(r75.equityAtual, 15000);
    assert.equal(r75.estadoRisco, "SEGURO");

    const r90 = ok(tickerTick(PARAMS_SHORT, "90000", ui));
    assert.equal(r90.equityAtual, r90.equityLiquidacao);
    assert.equal(r90.estadoRisco, "LIQUIDACAO");

    const r95 = ok(tickerTick(PARAMS_SHORT, "95000", ui));
    assert.equal(r95.estadoRisco, "LIQUIDACAO");
    assert.equal(ui.length, 4);
  });
});

describe("§14 — alavancagem 2/5/10/20/50", () => {
  it("Pliq idêntico; margemRetida/margemLivre mudam; sem 'correção' da fórmula", () => {
    const pliqs = new Set();
    const margens = [];
    for (const lev of [2, 5, 10, 20, 50]) {
      const r = ok(
        calcularRisco({ ...PARAMS_LONG, alavancagem: lev, precoAtual: 60000 }),
      );
      pliqs.add(r.precoLiquidacao);
      margens.push([r.margemRetida, r.margemLivre]);
      assert.equal(r.margemRetida, 60000 / lev);
      assert.equal(r.margemLivre, 30000 - 60000 / lev);
    }
    assert.equal(pliqs.size, 1, "Pliq deve ser único para as 5 alavancagens");
    assert.equal(pliqs.has(30000), true);
    assert.equal(new Set(margens.map(String)).size, 5);
  });
});

describe("§15 — sequência realtime sem reinicializar", () => {
  it("60000→61000→62000→61000→59000→57000→50000→40000→30000", () => {
    const ui = [];
    const seq = [60000, 61000, 62000, 61000, 59000, 57000, 50000, 40000, 30000];
    const seen = seq.map((p) => ok(tickerTick(PARAMS_LONG, String(p), ui)));
    // PnL/equity exatos acompanham o preço, tick a tick:
    assert.deepEqual(
      seen.map((r) => r.pnlNaoRealizado),
      [0, 1000, 2000, 1000, -1000, -3000, -10000, -20000, -30000],
    );
    assert.deepEqual(
      seen.map((r) => r.equityAtual),
      [30000, 31000, 32000, 31000, 29000, 27000, 20000, 10000, 0],
    );
    // distância encolhe de 50% até 0%:
    assert.ok(seen[0].distanciaLiquidacaoPercentual === 50);
    assert.ok(seen[7].distanciaLiquidacaoPercentual === 25);
    assert.equal(seen[8].distanciaLiquidacaoPercentual, 0);
    // estados: SEGURO até o fim, LIQUIDACAO no último tick:
    assert.deepEqual(
      seen.map((r) => r.estadoRisco),
      ["SEGURO", "SEGURO", "SEGURO", "SEGURO", "SEGURO", "SEGURO", "SEGURO", "SEGURO", "LIQUIDACAO"],
    );
    // motor sem estado: repetir o primeiro preço reproduz o 1º resultado:
    const replay = ok(tickerTick(PARAMS_LONG, "60000", ui));
    assert.deepEqual(replay, seen[0]);
  });
});

describe("posição nasce já liquidada (nome explícito §7)", () => {
  it("posição nasce já liquidada", () => {
    const r = ok(
      calcularRisco({
        moedaConta: "USD",
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
});
