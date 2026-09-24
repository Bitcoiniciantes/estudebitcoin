const fs = require('fs');
const path = require('path');

const URL_API = 'https://openapi.sosovalue.com/openapi/v1/etfs/summary-history?symbol=BTC&country_code=US&limit=31';
const TIMEOUT_MS = 30000;
const REGEX_DATA = /^\d{4}-\d{2}-\d{2}$/;

// Converte para número finito ou devolve null (null, '', undefined, texto e NaN viram null).
function paraNumero(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'string' && valor.trim() === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function horaAgora() {
  const agora = new Date();
  const utc = agora.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const sp = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) + ' (Brasília)';
  return { utc: utc, sp: sp };
}

function lerArquivo(caminho) {
  return fs.existsSync(caminho) ? fs.readFileSync(caminho, 'utf-8') : null;
}

async function atualizarHistoricoETF() {
  try {
    const apiKey = process.env.SOSOVALUE_API_KEY;
    if (!apiKey) {
      throw new Error('SOSOVALUE_API_KEY não foi definida (configure como Secret do repositório).');
    }

    const hora = horaAgora();
    console.log('Execução em: ' + hora.utc + ' | ' + hora.sp);

    // 1. Busca os últimos dias disponíveis na API da SoSoValue (limit=31).
    //    Cada execução traz só uma janela recente, então o histórico é acumulado
    //    em dados/historico_etf.json, que o workflow commita de volta no repositório
    //    (é isso que faz o histórico sobreviver entre execuções).
    let resposta;
    try {
      resposta = await fetch(URL_API, {
        method: 'GET',
        headers: {
          'x-soso-api-key': apiKey,
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error('Timeout: a API da SoSoValue não respondeu em ' + (TIMEOUT_MS / 1000) + 's.');
      }
      throw new Error('Falha de rede ao chamar a SoSoValue: ' + (err && err.message ? err.message : err));
    }

    if (!resposta.ok) {
      const motivos = {
        401: 'chave de API inválida ou ausente (401)',
        403: 'acesso negado (403), verifique permissões da chave',
        429: 'limite de requisições excedido (429)'
      };
      throw new Error('HTTP ' + resposta.status + (motivos[resposta.status] ? ' - ' + motivos[resposta.status] : ''));
    }

    const json = await resposta.json();

    if (json.code !== 0 || !Array.isArray(json.data)) {
      throw new Error(json.message || 'Resposta inesperada da API da SoSoValue');
    }

    // Validação: descarta registros com data inválida ou números ausentes/inválidos.
    // Atenção: Number(null) e Number('') dão 0 (não NaN), então esses casos são
    // tratados à parte em paraNumero() para não gravar zeros falsos.
    const novosRegistros = [];
    let descartados = 0;

    json.data.forEach(function (item) {
      const data = item && item.date;
      const fluxo = item ? paraNumero(item.total_net_inflow) : null;
      const ativos = item ? paraNumero(item.total_net_assets) : null;

      if (typeof data === 'string' && REGEX_DATA.test(data) && fluxo !== null && ativos !== null) {
        novosRegistros.push({ data: data, fluxoLiquidoUsd: fluxo, ativosTotaisUsd: ativos });
      } else {
        descartados++;
        console.warn('Registro descartado por dados inválidos: ' + JSON.stringify(item));
      }
    });

    if (descartados > 0) {
      console.warn('Atenção: ' + descartados + ' registro(s) da API foram descartados.');
    }

    if (novosRegistros.length === 0) {
      throw new Error('A API não trouxe nenhum registro válido (recebidos: ' + json.data.length + ').');
    }

    // 2. Carrega o histórico já acumulado (se existir)
    const dirPath = path.join(__dirname, '../dados');
    const filePath = path.join(dirPath, 'historico_etf.json');
    const scriptPath = path.join(dirPath, 'historico_etf-data.js');

    const conteudoJsonAtual = lerArquivo(filePath);
    const conteudoJsAtual = lerArquivo(scriptPath);

    let historicoAtual = [];
    if (conteudoJsonAtual) {
      historicoAtual = JSON.parse(conteudoJsonAtual);
    }

    // 3. Mescla por data: registros novos sobrescrevem dias já salvos
    //    (a API às vezes revisa os últimos dias); dias fora da janela da API
    //    são mantidos como já estavam.
    const porData = new Map();
    historicoAtual.forEach(function (r) { porData.set(r.data, r); });
    novosRegistros.forEach(function (r) { porData.set(r.data, r); });

    const historicoFinal = Array.from(porData.values())
      .sort(function (a, b) { return a.data < b.data ? -1 : (a.data > b.data ? 1 : 0); });

    // 4. Diagnóstico: última data da API x última data já salva
    const ultimaApi = novosRegistros
      .map(function (r) { return r.data; })
      .sort()
      .pop();
    const ultimaArquivo = historicoAtual.length
      ? historicoAtual.map(function (r) { return r.data; }).sort().pop()
      : null;

    console.log('Última data na API: ' + ultimaApi);
    console.log('Última data já salva: ' + (ultimaArquivo || '(arquivo vazio)'));

    // 5. Só grava se algo realmente mudou
    const historicoJson = JSON.stringify(historicoFinal, null, 2);
    const novoConteudoJson = historicoJson + '\n';
    const novoConteudoJs = 'window.BI_ETF_HISTORY = ' + historicoJson + ';\n';

    const mudouJson = novoConteudoJson !== conteudoJsonAtual;
    const mudouJs = novoConteudoJs !== conteudoJsAtual;
    const temDataNova = !ultimaArquivo || ultimaApi > ultimaArquivo;

    if (mudouJson || mudouJs) {
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
      if (mudouJson) fs.writeFileSync(filePath, novoConteudoJson, 'utf8');
      if (mudouJs) fs.writeFileSync(scriptPath, novoConteudoJs, 'utf8');
    }

    if (temDataNova) {
      console.log('NOVO DADO: ' + ultimaApi);
    } else if (mudouJson || mudouJs) {
      console.log('SEM DATA NOVA, mas valores de dias anteriores foram revisados pela API (última data: ' + ultimaArquivo + ')');
    } else {
      console.log('SEM DADO NOVO (última data: ' + ultimaArquivo + ')');
    }

    console.log('Total acumulado: ' + historicoFinal.length + ' dias (' + novosRegistros.length + ' vieram da API nesta execução).');

  } catch (error) {
    console.error('Erro: ' + (error && error.message ? error.message : error));
    process.exit(1);
  }
}

atualizarHistoricoETF();
