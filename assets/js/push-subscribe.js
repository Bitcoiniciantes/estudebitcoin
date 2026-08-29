/* =====================================================================
   Push Subscribe — Inscrição Web Push
   - Botão "Ativar alertas" (só aparece quando suportado)
   - Permissão SOMENTE em clique do usuário
   - iPhone: só mostra se estiver em modo standalone (PWA instalado)
   - Worker /subscribe ainda não existe (Fase 4) — salva em localStorage
   ===================================================================== */
(function () {
  'use strict';

  var VAPID_PUBLIC_KEY = window.PushConfig && window.PushConfig.VAPID_PUBLIC_KEY;
  var WORKER_URL = window.PushConfig && window.PushConfig.WORKER_URL;

  function isPushSupported() {
    if (!('serviceWorker' in navigator)) return false;
    if (!('PushManager' in window)) return false;
    if (!('Notification' in window)) return false;
    // iPhone: só suporta Web Push em PWA instalado (standalone)
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

  function sendToWorker(subscription) {
    if (!WORKER_URL) {
      console.log('[Push] Worker URL não configurada. Subscription salva em localStorage.');
      return Promise.resolve();
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
        updateButton('subscribed');

        // [TEMP TESTE] — Enviar subscription ao Worker para teste
        fetch('https://alerta-worker.bitcoiniciantes.workers.dev/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription)
        }).catch(function() {});

        // Enviar ao Worker
        return sendToWorker(subscription);
      }).catch(function (err) {
        console.error('[Push] Erro na inscrição:', err);
        updateButton('error');
      });
    });
  }

  function unsubscribe() {
    navigator.serviceWorker.ready.then(function (registration) {
      return registration.pushManager.getSubscription();
    }).then(function (subscription) {
      if (!subscription) return;
      return subscription.unsubscribe().then(function () {
        console.log('[Push] Desinscrito.');
        localStorage.removeItem('push_subscription');
        updateButton('default');
      });
    });
  }

  function updateButton(state) {
    var btn = document.getElementById('push-activate-btn');
    if (!btn) return;
    switch (state) {
      case 'subscribed':
        btn.textContent = 'Alertas ativos';
        btn.classList.add('push-active');
        btn.onclick = unsubscribe;
        break;
      case 'denied':
        btn.textContent = 'Permissão negada';
        btn.disabled = true;
        break;
      case 'error':
        btn.textContent = 'Erro ao ativar';
        btn.classList.add('push-error');
        break;
      default:
        btn.textContent = 'Ativar alertas';
        btn.classList.remove('push-active', 'push-error');
        btn.onclick = subscribe;
    }
  }

  function init() {
    var btn = document.getElementById('push-activate-btn');
    console.log('[Push] init() — btn:', !!btn, 'isPushSupported:', isPushSupported());
    if (!btn) return;
    if (!isPushSupported()) return;
    btn.style.display = '';

    // [TEMP TESTE] — Sempre mostrar botão para forçar re-subscription
    btn.style.display = '';
    btn.textContent = 'Ativar alertas (teste)';
    btn.onclick = subscribe;

    getExistingSubscription().then(function (subscription) {
      if (subscription) {
        updateButton('subscribed');
        // Reenviar subscription ao Worker
        fetch('https://alerta-worker.bitcoiniciantes.workers.dev/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription)
        }).then(function(res) { return res.json(); }).then(function(data) {
          console.log('[Push] Subscription reenviada ao Worker:', data);
          alert('Subscription enviada ao Worker! ID: ' + (data.id || 'erro'));
        }).catch(function(e) { console.error('[Push] Erro ao reenviar:', e); });
      }
    });
  }

  // Expor para uso externo se necessário
  window.PushSubscribe = { init: init, subscribe: subscribe, unsubscribe: unsubscribe };

  // Inicializar quando DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
