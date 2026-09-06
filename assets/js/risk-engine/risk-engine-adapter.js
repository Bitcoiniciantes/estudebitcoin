/**
 * Adapter de integração Market Data → Risk Engine (EstudeBitcoin).
 *
 * Responsabilidade EXCLUSIVA (§6–§8):
 *
 *   Market Data (ticker-widget.js, evento "estudebitcoin:ticker-price")
 *        ↓ precoAtual
 *   Adapter (este arquivo: guarda parâmetros, encaminha preço)
 *        ↓ RiskEngine.calcularRisco({...params, precoAtual})
 *   ResultadoRisco → ouvintes (painel UI) via onResult / evento
 *        "riskengine:result"
 *
 * PROIBIÇÕES (§6, §8, §15):
 * - Nenhuma fórmula de risco (sem PnL, Pliq, MMR, validações duplicadas).
 *   Toda matemática vive exclusivamente em risk-engine.js, única fonte de
 *   verdade matemática. A UI apenas apresenta resultado.*.
 * - Nenhum fetch/WebSocket/polling/timer/DOM obrigatório. O preço chega pelo
 *   evento do ticker já existente; sem ele, updateRiskPrice() pode ser chamado
 *   diretamente por qualquer fonte externa.
 * - Nenhum estado de mercado duplicado: preço/PnL/equity/liquidação existem
 *   apenas no último ResultadoRisco retornado/guardado (getLastResult).
 *
 * Uso:
 *   RiskEngineAdapter.configure({ simbolo:"BTC", moedaConta:"USD",
 *     saldoCorretora:30000, alavancagem:10,
 *     ordens:[{moeda:"USD", preco:60000, valor:60000}],
 *     fundingCustoAcumulado:0, mmr:0, lado:"LONG" });
 *   RiskEngineAdapter.attach(); // ouve o ticker para o símbolo configurado
 *   RiskEngineAdapter.onResult(function (resultado) { ... });
 */
(function (global, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory(global);
  } else {
    global.RiskEngineAdapter = factory(global);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (host) {
  "use strict";

  var TICKER_EVENT = "estudebitcoin:ticker-price";
  var RESULT_EVENT = "riskengine:result";

  var params = null;
  var lastResult = null;
  var lastPrice = null;
  var listeners = [];
  var attached = false;

  function getEngine() {
    if (host && host.RiskEngine && host.RiskEngine.calcularRisco) {
      return host.RiskEngine;
    }
    if (typeof require === "function") {
      return require("./risk-engine.js");
    }
    throw new Error("RiskEngineAdapter: risk-engine.js não carregado.");
  }

  function notify(resultado) {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](resultado);
      } catch (listenerError) {
        /* ouvinte com falha não quebra o adapter */
      }
    }
    try {
      if (host && host.dispatchEvent && host.CustomEvent) {
        host.dispatchEvent(
          new host.CustomEvent(RESULT_EVENT, { detail: resultado }),
        );
      }
    } catch (broadcastError) {
      /* broadcast opcional */
    }
  }

  function configure(p) {
    params = p === null || typeof p !== "object" ? null : p;
    return true;
  }

  function getParams() {
    return params;
  }

  function getLastResult() {
    return lastResult;
  }

  function getLastPrice() {
    return lastPrice;
  }

  /**
   * Interface do adapter (§7): recebe precoAtual, encaminha ao motor,
   * guarda e distribui o ResultadoRisco. Motor permanece função pura e
   * sem estado; o ÚNICO estado aqui é o último resultado (cache de leitura).
   * Sem parâmetros configurados, retorna null (sem inventar erro FATAL).
   */
  function updateRiskPrice(precoAtual) {
    if (params === null) return null;
    var input = {
      moedaConta: params.moedaConta,
      saldoCorretora: params.saldoCorretora,
      alavancagem: params.alavancagem,
      ordens: params.ordens,
      precoAtual: precoAtual,
      fundingCustoAcumulado: params.fundingCustoAcumulado,
      mmr: params.mmr,
      lado: params.lado,
    };
    var resultado = getEngine().calcularRisco(input);
    lastPrice = precoAtual;
    lastResult = resultado;
    notify(resultado);
    return resultado;
  }

  function onResult(callback) {
    if (typeof callback === "function") listeners.push(callback);
    return callback;
  }

  function offResult(callback) {
    for (var i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i] === callback) listeners.splice(i, 1);
    }
  }

  function handleTickerEvent(event) {
    if (params === null || !event || !event.detail) return;
    if (event.detail.symbol !== params.simbolo) return;
    updateRiskPrice(event.detail.price);
  }

  function attach() {
    if (attached) return true;
    try {
      if (host && typeof host.addEventListener === "function") {
        host.addEventListener(TICKER_EVENT, handleTickerEvent);
        attached = true;
        return true;
      }
    } catch (attachError) {
      /* sem window: updateRiskPrice() direto continua válido */
    }
    return false;
  }

  function detach() {
    try {
      if (attached && host && typeof host.removeEventListener === "function") {
        host.removeEventListener(TICKER_EVENT, handleTickerEvent);
      }
    } catch (detachError) {
      /* noop */
    }
    attached = false;
  }

  return {
    TICKER_EVENT: TICKER_EVENT,
    RESULT_EVENT: RESULT_EVENT,
    configure: configure,
    getParams: getParams,
    getLastResult: getLastResult,
    getLastPrice: getLastPrice,
    updateRiskPrice: updateRiskPrice,
    onResult: onResult,
    offResult: offResult,
    attach: attach,
    detach: detach,
  };
});
