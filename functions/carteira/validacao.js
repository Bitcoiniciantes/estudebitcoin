/* Carteira — validação de entrada (Fase 2, §10).
 * Obrigatória porque o Admin SDK ignora as Firestore Rules.
 */
'use strict';

const { normalizarTicker, normalizarTipo } = require('./normalizacao');

function validarEntradaAporte(data) {
  const erros = [];
  const ticker = normalizarTicker(data && data.ticker);
  const type = normalizarTipo(data && data.type);

  if (!ticker) erros.push('ticker inválido');
  if (typeof (data && data.name) !== 'string' || data.name.trim().length === 0) {
    erros.push('name inválido');
  }
  if (!type) erros.push('type inválido: use crypto ou stock');

  if (typeof (data && data.quantity) !== 'number' ||
      !Number.isFinite(data.quantity) ||
      data.quantity === 0) {
    erros.push('quantity deve ser um número finito diferente de zero ' +
      '(positivo = compra, negativo = venda)');
  }

  if (typeof (data && data.purchasePrice) !== 'number' ||
      !Number.isFinite(data.purchasePrice) ||
      data.purchasePrice < 0) {
    erros.push('purchasePrice deve ser um número finito maior ou igual a zero');
  }

  if (typeof (data && data.currentPrice) !== 'number' ||
      !Number.isFinite(data.currentPrice) ||
      data.currentPrice < 0) {
    erros.push('currentPrice deve ser um número finito maior ou igual a zero');
  }

  const dailyChangePercent = data && data.dailyChangePercent == null
    ? 0
    : Number(data.dailyChangePercent);
  if (!Number.isFinite(dailyChangePercent)) {
    erros.push('dailyChangePercent deve ser um número finito');
  }

  return { ticker, type, dailyChangePercent, erros };
}

module.exports = { validarEntradaAporte };
