/**
 * Risk Engine determinístico de posições (modelo Quantfury do EstudeBitcoin).
 *
 * ============================================================================
 * DOCUMENTAÇÃO OBRIGATÓRIA (§35 da especificação)
 * ============================================================================
 *
 * 1. MOTOR LOCAL: biblioteca matemática pura executada no client-side. Não faz
 *    chamadas de rede, não usa `fetch`, WebSocket, timers, DOM, React, Vue,
 *    localStorage, APIs externas, banco de dados ou estado interno. O preço em
 *    tempo real (`precoAtual`) é fornecido pela camada externa de market data
 *    já existente no projeto (ex.: ticker-widget.js). Este motor NUNCA coleta
 *    preços; apenas recebe `precoAtual` como entrada.
 *
 * 2. MODELO QUANTFURY DO PROJETO: implementa exclusivamente o modelo de risco
 *    definido na especificação do projeto para simular a dinâmica de margem da
 *    Quantfury. NÃO utiliza fórmula da Binance, Bybit, OKX, tiers de manutenção
 *    de outras corretoras, ADL, liquidation fee de outras corretoras, nem regras
 *    de cross margin de outras exchanges. Nenhuma fórmula aqui é declarada como
 *    "fórmula oficial da Quantfury"; é o modelo matemático desta especificação.
 *
 * 3. MMR SOBRE O NOCIONAL: `EquityLiquidacao = V * mmr`, onde V é a exposição
 *    nocional total (Σ valor das ordens). NÃO se utiliza `margemRetida * mmr`.
 *    Escolha deliberada: a alavancagem determina a margem inicialmente retida,
 *    enquanto o MMR determina a equity mínima exigida em relação ao nocional.
 *
 * 4. MARGEM RETIDA NÃO É SUBTRAÍDA NOVAMENTE: a equity é
 *    `saldoCorretora + PnL - fundingCustoAcumulado`. A margem retida (M = V /
 *    alavancagem) é alocação de capital, não perda adicional.
 *
 * 5. FUNDING = CUSTO PAGO: `fundingCustoAcumulado` representa exclusivamente
 *    custo acumulado pago (>= 0). Ausente => 0. Nunca representa crédito
 *    recebido; não há interpretação implícita de sinal.
 *
 * 6. PLIQ <= 0: não é entrada inválida. Significa que, segundo o modelo, não
 *    existe preço positivo capaz de levar a equity ao limite de liquidação.
 *    Retorna `precoLiquidacao = null`, `distanciaLiquidacaoPercentual = null`
 *    e estado `LIQUIDACAO_INATINGIVEL`. Nunca retorna 0 nem usa Math.max.
 *
 * 7. PRECEDÊNCIA: `LIQUIDACAO` (EquityAtual <= EquityLiquidacao) tem precedência
 *    absoluta sobre `LIQUIDACAO_INATINGIVEL`.
 *
 * 8. EQUIVALÊNCIA MATEMÁTICA: neste modelo Equity(P) é linear e monotônica no
 *    preço; quando existe Pliq > 0, `EquityAtual <= EquityLiquidacao` e
 *    `distancia <= 0%` representam o MESMO cruzamento matemático, não dois
 *    mecanismos independentes. A condição de equity é a condição primária.
 *
  * 9. RESULTADO PERCENTUAL DA EQUITY (líquido — NÃO é o PnL):
  *    `resultadoEquityPercentual = (EquityAtual - saldo) / saldo * 100`.
  *    > 0 = ganho líquido da equity | = 0 = neutro | < 0 = perda líquida.
  *    NÃO é necessariamente igual ao PnL da posição: PnL > 0 com
  *    resultadoEquityPercentual < 0 é válido quando os custos acumulados
  *    (funding) superam o ganho da posição. Pode ainda ser negativo com a
  *    posição no lucro pelo mesmo motivo. A UI deve interpretar o sinal:
  *    "+12%" apresenta-se como ganho; NUNCA exibir "perda de -12%".
 *
 * 10. ALAVANCAGEM NÃO DESLOCA O PLIQ: fixados saldo, V, Q, Pmedio, funding e
 *     mmr, o preço de liquidação NÃO depende diretamente da alavancagem.
 *     Mudar a alavancagem altera margemRetida/margemLivre, nunca o Pliq.
 *     NÃO "corrigir" a fórmula para aproximar a liquidação com maior
 *     alavancagem sem alteração explícita da especificação.
 *
 * 11. SEM ARREDONDAMENTO: nenhum `toFixed()` ou arredondamento nos cálculos.
 *     Arredondamento pertence exclusivamente à UI.
 *
 * ============================================================================
 * CONTRATO
 * ============================================================================
 * - Função pura e determinística: mesmas entradas => exatamente mesma saída.
 * - Fail-fast: validações FATAL_01..FATAL_10 na ordem da especificação.
 * - Sem rede, sem estado, sem efeitos colaterais.
 */

