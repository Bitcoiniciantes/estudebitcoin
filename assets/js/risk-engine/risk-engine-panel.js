/**
 * Painel ao vivo do Risk Engine (apresentação e entrada localizada).
 *
 * Consome exclusivamente o Adapter → RiskEngine. NÃO recalcula nenhum campo
 * (§9): apenas apresenta `resultado.*`. Formatação (toFixed/toLocaleString)
 * vive aqui na UI — o motor continua sem arredondamento.
 *
 * Guarda anti-erro (§14): `buildViewModel` testa `resultado.sucesso` ANTES de
 * tocar qualquer campo de sucesso; em falha, a UI exibe código+mensagem e
 * nunca lê `precoLiquidacao` etc.
 */
(function (global, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    global.RiskEnginePanel = factory(global);
    if (global.document) {
      var boot = function () {
        try {
          global.RiskEnginePanel.bind();
        } catch (bootError) {
          /* painel opcional, nunca quebra a página */
        }
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
      } else {
        boot();
      }
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (host) {
  "use strict";

  /**
   * Mapeamento §9 (puro, testável em Node): ResultadoRisco → ViewModel.
   * Em falha: { ok:false, codigo, mensagem } — campos de sucesso intocados.
   */
  function buildViewModel(resultado) {
    if (!resultado || typeof resultado !== "object" || resultado.sucesso !== true) {
      return {
        ok: false,
        codigo:
          resultado && typeof resultado.codigoErro === "string"
            ? resultado.codigoErro
            : "SEM_RESULTADO",
        mensagem:
          resultado && typeof resultado.mensagem === "string"
            ? resultado.mensagem
            : "Sem resultado do Risk Engine.",
      };
    }
    return {
      ok: true,
      quantidadeAtivo: resultado.quantidadeAtivo,
      precoMedio: resultado.precoMedio,
      margemRetida: resultado.margemRetida,
      margemLivre: resultado.margemLivre,
      pnlNaoRealizado: resultado.pnlNaoRealizado,
      equityAtual: resultado.equityAtual,
      equityLiquidacao: resultado.equityLiquidacao,
      precoLiquidacao: resultado.precoLiquidacao,
      distanciaLiquidacaoPercentual: resultado.distanciaLiquidacaoPercentual,
      resultadoEquityPercentual: resultado.resultadoEquityPercentual,
      estadoRisco: resultado.estadoRisco,
      lado: resultado.lado,
    };
  }

  function parseMoeda(texto) {
    // Valida a string inteira: nunca transforma "100abc" em 100.
    // Com vírgula, usa pt-BR; grupos completos ("1.000") são milhares.
    // Um ponto fora desse padrão ("3000.12") é decimal.
    var s = String(texto == null ? "" : texto).trim();
    if (s.indexOf(",") !== -1) {
      if (!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+),\d+$/.test(s)) return null;
      s = s.replace(/\./g, "").replace(",", ".");
    } else if (/^[+-]?[1-9]\d{0,2}(?:\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, "");
    } else if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(s)) return null;
    var n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function parseDecimal(texto) {
    var s = String(texto == null ? "" : texto).trim();
    if (!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(s)) return null;
    var n = Number(s.replace(",", "."));
    return Number.isFinite(n) ? n : null;
  }

  function fmtMoedaInput(n) {
    // Preserva a precisão do Number, inclusive em preços muito pequenos.
    // Duas casas são apenas padding visual, nunca arredondamento do input.
    var text = n.toLocaleString("pt-BR", { maximumSignificantDigits: 21 });
    var parts = text.split(",");
    return parts.length === 1 ? text + ",00" : parts[1].length < 2 ? text + "0" : text;
  }

  function num(value, digits) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    return value.toLocaleString("pt-BR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtUsd(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    return "$ " + num(value, 2);
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  /** Classificação exclusivamente visual; não participa do motor financeiro. */
  function classifyLiquidationDistance(value, riskState) {
    if (riskState === "LIQUIDACAO") {
      return { key: "critical", label: "CRÍTICO" };
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { key: "unavailable", label: "INDISPONÍVEL" };
    }
    if (value > 30) return { key: "comfortable", label: "CONFORTÁVEL" };
    if (value > 20) return { key: "safe", label: "SEGURO" };
    if (value > 10) return { key: "attention", label: "ATENÇÃO" };
    if (value > 5) return { key: "elevated", label: "RISCO ELEVADO" };
    return { key: "critical", label: "CRÍTICO" };
  }

  function renderLiquidationDistance(value, riskState) {
    var el = document.getElementById("re-dist");
    if (!el) return;
    var visual = classifyLiquidationDistance(value, riskState);
    var displayed = typeof value === "number" && Number.isFinite(value)
      ? num(value, 2) + "%"
      : "—";
    el.textContent = displayed;
    el.setAttribute("data-distance", visual.key);
    el.setAttribute("data-distance-label", visual.label);
    el.setAttribute("aria-label", displayed + " — " + visual.label);
  }

  /* ---------- Status de persistência (feedback visual, sem botão) ----------
   * Texto reflete só o que é determinístico no painel: save local (retorno
   * de saveLocal) e eventos de push vindos do PanelSync. Nuvem nunca é
   * inferida de estado de autenticação. */
  function updateSaveStatus(texto) {
    var el = (typeof document !== 'undefined' && document.getElementById)
      ? document.getElementById('re-save-status') : null;
    if (el) el.textContent = texto;
  }

  function getTimeString() {
    try {
      return new Date().toLocaleTimeString('pt-BR', { hour12: false });
    } catch (e) {
      var d = new Date();
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }
  }

  /* ---------- Persistência (Etapa 1 local + Etapa 3 nuvem via PanelSync) ----------
   * - Anônimo: salva/restaura em localStorage (nunca perde no reload).
   * - Logado: PanelSync empurra para a nuvem (debounce interno) e aplica o
   *   pull via evento 'estudebitcoin:panel-pull'. Login continua opcional:
   *   sem window.PanelSync, o painel funciona exatamente como antes. */
  var RISK_PANEL = 'risk';

  /* ---------- Identidade do ativo (multi-ativo) ----------
   * Única leitura canonizada do #re-simbolo. Usada nos 4 pontos:
   * restore, change, boot e pull. Espelha normalizeSymbol (utils.js). */
  function getCurrentAssetId() {
    try {
      var el = (typeof document !== 'undefined' && document.getElementById)
        ? document.getElementById('re-simbolo') : null;
      var v = el && el.value ? String(el.value) : '';
      if (host && host.BI && host.BI.normalizeSymbol) {
        return host.BI.normalizeSymbol(v) || 'BTC';
      }
      return v.trim().toUpperCase().replace(/USDT$/, '') || 'BTC';
    } catch (e) { return 'BTC'; }
  }

  // Defaults espelhando os fallbacks de readParams(). Usados quando o novo
  // ativo não tem estado salvo — o form nunca herda valores do ativo anterior.
  function defaultRiskParams(asset) {
    return {
      simbolo: asset || 'BTC',
      moedaConta: 'USD',
      saldoCorretora: 3000,
      alavancagem: 5,
      ordens: [{ moeda: 'USD', preco: 52000, valor: 15000 }],
      fundingCustoAcumulado: 0,
      mmr: 0,
      lado: 'LONG'
    };
  }

  function finiteOr(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  function setSelect(id, value) {
    var el = document.getElementById(id);
    if (!el || value == null) return;
    var v = String(value);
    for (var i = 0; i < el.options.length; i++) {
      if (el.options[i].value === v || el.options[i].text === v) {
        el.value = el.options[i].value;
        return;
      }
    }
  }

  function setMoney(id, value) {
    var el = document.getElementById(id);
    if (!el) return;
    var n = finiteOr(value, null);
    if (n !== null) el.value = fmtMoedaInput(n);
  }

  function setNumber(id, value) {
    var el = document.getElementById(id);
    if (!el) return;
    var n = finiteOr(value, null);
    if (n !== null) el.value = String(n);
  }

  function applyRiskParams(p) {
    if (!p || typeof p !== 'object') return false;
    try {
      setSelect('re-simbolo', p.simbolo);
      setSelect('re-lado', p.lado);
      setMoney('re-saldo', p.saldoCorretora);
      setNumber('re-alavancagem', p.alavancagem);
      var ordem = p.ordens && p.ordens[0];
      if (ordem) {
        setMoney('re-preco-entrada', ordem.preco);
        setMoney('re-valor', ordem.valor);
      }
      setMoney('re-funding', p.fundingCustoAcumulado);
      setNumber('re-mmr', p.mmr);
      return true;
    } catch (e) { return false; }
  }

  /* Persiste sob o asset rastreado — NUNCA troca a identidade.
   * Durante a troca BTC→ETH, o select já mostra ETH mas os campos ainda são
   * de BTC: escrever sob o tracked (BTC) evita contaminar a chave de ETH. */
  function persistRiskParams(assetOverride) {
    try {
      var hasSync = !!(host.PanelSync && host.PanelSync.saveLocal);
      var params = readParams();
      // Uma edição incompleta não substitui a última configuração salva.
      if (![params.saldoCorretora, params.alavancagem, params.ordens[0].preco,
        params.ordens[0].valor, params.fundingCustoAcumulado, params.mmr].every(Number.isFinite)) {
        if (hasSync) updateSaveStatus("Edição incompleta — preencha os campos para salvar.");
        return;
      }
      if (hasSync) updateSaveStatus("Salvando...");
      var current = assetOverride
        || (host.PanelSync && host.PanelSync.getCurrentAsset && host.PanelSync.getCurrentAsset())
        || params.simbolo || 'BTC';
      current = String(current).toUpperCase();
      params.simbolo = current;
      if (hasSync) {
        if (host.PanelSync.saveLocal(RISK_PANEL, params, current)) {
          updateSaveStatus("Salvo neste navegador às " + getTimeString());
        } else {
          updateSaveStatus("Não foi possível salvar neste navegador");
        }
      }
    } catch (e) { /* persistência opcional: nunca quebra o painel */ }
  }

  // Segunda linha de defesa da migração (a primeira é migrateLegacyRisk() no
  // parse de auth.js): se a chave legada ainda existir, migra e remove.
  // Espelha migrateLegacyRisk(): legado sem simbolo cai em BTC, nunca é perdido.
  function restoreLegacyIfAvailable() {
    try {
      var store = (host && host.localStorage) ||
        (typeof localStorage !== 'undefined' ? localStorage : null);
      if (!store) return;
      var raw = store.getItem('eb_panel_risk');
      if (!raw) return;
      var obj = JSON.parse(raw);
      if (obj && obj.params && typeof obj.params === 'object') {
        var legacyAsset = getCurrentAssetId();
        try {
          if (host && host.BI && host.BI.normalizeSymbol) {
            legacyAsset = host.BI.normalizeSymbol(obj.params.simbolo) || 'BTC';
          } else {
            legacyAsset = String(obj.params.simbolo == null ? '' : obj.params.simbolo)
              .trim().toUpperCase().replace(/USDT$/, '') || 'BTC';
          }
        } catch (e) { legacyAsset = 'BTC'; }
        obj.params.simbolo = legacyAsset;
        if (host.PanelSync && host.PanelSync.setCurrentAsset) {
          host.PanelSync.setCurrentAsset(legacyAsset);
        }
        if (host.PanelSync && host.PanelSync.saveLocal) {
          host.PanelSync.saveLocal(RISK_PANEL, obj.params, legacyAsset);
        }
        applyRiskParams(obj.params);
      }
      try { store.removeItem('eb_panel_risk'); } catch (e) {}
    } catch (e) { /* legado é best-effort */ }
  }

  function restoreRiskParams() {
    try {
      updateSaveStatus("");
      // Boot: o último asset usado reposiciona o select antes de ler.
      var bootAsset = host.PanelSync && host.PanelSync.loadLastAsset
        ? host.PanelSync.loadLastAsset() : null;
      if (bootAsset) setSelect('re-simbolo', bootAsset);
      var currentSymbol = getCurrentAssetId();
      if (host.PanelSync && host.PanelSync.setCurrentAsset) {
        host.PanelSync.setCurrentAsset(currentSymbol);
      }
      restoreLegacyIfAvailable();
      // Reler: a função acima pode ter trocado DOM + identidade (legado de
      // outro ativo). Reusar a variável capturada antes carrega a chave errada
      // por cima do que acabou de ser migrado.
      currentSymbol = getCurrentAssetId();
      if (host.PanelSync && host.PanelSync.setCurrentAsset) {
        host.PanelSync.setCurrentAsset(currentSymbol);
      }
      if (host.PanelSync && host.PanelSync.loadLocal) {
        var saved = host.PanelSync.loadLocal(RISK_PANEL, currentSymbol);
        if (saved && saved.params) {
          applyRiskParams(saved.params);
          // Garante tracked == form após o apply (legado ou chave nova).
          if (host.PanelSync.setCurrentAsset) {
            host.PanelSync.setCurrentAsset(getCurrentAssetId());
          }
        }
      }
    } catch (e) { /* segue com os padrões */ }
  }

  function readParams() {
    function val(id, fallback) {
      var el = document.getElementById(id);
      if (!el) return fallback;
      // Defaults só para controles ausentes; edição vazia/inválida vai ao
      // motor como NaN, sem calcular com um valor diferente do exibido.
      var n = /^(re-saldo|re-preco-entrada|re-valor|re-funding)$/.test(id)
        ? parseMoeda(el.value)
        : parseDecimal(el.value);
      return n !== null ? n : NaN;
    }
    function str(id, fallback) {
      var el = document.getElementById(id);
      return el && el.value ? String(el.value) : fallback;
    }
    var precoEntrada = val("re-preco-entrada", 52000);
    var valor = val("re-valor", 15000);
    return {
      simbolo: str("re-simbolo", "BTC"),
      moedaConta: "USD",
      saldoCorretora: val("re-saldo", 3000),
      alavancagem: val("re-alavancagem", 5),
      ordens: [{ moeda: "USD", preco: precoEntrada, valor: valor }],
      fundingCustoAcumulado: val("re-funding", 0),
      mmr: val("re-mmr", 0),
      lado: str("re-lado", "LONG"),
    };
  }

  function render(vm, precoAtual) {
    setText("re-preco-atual", typeof precoAtual === "number" ? fmtUsd(precoAtual) : "Aguardando ticker…");
    var errBox = document.getElementById("re-erro");
    var errorFields = { FATAL_01: ["re-preco-entrada", "re-valor"], FATAL_04: ["re-saldo"],
      FATAL_05: ["re-alavancagem"], FATAL_07: ["re-funding"], FATAL_08: ["re-mmr"],
      FATAL_09: ["re-saldo", "re-alavancagem", "re-valor"] };
    var invalidFields = vm && !vm.ok ? errorFields[vm.codigo] || [] : [];
    ["re-saldo", "re-alavancagem", "re-preco-entrada", "re-valor", "re-funding", "re-mmr"].forEach(function (id) {
      var field = document.getElementById(id);
      if (field) field.setAttribute("aria-invalid", invalidFields.indexOf(id) !== -1 ? "true" : "false");
    });
    if (!vm || vm.ok !== true) {
      if (errBox) {
        errBox.style.display = "";
        errBox.textContent = vm ? vm.mensagem : "Aguardando cotação do ativo selecionado.";
      }
      ["re-qtd", "re-pmedio", "re-margem", "re-livre", "re-pnl", "re-equity",
       "re-plq", "re-res"].forEach(function (id) { setText(id, "—"); });
      renderLiquidationDistance(null, vm && vm.estadoRisco);
      setText("re-estado", "—");
      ["re-pnl", "re-res", "re-estado"].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
          el.setAttribute("data-sign", "");
          el.setAttribute("data-estado", "");
        }
      });
      return;
    }
    if (errBox) {
      errBox.style.display = "none";
      errBox.textContent = "";
    }
    var symbolEl = document.getElementById("re-simbolo");
    var quantityDigits = symbolEl && String(symbolEl.value).trim().toUpperCase().replace(/USDT$/, "") === "BTC" ? 8 : 2;
    setText("re-qtd", num(vm.quantidadeAtivo, quantityDigits));
    setText("re-pmedio", fmtUsd(vm.precoMedio));
    setText("re-margem", fmtUsd(vm.margemRetida));
    setText("re-livre", fmtUsd(vm.margemLivre));
    var pnlEl = document.getElementById("re-pnl");
    if (pnlEl) {
      pnlEl.textContent = (vm.pnlNaoRealizado >= 0 ? "+" : "") + fmtUsd(vm.pnlNaoRealizado).replace("$ ", "$ ");
      pnlEl.setAttribute("data-sign", vm.pnlNaoRealizado >= 0 ? "positive" : "negative");
    }
    setText("re-equity", fmtUsd(vm.equityAtual));
    setText("re-plq", vm.precoLiquidacao === null ? "Sem preço positivo" : fmtUsd(vm.precoLiquidacao));
    renderLiquidationDistance(vm.distanciaLiquidacaoPercentual, vm.estadoRisco);
    // §4 etapa anterior: "+12%" = ganho, nunca "perda de -12%".
    var resEl = document.getElementById("re-res");
    if (resEl) {
      var v = vm.resultadoEquityPercentual;
      resEl.textContent = (v > 0 ? "+" : "") + num(v, 2) + "%";
      resEl.setAttribute("data-sign", v > 0 ? "positive" : v < 0 ? "negative" : "neutral");
    }
    var estEl = document.getElementById("re-estado");
    if (estEl) {
      var riskLabels = { ATENCAO: "ATENÇÃO", CRITICO: "CRÍTICO", LIQUIDACAO: "LIQUIDAÇÃO",
        LIQUIDACAO_INATINGIVEL: "LIQUIDAÇÃO INATINGÍVEL" };
      estEl.textContent = riskLabels[vm.estadoRisco] || vm.estadoRisco;
      estEl.setAttribute("data-estado", vm.estadoRisco);
    }
  }

  function bind() {
    if (!host.document || !host.RiskEngineAdapter) return false;
    if (!document.getElementById("re-painel")) return false;
    var adapter = host.RiskEngineAdapter;
    var waitingForPrice = true;
    var recalculating = false;
    var quoteTimeout = null;

    function clearQuoteTimeout() {
      if (quoteTimeout !== null && host.clearTimeout) host.clearTimeout(quoteTimeout);
      quoteTimeout = null;
    }

    /* Configuração visual do adapter (SEM persistência). Usada pela troca
     * de ativo: trocar ≠ alterar — nenhum saveLocal/push pode sair daqui. */
    function configureAdapter() {
      adapter.configure(readParams());
      var last = adapter.getLastPrice();
      if (!waitingForPrice && typeof last === "number") {
        recalculating = true;
        try { render(buildViewModel(adapter.updateRiskPrice(last)), last); }
        finally { recalculating = false; }
      }
    }

    function reconfigurar() {
      configureAdapter();
      persistRiskParams();
    }

    /* `re-simbolo` NÃO está na lista: o `change` abaixo cobre o <select>
     * por mouse e teclado sozinho. Incluí-lo aqui persistia na troca. */
    ["re-lado", "re-saldo", "re-alavancagem", "re-preco-entrada",
     "re-valor", "re-funding", "re-mmr"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("input", reconfigurar);
    });

    /* Troca de ativo — ZERO persistência de parâmetros:
     * 1) identifica o novo asset; 2) troca a identidade; 3) registra a
     * seleção (saveLastAsset ≠ saveLocal); 4) carrega o novo (salvo ou
     * defaults); 5) configureAdapter() (sem persist).
     * Trocar sem editar não salva, não agenda push, não toca updatedAt. */
    var simboloEl = document.getElementById("re-simbolo");
    if (simboloEl) {
      simboloEl.addEventListener("change", function () {
        updateSaveStatus(""); // limpa o carimbo do ativo anterior imediatamente
        var newAsset = getCurrentAssetId(); // select JÁ mudou — este é o NOVO
        if (host.PanelSync && host.PanelSync.setCurrentAsset) {
          host.PanelSync.setCurrentAsset(newAsset);
        }
        if (host.PanelSync && host.PanelSync.saveLastAsset) {
          host.PanelSync.saveLastAsset(newAsset);
        }
        var saved = (host.PanelSync && host.PanelSync.loadLocal)
          ? host.PanelSync.loadLocal(RISK_PANEL, newAsset) : null;
        if (saved && saved.params) {
          applyRiskParams(saved.params);
        } else {
          applyRiskParams(defaultRiskParams(newAsset));
        }
        waitingForPrice = true;
        clearQuoteTimeout();
        configureAdapter();
        render(null, null);
      });
    }

    // Moeda com 2 casas: ao confirmar o campo (blur/Enter), normaliza a
    // exibição para 2 decimais. Só nos inputs monetários — MMR e alavancagem
    // ficam intocados (ex.: mmr 0.005 não pode ser cortado).
    ["re-saldo", "re-preco-entrada", "re-valor", "re-funding"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", function () {
        var n = parseMoeda(el.value);
        if (n !== null) el.value = fmtMoedaInput(n);
        reconfigurar();
      });
    });

    adapter.onResult(function (resultado) {
      waitingForPrice = false;
      render(buildViewModel(resultado), adapter.getLastPrice());
      // Apenas apresentação: o ticker atualiza a cada 5s. Após 30s sem
      // evento, não apresentar a última cotação como atual. Digitação não
      // renova esse prazo e não dispara requisições ou altera o motor.
      if (!recalculating && host.setTimeout) {
        clearQuoteTimeout();
        quoteTimeout = host.setTimeout(function () {
          waitingForPrice = true;
          render(null, null);
          setText("re-erro", "Cotação sem atualização há 30 s. Aguardando o ticker.");
        }, 30000);
      }
    });

    // Pull da nuvem (login): aplica params sincronizados sem recarregar a página.
    // Pull de asset inativo é ignorado — nunca sobrescreve o form de outro ativo.
    try {
      if (host.addEventListener) {
        host.addEventListener('estudebitcoin:panel-pull', function (ev) {
          var d = ev && ev.detail;
          if (!d || d.panel !== RISK_PANEL || !d.params) return;
          var currentAsset = getCurrentAssetId();
          var pullAsset = d.asset || d.params.simbolo || null;
          if (pullAsset && pullAsset !== currentAsset) return;
          if (host.PanelSync && host.PanelSync.setCurrentAsset) {
            host.PanelSync.setCurrentAsset(pullAsset || currentAsset);
          }
          applyRiskParams(d.params);
          reconfigurar();
        });
        // Feedback de push (nuvem): só o asset ativo consome. Success atrasado
        // de outro asset é ignorado — nunca reescreve o status do ativo atual.
        host.addEventListener('estudebitcoin:panel-push-start', function (ev) {
          var d = ev && ev.detail;
          if (!d || d.panel !== RISK_PANEL) return;
          if (d.asset !== getCurrentAssetId()) return;
          updateSaveStatus("Sincronizando nuvem...");
        });
        host.addEventListener('estudebitcoin:panel-push-success', function (ev) {
          var d = ev && ev.detail;
          if (!d || d.panel !== RISK_PANEL) return;
          if (d.asset !== getCurrentAssetId()) return;
          updateSaveStatus("Sincronizado na nuvem às " + getTimeString());
        });
        host.addEventListener('estudebitcoin:panel-push-error', function (ev) {
          var d = ev && ev.detail;
          if (!d || d.panel !== RISK_PANEL) return;
          if (d.asset !== getCurrentAssetId()) return;
          updateSaveStatus("Falha na sincronização às " + getTimeString());
        });
      }
    } catch (e) { /* listeners opcionais */ }

    restoreRiskParams();
    if (host.PanelSync && host.PanelSync.saveLastAsset) {
      host.PanelSync.saveLastAsset(getCurrentAssetId());
    }
    adapter.configure(readParams());
    adapter.attach();
    render(null, null);
    return true;
  }

  return {
    buildViewModel: buildViewModel,
    classifyLiquidationDistance: classifyLiquidationDistance,
    render: render,
    readParams: readParams,
    bind: bind,
  };
});
