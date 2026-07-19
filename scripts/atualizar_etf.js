const fs = require('fs');
const path = require('path');

async function atualizarHistoricoETF() {
  try {
    const apiKey = process.env.SOSOVALUE_API_KEY;
    if (!apiKey) {
      throw new Error('SOSOVALUE_API_KEY não foi definida (configure como Secret do repositório).');
    }

    // 1. Busca os últimos dias disponíveis na API da SoSoValue.
    //    A própria API só permite consultar ~30 dias por vez (janela deslizante),
    //    por isso guardamos o histórico dia a dia neste arquivo, acumulando com o tempo.
    const url = 'https://openapi.sosovalue.com/openapi/v1/etfs/summary-history?symbol=BTC&country_code=US&limit=31';

    const resposta = await fetch(url, {
      method: 'GET',
      headers: {
        'x-soso-api-key': apiKey,
        'Accept': 'application/json'
      }
    });

    if (!resposta.ok) {
      throw new Error(`HTTP ${resposta.status}`);
    }

    const json = await resposta.json();

    if (json.code !== 0 || !Array.isArray(json.data)) {
      throw new Error(json.message || 'Resposta inesperada da API da SoSoValue');
    }

    const novosRegistros = json.data.map(function (item) {
      return {
        data: item.date,
        fluxoLiquidoUsd: Number(item.total_net_inflow),
        ativosTotaisUsd: Number(item.total_net_assets)
      };
    });

    // 2. Carrega o histórico já acumulado (se existir)
    const dirPath = path.join(__dirname, '../dados');
    const filePath = path.join(dirPath, 'historico_etf.json');

    let historicoAtual = [];
    if (fs.existsSync(filePath)) {
      historicoAtual = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }

    // 3. Mescla por data: os registros novos sobrescrevem os dias equivalentes já
    //    salvos (a API às vezes revisa os últimos dias), dias fora da janela atual
    //    da API são mantidos como já estavam salvos.
    const porData = new Map();
    historicoAtual.forEach(function (r) { porData.set(r.data, r); });
    novosRegistros.forEach(function (r) { porData.set(r.data, r); });

    const historicoFinal = Array.from(porData.values())
      .sort(function (a, b) { return a.data < b.data ? -1 : (a.data > b.data ? 1 : 0); });

    // 4. Salva
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    const historicoJson = JSON.stringify(historicoFinal, null, 2);
    const scriptPath = path.join(dirPath, 'historico_etf-data.js');
    fs.writeFileSync(filePath, historicoJson + '\n', 'utf8');
    fs.writeFileSync(scriptPath, 'window.BI_ETF_HISTORY = ' + historicoJson + ';\n', 'utf8');

    console.log(`Histórico do ETF atualizado: ${historicoFinal.length} dias acumulados no total (${novosRegistros.length} vieram da API nesta execução).`);

  } catch (error) {
    console.error('Erro:', error);
    process.exit(1);
  }
}

atualizarHistoricoETF();