export type Ordem = {
  moeda: string;
  preco: number;
  valor: number;
};

export type RiskInput = {
  moedaConta: string;
  saldoCorretora: number;
  alavancagem: number;
  ordens: Ordem[];
  precoAtual: number;
  fundingCustoAcumulado?: number;
  /**
   * Percentual em formato decimal (0.005 = 0,5%). Ausente => 0.
   */
  mmr?: number;
  lado: "LONG" | "SHORT";
};

export type ResultadoSucesso = {
  sucesso: true;
  quantidadeAtivo: number;
  valorExposicao: number;
  precoMedio: number;
  margemRetida: number;
  margemLivre: number;
  saldoInicial: number;
  fundingCustoAcumulado: number;
  pnlNaoRealizado: number;
  equityAtual: number;
  equityLiquidacao: number;
  precoLiquidacao: number | null;
  distanciaLiquidacaoPercentual: number | null;
  /**
   * Resultado líquido da equity em relação ao saldo inicial — NÃO é o PnL.
   * > 0 = ganho líquido | = 0 = neutro | < 0 = perda líquida.
   * PnL > 0 com este campo < 0 é válido (custos superando o ganho).
   * A UI deve interpretar o sinal ("+12%" = ganho, nunca "perda de -12%").
   */
  resultadoEquityPercentual: number;
  estadoRisco:
    | "SEGURO"
    | "ATENCAO"
    | "CRITICO"
    | "LIQUIDACAO"
    | "LIQUIDACAO_INATINGIVEL";
  lado: "LONG" | "SHORT";
};

export type ResultadoErro = {
  sucesso: false;
  codigoErro:
    | "FATAL_01"
    | "FATAL_02"
    | "FATAL_03"
    | "FATAL_04"
    | "FATAL_05"
    | "FATAL_06"
    | "FATAL_07"
    | "FATAL_08"
    | "FATAL_09"
    | "FATAL_10";
  mensagem: string;
};

export type ResultadoRisco = ResultadoSucesso | ResultadoErro;

/**
 * Thresholds fixos de classificação de risco (§26).
 */
export const RISK_THRESHOLDS = {
  ATENCAO_PERCENTUAL: 10,
  CRITICO_PERCENTUAL: 5,
} as const;

function erro(
  codigoErro: ResultadoErro["codigoErro"],
  mensagem: string,
): ResultadoErro {
  return { sucesso: false, codigoErro, mensagem };
}

