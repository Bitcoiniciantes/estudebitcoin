/* =====================================================================
   Widget: Simulador DCA em Bitcoin & Consulta Histórica
   ===================================================================== */
window.BIWidgets = window.BIWidgets || {};

window.BIWidgets.dca = function initDca() {
  'use strict';
  console.log("✅ [DCA] Widget iniciado com sucesso!");

  var CFG = window.BI_CONFIG || { api: { binanceTicker24h: 'https://api.binance.com/api/v3/ticker/24hr' } };
  var dcaChart = null;

  var historicoDiarioCache = null;
  var historicoDiarioPromise = null;
  
  // Variáveis para a paginação da Tabela de Histórico
  var dcaFullHistoryData = [];
  var dcaRenderLimit = 50;

  function $(id) { return document.getElementById(id); }

  // ==========================================================
  // Datas preenchidas conforme o "Type" do HTML
  // ==========================================================
  var now = new Date();
  var yyyy = now.getFullYear();
  var mm = String(now.getMonth() + 1).padStart(2, '0');
  var dd = String(now.getDate()).padStart(2, '0');

  // 1. O input do Simulador "Até" é type="text" (padrão Brasil: DD/MM/AAAA)
  var endInput = $('dca-end');
  if (endInput && !endInput.value) {
    endInput.value = dd + '/' + mm + '/' + yyyy;
    console.log("[DCA] Data Final Simulador preenchida: " + endInput.value);
  }

// 2. O input da Consulta Histórica é type="date" (fixado em 01/10/2014)
  var histInput = $('dca-hist-data');
  if (histInput && !histInput.value) {
    histInput.value = '2014-10-01'; // Formato YYYY-MM-DD exigido pelo input date
    console.log("[DCA] Data Consulta Histórica fixada em: 01/10/2014");
  }

  function showError(msg) {
    var errEl = $('dca-error');
    if (errEl) { errEl.textContent = '⚠️ ' + msg; errEl.style.display = 'block'; }
  }

  function hideError() {
    var errEl = $('dca-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  }

  function loadChartJS() {
    return new Promise(function(resolve, reject) {
      if (typeof Chart !== 'undefined') return resolve();
      console.log("[DCA] Baixando biblioteca de Gráficos (Chart.js)...");
      var script = document.createElement('script');
      script.src = CFG.cdn.chartjs;
      script.onload = function() { console.log("[DCA] Chart.js carregado!"); resolve(); };
      script.onerror = function() { reject(new Error("Falha ao carregar o Chart.js.")); };
      document.head.appendChild(script);
    });
  }

  function atualizarTelaTicker(usd, brl, varPercent) {
    var precoUsd = parseFloat(usd);
    var precoBrl = parseFloat(brl);
    var variacao = parseFloat(varPercent);

    if ($('dca-btc-price-usd')) $('dca-btc-price-usd').textContent = '$ ' + precoUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if ($('dca-btc-price')) $('dca-btc-price').textContent = 'R$ ' + precoBrl.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    var elVar = $('dca-btc-change');
    if (elVar) {
      elVar.textContent = (variacao >= 0 ? '+' : '') + variacao.toFixed(2) + '%';
      elVar.style.color = variacao >= 0 ? '#10B981' : '#EF4444';
    }
  }

  async function fetchBtcTicker() {
    try {
      const [resUsd, resBrl] = await Promise.all([
        fetch(CFG.api.binanceTicker24h + '?symbol=BTCUSDT'),
        fetch(CFG.api.binanceTicker24h + '?symbol=BTCBRL')
      ]);
      if (!resUsd.ok || !resBrl.ok) throw new Error("Binance bloqueada");
      const dataUsd = await resUsd.json();
      const dataBrl = await resBrl.json();
      atualizarTelaTicker(dataUsd.lastPrice, dataBrl.lastPrice, dataBrl.priceChangePercent);
    } catch (e) {
      try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,brl&include_24hr_change=true');
        const data = await res.json();
        atualizarTelaTicker(data.bitcoin.usd, data.bitcoin.brl, data.bitcoin.brl_24h_change);
      } catch (err) {
        console.error('[DCA] Ticker falhou em ambas as APIs.');
      }
    }
  }

  async function carregarHistoricoDiario() {
    if (historicoDiarioCache) return historicoDiarioCache;
    if (historicoDiarioPromise) return historicoDiarioPromise;

    let urls = [CFG.data.dcaHistory];

    historicoDiarioPromise = (async function() {
      for (let url of urls) {
        try {
          let response = await fetch(url);
          if (response.ok) {
            let json = await response.json();
            json.sort(function(a, b) { return a.data < b.data ? -1 : (a.data > b.data ? 1 : 0); });
            historicoDiarioCache = json;
            return json;
          }
        } catch (e) {}
      }
      throw new Error("O arquivo de histórico JSON não foi encontrado no servidor.");
    })();

    return historicoDiarioPromise;
  }

  function precoMaisProximo(historicoDiario, dataAlvoIso) {
    var alvo = new Date(dataAlvoIso + 'T00:00:00');
    var melhor = null;
    for (var i = 0; i < historicoDiario.length; i++) {
      var item = historicoDiario[i];
      var d = new Date(item.data + 'T00:00:00');
      if (d <= alvo) { melhor = item; } else { break; }
    }
    return melhor;
  }

  // Lógica de Renderização e Paginação da Tabela
  function renderHistoryTable() {
    var tbody = $('dca-history-tbody');
    var loadMoreContainer = $('dca-load-more-container');
    if (!tbody) return;

    var tableHTML = '';
    var itemsToRender = dcaFullHistoryData.slice(0, dcaRenderLimit);

    itemsToRender.forEach(function(row) {
      tableHTML += `
        <tr style="font-family: 'DM Mono', monospace; font-weight: 500;">
          <td style="padding: 12px 10px; border-bottom: 1px solid rgba(255,255,255,0.03); color: #fff;">${row.dataFormated}</td>
          <td style="padding: 12px 10px; border-bottom: 1px solid rgba(255,255,255,0.03); color: #fff;">R$ ${row.preco.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
          <td style="padding: 12px 10px; border-bottom: 1px solid rgba(255,255,255,0.03); color: #fff;">R$ ${row.aporte.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</td>
          <td style="padding: 12px 10px; border-bottom: 1px solid rgba(255,255,255,0.03); color: #fff;">${row.btcComprado.toFixed(8)}</td>
          <td style="padding: 12px 10px; border-bottom: 1px solid rgba(255,255,255,0.03); color: #fff;">${row.btcAcumulado.toFixed(8)}</td>
        </tr>
      `;
    });
    
    tbody.innerHTML = tableHTML;

    if (loadMoreContainer) {
      loadMoreContainer.style.display = (dcaFullHistoryData.length > dcaRenderLimit) ? 'block' : 'none';
    }
  }

  /* ================= SIMULADOR DCA ================= */
  async function simulateDca(e) {
    if (e) e.preventDefault();
    console.log("[DCA] Simulador acionado pelo botão.");

    var loading = $('dca-loading');
    var resultsBox = $('dca-results');
    var btn = $('dca-btn-simulate');

    try {
      if (btn) btn.disabled = true;
      if (loading) loading.style.display = 'flex';
      if (resultsBox) resultsBox.style.display = 'none';
      hideError();

      await loadChartJS();

      var amountInput = $('dca-monthly');
      var freqSelect = $('dca-frequencia');
      var rawStart = $('dca-start').value;
      var rawEnd = $('dca-end').value;
      
      var aporte = parseFloat(amountInput.value);
      var frequencia = freqSelect ? freqSelect.value : 'mensal';

      function parseDateBR(dateStr) {
        if (!dateStr) return new Date();
        var parts = dateStr.split('/');
        if (parts.length === 3) return new Date(parts[2], parts[1] - 1, parts[0]);
        if (dateStr.includes('-')) {
          var dParts = dateStr.split('-');
          return new Date(dParts[0], dParts[1] - 1, dParts[2] || 1);
        }
        return new Date();
      }

      var currentDate = parseDateBR(rawStart);
      var endDateObj = parseDateBR(rawEnd);

      if (currentDate > endDateObj) throw new Error("A data de início não pode ser maior que a data final.");

      var historicoDiario = await carregarHistoricoDiario();
      
      var totalInvested = 0;
      var totalBtc = 0;
      dcaFullHistoryData = []; // Zera o array global de histórico
      dcaRenderLimit = 50; // Reseta a paginação
      
      var labels = [];
      var dcaValues = [];
      var investedValues = [];
      var lastChartMonth = "";

      // Loop do motor de aportes
      while (currentDate <= endDateObj) {
        var isoDate = currentDate.getFullYear() + '-' + String(currentDate.getMonth() + 1).padStart(2, '0') + '-' + String(currentDate.getDate()).padStart(2, '0');
        
        var registro = precoMaisProximo(historicoDiario, isoDate);
        
        if (registro) {
          var precoBtc = registro.precoBtcBrl;
          var btcComprado = aporte / precoBtc;
          
          totalInvested += aporte;
          totalBtc += btcComprado;

          // Salva para a tabela (unshift coloca os mais recentes no topo)
          dcaFullHistoryData.unshift({
            dataFormated: String(currentDate.getDate()).padStart(2, '0') + '/' + String(currentDate.getMonth() + 1).padStart(2, '0') + '/' + currentDate.getFullYear(),
            preco: precoBtc,
            aporte: aporte,
            btcComprado: btcComprado,
            btcAcumulado: totalBtc
          });

          var mesAtual = isoDate.substring(0, 7);
          if (mesAtual !== lastChartMonth || frequencia === 'mensal') {
            labels.push(mesAtual.split('-').reverse().join('/'));
            dcaValues.push(totalBtc * precoBtc);
            investedValues.push(totalInvested);
            lastChartMonth = mesAtual;
          }
        }

        if (frequencia === 'diario') {
          currentDate.setDate(currentDate.getDate() + 1);
        } else if (frequencia === 'semanal') {
          currentDate.setDate(currentDate.getDate() + 7);
        } else {
          currentDate.setMonth(currentDate.getMonth() + 1);
        }
      }

      if (dcaFullHistoryData.length === 0) throw new Error("Não existem dados disponíveis para este período.");

      // Cálculos finais para o Grid
      var precoFinal = historicoDiario[historicoDiario.length - 1].precoBtcBrl;
      var finalBrlValue = totalBtc * precoFinal;
      var roi = ((finalBrlValue - totalInvested) / totalInvested) * 100;
      var precoMedio = totalInvested / totalBtc;
      var roiPrecoMedio = ((precoFinal - precoMedio) / precoMedio) * 100;

      // Renderiza os 6 cards
      var grid = $('dca-result-grid');
      if (grid) {
        grid.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:4px;">
            <span style="font-size:11px; color:#aaa;">Total Investido</span>
            <strong style="color:#fff; font-size:15px;">R$ ${totalInvested.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          </div>
          <div style="display:flex; flex-direction:column; gap:4px;">
            <span style="font-size:11px; color:#aaa;">BTC Acumulado</span>
            <strong style="color:#F7931A; font-size:15px;">${totalBtc.toFixed(8)}</strong>
          </div>
          <div style="display:flex; flex-direction:column; gap:4px;">
            <span style="font-size:11px; color:#aaa;">Valor Atual</span>
            <strong style="color:#fff; font-size:15px;">R$ ${finalBrlValue.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          </div>
          <div style="display:flex; flex-direction:column; gap:4px;">
            <span style="font-size:11px; color:#aaa;">Preço Médio</span>
            <strong style="color:#fff; font-size:15px;">R$ ${precoMedio.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          </div>
          <div style="display:flex; flex-direction:column; gap:4px;">
            <span style="font-size:11px; color:#aaa;">Retorno Total</span>
            <strong style="font-size:15px; color:${roi >= 0 ? '#10B981' : '#EF4444'};">${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%</strong>
          </div>
          <div style="display:flex; flex-direction:column; gap:4px;">
            <span style="font-size:11px; color:#aaa;">Média vs Atual</span>
            <strong style="font-size:15px; color:${roiPrecoMedio >= 0 ? '#10B981' : '#EF4444'};">${roiPrecoMedio >= 0 ? '+' : ''}${roiPrecoMedio.toFixed(2)}%</strong>
          </div>
        `;
      }

      // Renderiza a tabela inicial com limite
      renderHistoryTable();

      // Configura evento de Expandir/Recolher Tabela
      var toggleBtn = $('dca-history-toggle');
      var histContainer = $('dca-history-container');
      var histArrow = $('dca-history-arrow');
      if (toggleBtn && histContainer && histArrow) {
        toggleBtn.onclick = function() {
          if (histContainer.style.display === 'none') {
            histContainer.style.display = 'block';
            histArrow.innerHTML = '▴ Recolher';
          } else {
            histContainer.style.display = 'none';
            histArrow.innerHTML = '▾ Expandir';
          }
        };
      }

      // Gráfico
      var ctx = $('dca-mini-chart');
      if (ctx) {
        if (dcaChart) dcaChart.destroy();
        dcaChart = new Chart(ctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              { label: 'Valor Atual (R$)', data: dcaValues, borderColor: '#F7931A', borderWidth: 2, fill: true, backgroundColor: 'rgba(247,147,26,0.08)', tension: 0.3, pointRadius: 0 },
              { label: 'Investido (R$)', data: investedValues, borderColor: '#555', borderWidth: 1.5, borderDash: [4, 4], fill: false, tension: 0, pointRadius: 0 }
            ]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { 
              legend: { labels: { color: '#aaa', font: { size: 10 } } },
              tooltip: { callbacks: { label: function(context) { var valor = context.parsed.y; return context.dataset.label + ': R$ ' + valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } } }
            },
            scales: {
              x: { ticks: { maxTicksLimit: 5, font: { size: 9 }, color: '#666' }, grid: { display: false } },
              y: { ticks: { font: { size: 9 }, color: '#666', callback: function (v) { return 'R$ ' + v.toLocaleString('pt-BR'); } }, grid: { color: 'rgba(255,255,255,0.05)' } }
            }
          }
        });
      }

      if (resultsBox) resultsBox.style.display = 'block';

    } catch (e) {
      console.error("[DCA] Erro no simulador:", e);
      showError(e.message);
    } finally {
      if (loading) loading.style.display = 'none';
      if (btn) btn.disabled = false;
    }
  }

  /* ================= CONSULTA HISTÓRICA ================= */
  function showHistError(msg) {
    var errEl = $('dca-hist-error');
    if (errEl) { errEl.textContent = '⚠️ ' + msg; errEl.style.display = 'block'; }
  }

  function hideHistError() {
    var errEl = $('dca-hist-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  }

  function formatarBRL(v) {
    return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatarSats(sats) {
    var btc = sats / 100000000;
    return btc.toLocaleString('pt-BR', { maximumFractionDigits: 8 }) + ' BTC';
  }

  function formatarUSD(v) {
    return '$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  async function consultarHistorico(e) {
    if (e) e.preventDefault();
    console.log("[DCA] Consulta Histórica acionada.");

    var btn = $('dca-hist-btn-consultar');
    var resultsBox = $('dca-hist-results');
    var loading = $('dca-hist-loading');

    try {
      if (btn) btn.disabled = true;
      if (loading) loading.style.display = 'flex';
      if (resultsBox) resultsBox.style.display = 'none';
      hideHistError();

      var rawData = $('dca-hist-data').value;
      var valorDigitado = $('dca-hist-valor').value.replace(/\D/g, '');
      var valor = parseFloat(valorDigitado);

      if (!rawData) throw new Error("Escolha uma data.");
      if (!valor || valor <= 0) throw new Error("Digite um valor em reais válido.");

      var historicoDiario = await carregarHistoricoDiario();

      var registroData = precoMaisProximo(historicoDiario, rawData);
      var registroHoje = historicoDiario[historicoDiario.length - 1];

      if (!registroData) throw new Error("Não há dados para essa data.");

      var precoData = registroData.precoBtcBrl;
      var precoHoje = registroHoje.precoBtcBrl;

      // CÁLCULOS
      var satsCompraria = (valor / precoData) * 100000000;
      var satsHoje = (valor / precoHoje) * 100000000;
      var diferenca = ((satsCompraria - satsHoje) / satsHoje) * 100;
      
      // NOVO CÁLCULO: Valor em Reais Hoje
      var btcComprado = valor / precoData; 
      var valorAtualEmReais = btcComprado * precoHoje;

      var grid = $('dca-hist-result-grid');
      if (grid) {
        grid.innerHTML = `
          <div style="display:flex; flex-direction:column; gap:4px;">
            <span style="font-size:12px; color:#aaa;">Preço na data</span>
            <strong style="color:#fff; font-size:16px; white-space:nowrap;">
              <span style="color:#00ffae;">${formatarUSD(registroData.precoBtcUsd)}</span>
              <span style="color:#555; font-weight:400;"> &nbsp;/&nbsp; </span>${formatarBRL(precoData)}
            </strong>
          </div>
          
          <div style="display:flex; flex-direction:column; gap:4px;">
            <span style="font-size:12px; color:#aaa;">Compraria na data</span>
            <strong style="color:#F7931A; font-size:16px;">${formatarSats(satsCompraria)}</strong>
          </div>
          
          <div style="display:flex; flex-direction:column; gap:8px;">
            <div>
              <span style="font-size:12px; color:#aaa;">Compraria Hoje</span>
              <strong style="color:#10B981; font-size:16px; display:block;">${formatarSats(satsHoje)}</strong>
              <span style="font-size:13px; color:${diferenca >= 0 ? '#10B981' : '#EF4444'};">${diferenca >= 0 ? '+' : ''}${diferenca.toFixed(1)}% vs. essa data</span>
            </div>
            
            <div style="background: rgba(22, 199, 132, 0.1); padding: 8px; border-radius: 6px; border: 1px solid rgba(22, 199, 132, 0.2); margin-top: 2px;">
              <span style="font-size:11px; color:#ccc; display:block; margin-bottom:2px;">Seus R$ ${valor.toLocaleString('pt-BR')} valeriam hoje:</span>
              <strong style="color:#10B981; font-size:16px;">${formatarBRL(valorAtualEmReais)}</strong>
            </div>
          </div>
        `;
      }

      if (registroData.data !== rawData) {
        showHistError('Sem pregão em ' + rawData.split('-').reverse().join('/') + ', mostrando o dado mais próximo (' + registroData.data.split('-').reverse().join('/') + ').');
      }

      if (resultsBox) resultsBox.style.display = 'block';

    } catch (e) {
      showHistError(e.message);
    } finally {
      if (loading) loading.style.display = 'none';
      if (btn) btn.disabled = false;
    }
  }

  var slider = $('dca-monthly');
  var sliderVal = $('dca-val-monthly');
  if (slider && sliderVal) {
    slider.addEventListener('input', function() {
      sliderVal.textContent = parseFloat(this.value).toLocaleString('pt-BR');
    });
  }

  // Máscara de milhar para inputs de valor em texto (ex: 1000 -> 1.000)
  function mascararMilhar(el) {
    if (!el) return;
    function aplicar() {
      var raw = el.value.replace(/\D/g, '');
      el.value = raw ? parseInt(raw, 10).toLocaleString('pt-BR') : '';
    }
    aplicar();
    el.addEventListener('input', aplicar);
  }
  mascararMilhar($('dca-hist-valor'));

  // ====================================================================
  // FORÇANDO A CONEXÃO DIRETA DOS BOTÕES
  // ====================================================================
  var histBtn = document.getElementById('dca-hist-btn-consultar');
  if (histBtn) {
    histBtn.onclick = consultarHistorico;
    console.log("✅ [DCA] Botão Consulta Histórica conectado!");
  } else {
    console.error("❌ [DCA] Botão 'dca-hist-btn-consultar' não encontrado.");
  }

  var dcaBtn = document.getElementById('dca-btn-simulate');
  if (dcaBtn) {
    dcaBtn.onclick = simulateDca;
    console.log("✅ [DCA] Botão Simulador conectado!");
  }

  // Ação do Botão "Carregar Mais"
  var btnLoadMore = document.getElementById('dca-btn-load-more');
  if (btnLoadMore) {
    btnLoadMore.onclick = function() {
      dcaRenderLimit += 50;
      renderHistoryTable();
    };
  }

  fetchBtcTicker();
  setInterval(fetchBtcTicker, 60000);
};

function arrancarScript() {
  if (!document.getElementById('dca-btn-simulate') && !document.getElementById('dca-hist-btn-consultar')) {
    setTimeout(arrancarScript, 500);
    return;
  }
  window.BIWidgets.dca();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', arrancarScript);
} else {
  arrancarScript();
}
