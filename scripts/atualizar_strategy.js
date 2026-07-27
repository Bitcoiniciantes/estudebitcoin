const fs = require('fs');
const path = require('path');

const SOURCE_URL = 'https://www.strategy.com/ledger';

function mnavValido(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function mesclarHistoricoMnav(anterior, novo) {
  const porData = new Map();
  for (const item of anterior || []) {
    const data = String(item?.date || '').slice(0, 10);
    if (data) porData.set(data, { ...item });
  }
  for (const item of novo || []) {
    const data = String(item?.date || '').slice(0, 10);
    if (!data) continue;
    const existente = porData.get(data);
    if (mnavValido(item.mNav)) {
      porData.set(data, { ...(existente || {}), ...item, mNav: Number(item.mNav) });
    } else if (!existente) {
      porData.set(data, { ...item });
    }
  }
  return Array.from(porData.values()).sort((a, b) =>
    String(b.date).localeCompare(String(a.date))
  );
}

async function atualizarStrategy() {
  const resposta = await fetch(SOURCE_URL, {
    headers: {
      'User-Agent': 'BitcoinIniciantes-Strategy-Tracker/1.0',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });

  if (!resposta.ok) throw new Error(`Strategy respondeu HTTP ${resposta.status}`);

  const html = await resposta.text();
  const inicioScript = html.indexOf('<script id="__NEXT_DATA__"');
  const inicioJson = html.indexOf('>', inicioScript) + 1;
  const fimJson = html.indexOf('</script>', inicioJson);

  if (inicioScript < 0 || inicioJson <= 0 || fimJson < 0) {
    throw new Error('Não foi possível localizar __NEXT_DATA__ na página da Strategy.');
  }

  const nextData = JSON.parse(html.slice(inicioJson, fimJson));
  const dadosOriginais = nextData?.props?.pageProps?.bitcoinData;
  if (!Array.isArray(dadosOriginais) || dadosOriginais.length === 0) {
    throw new Error('Histórico de compras não encontrado na resposta da Strategy.');
  }

  const compras = dadosOriginais.map((item) => ({
    data: item.date_of_purchase,
    quantidadeBtc: Number(item.count),
    venda: Boolean(item.sale) || Number(item.count) < 0,
    precoOperacaoUsd: Number(item.purchase_price),
    valorOperacaoUsd: Number(item.total_purchase_price),
    btcAcumulado: Number(item.btc_holdings),
    precoMedioAcumuladoUsd: Number(item.average_price),
    custoTotalAcumuladoUsd: Number(item.total_acquisition_cost) * 1000000,
    acoesBasicas: Number(item.basic_shares_outstanding),
    acoesDiluidas: Number(item.assumed_diluted_shares_outstanding),
    valorReservaNaDataUsd: Number(item.btc_nav) * 1000000,
    documentoSec: item.sec?.url || null
  })).filter((item) => item.data && Number.isFinite(item.btcAcumulado))
    .sort((a, b) => a.data.localeCompare(b.data));

  const hoje = new Date().toISOString().slice(0, 10);
  const [mstrResposta, btcResposta, historicoResposta] = await Promise.all([
    fetch('https://api.strategy.com/btc/mstrKpiData'),
    fetch('https://api.strategy.com/btc/bitcoinKpis'),
    fetch('https://api.strategy.com/btc/timeSeries?from=2024-12-01&to=' + hoje + '&tickers=MSTR&metrics=mNav')
  ]);
  if (!mstrResposta.ok || !btcResposta.ok || !historicoResposta.ok) {
    throw new Error('Não foi possível atualizar os indicadores oficiais da Strategy.');
  }
  const mstrDados = await mstrResposta.json();
  const btcDados = await btcResposta.json();
  const historicoDados = await historicoResposta.json();

  const arquivo = path.join(__dirname, '../dados/strategy.json');
  let historicoAnterior = [];
  try {
    const anterior = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    historicoAnterior = Array.isArray(anterior.mnavHistorico) ? anterior.mnavHistorico : [];
  } catch {}

  const historicoNovo = historicoDados?.[0]?.values || [];
  const historicoPreservado = mesclarHistoricoMnav(historicoAnterior, historicoNovo);
  const saida = {
    fonte: SOURCE_URL,
    atualizadoEm: new Date().toISOString(),
    primeiraData: compras[0]?.data || null,
    ultimaData: compras[compras.length - 1]?.data || null,
    snapshot: {
      mstr: Array.isArray(mstrDados) ? mstrDados[0] : mstrDados,
      bitcoin: btcDados?.results || null,
      timestamp: btcDados?.timestamp || mstrDados?.[0]?.timeStampUtc || null
    },
    mnavHistorico: historicoPreservado,
    compras
  };

  const json = JSON.stringify(saida, null, 2);
  const arquivoScript = path.join(__dirname, '../dados/strategy-data.js');
  fs.writeFileSync(arquivo, json + '\n', 'utf8');
  fs.writeFileSync(arquivoScript, 'window.BI_STRATEGY_DATA = ' + json + ';\n', 'utf8');
  const mnavValidos = historicoPreservado.filter((item) => mnavValido(item.mNav)).length;
  console.log(
    `Strategy atualizada: ${compras.length} movimentacoes, ` +
    `${mnavValidos} pontos mNAV preservados ate ${saida.ultimaData}.`
  );
}

atualizarStrategy().catch((erro) => {
  console.error('Erro:', erro);
  process.exit(1);
});