function ehNumeroFinito(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Calcula a situação de risco da posição para os parâmetros e preço dados.
 *
 * Não prevê o mercado; responde apenas: "dados estes parâmetros e este preço
 * atual, qual é a situação de risco da posição?"
 */
export function calcularRisco(input: RiskInput): ResultadoRisco {
  // ---- Guarda de contrato (§38: dado necessário ausente => erro explícito).
  // A especificação não prevê código dedicado para `input` nulo/não-objeto
  // ou `lado` fora de LONG|SHORT; mapeados para FATAL_10 com mensagem
  // explícita, pois nenhum resultado finito/válido seria produzível.
  if (input === null || typeof input !== "object") {
    return erro("FATAL_10", "FATAL_10: input ausente ou inválido.");
  }
  const lado = (input as RiskInput).lado;
  if (lado !== "LONG" && lado !== "SHORT") {
    return erro("FATAL_10", "FATAL_10: lado deve ser LONG ou SHORT.");
  }

  const ordens = (input as RiskInput).ordens;

  // ---- FASE A (§6): FATAL_01 antes de FATAL_02; loop só se for array.
  if (Array.isArray(ordens)) {
    for (let i = 0; i < ordens.length; i++) {
      const o = ordens[i] as Ordem;
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

  // ---- FATAL_02: lista vazia (ou ausente/não-array => erro explícito).
  if (!Array.isArray(ordens) || ordens.length === 0) {
    return erro("FATAL_02", "FATAL_02: lista de ordens vazia.");
  }

  // ---- FATAL_03: moeda incompatível, sem conversão implícita.
  const moedaConta = (input as RiskInput).moedaConta;
  if (typeof moedaConta !== "string" || moedaConta.length === 0) {
    return erro("FATAL_03", "FATAL_03: moeda da conta ausente ou inválida.");
  }
  for (let i = 0; i < ordens.length; i++) {
    if ((ordens[i] as Ordem).moeda !== moedaConta) {
      return erro(
        "FATAL_03",
        "FATAL_03: ordem no índice " +
          i +
          " com moeda incompatível com a conta.",
      );
    }
  }

  // ---- FATAL_04: saldo inválido.
  const saldoCorretora = (input as RiskInput).saldoCorretora;
  if (!ehNumeroFinito(saldoCorretora) || saldoCorretora <= 0) {
    return erro("FATAL_04", "FATAL_04: saldo deve ser finito e > 0.");
  }

  // ---- FATAL_05: alavancagem inválida.
  const alavancagem = (input as RiskInput).alavancagem;
  if (!ehNumeroFinito(alavancagem) || alavancagem < 1) {
    return erro("FATAL_05", "FATAL_05: alavancagem deve ser finita e >= 1.");
  }

  // ---- FATAL_06: preço atual inválido.
  const precoAtual = (input as RiskInput).precoAtual;
  if (!ehNumeroFinito(precoAtual) || precoAtual <= 0) {
    return erro("FATAL_06", "FATAL_06: preco atual deve ser finito e > 0.");
  }

  // ---- FATAL_07: funding inválido (ausente => 0; só custo pago, >= 0).
  const fundingCustoAcumulado = (input as RiskInput).fundingCustoAcumulado ?? 0;
  if (
    !ehNumeroFinito(fundingCustoAcumulado) ||
    fundingCustoAcumulado < 0
  ) {
    return erro("FATAL_07", "FATAL_07: funding deve ser finito e >= 0.");
  }

  // ---- FATAL_08: MMR inválido (ausente => 0; 0 <= mmr < 1).
  const mmr = (input as RiskInput).mmr ?? 0;
  if (!ehNumeroFinito(mmr) || mmr < 0 || mmr >= 1) {
    return erro("FATAL_08", "FATAL_08: mmr deve ser finito e satisfazer 0 <= mmr < 1.");
  }

  // ---- Processamento das ordens (§15): média PONDERADA financeiramente.
  let q = 0;
  let v = 0;
  for (let i = 0; i < ordens.length; i++) {
    const o = ordens[i] as Ordem;
    q += o.valor / o.preco;
    v += o.valor;
  }
  const quantidadeAtivo = q;
  const valorExposicao = v;
  const precoMedio = valorExposicao / quantidadeAtivo;

  // ---- Margem retida (§16).
  const margemRetida = valorExposicao / alavancagem;

  // ---- FATAL_09: capacidade de abertura (Correção 1 — semântica B).
  // DECISÃO DOCUMENTADA: `fundingCustoAcumulado` é custo de uma posição JÁ
  // EXISTENTE que reduz a equity ao longo do tempo
  // (Equity = saldo + PnL - funding), NÃO exigência de capital prévio.
  // Evidência no projeto: a calculadora legada (calculadora-liquidacao-dca/)
  // valida abertura como `posição <= margemCorretora * alavancagemMaxima`,
  // sem nenhum campo de funding (o bundle não menciona funding nenhuma vez).
  // Logo, funding histórico NUNCA invalida retroativamente uma posição aqui;
  // se corroer a equity até o limite, o mecanismo correto é LIQUIDACAO
  // (Regra 1, condição de equity), não FATAL_09. FATAL_09 dispara SOMENTE
  // quando M > saldo (capacidade insuficiente para abrir a posição).
  // `margemLivre` continua reportada como saldo - M - funding e PODE ser
  // negativa em um resultado de sucesso: significa custos acumulados acima
  // do capital livre, absorvidos pela equity — não é erro de entrada.
  const margemLivre = saldoCorretora - margemRetida - fundingCustoAcumulado;
  if (margemRetida > saldoCorretora) {
    return erro("FATAL_09", "FATAL_09: margem retida superior ao saldo disponível.");
  }

  // ---- PnL (§18).
  const pnlNaoRealizado =
    lado === "LONG"
      ? (precoAtual - precoMedio) * quantidadeAtivo
      : (precoMedio - precoAtual) * quantidadeAtivo;

  // ---- Equity atual (§19): margem retida NÃO é subtraída novamente.
  const equityAtual = saldoCorretora + pnlNaoRealizado - fundingCustoAcumulado;

  // ---- Equity de liquidação (§20): MMR incide sobre o NOCIONAL.
  const equityLiquidacao = valorExposicao * mmr;

  // ---- Preço de liquidação (§21/§22).
  // INTENCIONAL (§29, Correção 4): esta fórmula NÃO usa `alavancagem`.
  // Fixados saldo, V, Q, Pmedio, funding e mmr, o Pliq é idêntico para
  // qualquer alavancagem; ela só dimensiona margemRetida/margemLivre
  // (capacidade de abertura). NÃO "corrigir" aproximando a liquidação com
  // maior alavancagem — isso quebraria o modelo. Mudança só com alteração
  // explícita da especificação.
  const termo =
    (equityLiquidacao - saldoCorretora + fundingCustoAcumulado) /
    quantidadeAtivo;
  const pliqBruto = lado === "LONG" ? precoMedio + termo : precoMedio - termo;

  // ---- FATAL_10 (núcleo): nenhum resultado numérico pode ser não finito.
  const nucleo: number[] = [
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
  for (let i = 0; i < nucleo.length; i++) {
    if (!ehNumeroFinito(nucleo[i])) {
      return erro("FATAL_10", "FATAL_10: resultado matemático não finito.");
    }
  }

  // ---- Classificação (§24: precedência absoluta da condição de equity).
  let estadoRisco: ResultadoSucesso["estadoRisco"];
  let precoLiquidacao: number | null;
  let distanciaLiquidacaoPercentual: number | null;

  if (equityAtual <= equityLiquidacao) {
    // Regra 1: posição já liquidada (inclui "nascer liquidada", §28).
    estadoRisco = "LIQUIDACAO";
    precoLiquidacao = pliqBruto > 0 ? pliqBruto : null;
    distanciaLiquidacaoPercentual =
      precoLiquidacao === null
        ? null
        : lado === "LONG"
          ? ((precoAtual - precoLiquidacao) / precoAtual) * 100
          : ((precoLiquidacao - precoAtual) / precoAtual) * 100;
  } else if (pliqBruto <= 0) {
    // Regra 2: sem preço positivo de liquidação (§23).
    estadoRisco = "LIQUIDACAO_INATINGIVEL";
    precoLiquidacao = null;
    distanciaLiquidacaoPercentual = null;
  } else {
    // Regra 3: classificação percentual (§25/§26).
    precoLiquidacao = pliqBruto;
    const distancia =
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
      // RAMO DEFENSIVO (Correção 3): com Pliq > 0 e EquityAtual >
      // EquityLiquidacao, `distancia <= 0` é matematicamente impossível —
      // seria o MESMO cruzamento já testado na Regra 1, não um segundo
      // mecanismo independente. Se este ramo for atingido, há inconsistência
      // matemática interna (ou poeira IEEE-754 exatamente sobre a fronteira
      // precoAtual == Pliq); retorna-se erro explícito em vez de converter
      // silenciosamente a inconsistência em estado válido. A matemática NÃO
      // deve ser ajustada para satisfazer este caso.
      return erro(
        "FATAL_10",
        "FATAL_10: inconsistência matemática interna " +
          "(distancia <= 0 com equity acima do limite de liquidação).",
      );
    }
  }

  // ---- Resultado percentual da equity (§27): > 0 ganho, < 0 perda.
  const resultadoEquityPercentual =
    ((equityAtual - saldoCorretora) / saldoCorretora) * 100;

  // ---- FATAL_10 (derivados).
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
    quantidadeAtivo,
    valorExposicao,
    precoMedio,
    margemRetida,
    margemLivre,
    saldoInicial: saldoCorretora,
    fundingCustoAcumulado,
    pnlNaoRealizado,
    equityAtual,
    equityLiquidacao,
    precoLiquidacao,
    distanciaLiquidacaoPercentual,
    resultadoEquityPercentual,
    estadoRisco,
    lado,
  };
}
