import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import calc from '../assets/js/portfolio/portfolioCalculator.js';
import serviceModule from '../assets/js/portfolio/portfolioService.js';

function makeService() {
  globalThis.PortfolioCalculator = calc;
  const state = {
    version: 1, portfolio: {}, assets: [
      { id: 'btc', ticker: 'BTC', type: 'CRYPTO', quantity: 1, averagePrice: 100, currentPrice: 150, dailyVariation: 3 },
      { id: 'nvda', ticker: 'NVDA', type: 'STOCK', quantity: 2, averagePrice: 100, currentPrice: 120, dailyVariation: -2 },
      { id: 'eth', ticker: 'ETH', type: 'CRYPTO', quantity: 1, averagePrice: 200, currentPrice: 150, dailyVariation: 1 },
      { id: 'amd', ticker: 'AMD', type: 'STOCK', quantity: 1, averagePrice: 100, currentPrice: 150, dailyVariation: 3 }
    ]
  };
  return serviceModule.createService({ load: () => state, save: () => ({ ok: true }) });
}

describe('ordenação da carteira', () => {
  it('ordena todos os critérios sobre indicadores calculados, com desempate por ticker', () => {
    const service = makeService();
    const expected = {
      value_desc: ['NVDA', 'AMD', 'BTC', 'ETH'],
      value_asc: ['AMD', 'BTC', 'ETH', 'NVDA'],
      profit_desc: ['AMD', 'BTC', 'NVDA', 'ETH'],
      profit_asc: ['ETH', 'NVDA', 'AMD', 'BTC'],
      rent_desc: ['AMD', 'BTC', 'NVDA', 'ETH'],
      day_desc: ['AMD', 'BTC', 'ETH', 'NVDA'],
      ticker_asc: ['AMD', 'BTC', 'ETH', 'NVDA'],
      alloc_desc: ['NVDA', 'AMD', 'BTC', 'ETH']
    };
    for (const [sort, tickers] of Object.entries(expected)) {
      assert.deepEqual(service.query({ sort }).assets.map((a) => a.ticker), tickers, sort);
    }
  });

  it('não muda o array de entrada e deixa valores indisponíveis no final', () => {
    const service = makeService();
    const rows = [
      { ticker: 'Z', calc: { profit: Number.NaN } },
      { ticker: 'B', calc: { profit: 10 } },
      { ticker: 'A', calc: { profit: 10 } }
    ];
    const sorted = service.sortAssets(rows, 'profit_desc');
    assert.deepEqual(sorted.map((a) => a.ticker), ['A', 'B', 'Z']);
    assert.deepEqual(rows.map((a) => a.ticker), ['Z', 'B', 'A']);
  });

  it('expõe a coluna e a direção da opção selecionada', () => {
    const service = makeService();
    assert.deepEqual(service.getSortMeta('profit_desc'), { column: 'profit', direction: 'descending' });
    assert.deepEqual(service.getSortMeta('ticker_asc'), { column: 'asset', direction: 'ascending' });
  });
});
