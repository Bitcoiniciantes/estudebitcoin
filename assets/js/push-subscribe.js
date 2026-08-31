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

  // ─── Diagnóstico visual (TEMP — remover depois do diagnóstico) ──────

  function clearDiagnostic() {
    var el = document.getElementById('push-diagnostic');
    if (el) el.remove();
  }

  function showPushDiagnostic(message) {
    console.error('[Push][DIAG]', message);

    var btn = document.getElementById('push-activate-btn');
    if (btn) {
      btn.textContent = 'ERRO: ' + String(message).slice(0, 80);
      btn.classList.add('push-error');
    }

    var existing = document.getElementById('push-diagnostic');
    if (!existing) {
      existing = document.createElement('pre');
      existing.id = 'push-diagnostic';
      existing.style.cssText =
        'position:fixed;z-index:99999;left:10px;right:10px;bottom:10px;' +
        'max-height:45vh;overflow:auto;padding:12px;' +
        'background:#111;color:#0f0;font-size:11px;white-space:pre-wrap;' +
        'font-family:monospace;border-radius:8px;border:1px solid #333;';
      document.body.appendChild(existing);
    }

    existing.textContent += '\n' + message;
  }

  // ─── Worker communication ───────────────────────────────────────────

  function sendToWorker(subscription) {
    if (!WORKER_URL) {
      showPushDiagnostic('[sendToWorker] Worker URL AUSENTE');
      return Promise.reject(new Error('WORKER_URL não configurada'));
    }
    console.log('[Push][sendToWorker] POST', WORKER_URL + '/subscribe');
    showPushDiagnostic('[10] POST /subscribe → ' + WORKER_URL);
    return fetch(WORKER_URL + '/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription)
    }).then(function (res) {
      console.log('[Push][sendToWorker] HTTP status:', res.status, res.statusText);
      showPushDiagnostic('[11] HTTP ' + res.status + ' ' + res.statusText);
      if (!res.ok) {
        return res.text().then(function (body) {
          console.error('[Push][sendToWorker] Response body:', body);
          showPushDiagnostic('[11] Body: ' + body.slice(0, 200));
          throw new Error('Worker HTTP ' + res.status + ': ' + body);
        });
      }
      return res.json();
    }).catch(function (err) {
      console.error('[Push][sendToWorker] fetch error:', err.name, err.message);
      showPushDiagnostic('[sendToWorker] Fetch error: ' + err.message);
      throw err;
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
    clearDiagnostic();
    showPushDiagnostic('[1] subscribe() chamado');
    showPushDiagnostic('[2] VAPID: ' + (VAPID_PUBLIC_KEY ? 'OK' : 'AUSENTE'));
    showPushDiagnostic('[2] WORKER: ' + (WORKER_URL || 'AUSENTE'));
    showPushDiagnostic('[3] permission (antes): ' + Notification.permission);

    Notification.requestPermission().then(function (permission) {
      showPushDiagnostic('[4] permission resultado: ' + permission);
      if (permission !== 'granted') {
        showPushDiagnostic('Permissão negada — abortando.');
        updateButton('denied');
        return;
      }

      showPushDiagnostic('[5] serviceWorker.ready...');
      navigator.serviceWorker.ready.then(function (registration) {
        showPushDiagnostic('[6] SW scope: ' + registration.scope);
        showPushDiagnostic('[7] pushManager.subscribe()...');
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
        });
      }).then(function (subscription) {
        var endpoint = subscription ? subscription.endpoint : 'AUSENTE';
        showPushDiagnostic('[8] PushSubscription criada');
        showPushDiagnostic('[9] endpoint: ' + endpoint.substring(0, 60));
        saveSubscriptionLocally(subscription);
        return sendToWorker(subscription);
      }).then(function (result) {
        showPushDiagnostic('[11] Worker response: ' + JSON.stringify(result));
        var receivedId = result && result.id ? result.id : null;
        showPushDiagnostic('[12] workerSubscriptionId: ' + receivedId);
        if (receivedId) {
          workerSubscriptionId = receivedId;
        }
        pushEnabled = true;
        showPushDiagnostic('[13] pushEnabled=true');
        persistState();
        activateAlertEngine();
        updateButton('subscribed');
        showPushDiagnostic('[15] SUCESSO TOTAL');
        setTimeout(clearDiagnostic, 5000);
      }).catch(function (err) {
        showPushDiagnostic(
          'ERRO\n' +
          'name=' + (err && err.name) + '\n' +
          'message=' + (err && err.message) + '\n' +
          'stack=' + (err && err.stack || '')
        );
        pushEnabled = false;
        persistState();
        updateButton('error');
      });
    });
  }

  // ─── Unsubscribe (SINO OFF) ────────────────────────────────────────

  function unsubscribe() {
    console.log('[Push][unsubscribe] Chamado. workerSubscriptionId:', workerSubscriptionId);
    navigator.serviceWorker.ready.then(function (registration) {
      return registration.pushManager.getSubscription();
    }).then(function (subscription) {
      console.log('[Push][unsubscribe] Browser subscription:', !!subscription);
      // Remover do Worker PRIMEIRO (antes de destruir a subscription local)
      return removeFromWorker(workerSubscriptionId).then(function () {
        if (subscription) {
          console.log('[Push][unsubscribe] Desinscrevendo do pushManager...');
          return subscription.unsubscribe();
        }
      });
    }).then(function () {
      console.log('[Push][unsubscribe] ✅ Desinscrito com sucesso');
      pushEnabled = false;
      workerSubscriptionId = null;
      persistState();
      localStorage.removeItem('push_subscription');
      deactivateAlertEngine();
      updateButton('default');
      console.log('[Push][unsubscribe] pushEnabled=false | Estado: OFF');
    }).catch(function (err) {
      console.error('[Push][unsubscribe] Erro:', err.name, err.message);
      // Forçar estado OFF mesmo se Worker falhar
      pushEnabled = false;
      workerSubscriptionId = null;
      persistState();
      deactivateAlertEngine();
      updateButton('default');
      console.warn('[Push][unsubscribe] Estado forçado OFF apesar do erro');
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
    console.log('[Push][init] btn:', !!btn, '| isPushSupported:', isPushSupported());
    if (!btn) return;
    if (!isPushSupported()) return;
    btn.style.display = '';

    // Restaurar estado persistido
    restoreState();
    console.log('[Push][init] pushEnabled (restaurado):', pushEnabled, '| workerSubscriptionId:', workerSubscriptionId);

    if (pushEnabled) {
      // Estado ON: verificar se subscription browser ainda existe
      console.log('[Push][init] Estado ON — validando subscription browser...');
      getExistingSubscription().then(function (subscription) {
        var hasSubscription = !!subscription;
        var hasWorkerId = !!workerSubscriptionId;
        console.log('[Push][init] browser subscription:', hasSubscription, '| workerSubscriptionId:', hasWorkerId);
        if (hasSubscription && hasWorkerId) {
          // Tudo OK: subscription browser + Worker ID existem
          activateAlertEngine();
          updateButton('subscribed');
          console.log('[Push][init] ✅ Estado restaurado: ON');
        } else {
          // Subscription browser ou Worker ID sumiu: forçar OFF
          console.warn('[Push][init] Subscription ou Worker ID ausente — forçando OFF');
          pushEnabled = false;
          workerSubscriptionId = null;
          persistState();
          deactivateAlertEngine();
          updateButton('default');
          console.log('[Push][init] Estado alterado para OFF');
        }
      }).catch(function (err) {
        console.error('[Push][init] Erro ao validar subscription:', err);
        pushEnabled = false;
        workerSubscriptionId = null;
        persistState();
        deactivateAlertEngine();
        updateButton('default');
      });
    } else {
      // Estado OFF: garantir que AlertEngine está desativado
      deactivateAlertEngine();
      updateButton('default');
      console.log('[Push][init] Estado OFF — botão em "Ativar alertas"');

      // Verificar se há subscription browser órfã (limpar)
      getExistingSubscription().then(function (subscription) {
        if (subscription) {
          console.warn('[Push][init] Subscription órfã encontrada — removendo');
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
