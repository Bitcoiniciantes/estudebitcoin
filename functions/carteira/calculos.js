/* Carteira — cálculos centrais (Fase 2, §9/§13).
 * ÚNICO lugar onde preço médio/posição é calculado para gravação.
 * Nunca duplicar no frontend (lá só existe estimativa de preview).
 */
'use strict';

function consolidarPosicao(posicaoExistente, aporte) {
  const qtdExistente = posicaoExistente.quantity;
  const qtdMovimento = aporte.quantity;
  const novaQuantidade = qtdExistente + qtdMovimento;

  if (novaQuantidade < 0) {
    throw new Error('Saldo insuficiente: a venda supera a quantidade em carteira.');
  }

  let novoAvgPrice;
  if (qtdMovimento > 0) {
    const custoExistente = qtdExistente * posicaoExistente.avgPrice;
    const custoNovo = qtdMovimento * aporte.purchasePrice;
    novoAvgPrice = (custoExistente + custoNovo) / novaQuantidade;
  } else {
    novoAvgPrice = novaQuantidade === 0 ? 0 : posicaoExistente.avgPrice;
  }

  return {
    quantity: novaQuantidade,
    avgPrice: novoAvgPrice,
    currentPrice: aporte.currentPrice,
    manualPrice: aporte.currentPrice,
    dailyChangePercent: aporte.dailyChangePercent,
  };
}

function reconstruirPosicaoDosLotes(lotes) {
  const quantity = lotes.reduce((soma, lote) => soma + lote.quantity, 0);
  const positivos = lotes.filter((lote) => lote.quantity > 0);
  const qtdPositiva = positivos.reduce((soma, lote) => soma + lote.quantity, 0);
  const custoPositivo = positivos.reduce(
    (soma, lote) => soma + lote.quantity * lote.price, 0);

  if (quantity < 0) {
    throw new Error('Remoção deixaria saldo negativo.');
  }

  return {
    quantity,
    avgPrice: qtdPositiva > 0 ? custoPositivo / qtdPositiva : 0,
    closed: quantity === 0,
  };
}

module.exports = { consolidarPosicao, reconstruirPosicaoDosLotes };
