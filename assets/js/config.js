/* =====================================================================
   Configuração central — endpoints, chaves e constantes
   ===================================================================== */
window.BI_CONFIG = {
  // Formulário de contato (Formspree)
  formspreeId: 'xaqvwpak',
  contactEmail: 'bitcoiniciantes@proton.me',

  // APIs públicas
  api: {
    binanceKlines: 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=24',
    binanceWs: 'wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/btcbrl@ticker/usdtbrl@ticker',
    binanceKlinesBase: 'https://api.binance.com/api/v3/klines',
    binanceTicker24h: 'https://api.binance.com/api/v3/ticker/24hr',
    mempoolFees: 'https://mempool.space/api/v1/fees/recommended',
    mempoolBlocks: 'https://mempool.space/api/v1/fees/mempool-blocks',
    mempoolPrices: 'https://mempool.space/api/v1/prices',
    fearGreed: 'https://api.alternative.me/fng/?limit=31&format=json',
    coingeckoSimple: 'https://api.coingecko.com/api/v3/simple/price',
    coingeckoMarketChart: 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart',
    mstrYahoo: 'https://query1.finance.yahoo.com/v8/finance/chart/MSTR?region=US&lang=en-US&interval=1m&range=1d',
    strategyMstr: 'https://api.strategy.com/btc/mstrKpiData',
    strategyBtc: 'https://api.strategy.com/btc/bitcoinKpis',
    strategyTimeSeries: 'https://api.strategy.com/btc/timeSeries',
    // AwesomeAPI (BR) — câmbio USD/BRL histórico, CORS nativo (sem proxy), sem chave.
    // Máximo 360 registros por requisição, por isso buscamos em blocos anuais.
    awesomeApiDaily: 'https://economia.awesomeapi.com.br/json/daily/USD-BRL/360',
    corsProxy: 'https://api.allorigins.win/get?url='
  },

  // Firebase (Mural de Sentimentos)
  firebase: {
    apiKey: 'AIzaSyDssItjo_Ctfdlnqrf2KD5QmvH21h-sS3Y',
    authDomain: 'mural-bitcoiniciantes.firebaseapp.com',
    databaseURL: 'https://mural-bitcoiniciantes-default-rtdb.firebaseio.com',
    projectId: 'mural-bitcoiniciantes',
    storageBucket: 'mural-bitcoiniciantes.firebasestorage.app',
    messagingSenderId: '725960603784',
    appId: '1:725960603784:web:00b9a802e76afd593c873d'
  },

  // Dados versionados junto com o site. Os widgets sempre usam estes
  // arquivos locais, garantindo que a interface reflita o conteúdo de /dados.
  data: {
    dcaHistory: 'dados/historico_dca.json',
    dcaHistoryScript: 'dados/historico_dca-data.js',
    etfHistory: 'dados/historico_etf.json',
    etfHistoryScript: 'dados/historico_etf-data.js',
    costBasis: 'dados/costbasis.json',
    costBasisScript: 'dados/costbasis-data.js',
    nupl: 'dados/nupl.json',
    nuplScript: 'dados/nupl-data.js',
    strategyPurchases: 'dados/strategy.json',
    strategyPurchasesScript: 'dados/strategy-data.js'
  },

  // CDNs carregados sob demanda
  cdn: {
    chartjs: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js',
    firebaseApp: 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
    firebaseDb: 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js'
  }
};
