/* =====================================================================
   Push Subscribe — Inscrição Web Push
   - Botão "Ativar alertas" (só aparece quando suportado)
   - Permissão SOMENTE em clique do usuário
   - iPhone: só mostra se estiver em modo standalone (PWA instalado)
   - Worker /subscribe salva subscription no KV
   - pushEnabled = ÚNICA autoridade de ativação/desativação dos alertas
   ===================================================================== */
(function () {
  'use strict';

  var VAPID_PUBLIC_KEY = window.PushConfig && window.PushConfig.VAPID_PUBLIC_KEY;
  var WORKER_URL = window.PushConfig && window.PushConfig.WORKER_URL;

  // ─── Estado único: pushEnabled ──────────────────────────────────────
  // Autoridade central para saber se alertas estão habilitados.
  // Persistido em localStorage, restaurado no reload.
  var pushEnabled = false;
  var workerSubscriptionId = null;

  function persistState() {
    try {
      localStorage.setItem('push_enabled', pushEnabled ? '1' : '0');
      if (workerSubscriptionId) {
        localStorage.setItem('push_worker_sub_id', workerSubscriptionId);
      } else {
        localStorage.removeItem('push_worker_sub_id');
      }
    } catch (e) { /* falha silenciosa */ }
  }

  function restoreState() {
    try {
      var stored = localStorage.getItem('push_enabled');
      if (stored === '1') pushEnabled = true;
      var storedId = localStorage.getItem('push_worker_sub_id');
      if (storedId) workerSubscriptionId = storedId;
    } catch (e) { /* falha silenciosa */ }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  function isPushSupported() {
    if (!('serviceWorker' in navigator)) return false;
    if (!('PushManager' in window)) return false;
    if (!('Notification' in window)) return false;
    var isMobile = /Android|iPhone|iPod|iPad/.test(navigator.userAgent) ||
                   (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isMobile) return false;
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      var isStandalone = window.matchMedia('(display-mode: standalone)').matches ||
                         window.navigator.standalone === true;
      if (!isStandalone) return false;
    }
    return true;
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function getExistingSubscription() {
    return navigator.serviceWorker.ready.then(function (registration) {
      return registration.pushManager.getSubscription();
    });
  }

  function saveSubscriptionLocally(subscription) {
    try {
      var payload = subscription.toJSON();
      payload._savedAt = new Date().toISOString();
      localStorage.setItem('push_subscription', JSON.stringify(payload));
    } catch (e) { /* falha silenciosa */ }
  }

  // ─── AlertEngine integration ────────────────────────────────────────

  function activateAlertEngine() {
    if (window.AlertEngine && window.AlertEngine.unlockAudio) {
      window.AlertEngine.unlockAudio();
    }
  }

  function deactivateAlertEngine() {
    if (window.AlertEngine && window.AlertEngine.disableAll) {
      window.AlertEngine.disableAll();
    }
  }

  // ─── Worker communication ───────────────────────────────────────────

  function sendToWorker(subscription) {
    if (!WORKER_URL) {
      console.log('[Push] Worker URL não configurada. Subscription salva em localStorage.');
      return Promise.resolve({ id: null });
    }
    return fetch(WORKER_URL + '/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription)
    }).then(function (res) {
      if (!res.ok) throw new Error('Worker responded ' + res.status);
      return res.json();
    });
  }

  function removeFromWorker(subId) {
    if (!WORKER_URL || !subId) return Promise.resolve();
    return fetch(WORKER_URL + '/unsubscribe?id=' + encodeURIComponent(subId), {
      method: 'POST'
    }).then(function (res) {
      if (!res.ok) console.warn('[Push] Worker unsubscribe retornou ' + res.status);
    }).catch(function (e) {
      console.warn('[Push] Worker unsubscribe falhou: ' + e.message);
    });
  }

  // ─── syncToWorker (S/R levels) ─────────────────────────────────────

  var lastSyncedLevels = {};

  function syncToWorker(symbol, support, resistance, lastPrice) {
    if (!pushEnabled) return;
    if (!WORKER_URL) return;
    if (!symbol || !Number.isFinite(support) || !Number.isFinite(resistance)) return;

    var now = Date.now();
    var prev = lastSyncedLevels[symbol];

    if (prev) {
      var supportChanged = Math.abs(prev.support - support) > support * 0.001;
      var resistanceChanged = Math.abs(prev.resistance - resistance) > resistance * 0.001;
      if (!supportChanged && !resistanceChanged) return;
      if (now - prev.timestamp < 5 * 60 * 1000) return;
    }

    lastSyncedLevels[symbol] = { support: support, resistance: resistance, timestamp: now };

    fetch(WORKER_URL + '/alerts/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: symbol,
        support: support,
        resistance: resistance,
        direction: 'BOTH',
        lastPrice: lastPrice
      })
    }).catch(function () {});
  }

  // ─── Subscribe (SINO ON) ───────────────────────────────────────────

  function subscribe() {
    console.log('[Push] subscribe() chamado');
    if (!VAPID_PUBLIC_KEY) {
      console.error('[Push] VAPID_PUBLIC_KEY não configurada.');
      return;
    }
    console.log('[Push] Pedindo permissão...');

    Notification.requestPermission().then(function (permission) {
      console.log('[Push] Permissão:', permission);
      if (permission !== 'granted') {
        console.log('[Push] Permissão negada.');
        updateButton('denied');
        return;
      }

      console.log('[Push] Aguardando serviceWorker.ready...');
      navigator.serviceWorker.ready.then(function (registration) {
        console.log('[Push] SW ready. Inscrevendo no pushManager...');
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
      }).then(function (subscription) {
        console.log('[Push] Subscription criada:', subscription);
        saveSubscriptionLocally(subscription);
        return sendToWorker(subscription);
      }).then(function (result) {
        // Persistir ID retornado pelo Worker
        if (result && result.id) {
          workerSubscriptionId = result.id;
        }
        pushEnabled = true;
        persistState();
        activateAlertEngine();
        updateButton('subscribed');
        console.log('[Push] Alertas ativados. pushEnabled=true');
      }).catch(function (err) {
        console.error('[Push] Erro na inscrição:', err);
        pushEnabled = false;
        persistState();
        updateButton('error');
      });
    });
  }

  // ─── Unsubscribe (SINO OFF) ────────────────────────────────────────

  function unsubscribe() {
    navigator.serviceWorker.ready.then(function (registration) {
      return registration.pushManager.getSubscription();
    }).then(function (subscription) {
      // Remover do Worker PRIMEIRO (antes de destruir a subscription local)
      return removeFromWorker(workerSubscriptionId).then(function () {
        if (subscription) {
          return subscription.unsubscribe();
        }
      });
    }).then(function () {
      console.log('[Push] Desinscrito.');
      pushEnabled = false;
      workerSubscriptionId = null;
      persistState();
      localStorage.removeItem('push_subscription');
      deactivateAlertEngine();
      updateButton('default');
      console.log('[Push] Alertas desativados. pushEnabled=false');
    }).catch(function (err) {
      console.error('[Push] Erro ao desativar:', err);
      // Forçar estado OFF mesmo se Worker falhar
      pushEnabled = false;
      workerSubscriptionId = null;
      persistState();
      deactivateAlertEngine();
      updateButton('default');
    });
  }

  // ─── Toggle (chamado pelo botão) ───────────────────────────────────

  function toggle() {
    if (pushEnabled) {
      unsubscribe();
    } else {
      subscribe();
    }
  }

  // ─── UI ─────────────────────────────────────────────────────────────

  function updateButton(state) {
    var btn = document.getElementById('push-activate-btn');
    if (!btn) return;
    switch (state) {
      case 'subscribed':
        btn.textContent = 'Alertas ativos';
        btn.classList.add('push-active');
        btn.onclick = toggle;
        break;
      case 'denied':
        btn.textContent = 'Permissão negada';
        btn.disabled = true;
        break;
      case 'error':
        btn.textContent = 'Erro ao ativar';
        btn.classList.add('push-error');
        btn.onclick = toggle;
        break;
      default:
        btn.textContent = 'Ativar alertas';
        btn.classList.remove('push-active', 'push-error');
        btn.disabled = false;
        btn.onclick = toggle;
    }
  }

  // ─── Init (restaura estado no reload) ──────────────────────────────

  function init() {
    var btn = document.getElementById('push-activate-btn');
    console.log('[Push] init() — btn:', !!btn, 'isPushSupported:', isPushSupported());
    if (!btn) return;
    if (!isPushSupported()) return;
    btn.style.display = '';

    // Restaurar estado persistido
    restoreState();

    if (pushEnabled) {
      // Estado ON: verificar se subscription browser ainda existe
      getExistingSubscription().then(function (subscription) {
        if (subscription && workerSubscriptionId) {
          // Tudo OK: subscription browser + Worker ID existem
          activateAlertEngine();
          updateButton('subscribed');
          console.log('[Push] Estado restaurado: ON (subscription válida)');
        } else {
          // Subscription browser ou Worker ID sumiu: forçar OFF
          console.log('[Push] Subscription ou Worker ID ausente — forçando OFF');
          pushEnabled = false;
          workerSubscriptionId = null;
          persistState();
          deactivateAlertEngine();
          updateButton('default');
        }
      });
    } else {
      // Estado OFF: garantir que AlertEngine está desativado
      deactivateAlertEngine();
      updateButton('default');

      // Verificar se há subscription browser órfã (limpar)
      getExistingSubscription().then(function (subscription) {
        if (subscription) {
          console.log('[Push] Subscription órfã encontrada — removendo');
          subscription.unsubscribe().catch(function () {});
        }
      });
    }
  }

  // Expor para uso externo
  window.PushSubscribe = {
    init: init,
    subscribe: subscribe,
    unsubscribe: unsubscribe,
    toggle: toggle,
    syncToWorker: syncToWorker,
    isEnabled: function () { return pushEnabled; }
  };

  // Inicializar quando DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
