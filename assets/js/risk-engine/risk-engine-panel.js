/**
 * Painel ao vivo do Risk Engine (nova camada visual mínima, §10).
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
    // Aceita "3.000,00" (pontos de milhar + vírgula) ou "3000.12" (ponto decimal):
    // com vírgula, pontos são milhar; sem vírgula, parse direto.
    var s = String(texto == null ? "" : texto).trim();
    if (s.indexOf(",") !== -1) s = s.replace(/\./g, "").replace(",", ".");
    var n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  function fmtMoedaInput(n) {
    return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

  /* ---------- Persistência (Etapa 1 local + Etapa 3 nuvem via PanelSync) ----------
   * - Anônimo: salva/restaura em localStorage (nunca perde no reload).
   * - Logado: PanelSync empurra para a nuvem (debounce interno) e aplica o
   *   pull via evento 'estudebitcoin:panel-pull'. Login continua opcional:
   *   sem window.PanelSync, o painel funciona exatamente como antes. */
  var RISK_PANEL = 'risk';

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

  function persistRiskParams() {
    try {
      if (host.PanelSync && host.PanelSync.saveLocal) {
        host.PanelSync.saveLocal(RISK_PANEL, readParams());
      }
    } catch (e) { /* persistência opcional: nunca quebra o painel */ }
  }

  function restoreRiskParams() {
    try {
      if (host.PanelSync && host.PanelSync.loadLocal) {
        var saved = host.PanelSync.loadLocal(RISK_PANEL);
        if (saved && saved.params) applyRiskParams(saved.params);
      }
    } catch (e) { /* segue com os padrões */ }
  }

  function readParams() {
    function val(id, fallback) {
      var el = document.getElementById(id);
      if (!el) return fallback;
      // Campos monetários (type=text) usam parseMoeda ("3.000,00");
      // numéricos (alavancagem/MMR) usam parse direto.
      var n = /^(re-saldo|re-preco-entrada|re-valor|re-funding)$/.test(id)
        ? parseMoeda(el.value)
        : parseFloat(String(el.value).replace(",", "."));
      return n !== null && Number.isFinite(n) ? n : fallback;
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
    setText("re-preco-atual", typeof precoAtual === "number" ? fmtUsd(precoAtual) : "aguardando ticker…");
    var errBox = document.getElementById("re-erro");
    if (!vm || vm.ok !== true) {
      if (errBox) {
        errBox.style.display = "";
        errBox.textContent =
          (vm ? vm.codigo : "SEM_RESULTADO") + ": " + (vm ? vm.mensagem : "Sem resultado.");
      }
      ["re-qtd", "re-pmedio", "re-margem", "re-livre", "re-pnl", "re-equity",
       "re-plq", "re-dist", "re-res"].forEach(function (id) { setText(id, "—"); });
      setText("re-estado", "—");
      return;
    }
    if (errBox) {
      errBox.style.display = "none";
      errBox.textContent = "";
    }
    setText("re-qtd", num(vm.quantidadeAtivo, 8));
    setText("re-pmedio", fmtUsd(vm.precoMedio));
    setText("re-margem", fmtUsd(vm.margemRetida));
    setText("re-livre", fmtUsd(vm.margemLivre));
    var pnlEl = document.getElementById("re-pnl");
    if (pnlEl) {
      pnlEl.textContent = (vm.pnlNaoRealizado >= 0 ? "+" : "") + fmtUsd(vm.pnlNaoRealizado).replace("$ ", "$ ");
      pnlEl.style.color = vm.pnlNaoRealizado >= 0 ? "#54b85a" : "#e5484d";
    }
    setText("re-equity", fmtUsd(vm.equityAtual));
    setText("re-plq", vm.precoLiquidacao === null ? "Sem preço positivo" : fmtUsd(vm.precoLiquidacao));
    setText("re-dist", vm.distanciaLiquidacaoPercentual === null ? "—" : num(vm.distanciaLiquidacaoPercentual, 2) + "%");
    // §4 etapa anterior: "+12%" = ganho, nunca "perda de -12%".
    var resEl = document.getElementById("re-res");
    if (resEl) {
      var v = vm.resultadoEquityPercentual;
      resEl.textContent = (v > 0 ? "+" : "") + num(v, 2) + "%";
      resEl.style.color = v > 0 ? "#54b85a" : v < 0 ? "#e5484d" : "#a8a8a8";
    }
    var estEl = document.getElementById("re-estado");
    if (estEl) {
      estEl.textContent = vm.estadoRisco;
      estEl.setAttribute("data-estado", vm.estadoRisco);
    }
  }

  function bind() {
    if (!host.document || !host.RiskEngineAdapter) return false;
    if (!document.getElementById("re-painel")) return false;
    var adapter = host.RiskEngineAdapter;

    function reconfigurar() {
      adapter.configure(readParams());
      persistRiskParams();
      var last = adapter.getLastPrice();
      if (typeof last === "number") render(buildViewModel(adapter.updateRiskPrice(last)), last);
    }

    ["re-simbolo", "re-lado", "re-saldo", "re-alavancagem", "re-preco-entrada",
     "re-valor", "re-funding", "re-mmr"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener("input", reconfigurar);
    });

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
      render(buildViewModel(resultado), adapter.getLastPrice());
    });

    // Pull da nuvem (login): aplica params sincronizados sem recarregar a página.
    try {
      if (host.addEventListener) {
        host.addEventListener('estudebitcoin:panel-pull', function (ev) {
          var d = ev && ev.detail;
          if (d && d.panel === RISK_PANEL && d.params) {
            applyRiskParams(d.params);
            reconfigurar();
          }
        });
      }
    } catch (e) { /* listener opcional */ }

    restoreRiskParams();
    adapter.configure(readParams());
    adapter.attach();
    render(null, null);
    return true;
  }

  return {
    buildViewModel: buildViewModel,
    render: render,
    readParams: readParams,
    bind: bind,
  };
});
