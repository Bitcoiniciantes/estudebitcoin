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

export declare const RISK_THRESHOLDS: {
  readonly ATENCAO_PERCENTUAL: 10;
  readonly CRITICO_PERCENTUAL: 5;
};

export declare function calcularRisco(input: RiskInput): ResultadoRisco;
