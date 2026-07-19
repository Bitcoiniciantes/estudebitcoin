/* =====================================================================
   WIDGET: Spot Bitcoin ETF (SoSoValue)
   O histórico é acumulado dia a dia por um GitHub Action e salvo em
   dados/historico_etf.json (ver scripts/atualizar_etf.js). O widget só
   lê esse arquivo — não chama mais a API da SoSoValue no navegador.
   ===================================================================== */
window.BIWidgets = window.BIWidgets || {};

window.BIWidgets.etfWidget = async function () {
    const container = document.getElementById('widget-etf-sosovalue');
    if (!container) return;

    container.innerHTML = `
        <div class="btc-ultra-card etf-widget">
            <div class="etf-header">
                <h3 class="etf-title">Histórico ETF BTC (EUA)</h3>
                <div class="etf-stats-inline">
                    <span class="etf-stat-chip">
                        <span class="etf-stat-chip-label">Ativos Totais</span>
                        <span class="etf-stat-chip-val" id="etf-assets">A carregar...</span>
                    </span>
                    <span class="etf-stat-chip">
                        <span class="etf-stat-chip-label">Fluxo (último dia)</span>
                        <span class="etf-stat-chip-val" id="etf-fluxo-ultimo">A carregar...</span>
                    </span>
                </div>
                <div class="etf-filtros">
                    <button type="button" class="btn-periodo ativo" data-periodo="diario">Diariamente</button>
                    <button type="button" class="btn-periodo" data-periodo="semanal">Semanalmente</button>
                    <button type="button" class="btn-periodo" data-periodo="mensal">Mensal</button>
                </div>
            </div>

            <div class="etf-canvas-container">
                <canvas id="canvas-etf-oficial"></canvas>
            </div>
        </div>
    `;

    var DIAS_DIARIO = 30;
    var SEMANAS_SEMANAL = 12;
    var MESES_MENSAL = 12;

    var historico = [];      // histórico completo do ETF, ordem cronológica (mais antigo -> mais recente)
    var precosPorData = new Map(); // "AAAA-MM-DD" -> preço BTC/USD (vem do historico_dca.json)
    var periodoAtual = 'diario';

    container.querySelectorAll('.btn-periodo').forEach(function (btn) {
        btn.addEventListener('click', function () {
            if (btn.classList.contains('ativo')) return;
            container.querySelectorAll('.btn-periodo').forEach(function (b) { b.classList.remove('ativo'); });
            btn.classList.add('ativo');
            periodoAtual = btn.dataset.periodo;
            if (historico.length) {
                renderizarGrafico(dadosDoPeriodo(historico, periodoAtual));
            }
        });
    });

    if (typeof Chart === 'undefined') {
        const script = document.createElement('script');
        script.src = window.BI_CONFIG.cdn.chartjs;
        script.onload = carregarHistorico;
        document.head.appendChild(script);
    } else {
        carregarHistorico();
    }

    // Os históricos publicados com o site são a fonte única dos widgets.
    async function buscarJson(caminhoLocal, caminhoScript, nomeGlobal) {
        if (location.protocol !== 'file:') {
            try {
                var resposta = await fetch(caminhoLocal);
                if (resposta.ok) return await resposta.json();
            } catch (e) {}
        }
        if (caminhoScript && nomeGlobal) {
            try {
                await BI.loadScript(caminhoScript);
                return window[nomeGlobal] || null;
            } catch (e) {}
        }
        return null;
    }

    async function carregarHistorico() {
        var etfJson = await buscarJson(window.BI_CONFIG.data.etfHistory, window.BI_CONFIG.data.etfHistoryScript, 'BI_ETF_HISTORY');

        if (!etfJson) {
            console.error('[ETF] histórico não encontrado em nenhuma das fontes.');
            document.getElementById('etf-assets').innerText = 'Erro';
            document.getElementById('etf-fluxo-ultimo').innerText = 'Erro';
            return;
        }

        etfJson.sort(function (a, b) { return a.data < b.data ? -1 : (a.data > b.data ? 1 : 0); });
        historico = etfJson;
        atualizarStats(historico);

        // Preço do BTC é "best effort": se não carregar, o gráfico funciona igual, só sem a linha
        var dcaJson = await buscarJson(window.BI_CONFIG.data.dcaHistory, window.BI_CONFIG.data.dcaHistoryScript, 'BI_DCA_HISTORY');
        if (Array.isArray(dcaJson)) {
            dcaJson.forEach(function (item) {
                if (item.data && typeof item.precoBtcUsd === 'number') {
                    precosPorData.set(item.data, item.precoBtcUsd);
                }
            });
        }

        renderizarGrafico(dadosDoPeriodo(historico, periodoAtual));
    }

    // Sempre reflete o dia mais recente do histórico completo, independente do período escolhido no gráfico
    function atualizarStats(dados) {
        var ultimo = dados[dados.length - 1];
        var ultimoFluxo = ultimo.fluxoLiquidoUsd / 1000000;
        var ultimosAssets = ultimo.ativosTotaisUsd;

        var fluxoEl = document.getElementById('etf-fluxo-ultimo');
        var seta = ultimoFluxo >= 0 ? '↑' : '↓';
        fluxoEl.innerText = `${seta} ${ultimoFluxo >= 0 ? '+' : ''}${ultimoFluxo.toFixed(1)}M`;
        fluxoEl.className = `etf-stat-chip-val ${ultimoFluxo >= 0 ? 'halv__green' : 'halv__red'}`;
        document.getElementById('etf-assets').innerText = `$${(ultimosAssets / 1000000000).toFixed(2)}B`;
    }

    // Recorta o histórico completo conforme o período escolhido:
    // diário = últimos 30 dias | semanal = últimas 12 semanas | mensal = últimos 12 meses
    function dadosDoPeriodo(dados, periodo) {
        if (periodo === 'diario') {
            var diario = dados.slice(-DIAS_DIARIO);
            return {
                datas: diario.map(function (i) { return formatarRotuloDiaMes(i.data); }),
                fluxos: diario.map(function (i) { return i.fluxoLiquidoUsd / 1000000; }),
                precos: diario.map(function (i) { return buscarPreco(i.data); })
            };
        }

        var agrupado = agregarPorPeriodo(dados, periodo);
        var limite = periodo === 'semanal' ? SEMANAS_SEMANAL : MESES_MENSAL;
        var datas = agrupado.datas.slice(-limite);
        var fluxos = agrupado.fluxos.slice(-limite);
        var ultimasDatas = agrupado.ultimasDatas.slice(-limite);
        return {
            datas: datas.map(periodo === 'mensal' ? formatarRotuloMes : formatarRotuloDiaMes),
            fluxos: fluxos,
            precos: ultimasDatas.map(function (d) { return buscarPreco(d); })
        };
    }

    // "2026-06-10" -> "10/06"
    function formatarRotuloDiaMes(dataStr) {
        var partes = dataStr.split('-');
        return partes[2] + '/' + partes[1];
    }

    var MESES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

    // "2026-07" -> "Jul/26"
    function formatarRotuloMes(dataStr) {
        var partes = dataStr.split('-');
        return MESES_ABREV[parseInt(partes[1], 10) - 1] + '/' + partes[0].slice(2);
    }

    // Busca o preço na data exata; se não achar (ex: feriado/final de semana sem candle),
    // procura até 5 dias pra trás como aproximação
    function buscarPreco(dataStr) {
        var d = new Date(dataStr + 'T00:00:00Z');
        for (var tentativa = 0; tentativa < 5; tentativa++) {
            var chave = d.toISOString().slice(0, 10);
            if (precosPorData.has(chave)) return precosPorData.get(chave);
            d.setUTCDate(d.getUTCDate() - 1);
        }
        return null;
    }

    // Agrupa os registros diários em semanas (seg-dom) ou meses, somando o fluxo líquido de cada grupo
    // e guardando a última data real de cada grupo (usada para buscar o preço do BTC nesse ponto)
    function agregarPorPeriodo(dados, periodo) {
        var grupos = new Map();

        dados.forEach(function (item) {
            var chave = periodo === 'semanal' ? chaveDaSemana(item.data) : item.data.slice(0, 7); // YYYY-MM
            if (!grupos.has(chave)) grupos.set(chave, { rotulo: chave, fluxo: 0, ultimaData: item.data });
            var g = grupos.get(chave);
            g.fluxo += item.fluxoLiquidoUsd;
            if (item.data > g.ultimaData) g.ultimaData = item.data;
        });

        var lista = Array.from(grupos.values());
        return {
            datas: lista.map(function (g) { return g.rotulo; }),
            fluxos: lista.map(function (g) { return g.fluxo / 1000000; }),
            ultimasDatas: lista.map(function (g) { return g.ultimaData; })
        };
    }

    // Retorna a segunda-feira (ISO) da semana correspondente à data, como rótulo "AAAA-MM-DD"
    function chaveDaSemana(dataStr) {
        var d = new Date(dataStr + 'T00:00:00Z');
        var diaSemana = d.getUTCDay(); // 0=dom ... 6=sáb
        var diffParaSegunda = (diaSemana === 0 ? -6 : 1 - diaSemana);
        d.setUTCDate(d.getUTCDate() + diffParaSegunda);
        return d.toISOString().slice(0, 10);
    }

    function renderizarGrafico(dados) {
        if (!dados.fluxos.length) return;

        const ctx = document.getElementById('canvas-etf-oficial').getContext('2d');

        if (window.graficoInstancia) window.graficoInstancia.destroy();

        var temPreco = dados.precos.some(function (p) { return p !== null; });

        var datasets = [{
            type: 'bar',
            label: 'Fluxo Líquido (M$)',
            data: dados.fluxos,
            backgroundColor: dados.fluxos.map(function (v) { return v >= 0 ? '#4ade80' : '#ff4d6d'; }),
            borderRadius: 4,
            yAxisID: 'y',
            order: 2
        }];

        if (temPreco) {
            datasets.push({
                type: 'line',
                label: 'Preço BTC (US$)',
                data: dados.precos,
                borderColor: '#ff9f1a',
                backgroundColor: '#ff9f1a',
                borderWidth: 2,
                pointRadius: 0,
                pointHitRadius: 8,
                tension: 0.25,
                spanGaps: true,
                yAxisID: 'y1',
                order: 1
            });
        }

        var scales = {
            x: { grid: { display: false }, ticks: { color: '#ccc', maxRotation: 0 } },
            y: {
                position: 'left',
                grid: {
                    color: function (ctx) { return ctx.tick.value === 0 ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.05)'; },
                    lineWidth: function (ctx) { return ctx.tick.value === 0 ? 1.5 : 1; }
                },
                ticks: { color: '#ccc' }
            }
        };

        if (temPreco) {
            // Aproxima a escala da faixa real de preços do período, em vez de sempre começar em $0,
            // pra deixar a variação da linha mais visível.
            var precosValidos = dados.precos.filter(function (p) { return p !== null; });
            var minPreco = Math.min.apply(null, precosValidos);
            var maxPreco = Math.max.apply(null, precosValidos);
            var margem = Math.max((maxPreco - minPreco) * 0.2, maxPreco * 0.03);

            scales.y1 = {
                position: 'right',
                min: Math.max(0, Math.floor((minPreco - margem) / 1000) * 1000),
                max: Math.ceil((maxPreco + margem) / 1000) * 1000,
                grid: { display: false },
                ticks: {
                    color: '#ff9f1a',
                    callback: function (v) { return '$' + Number(v).toLocaleString('pt-BR'); }
                }
            };
        }

        window.graficoInstancia = new Chart(ctx, {
            type: 'bar',
            data: { labels: dados.datas, datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: scales,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: {
                        display: true,
                        labels: {
                            color: '#ccc',
                            usePointStyle: true,
                            boxWidth: 8,
                            padding: 16,
                            generateLabels: function () {
                                var itens = [
                                    { text: ' Fluxo Positivo', fillStyle: '#4ade80', strokeStyle: '#4ade80', fontColor: '#4ade80', pointStyle: 'circle', datasetIndex: 0 },
                                    { text: ' Fluxo Negativo', fillStyle: '#ff4d6d', strokeStyle: '#ff4d6d', fontColor: '#ff4d6d', pointStyle: 'circle', datasetIndex: 0 }
                                ];
                                if (temPreco) {
                                    itens.push({ text: ' Preço BTC (US$)', fillStyle: '#ff9f1a', strokeStyle: '#ff9f1a', fontColor: '#ff9f1a', pointStyle: 'circle', datasetIndex: 1 });
                                }
                                return itens;
                            }
                        }
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        // O tooltip do preço só aparece na visão diária: nas visões semanal/mensal
                        // o "preço" mostrado é só o do último dia do grupo, então misturar no hover confundiria.
                        filter: function (item) {
                            if (item.dataset.yAxisID === 'y1') return periodoAtual === 'diario';
                            return true;
                        },
                        callbacks: {
                            title: function (items) {
                                return items.length ? 'Data: ' + items[0].label : '';
                            },
                            label: function (item) {
                                if (item.dataset.yAxisID === 'y1') {
                                    return 'Preço BTC: $' + Number(item.parsed.y).toLocaleString('pt-BR');
                                }
                                var v = item.parsed.y;
                                return 'Fluxo Líquido: ' + (v >= 0 ? '+' : '') + v.toFixed(1) + 'M';
                            }
                        }
                    }
                }
            }
        });
    }
};
