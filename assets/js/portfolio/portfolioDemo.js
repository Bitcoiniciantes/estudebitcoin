/* =====================================================================
   EstudeBitcoin — portfolioDemo (FASE 1)
   Dados de demonstração em USD, carregados SOMENTE se a carteira
   estiver vazia. Marcados com demo:true, fáceis de remover
   (botão "Limpar exemplos").
   ===================================================================== */
(function () {
  'use strict';

  // Valores em USD (FASE 1b). Somente se a carteira estiver vazia.
  // Seed padrão (2026-09-11): PRATA/COBRE/BRENT/URNM (cards do ticker) +
  // BTC/ETH/LINK/MSTR/AVAX. Qtd 1 em todos; médio = atual (neutro — o
  // preço ao vivo assume as linhas com dot verde em segundos).
  var DEMO_ASSETS = [
    { ticker: 'BTC', name: 'Bitcoin', type: 'CRYPTO', quantity: 1, averagePrice: 77900, currentPrice: 77900, dailyVariation: 0 },
    { ticker: 'ETH', name: 'Ethereum', type: 'CRYPTO', quantity: 1, averagePrice: 2580, currentPrice: 2580, dailyVariation: 0 },
    { ticker: 'LINK', name: 'Chainlink', type: 'CRYPTO', quantity: 1, averagePrice: 16, currentPrice: 16, dailyVariation: 0 },
    { ticker: 'AVAX', name: 'Avalanche', type: 'CRYPTO', quantity: 1, averagePrice: 22, currentPrice: 22, dailyVariation: 0 },
    { ticker: 'MSTR', name: 'Strategy', type: 'STOCK', quantity: 1, averagePrice: 133.5, currentPrice: 133.5, dailyVariation: 0 },
    { ticker: 'SI=F', name: 'PRATA', type: 'STOCK', quantity: 1, averagePrice: 64.97, currentPrice: 64.97, dailyVariation: 1.07 },
    { ticker: 'HG=F', name: 'COBRE', type: 'STOCK', quantity: 1, averagePrice: 6.55, currentPrice: 6.55, dailyVariation: 1.25 },
    { ticker: 'BZ=F', name: 'BRENT', type: 'STOCK', quantity: 1, averagePrice: 105.13, currentPrice: 105.13, dailyVariation: -2.32 },
    { ticker: 'URNM', name: 'URÂNIO ETF', type: 'STOCK', quantity: 1, averagePrice: 53.03, currentPrice: 53.03, dailyVariation: -2.93 }
  ];

  function seedIfEmpty(service) {
    var view = service.recalc();
    if (view.assets.length) return { seeded: false };
    for (var i = 0; i < DEMO_ASSETS.length; i++) {
      service.add(DEMO_ASSETS[i], { allowDuplicate: true, demo: true });
    }
    return { seeded: true, count: DEMO_ASSETS.length };
  }

  var api = { seedIfEmpty: seedIfEmpty, DEMO_ASSETS: DEMO_ASSETS };

  if (typeof module === 'object' && module.exports && typeof module.exports === 'object') {
    module.exports = api;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.PortfolioDemo = api;
  }
})();
