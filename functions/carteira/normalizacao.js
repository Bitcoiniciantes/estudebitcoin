/* Carteira — normalização (Fase 2, §2.1/§2.2).
 * Usado pelas Cloud Functions. Frontend usa a mesma regra no preview. */
'use strict';

function normalizarTicker(ticker) {
  return String(ticker || '')
    .trim()
    .toUpperCase()
    .replace(/\//g, '-');
}

function normalizarTipo(type) {
  const valor = String(type || '').trim().toLowerCase();
  if (valor === 'crypto') return 'crypto';
  if (valor === 'stock') return 'stock';
  return null;
}

module.exports = { normalizarTicker, normalizarTipo };
