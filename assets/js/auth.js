/* =====================================================================
   EstudeBitcoin — Login opcional + sincronização de painéis (Firebase)
   ---------------------------------------------------------------------
   - Login 100% OPCIONAL: sem login, tudo funciona com localStorage.
   - Provedores: Google (OAuth, sem senha) + e-mail/senha (com
     confirmação por e-mail e reset — fluxos nativos do Firebase Auth).
   - Reaproveita o projeto Firebase do mural (`BI_CONFIG.firebase`):
     nenhuma chave nova no código. Provedores são ativados no console.
   - SDKs (app/auth/database compat) carregados SOB DEMANDA via
     `BI.loadScripts`. Qualquer falha é silenciosa: a página nunca quebra.
   - Painéis sincronizados no Realtime Database em
     `users/{uid}/panels/{risk,sim}` (+ `updatedAt`).
     Merge "último vence" por painel (local × nuvem).
   - Plano Free do Firebase NÃO pausa por inatividade.

   Eventos (window):
   - 'estudebitcoin:auth-change'  detail: { user } (null no logout)
   - 'estudebitcoin:panel-pull'   detail: { panel, params, updatedAt }

   Expõe: window.EstudeAuth e window.PanelSync
   ===================================================================== */
(function (global) {
  'use strict';

  var LS_PREFIX = 'eb_panel_';
  var PANELS = ['risk', 'sim'];
  var PUSH_DEBOUNCE_MS = 2500;

  /* ---------- Config (projeto do mural; sem chaves novas) ---------- */
  function getCfg() {
    return (global.BI_CONFIG && global.BI_CONFIG.firebase) || {};
  }

  function isConfigured() {
    var c = getCfg();
    return !!(c.apiKey && c.authDomain && c.databaseURL);
  }

  /* ---------- Estado ---------- */
  var fbApp = null;         // firebase.app (lazy)
  var fbLoading = null;     // promise do carregamento dos SDKs
  var currentUser = null;   // { id, email, name, verified, provider }
  var authListeners = [];

  function emit(name, detail) {
    try {
      if (global.dispatchEvent && global.CustomEvent) {
        global.dispatchEvent(new global.CustomEvent(name, { detail: detail }));
      }
    } catch (e) { /* broadcast opcional */ }
  }

  function refreshHeaderLater() {
    refreshHeader();
  }

  function notifyAuth() {
    for (var i = 0; i < authListeners.length; i++) {
      try { authListeners[i](currentUser); } catch (e) { /* ouvinte isolado */ }
    }
    emit('estudebitcoin:auth-change', { user: currentUser });
    refreshHeaderLater();
  }

  function normUser(fu) {
    if (!fu) return null;
    var provs = fu.providerData || [];
    var isPasswordOnly = provs.length > 0;
    for (var i = 0; i < provs.length; i++) {
      if (provs[i] && provs[i].providerId !== 'password') { isPasswordOnly = false; break; }
    }
    return {
      id: fu.uid,
      email: fu.email || '',
      name: fu.displayName || fu.email || 'Usuário',
      verified: !!fu.emailVerified,
      passwordOnly: isPasswordOnly,
      _ref: fu
    };
  }

  /* ---------- SDK sob demanda ---------- */
  function ensureFirebase() {
    if (fbApp) return Promise.resolve(fbApp);
    if (!isConfigured()) return Promise.resolve(null);
    if (fbLoading) return fbLoading;
    var cdn = (global.BI_CONFIG && global.BI_CONFIG.cdn) || {};
    var list = [
      cdn.firebaseApp || 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
      cdn.firebaseAuth || 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js',
      cdn.firebaseDb || 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js'
    ];
    var loader = (global.BI && global.BI.loadScripts)
      ? global.BI.loadScripts(list)
      : Promise.reject(new Error('carregador indisponível'));
    fbLoading = loader.then(function () {
      if (!global.firebase || !global.firebase.apps) {
        throw new Error('SDK Firebase indisponível.');
      }
      if (!global.firebase.apps.length) global.firebase.initializeApp(getCfg());
      fbApp = global.firebase;
      return fbApp;
    }).catch(function (err) {
      fbLoading = null;
      throw err;
    });
    return fbLoading;
  }

  function auth() { return fbApp.auth(); }
  function db() { return fbApp.database(); }
  function panelRef(uid, panel) { return db().ref('users/' + uid + '/panels/' + panel); }

  /* ---------- Auth ---------- */
  function afterUser(fu) {
    var next = normUser(fu);
    var changed = (!!next !== !!currentUser) ||
      (next && currentUser && next.id !== currentUser.id);
    currentUser = next;
    if (changed && next) {
      PanelSync.syncOnLogin().catch(function () { /* sync opcional */ });
    }
    notifyAuth();
    return next;
  }

  function signInGoogle() {
    return ensureFirebase().then(function (fb) {
      if (!fb) throw new Error('Login ainda não configurado.');
      var provider = new fb.auth.GoogleAuthProvider();
      return auth().signInWithPopup(provider).then(function (cred) {
        return afterUser(cred.user) && true;
      }, function (err) {
        // Popup bloqueado/fechado (comum em PWA/iOS) → tenta redirect.
        if (err && (err.code === 'auth/popup-blocked' ||
            err.code === 'auth/popup-closed-by-user' ||
            err.code === 'auth/cancelled-popup-request')) {
          return auth().signInWithRedirect(provider).then(function () { return true; });
        }
        throw err;
      });
    });
  }

  function needsVerification(user) {
    return user && user.passwordOnly && !user.verified;
  }

  function signInEmail(email, senha) {
    return ensureFirebase().then(function (fb) {
      if (!fb) throw new Error('Login ainda não configurado.');
      return auth().signInWithEmailAndPassword(email, senha);
    }).then(function (cred) {
      var u = normUser(cred.user);
      if (needsVerification(u)) {
        return auth().signOut().then(function () {
          var err = new Error('E-mail não confirmado.');
          err.code = 'auth/email-not-verified';
          err.pendingEmail = email;
          throw err;
        });
      }
      afterUser(cred.user);
      return u;
    });
  }

  function signUpEmail(email, senha) {
    return ensureFirebase().then(function (fb) {
      if (!fb) throw new Error('Login ainda não configurado.');
      return auth().createUserWithEmailAndPassword(email, senha);
    }).then(function (cred) {
      var redirect = global.location.href.split('#')[0];
      return cred.user.sendEmailVerification({ url: redirect }).catch(function () {
        /* e-mail de verificação falhou; conta criada mesmo assim */
      }).then(function () {
        // Sai até confirmar (evita sessão não verificada sincronizando).
        return auth().signOut().then(function () {
          return { user: normUser(cred.user), session: null };
        });
      });
    });
  }

  function resendVerification(email, senha) {
    // Reenvia confirmação: entra temporariamente só para enviar o e-mail.
    return ensureFirebase().then(function (fb) {
      if (!fb) throw new Error('Login ainda não configurado.');
      return auth().signInWithEmailAndPassword(email, senha);
    }).then(function (cred) {
      return cred.user.sendEmailVerification().then(function () {
        return auth().signOut();
      }, function (err) {
        return auth().signOut().then(function () { throw err; });
      });
    });
  }

  function sendReset(email) {
    return ensureFirebase().then(function (fb) {
      if (!fb) throw new Error('Login ainda não configurado.');
      return fb.auth().sendPasswordResetEmail(email);
    }).then(function () { return true; });
  }

  function signOut() {
    var done = function () {
      currentUser = null;
      notifyAuth();
    };
    if (!fbApp) { done(); return Promise.resolve(true); }
    return auth().signOut().then(done, done);
  }

  function deleteMyData() {
    // Apaga os painéis da nuvem e encerra a sessão.
    // (A exclusão do usuário Auth é feita no console Firebase, se desejado.)
    if (!fbApp || !currentUser) return signOut();
    var uid = currentUser.id;
    return db().ref('users/' + uid + '/panels').remove()
      .then(function () { return true; }, function () { return false; })
      .then(function () { return signOut(); });
  }

  /* ---------- PanelSync (local + nuvem) ---------- */
  function lsKey(panel) { return LS_PREFIX + panel; }

  function saveLocal(panel, params) {
    if (PANELS.indexOf(panel) === -1) return false;
    try {
      global.localStorage.setItem(lsKey(panel), JSON.stringify({
        params: params || null,
        updatedAt: new Date().toISOString()
      }));
      schedulePush(panel);
      return true;
    } catch (e) { return false; }
  }

  function loadLocal(panel) {
    try {
      var raw = global.localStorage.getItem(lsKey(panel));
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      return { params: obj.params || null, updatedAt: obj.updatedAt || null };
    } catch (e) { return null; }
  }

  function newer(a, b) {
    if (!a) return false;
    if (!b) return true;
    return String(a) > String(b);
  }

  var pushTimers = {};
  function schedulePush(panel) {
    if (!currentUser || !currentUser.verified) return; // anônimo/não verificado: só local
    if (pushTimers[panel]) global.clearTimeout(pushTimers[panel]);
    pushTimers[panel] = global.setTimeout(function () {
      pushTimers[panel] = null;
      pushPanel(panel).catch(function () { /* retry no próximo save/login */ });
    }, PUSH_DEBOUNCE_MS);
  }

  function pushPanel(panel) {
    var local = loadLocal(panel);
    if (!local || !local.params) return Promise.resolve(false);
    if (!fbApp || !currentUser) return Promise.resolve(false);
    return panelRef(currentUser.id, panel).set({
      params: local.params,
      updatedAt: local.updatedAt || new Date().toISOString()
    }).then(function () { return true; });
  }

  function pullPanels() {
    if (!fbApp || !currentUser) return Promise.resolve({});
    var uid = currentUser.id;
    var jobs = PANELS.map(function (panel) {
      return panelRef(uid, panel).once('value').then(function (snap) {
        var row = snap.val();
        if (!row || !row.params) return null;
        var local = loadLocal(panel);
        if (newer(row.updatedAt, local && local.updatedAt)) {
          try {
            global.localStorage.setItem(lsKey(panel), JSON.stringify({
              params: row.params, updatedAt: row.updatedAt
            }));
          } catch (e) { /* segue emitindo para a UI */ }
          emit('estudebitcoin:panel-pull', {
            panel: panel, params: row.params, updatedAt: row.updatedAt
          });
          return panel;
        }
        return null;
      }, function () { return null; });
    });
    return Promise.all(jobs).then(function (done) {
      var applied = {};
      done.forEach(function (p) { if (p) applied[p] = true; });
      return applied;
    });
  }

  function syncOnLogin() {
    return pullPanels().then(function () {
      var jobs = PANELS.map(function (panel) {
        var local = loadLocal(panel);
        if (!local || !local.params || !fbApp || !currentUser) {
          return Promise.resolve(false);
        }
        return panelRef(currentUser.id, panel).once('value').then(function (snap) {
          var row = snap.val();
          var cloudTs = (row && row.updatedAt) || null;
          if (newer(local.updatedAt, cloudTs)) return pushPanel(panel);
          return false;
        }, function () { return false; });
      });
      return Promise.all(jobs);
    });
  }

  var PanelSync = {
    PANELS: PANELS.slice(),
    saveLocal: saveLocal,
    loadLocal: loadLocal,
    pushPanel: pushPanel,
    pullPanels: pullPanels,
    syncOnLogin: syncOnLogin,
    schedulePush: schedulePush
  };

  /* ---------- Modal ---------- */
  function $(id) { return global.document ? document.getElementById(id) : null; }

  function setView(view) {
    var views = ['login', 'signup', 'reset', 'verify', 'account'];
    views.forEach(function (v) {
      var el = $('eb-login-view-' + v);
      if (el) el.hidden = (v !== view);
    });
    setError('');
  }

  function setError(msg) {
    var el = $('eb-login-error');
    if (el) {
      el.textContent = msg || '';
      el.style.display = msg ? 'block' : 'none';
    }
  }

  function setLoading(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.setAttribute('data-label', btn.textContent);
      btn.textContent = 'Aguarde…';
      btn.disabled = true;
    } else {
      btn.textContent = label || btn.getAttribute('data-label') || btn.textContent;
      btn.disabled = false;
    }
  }

  function friendlyError(err) {
    var code = (err && err.code) || '';
    var m = String((err && err.message) || err || '');
    if (code === 'auth/email-not-verified') return 'NOT_VERIFIED';
    if (/invalid-credential|wrong-password|user-not-found|invalid-email/i.test(code + ' ' + m) ||
        /invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos. Esqueceu? Use "Esqueci a senha".';
    if (/email-already-in-use|already registered/i.test(code + ' ' + m)) return 'Este e-mail já tem conta. Entre com sua senha ou clique em "Esqueci a senha".';
    if (/weak-password|weak|short|length/i.test(code + ' ' + m)) return 'Use uma senha com 6+ caracteres.';
    if (/too-many-requests|rate limit|too many/i.test(code + ' ' + m)) return 'Muitas tentativas. Aguarde um pouco.';
    if (/network-request-failed|network/i.test(code)) return 'Sem conexão. Verifique a internet e tente de novo.';
    if (/operation-not-allowed/i.test(code)) return 'Este método de login ainda não foi ativado.';
    return m || 'Não foi possível concluir. Tente de novo.';
  }

  function openModal(view) {
    var ov = $('eb-login-overlay');
    if (!ov) return;
    if (currentUser) setView('account');
    else setView(view || 'login');
    ov.hidden = false;
    try { document.body.style.overflow = 'hidden'; } catch (e) {}
    var first = ov.querySelector('input[type="email"]');
    if (first && !currentUser) { try { first.focus(); } catch (e) {} }
  }

  function closeModal() {
    var ov = $('eb-login-overlay');
    if (ov) ov.hidden = true;
    try { document.body.style.overflow = ''; } catch (e) {}
  }

  function refreshHeader() {
    var btn = $('eb-login-btn');
    if (!btn) return;
    if (currentUser) {
      var name = String(currentUser.name || currentUser.email || 'U').trim();
      var initial = (name.charAt(0) || 'U').toUpperCase();
      btn.innerHTML = '';
      var av = document.createElement('span');
      av.className = 'eb-login-avatar';
      av.textContent = initial;
      btn.appendChild(av);
      btn.setAttribute('aria-label', 'Minha conta (' + name + ')');
    } else {
      btn.textContent = 'Entrar';
      btn.setAttribute('aria-label', 'Entrar');
    }
  }

  function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()); }

  function showVerify(text) {
    setView('verify');
    var v = $('eb-login-verify-text');
    if (v && text) v.textContent = text;
  }

  function bindModal() {
    if (!global.document) return false;
    if (!$('eb-login-overlay') || !$('eb-login-btn')) return false;
    if (bindModal.done) return true;
    bindModal.done = true;

    $('eb-login-btn').addEventListener('click', function () { openModal(); });
    var ov = $('eb-login-overlay');
    ov.addEventListener('click', function (ev) {
      if (ev.target === ov || ev.target.getAttribute('data-close') === '1') closeModal();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !ov.hidden) closeModal();
    });

    function gateConfigured() {
      if (isConfigured()) return true;
      setError('Login será ativado em breve. Por enquanto, suas simulações ficam salvas neste navegador.');
      return false;
    }

    var gBtn = $('eb-login-google');
    if (gBtn) gBtn.addEventListener('click', function () {
      if (!gateConfigured()) return;
      setLoading(gBtn, true);
      signInGoogle().then(function () {
        setLoading(gBtn, false, 'Continuar com Google');
        closeModal();
      }).catch(function (err) {
        setLoading(gBtn, false, 'Continuar com Google');
        setError(friendlyError(err));
      });
      // Redirect (fallback mobile/PWA): a página recarrega logada.
    });

    function wireForm(formId, btnId, fn) {
      var form = $(formId), btn = $(btnId);
      if (!form || !btn) return;
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (!gateConfigured()) return;
        var email = $(formId + '-email');
        var pass = $(formId + '-pass');
        var e = email ? String(email.value || '').trim() : '';
        var p = pass ? String(pass.value || '') : '';
        if (!validEmail(e)) { setError('Informe um e-mail válido.'); return; }
        if (formId !== 'eb-login-form-reset' && p.length < 6) {
          setError('A senha precisa de 6+ caracteres.'); return;
        }
        setLoading(btn, true);
        fn(e, p).then(function (res) {
          setLoading(btn, false);
          if (formId === 'eb-login-form-signup') {
            showVerify('Enviamos um link de confirmação para ' + e + '. Clique nele e depois entre normalmente.');
          } else if (formId === 'eb-login-form-reset') {
            showVerify('Se este e-mail tiver conta, enviamos o link de redefinição. Verifique sua caixa de entrada.');
          } else { closeModal(); }
        }).catch(function (err) {
          setLoading(btn, false);
          var f = friendlyError(err);
          if (f === 'NOT_VERIFIED') {
            lastPending = { email: e, pass: p };
            showVerify('Este e-mail ainda não foi confirmado. Verifique sua caixa de entrada — ou reenvie abaixo.');
            ensureResend();
          } else {
            setError(f);
          }
        });
      });
    }
    wireForm('eb-login-form-login', 'eb-login-submit', signInEmail);
    wireForm('eb-login-form-signup', 'eb-login-signup', signUpEmail);
    wireForm('eb-login-form-reset', 'eb-login-reset', function (e) { return sendReset(e); });

    // Reenvio de confirmação na tela de verificação.
    var lastPending = null;
    function ensureResend() {
      var v = $('eb-login-view-verify');
      if (!v || $('eb-login-resend')) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.id = 'eb-login-resend';
      b.className = 'eb-login-secondary';
      b.textContent = 'Reenviar e-mail de confirmação';
      b.addEventListener('click', function () {
        if (!lastPending) return;
        setLoading(b, true);
        resendVerification(lastPending.email, lastPending.pass).then(function () {
          setLoading(b, false, 'Reenviar e-mail de confirmação');
          showVerify('Reenviamos para ' + lastPending.email + '. Verifique sua caixa de entrada.');
        }).catch(function (err) {
          setLoading(b, false, 'Reenviar e-mail de confirmação');
          setError(friendlyError(err));
        });
      });
      var links = v.querySelector('.eb-login-links');
      if (links) v.insertBefore(b, links);
      else v.appendChild(b);
    }

    function link(id, view) {
      var el = $(id);
      if (el) el.addEventListener('click', function (ev) { ev.preventDefault(); setView(view); });
    }
    link('eb-login-to-signup', 'signup');
    link('eb-login-to-login', 'login');
    link('eb-login-to-login2', 'login');
    link('eb-login-to-reset', 'reset');
    link('eb-login-back-login', 'login');

    var out = $('eb-login-logout');
    if (out) out.addEventListener('click', function () {
      signOut().then(function () { setView('login'); });
    });
    var del = $('eb-login-delete');
    if (del) del.addEventListener('click', function () {
      if (!global.confirm('Apagar suas simulações salvas na nuvem e sair?')) return;
      deleteMyData().then(function () { setView('login'); });
    });

    var obs = function (user) {
      var em = $('eb-login-account-email');
      if (em) em.textContent = user ? (user.email || '') : '';
    };
    authListeners.push(obs);
    return true;
  }

  var EstudeAuth = {
    isConfigured: isConfigured,
    getUser: function () { return currentUser; },
    onAuthChange: function (fn) {
      if (typeof fn === 'function') authListeners.push(fn);
      return fn;
    },
    signInGoogle: signInGoogle,
    signInEmail: signInEmail,
    signUpEmail: signUpEmail,
    sendReset: sendReset,
    signOut: signOut,
    deleteMyData: deleteMyData,
    openModal: openModal,
    closeModal: closeModal,
    refreshHeader: refreshHeader
  };

  global.EstudeAuth = EstudeAuth;
  global.PanelSync = PanelSync;

  /* ---------- Boot (nunca quebra a página) ---------- */
  function boot() {
    try {
      bindModal();
      refreshHeader();
      if (isConfigured()) {
        ensureFirebase().then(function (fb) {
          if (!fb) return;
          // Conclui login por redirect (mobile/PWA) e acompanha a sessão.
          fb.auth().getRedirectResult().catch(function () { /* sem redirect pendente */ });
          fb.auth().onAuthStateChanged(function (fu) { afterUser(fu); });
        }).catch(function () { /* silencioso */ });
      }
    } catch (e) { /* login opcional: nunca quebra a página */ }
  }

  if (global.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
