const fs = require('fs');
const path = require('path');

async function gerarHistorico() {
  try {
    // 1. Busca BTC em Dólar e Dólar em Real do Yahoo Finance (15 anos, granularidade diária)
    const resBtc = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/BTC-USD?interval=1d&range=15y');
    const btcJson = await resBtc.json();

    const resBrl = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/BRL=X?interval=1d&range=15y');
    const brlJson = await resBrl.json();

    const btcTimestamps = btcJson.chart.result[0].timestamp;
    const btcPrices = btcJson.chart.result[0].indicators.quote[0].close;

    const brlTimestamps = brlJson.chart.result[0].timestamp;
    const brlPrices = brlJson.chart.result[0].indicators.quote[0].close;

    // 2. Monta um mapa data -> cotação USD/BRL, para achar a cotação mais próxima de cada dia do BTC
    const brlPorData = new Map();
    for (let j = 0; j < brlTimestamps.length; j++) {
      if (brlPrices[j] == null) continue;
      const d = new Date(brlTimestamps[j] * 1000);
      const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
      brlPorData.set(key, brlPrices[j]);
    }

    let ultimaCotacaoBrl = 5.0; // fallback de segurança para o primeiro dia, caso falte dado
    let historicoDiario = [];

    // 3. Cruza os dados dia a dia
    for (let i = 0; i < btcTimestamps.length; i++) {
      const btcUsd = btcPrices[i];
      if (btcUsd == null) continue;

      const date = new Date(btcTimestamps[i] * 1000);
      const dataKey = date.toISOString().slice(0, 10); // YYYY-MM-DD

      if (brlPorData.has(dataKey)) {
        ultimaCotacaoBrl = brlPorData.get(dataKey);
      }
      // se não achar a cotação exata do dia (fim de semana/feriado no câmbio),
      // usa a última cotação USD/BRL conhecida

      historicoDiario.push({
        data: dataKey,
        precoBtcUsd: Number(btcUsd.toFixed(2)),
        cotacaoUsdBrl: Number(ultimaCotacaoBrl.toFixed(4)),
        precoBtcBrl: Number((btcUsd * ultimaCotacaoBrl).toFixed(2))
      });
    }

    // 4. Cria a pasta 'dados' se não existir e salva o JSON
    const dirPath = path.join(__dirname, '../dados');
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    const historicoJson = JSON.stringify(historicoDiario, null, 2);
    const filePath = path.join(dirPath, 'historico_dca.json');
    const scriptPath = path.join(dirPath, 'historico_dca-data.js');
    fs.writeFileSync(filePath, historicoJson + '\n', 'utf8');
    fs.writeFileSync(scriptPath, 'window.BI_DCA_HISTORY = ' + historicoJson + ';\n', 'utf8');

    console.log(`Histórico gerado com ${historicoDiario.length} dias, salvo em ${filePath}`);

  } catch (error) {
    console.error("Erro:", error);
    process.exit(1);
  }
}

gerarHistorico();
