/**
 * Risk Engine determinístico de posições (modelo Quantfury do EstudeBitcoin).
 *
 * Build JS puro espelhado de `risk-engine.ts` (fonte da verdade, TypeScript
 * com `strict: true`). Lógica idêntica, sem dependências.
 *
 * USO NO NAVEGADOR (sem bundler):
 *   <script src="assets/js/risk-engine/risk-engine.js"></script>
 *   <script>
 *     var r = window.RiskEngine.calcularRisco({
 *       moedaConta: "USD", saldoCorretora: 3000, alavancagem: 10,
 *       ordens: [{ moeda: "USD", preco: 60000, valor: 6000 }],
 *       precoAtual: 66000, lado: "LONG"
 *     });
 *   </script>
 *
 * USO EM NODE (testes):
 *   const { calcularRisco } = require("./risk-engine.js");
 *
 * INTEGRAÇÃO EM TEMPO REAL (§32): a camada externa de market data observa o
 * preço novo e chama `calcularRisco({ ...params, precoAtual })` a cada tick;
 * o motor não mantém preço anterior, timers ou debounce.
 *
 * REGRAS DO MODELO (resumo; documentação completa no .ts):
 * - Puro e determinístico: mesmas entradas => mesma saída. Sem rede/DOM.
 * - MMR incide sobre o NOCIONAL (V * mmr), nunca sobre a margem retida.
 * - Equity = saldo + PnL - funding (margem retida não subtraída de novo).
 * - funding >= 0 é custo pago; ausente => 0. mmr em [0,1); ausente => 0.
 * - Pliq <= 0 => null/null + LIQUIDACAO_INATINGIVEL (sem Math.max, sem 0).
 * - LIQUIDACAO (equity <= limite) tem precedência absoluta.
 * - resultadoEquityPercentual é LÍQUIDO (≠ PnL): > 0 ganho, < 0 perda;
 *   PnL > 0 com resultado < 0 é válido (funding supera o ganho). UI: "+12%"
 *   = ganho, nunca "perda de -12%".
 * - Pliq NÃO depende da alavancagem neste modelo (§29); não "corrigir".
 * - Sem arredondamento: formatação pertence à UI.
 */
