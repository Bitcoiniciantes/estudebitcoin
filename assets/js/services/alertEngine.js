/* =====================================================================
   AlertEngine — Motor de alertas S/R Dinâmicos
   - Web Audio API (synthetic beep, sem依赖ência de .mp3)
   - Cooldown por símbolo/direção (5s)
   - Comunicação com UI via CustomEvent
   ===================================================================== */
window.AlertEngine = (function () {
  'use strict';

  function AlertEngine() {
    this.alerts = new Map();
    this.lastSoundAt = {};
    this.audioCtx = null;
    this.audioUnlocked = false;
  }

  /**
   * Cria/retorna o AudioContext (lazy, sem criar no construtor).
   * Chrome exige que o AudioContext seja criado em resposta a interação
   * do usuário, por isso o init() é chamado apenas no unlockAudio().
   */
  function getAudioCtx(self) {
    if (!self.audioCtx) {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) self.audioCtx = new Ctx();
      } catch (e) { /* Web Audio não suportado */ }
    }
    return self.audioCtx;
  }

  /**
   * Toca um beep curto via Web Audio API.
   * Não depende de nenhum arquivo externo.
   */
  function playBeep(self) {
    var ctx = getAudioCtx(self);
    if (!ctx) return;
    // Se estiver suspendido, tenta retomar (política de autoplay)
    if (ctx.state === 'suspended') {
      ctx.resume().catch(function () {});
    }
    try {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) { /* falha silenciosa */ }
  }

  /**
   * Desbloqueia áudio na primeira interação do usuário.
   * Cria o AudioContext e retoma se estiver suspendido.
   */
  AlertEngine.prototype.unlockAudio = function () {
    var ctx = getAudioCtx(this);
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(function () {});
    }
    this.audioUnlocked = true;
  };

  AlertEngine.prototype.setAlertLevels = function (symbol, support, resistance, metadata) {
    if (!Number.isFinite(support) || !Number.isFinite(resistance)) return;

    metadata = metadata || {};
    var source = metadata.source || 'UNKNOWN';
    var timeframe = metadata.timeframe || null;

    var existing = this.alerts.get(symbol);

    // Se já existe alerta com mesmos níveis (tolerância 0.1%), não alterar
    if (existing && existing.config) {
      var sameSupport = Math.abs(existing.config.support - support) < support * 0.001;
      var sameResistance = Math.abs(existing.config.resistance - resistance) < resistance * 0.001;
      if (sameSupport && sameResistance) return;
    }

    console.log('[SR-TRACE] ALERT_ENGINE setAlertLevels', {
      symbol: symbol,
      support: support,
      resistance: resistance,
      source: source,
      timeframe: timeframe,
      timestamp: Date.now()
    });

    // Separar configuração de estado runtime
    var newAlert = {
      config: {
        support: support,
        resistance: resistance,
        source: source,
        timeframe: timeframe,
        updatedAt: Date.now()
      },
      state: {
        active: true,
        lastPrice: existing && existing.state ? existing.state.lastPrice : null,
        resistanceTriggered: false,
        supportTriggered: false,
        armedSupport: true,
        armedResistance: true,
        visualAlert: existing && existing.state ? existing.state.visualAlert : false
      }
    };

    // Preservar visualAlert se níveis mudaram mas alerta ainda está ativo
    // (atualização legítima não deve destruir estado visual)
    if (existing && existing.state && existing.state.visualAlert) {
      // Se a divergência for grande (>5%), consideramos uma reconfiguração completa
      var largeChange = existing.config && (
        Math.abs(existing.config.support - support) > support * 0.05 ||
        Math.abs(existing.config.resistance - resistance) > resistance * 0.05
      );
      if (!largeChange) {
        newAlert.state.visualAlert = true;
      }
    }

    this.alerts.set(symbol, newAlert);

    if (!this.lastSoundAt[symbol]) {
      this.lastSoundAt[symbol] = { resistance: 0, support: 0 };
    }
  };

  AlertEngine.prototype.onPriceUpdate = function (symbol, currentPrice) {
    var alert = this.alerts.get(symbol);

    if (!alert || !alert.state || !alert.state.active) return;
    if (!Number.isFinite(currentPrice)) return;

    var state = alert.state;
    var config = alert.config;

    // Proteção contra disparo imediato (Seção 9)
    if (state.lastPrice === null) {
      state.lastPrice = currentPrice;
      return;
    }

    var previousPrice = state.lastPrice;

    // Rearme (Seção 8 & 10) + desligar alerta visual quando preço se afasta
    if (currentPrice < config.resistance) {
      if (!state.armedResistance && state.visualAlert) {
        this.dismissVisualAlert(symbol);
      }
      state.armedResistance = true;
    }
    if (currentPrice > config.support) {
      if (!state.armedSupport && state.visualAlert) {
        this.dismissVisualAlert(symbol);
      }
      state.armedSupport = true;
    }

    // Rompimento de resistência
    if (
      state.armedResistance &&
      previousPrice < config.resistance &&
      currentPrice >= config.resistance
    ) {
      state.armedResistance = false;
      this.trigger(symbol, 'resistance', currentPrice, config.resistance);
    }

    // Rompimento de suporte
    if (
      state.armedSupport &&
      previousPrice > config.support &&
      currentPrice <= config.support
    ) {
      state.armedSupport = false;
      this.trigger(symbol, 'support', currentPrice, config.support);
    }

    state.lastPrice = currentPrice;
  };

  AlertEngine.prototype.updateArmingState = function (alert, currentPrice) {
    if (currentPrice >= alert.resistance) alert.armedResistance = false;
    if (currentPrice <= alert.support) alert.armedSupport = false;
  };

  AlertEngine.prototype.trigger = function (symbol, direction, price, level) {
    var alert = this.alerts.get(symbol);
    if (!alert || !alert.state) return;

    alert.state.visualAlert = true;

    // Cooldown de 2min por símbolo/direção
    var now = Date.now();
    if (!this.lastSoundAt[symbol]) {
      this.lastSoundAt[symbol] = {};
    }
    var last = this.lastSoundAt[symbol][direction] || 0;
    if (now - last >= 120000) {
      playBeep(this);
      // Feedback tátil no mobile (silencioso em desktop, que ignora navigator.vibrate)
      if (navigator.vibrate) {
        navigator.vibrate(200);
      }
      this.lastSoundAt[symbol][direction] = now;
    }

    // Comunicação com a UI (Seção 15)
    window.dispatchEvent(
      new CustomEvent('PriceAlertTriggered', {
        detail: { symbol: symbol, direction: direction, price: price, level: level }
      })
    );
  };

  AlertEngine.prototype.dismissVisualAlert = function (symbol) {
    var alert = this.alerts.get(symbol);
    if (!alert || !alert.state) return;

    alert.state.visualAlert = false;

    window.dispatchEvent(
      new CustomEvent('PriceAlertDismissed', {
        detail: { symbol: symbol }
      })
    );
  };

  /**
   * Verifica se o símbolo possui níveis definidos pelo usuário (source=GRAPH).
   * Ticker não deve sobrescrever símbolos com autoridade USER_DEFINED.
   */
  AlertEngine.prototype.hasUserDefinedLevels = function (symbol) {
    var alert = this.alerts.get(symbol);
    if (!alert || !alert.config) return false;
    return alert.config.source === 'GRAPH';
  };

  /**
   * Retorna os níveis atuais do símbolo (para leitura).
   */
  AlertEngine.prototype.getLevels = function (symbol) {
    var alert = this.alerts.get(symbol);
    if (!alert || !alert.config) return null;
    return {
      support: alert.config.support,
      resistance: alert.config.resistance,
      source: alert.config.source,
      timeframe: alert.config.timeframe
    };
  };

  AlertEngine.prototype.disable = function (symbol) {
    this.alerts.delete(symbol);
    this.dismissVisualAlert(symbol);
  };

  AlertEngine.prototype.isEnabled = function (symbol) {
    var alert = this.alerts.get(symbol);
    return !!(alert && alert.state && alert.state.active);
  };

  AlertEngine.prototype.isPushEnabled = function () {
    return !!(window.PushSubscribe && window.PushSubscribe.isEnabled());
  };

  /**
   * CORREÇÃO 5: disableAll() NÃO deve limpar alertas locais.
   * Push OFF deve desativar apenas entrega Push/Worker.
   * AlertEngine local permanece funcional.
   */
  AlertEngine.prototype.disableAll = function () {
    // NÃO fazer: this.alerts.clear()
    // Alertas locais permanecem ativos independentemente do Push
    console.log('[AlertEngine] disableAll() chamado - alertas locais preservados');
  };

  return new AlertEngine();
})();

// Desbloqueia o AudioContext no primeiro toque/clique do usuário (necessário no mobile)
function unlockAudioOnFirstInteraction() {
  window.AlertEngine.unlockAudio();
  document.removeEventListener('touchstart', unlockAudioOnFirstInteraction);
  document.removeEventListener('click', unlockAudioOnFirstInteraction);
}
document.addEventListener('touchstart', unlockAudioOnFirstInteraction, { once: true });
document.addEventListener('click', unlockAudioOnFirstInteraction, { once: true });
