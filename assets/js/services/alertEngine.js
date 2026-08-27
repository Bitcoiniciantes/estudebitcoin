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

  AlertEngine.prototype.setAlertLevels = function (symbol, support, resistance) {
    if (!Number.isFinite(support) || !Number.isFinite(resistance)) return;

    this.alerts.set(symbol, {
      support: support,
      resistance: resistance,
      active: true,
      supportTriggered: false,
      resistanceTriggered: false,
      armedSupport: true,
      armedResistance: true,
      lastPrice: null,
      visualAlert: false
    });

    if (!this.lastSoundAt[symbol]) {
      this.lastSoundAt[symbol] = { resistance: 0, support: 0 };
    }
  };

  AlertEngine.prototype.onPriceUpdate = function (symbol, currentPrice) {
    var alert = this.alerts.get(symbol);

    if (!alert || !alert.active) return;
    if (!Number.isFinite(currentPrice)) return;

    // Proteção contra disparo imediato (Seção 9)
    if (alert.lastPrice === null) {
      alert.lastPrice = currentPrice;
      return;
    }

    var previousPrice = alert.lastPrice;

    // Rearme (Seção 8 & 10)
    if (currentPrice < alert.resistance) {
      alert.armedResistance = true;
    }
    if (currentPrice > alert.support) {
      alert.armedSupport = true;
    }

    // Rompimento de resistência
    if (
      alert.armedResistance &&
      previousPrice < alert.resistance &&
      currentPrice >= alert.resistance
    ) {
      alert.armedResistance = false;
      this.trigger(symbol, 'resistance', currentPrice, alert.resistance);
    }

    // Rompimento de suporte
    if (
      alert.armedSupport &&
      previousPrice > alert.support &&
      currentPrice <= alert.support
    ) {
      alert.armedSupport = false;
      this.trigger(symbol, 'support', currentPrice, alert.support);
    }

    alert.lastPrice = currentPrice;
  };

  AlertEngine.prototype.updateArmingState = function (alert, currentPrice) {
    if (currentPrice >= alert.resistance) alert.armedResistance = false;
    if (currentPrice <= alert.support) alert.armedSupport = false;
  };

  AlertEngine.prototype.trigger = function (symbol, direction, price, level) {
    var alert = this.alerts.get(symbol);
    if (!alert) return;

    alert.visualAlert = true;

    // Cooldown de 5s por símbolo/direção (Seção 14)
    // Acesso seguro: cria entrada se não existir
    var now = Date.now();
    if (!this.lastSoundAt[symbol]) {
      this.lastSoundAt[symbol] = {};
    }
    var last = this.lastSoundAt[symbol][direction] || 0;
    if (now - last >= 5000) {
      playBeep(this);
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
    if (!alert) return;

    alert.visualAlert = false;

    window.dispatchEvent(
      new CustomEvent('PriceAlertDismissed', {
        detail: { symbol: symbol }
      })
    );
  };

  AlertEngine.prototype.disable = function (symbol) {
    this.alerts.delete(symbol);
    this.dismissVisualAlert(symbol);
  };

  AlertEngine.prototype.isEnabled = function (symbol) {
    var alert = this.alerts.get(symbol);
    return !!(alert && alert.active);
  };

  return new AlertEngine();
})();