(function (global, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    global.RiskEngine = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var RISK_THRESHOLDS = {
    ATENCAO_PERCENTUAL: 10,
    CRITICO_PERCENTUAL: 5,
  };

  function erro(codigoErro, mensagem) {
    return { sucesso: false, codigoErro: codigoErro, mensagem: mensagem };
  }

  function ehNumeroFinito(n) {
    return typeof n === "number" && Number.isFinite(n);
  }

  function calcularRisco(input) {
    if (input === null || typeof input !== "object") {
      return erro("FATAL_10", "FATAL_10: input ausente ou inválido.");
    }
    var lado = input.lado;
    if (lado !== "LONG" && lado !== "SHORT") {
      return erro("FATAL_10", "FATAL_10: lado deve ser LONG ou SHORT.");
    }

    var ordens = input.ordens;

    // FATAL_01 antes de FATAL_02; loop só se for array.
    if (Array.isArray(ordens)) {
      for (var i = 0; i < ordens.length; i++) {
        var o = ordens[i];
        if (
          o === null ||
          typeof o !== "object" ||
          !ehNumeroFinito(o.preco) ||
          !ehNumeroFinito(o.valor) ||
          o.preco <= 0 ||
          o.valor <= 0
        ) {
          return erro(
            "FATAL_01",
            "FATAL_01: ordem inválida no índice " +
              i +
              " (preco e valor devem ser finitos e > 0).",
          );
        }
      }
    }

    // FATAL_02.
    if (!Array.isArray(ordens) || ordens.length === 0) {
      return erro("FATAL_02", "FATAL_02: lista de ordens vazia.");
    }

    // FATAL_03.
    var moedaConta = input.moedaConta;
    if (typeof moedaConta !== "string" || moedaConta.length === 0) {
      return erro("FATAL_03", "FATAL_03: moeda da conta ausente ou inválida.");
    }
    for (var j = 0; j < ordens.length; j++) {
      if (ordens[j].moeda !== moedaConta) {
        return erro(
          "FATAL_03",
          "FATAL_03: ordem no índice " + j + " com moeda incompatível.",
        );
      }
    }

    // FATAL_04.
    var saldoCorretora = input.saldoCorretora;
    if (!ehNumeroFinito(saldoCorretora) || saldoCorretora <= 0) {
      return erro("FATAL_04", "FATAL_04: saldo deve ser finito e > 0.");
    }

    // FATAL_05.
    var alavancagem = input.alavancagem;
    if (!ehNumeroFinito(alavancagem) || alavancagem < 1) {
      return erro("FATAL_05", "FATAL_05: alavancagem deve ser finita e >= 1.");
    }

    // FATAL_06.
    var precoAtual = input.precoAtual;
    if (!ehNumeroFinito(precoAtual) || precoAtual <= 0) {
      return erro("FATAL_06", "FATAL_06: preco atual deve ser finito e > 0.");
    }

    // FATAL_07 (ausente => 0).
    var fundingCustoAcumulado =
      input.fundingCustoAcumulado === undefined ||
      input.fundingCustoAcumulado === null
        ? 0
        : input.fundingCustoAcumulado;
    if (!ehNumeroFinito(fundingCustoAcumulado) || fundingCustoAcumulado < 0) {
      return erro("FATAL_07", "FATAL_07: funding deve ser finito e >= 0.");
    }

    // FATAL_08 (ausente => 0).
    var mmr =
      input.mmr === undefined || input.mmr === null ? 0 : input.mmr;
    if (!ehNumeroFinito(mmr) || mmr < 0 || mmr >= 1) {
      return erro("FATAL_08", "FATAL_08: mmr deve ser finito e satisfazer 0 <= mmr < 1.");
    }

    // Ordens: Q, V, Pmedio ponderado.
    var q = 0;
    var v = 0;
    for (var k = 0; k < ordens.length; k++) {
      q += ordens[k].valor / ordens[k].preco;
      v += ordens[k].valor;
    }
    var quantidadeAtivo = q;
    var valorExposicao = v;
    var precoMedio = valorExposicao / quantidadeAtivo;

    // Margem retida.
    var margemRetida = valorExposicao / alavancagem;

    // FATAL_09: capacidade de abertura (Correção 1 — semântica B).
    // DECISÃO: funding é custo de posição JÁ EXISTENTE (Equity = saldo +
    // PnL - funding), NÃO exigência de capital prévio. Evidência: a
    // calculadora legada valida abertura como posição <= margem*alavancagem,
    // sem campo de funding. Funding histórico NUNCA invalida retroativamente;
    // se corroer a equity até o limite, o mecanismo é LIQUIDACAO (Regra 1).
    // FATAL_09 dispara SOMENTE quando M > saldo. margemLivre pode ser
    // negativa em sucesso (custos acima do capital livre, absorvidos).
    var margemLivre = saldoCorretora - margemRetida - fundingCustoAcumulado;
    if (margemRetida > saldoCorretora) {
      return erro("FATAL_09", "FATAL_09: margem retida superior ao saldo disponível.");
    }

    // PnL.
    var pnlNaoRealizado =
      lado === "LONG"
        ? (precoAtual - precoMedio) * quantidadeAtivo
        : (precoMedio - precoAtual) * quantidadeAtivo;

    // Equity (margem retida não subtraída de novo).
    var equityAtual =
      saldoCorretora + pnlNaoRealizado - fundingCustoAcumulado;

    // Equity de liquidação: MMR sobre o nocional.
    var equityLiquidacao = valorExposicao * mmr;

    // Pliq INTENCIONALMENTE sem alavancagem (§29, Correção 4): fixados
    // saldo, V, Q, Pmedio, funding e mmr, o Pliq é idêntico para qualquer
    // alavancagem. NÃO "corrigir" aproximando a liquidação — quebraria o
    // modelo. Mudança só com alteração explícita da especificação.
    var termo =
      (equityLiquidacao - saldoCorretora + fundingCustoAcumulado) /
      quantidadeAtivo;
    var pliqBruto =
      lado === "LONG" ? precoMedio + termo : precoMedio - termo;

    // FATAL_10 (núcleo).
    var nucleo = [
      quantidadeAtivo,
      valorExposicao,
      precoMedio,
      margemRetida,
      margemLivre,
      pnlNaoRealizado,
      equityAtual,
      equityLiquidacao,
      pliqBruto,
    ];
    for (var w = 0; w < nucleo.length; w++) {
      if (!ehNumeroFinito(nucleo[w])) {
        return erro("FATAL_10", "FATAL_10: resultado matemático não finito.");
      }
    }

    // Classificação (§24).
    var estadoRisco;
    var precoLiquidacao;
    var distanciaLiquidacaoPercentual;

    if (equityAtual <= equityLiquidacao) {
      estadoRisco = "LIQUIDACAO";
      precoLiquidacao = pliqBruto > 0 ? pliqBruto : null;
      distanciaLiquidacaoPercentual =
        precoLiquidacao === null
          ? null
          : lado === "LONG"
            ? ((precoAtual - precoLiquidacao) / precoAtual) * 100
            : ((precoLiquidacao - precoAtual) / precoAtual) * 100;
    } else if (pliqBruto <= 0) {
      estadoRisco = "LIQUIDACAO_INATINGIVEL";
      precoLiquidacao = null;
      distanciaLiquidacaoPercentual = null;
    } else {
      precoLiquidacao = pliqBruto;
      var distancia =
        lado === "LONG"
          ? ((precoAtual - precoLiquidacao) / precoAtual) * 100
          : ((precoLiquidacao - precoAtual) / precoAtual) * 100;
      distanciaLiquidacaoPercentual = distancia;
      if (distancia > RISK_THRESHOLDS.ATENCAO_PERCENTUAL) {
        estadoRisco = "SEGURO";
      } else if (distancia > RISK_THRESHOLDS.CRITICO_PERCENTUAL) {
        estadoRisco = "ATENCAO";
      } else if (distancia > 0) {
        estadoRisco = "CRITICO";
      } else {
        // RAMO DEFENSIVO (Correção 3): com Pliq > 0 e equity acima do limite,
        // distancia <= 0 é matematicamente impossível (mesmo cruzamento da
        // Regra 1, não segundo mecanismo). Erro explícito; nunca converter
        // silenciosamente em estado válido. Não ajustar a matemática.
        return erro(
          "FATAL_10",
          "FATAL_10: inconsistência matemática interna " +
            "(distancia <= 0 com equity acima do limite de liquidação).",
        );
      }
    }

    var resultadoEquityPercentual =
      ((equityAtual - saldoCorretora) / saldoCorretora) * 100;

    // FATAL_10 (derivados).
    if (
      (distanciaLiquidacaoPercentual !== null &&
        !ehNumeroFinito(distanciaLiquidacaoPercentual)) ||
      !ehNumeroFinito(resultadoEquityPercentual) ||
      (precoLiquidacao !== null && !ehNumeroFinito(precoLiquidacao))
    ) {
      return erro("FATAL_10", "FATAL_10: resultado matemático não finito.");
    }

    return {
      sucesso: true,
      quantidadeAtivo: quantidadeAtivo,
      valorExposicao: valorExposicao,
      precoMedio: precoMedio,
      margemRetida: margemRetida,
      margemLivre: margemLivre,
      saldoInicial: saldoCorretora,
      fundingCustoAcumulado: fundingCustoAcumulado,
      pnlNaoRealizado: pnlNaoRealizado,
      equityAtual: equityAtual,
      equityLiquidacao: equityLiquidacao,
      precoLiquidacao: precoLiquidacao,
      distanciaLiquidacaoPercentual: distanciaLiquidacaoPercentual,
      resultadoEquityPercentual: resultadoEquityPercentual,
      estadoRisco: estadoRisco,
      lado: lado,
    };
  }

  return {
    calcularRisco: calcularRisco,
    RISK_THRESHOLDS: RISK_THRESHOLDS,
  };
});
