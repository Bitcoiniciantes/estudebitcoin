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
  var LS_KEY_LEGACY = LS_PREFIX + 'risk'; // 'eb_panel_risk' (slot único legado)
  var LS_LAST_ASSET = 'eb_last_risk_asset';
  var RISK_ASSETS_FALLBACK = ['BTC', 'ETH', 'SOL', 'LINK', 'AVAX', 'RENDER', 'PAXG'];

  /* ---------- Identidade do ativo (multi-ativo) ----------
   * currentAssetId é SOMENTE estado da UI. Operações assíncronas (pull/push)
   * recebem o asset explicitamente e NUNCA leem essa global dentro de
   * .then()/.catch()/timers — ver pullOneRiskAsset() e schedulePush(). */
  var currentAssetId = null;

  function canonAssetId(v) {
    try {
      if (global.BI && global.BI.normalizeSymbol) return global.BI.normalizeSymbol(v) || null;
    } catch (e) { /* fallback abaixo */ }
    var s = String(v == null ? '' : v).trim().toUpperCase().replace(/USDT$/, '');
    return s || null;
  }

  // Fonte de verdade: <select id="re-simbolo">. Lida no momento do uso
  // (pull/sync), nunca cacheada no parse — indexsemalavancagem.html nem tem
  // o select, e um cache quebraria silenciosamente com defer/reordenação.
  function getRiskAssets() {
    try {
      var sel = global.document ? document.getElementById('re-simbolo') : null;
      if (sel && sel.options && sel.options.length) {
        var out = [];
        for (var i = 0; i < sel.options.length; i++) {
          var v = canonAssetId(sel.options[i].value || sel.options[i].text);
          if (v && out.indexOf(v) === -1) out.push(v);
        }
        if (out.length) return out;
      }
    } catch (e) { /* fallback abaixo */ }
    return RISK_ASSETS_FALLBACK.slice();
  }

  // Resolve o asset efetivo para o painel 'risk'. Para 'sim' retorna null
  // (painel ativo-agnóstico, chave única preservada).
  function resolveRiskAsset(panel, asset) {
    if (panel !== 'risk') return null;
    return canonAssetId(asset || currentAssetId);
  }

  /* ---------- Migração do slot único legado (localStorage) ----------
   * eb_panel_risk → eb_panel_risk_{assetId}. Idempotente, preserva o mais
   * recente, remove o legado só após copiar. Roda no parse do script
   * (top-level), pois risk-engine-panel.js carrega ANTES de auth.js e seu
   * bind() (DOMContentLoaded) pode rodar antes do boot() daqui. */
  function migrateLegacyRisk() {
    try {
      if (!global.localStorage) return;
      var raw = global.localStorage.getItem(LS_KEY_LEGACY);
      if (!raw) return; // sem dados legados
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !obj.params || typeof obj.params !== 'object') {
        try { global.localStorage.removeItem(LS_KEY_LEGACY); } catch (e) {}
        return; // formato inválido, limpa
      }
      var assetId = canonAssetId(obj.params.simbolo) || 'BTC';
      obj.params.simbolo = assetId;
      var newKey = LS_PREFIX + 'risk_' + assetId;
      var existing = null;
      try { existing = JSON.parse(global.localStorage.getItem(newKey) || 'null'); } catch (e) {}
      if (!existing || !existing.updatedAt || !obj.updatedAt ||
          !(String(existing.updatedAt) > String(obj.updatedAt))) {
        try {
          global.localStorage.setItem(newKey, JSON.stringify({
            params: obj.params, updatedAt: obj.updatedAt || new Date().toISOString()
          }));
        } catch (e) { return; }
      }
      try { global.localStorage.removeItem(LS_KEY_LEGACY); } catch (e) {}
    } catch (e) { /* best-effort, nunca quebra a página */ }
  }

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
      anonymous: !!fu.isAnonymous,
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
  function panelRef(uid, panel, asset) {
    var path = 'users/' + uid + '/panels/' + panel;
    var a = resolveRiskAsset(panel, asset);
    if (a) path += '/' + a;
    return db().ref(path);
  }

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

  /* ---------- Sessão anônima (Fase 2, carteira) ----------
   * Cria sessão anônima sob demanda (lazy: só quando a carteira precisa),
   * com guarda contra disparos concorrentes do onAuthStateChanged.
   * Vinculação preserva o UID (link, nunca nova conta). */
  var anonBusy = false;

  // Resolve na PRIMEIRA emissão do onAuthStateChanged — sinal do Firebase
  // de que a restauração da sessão terminou (com usuário ou sem).
  // Sem isso, checar currentUser no boot pega o momento null e cria
  // sessão duplicada a cada refresh.
  var authReadyPromise = null;
  function awaitAuthReady() {
    if (authReadyPromise) return authReadyPromise;
    authReadyPromise = ensureFirebase().then(function (fb) {
      if (!fb) return null;
      return new Promise(function (resolve) {
        var done = false;
        var to = setTimeout(function () {
          if (!done) { done = true; resolve(null); }
        }, 8000);
        try {
          var off = auth().onAuthStateChanged(function (fu) {
            if (!done) {
              done = true; clearTimeout(to);
              try { off(); } catch (e) {}
              resolve(fu || null);
            }
          });
        } catch (e) {
          if (!done) { done = true; clearTimeout(to); resolve(null); }
        }
      });
    }).catch(function () { return null; });
    return authReadyPromise;
  }

  // Trava entre abas para criação de anônimo: só uma aba cria; as outras
  // esperam o listener (a sessão é compartilhada via storage do Firebase).
  function anonClaim() {
    try {
      var k = 'eb_anon_claim';
      var now = Date.now();
      var raw = global.localStorage.getItem(k);
      if (raw) {
        var claim = JSON.parse(raw);
        if (claim && (now - claim.at) < 20000) return false; // outra aba criando
      }
      global.localStorage.setItem(k, JSON.stringify({ at: now }));
      return true;
    } catch (e) { return true; }
  }

  function anonUnclaim() {
    try { global.localStorage.removeItem('eb_anon_claim'); } catch (e) {}
  }

  function waitForUser(timeoutMs) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var to = setTimeout(function () {
        if (!done) { done = true; reject(new Error('Tempo esgotado.')); }
      }, timeoutMs || 15000);
      try {
        var off = auth().onAuthStateChanged(function (fu) {
          if (fu && !done) {
            done = true; clearTimeout(to);
            try { off(); } catch (e) {}
            resolve(fu);
          }
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(to); reject(e); }
      }
    });
  }

  function ensureAnonymous() {
    return ensureFirebase().then(function (fb) {
      if (!fb) throw new Error('Login ainda não configurado.');
      // 1. Sessão já viva? Retorna sem criar nada.
      var cur = null;
      try { cur = auth().currentUser; } catch (e) {}
      if (cur) return normUser(cur);
      // 2. Aguarda a restauração (pode haver sessão salva chegando).
      return awaitAuthReady().then(function (fu) {
        if (fu) return normUser(fu);
        var mine = false;
        try { mine = (auth().currentUser == null) && anonClaim(); } catch (e) { mine = true; }
        if (!mine) {
          // Outra aba está criando: espera o usuário aparecer.
          return waitForUser(15000).then(function (u2) { return normUser(u2); });
        }
        if (anonBusy) {
          anonUnclaim();
          return waitForUser(15000).then(function (u2) { return normUser(u2); });
        }
        anonBusy = true;
        return auth().signInAnonymously().then(function (cred) {
          anonBusy = false;
          anonUnclaim();
          return normUser(cred.user);
        }).catch(function (err) {
          anonBusy = false;
          anonUnclaim();
          throw err;
        });
      });
    });
  }

  function isAnonymousSession() {
    try {
      var u = auth().currentUser;
      return !!(u && u.isAnonymous);
    } catch (e) { return false; }
  }

  function linkGoogle() {
    return ensureFirebase().then(function (fb) {
      if (!fb) throw new Error('Login ainda não configurado.');
      var provider = new fb.auth.GoogleAuthProvider();
      if (isAnonymousSession()) {
        return auth().currentUser.linkWithPopup(provider).then(function (cred) {
          afterUser(cred.user);
          return true;
        });
      }
      return signInGoogle();
    });
  }

  function linkEmail(email, senha) {
    return ensureFirebase().then(function (fb) {
      if (!fb) throw new Error('Login ainda não configurado.');
      if (isAnonymousSession()) {
        var credential = fb.auth.EmailAuthProvider.credential(email, senha);
        return auth().currentUser.linkWithCredential(credential).then(function (cred) {
          afterUser(cred.user);
          return normUser(cred.user);
        });
      }
      return signInEmail(email, senha);
    });
  }

  function signInGoogle() {
    // Sessão anônima ativa: vincular (preserva UID e carteira) em vez de
    // trocar de sessão (o que orfanaria os dados do UID anônimo).
    try {
      if (isAnonymousSession()) return linkGoogle();
    } catch (e) {}
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
    try {
      if (isAnonymousSession()) return linkEmail(email, senha);
    } catch (e) {}
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
    // Cadastro com sessão anônima ativa = vinculação (preserva UID).
    // createUser trocaria de sessão e orfanaria a carteira anônima.
    try {
      if (isAnonymousSession()) return linkEmail(email, senha);
    } catch (e) {}
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
    // 1. Capturar uid ANTES de qualquer mudança de estado.
    var uid = currentUser && currentUser.id;

    // 2. Cancelar todos os timers pendentes e coletar as operações de flush.
    //    O flush usa o uid capturado — nunca lê currentUser depois daqui.
    var flushJobs = [];
    if (uid && fbApp) {
      var timerKeys = Object.keys(pushTimers);
      timerKeys.forEach(function (timerKey) {
        if (pushTimers[timerKey]) {
          global.clearTimeout(pushTimers[timerKey]);
          pushTimers[timerKey] = null;
          // Reconstruir panel e asset a partir do timerKey ('sim', 'risk:BTC', etc.)
          var parts = timerKey.split(':');
          var pnl = parts[0];
          var ast = parts.length > 1 ? parts.slice(1).join(':') : null;
          // Flush best-effort: tenta enviar antes do logout.
          // Se falhar, o dado fica no LS com owner = uid (não vaza para B).
          flushJobs.push(
            pushPanel(pnl, ast, uid).catch(function () { /* best-effort */ })
          );
        }
      });
    }

    var done = function () {
      // 3. Limpar eb_panel_sim do LS para isolar a sessão seguinte.
      //    eb_panel_risk_* são preservados (multi-ativo; owner protege downstream).
      try { global.localStorage.removeItem(lsKey('sim')); } catch (e) {}
      currentUser = null;
      notifyAuth();
    };

    // 4. Aguardar flush, depois executar o signOut do Firebase.
    var flushAll = flushJobs.length
      ? Promise.all(flushJobs)
      : Promise.resolve();

    if (!fbApp) {
      return flushAll.then(function () { done(); return true; });
    }
    return flushAll
      .then(function () { return auth().signOut(); })
      .then(done, done);
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
  function lsKey(panel, asset) {
    var a = resolveRiskAsset(panel, asset);
    if (a) return LS_PREFIX + panel + '_' + a;
    return LS_PREFIX + panel;
  }

  function saveLocal(panel, params, asset) {
    if (PANELS.indexOf(panel) === -1) return false;
    var a = resolveRiskAsset(panel, asset);
    try {
      global.localStorage.setItem(lsKey(panel, a), JSON.stringify({
        params: params || null,
        updatedAt: new Date().toISOString(),
        owner: (currentUser && currentUser.id) || null
      }));
      schedulePush(panel, a);
      return true;
    } catch (e) { return false; }
  }

  function loadLocal(panel, asset) {
    try {
      var a = resolveRiskAsset(panel, asset);
      var raw = global.localStorage.getItem(lsKey(panel, a));
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      // owner: string uid, null (anônimo/legado) ou ausente (legado sem campo)
      var owner = Object.prototype.hasOwnProperty.call(obj, 'owner') ? obj.owner : undefined;
      return { params: obj.params || null, updatedAt: obj.updatedAt || null, owner: owner };
    } catch (e) { return null; }
  }

  /* Determina a relação entre o estado local e o uid da sessão atual.
   * Retorna: 'self' | 'other' | 'legacy'
   *   self   = owner === uid (dado pertence ao usuário atual)
   *   other  = owner existe e é diferente de uid (dado de outra sessão)
   *   legacy = owner ausente/null (estado anônimo ou legado sem carimbo) */
  function isOwnedBy(localObj, uid) {
    if (!localObj) return 'legacy';
    var o = localObj.owner;
    if (o === undefined || o === null) return 'legacy';
    return o === uid ? 'self' : 'other';
  }

  function newer(a, b) {
    if (!a) return false;
    if (!b) return true;
    return String(a) > String(b);
  }

  // Debounce INDEPENDENTE por ativo: pushTimers['risk:BTC'], ['risk:ETH'], ...
  // Um save de BTC nunca cancela o push pendente de ETH.
  var pushTimers = {};
  function schedulePush(panel, asset) {
    if (!currentUser || !currentUser.verified) return; // anônimo/não verificado: só local
    var a = resolveRiskAsset(panel, asset);
    var timerKey = panel + (a ? ':' + a : '');
    var scheduledUid = currentUser.id; // capturado agora — o callback nunca relê currentUser
    if (pushTimers[timerKey]) global.clearTimeout(pushTimers[timerKey]);
    pushTimers[timerKey] = global.setTimeout(function () {
      pushTimers[timerKey] = null;
      pushPanel(panel, a, scheduledUid).catch(function () { /* retry no próximo save/login */ });
    }, PUSH_DEBOUNCE_MS);
  }

  /* uid: UID explícito do destinatário do push. Obrigatório — a função nunca
   * lê currentUser.id como destino, eliminando o risco de timer residual
   * redirecionar dados de A para a nuvem de B após troca de sessão. */
  function pushPanel(panel, asset, uid) {
    if (!uid) return Promise.resolve(false);
    var a = resolveRiskAsset(panel, asset);
    var local = loadLocal(panel, a);
    if (!local || !local.params) return Promise.resolve(false);
    if (!fbApp) return Promise.resolve(false);
    // Guarda adicional: se a sessão mudou para outro uid, aborta.
    if (currentUser && currentUser.id !== uid) return Promise.resolve(false);
    emit('estudebitcoin:panel-push-start', { panel: panel, asset: a });
    return panelRef(uid, panel, a).set({
      params: local.params,
      updatedAt: local.updatedAt || new Date().toISOString()
    }).then(function () {
      emit('estudebitcoin:panel-push-success', { panel: panel, asset: a });
      return true;
    }, function (err) {
      emit('estudebitcoin:panel-push-error', { panel: panel, asset: a });
      throw err;
    });
  }

  /* Pull de UM asset do painel risk. ref+key são computados em escopo local
   * ANTES do .then() — o callback assíncrono NUNCA lê currentAssetId, que
   * pode ter mudado enquanto a resposta trafegava (race do Bug 1). */
  function pullOneRiskAsset(uid, assetId) {
    var a = canonAssetId(assetId);
    if (!a) return Promise.resolve(null);
    var ref = panelRef(uid, 'risk', a);
    var key = lsKey('risk', a);
    return ref.once('value').then(function (snap) {
      var row = snap.val();
      if (!row || !row.params) return null;
      var local = loadLocal('risk', a);
      if (newer(row.updatedAt, local && local.updatedAt)) {
        try {
          global.localStorage.setItem(key, JSON.stringify({
            params: row.params, updatedAt: row.updatedAt, owner: uid
          }));
        } catch (e) { /* segue emitindo para a UI */ }
        emit('estudebitcoin:panel-pull', {
          panel: 'risk', asset: a, params: row.params, updatedAt: row.updatedAt
        });
        return 'risk:' + a;
      }
      return null;
    }, function () { return null; });
  }

  function pullPanels() {
    if (!fbApp || !currentUser) return Promise.resolve({});
    var uid = currentUser.id;
    var jobs = PANELS.map(function (panel) {
      if (panel === 'risk') {
        return Promise.all(getRiskAssets().map(function (a) {
          return pullOneRiskAsset(uid, a);
        }));
      }
      return panelRef(uid, panel).once('value').then(function (snap) {
        var row = snap.val();
        if (!row || !row.params) return null;
        var local = loadLocal(panel);
        if (newer(row.updatedAt, local && local.updatedAt)) {
          try {
            global.localStorage.setItem(lsKey(panel), JSON.stringify({
              params: row.params, updatedAt: row.updatedAt, owner: uid
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
      done.forEach(function (group) {
        (Array.isArray(group) ? group : [group]).forEach(function (p) {
          if (p) applied[p] = true;
        });
      });
      return applied;
    });
  }

  /* Migração RTDB do slot único legado.
   * CRÍTICO: `users/{uid}/panels/risk` é PAI de `risk/{asset}`. NUNCA fazer
   * riskRef.remove() — apagaria os filhos já migrados a cada login (Bug 3).
   * Nulifica SÓ os campos legados via update({params:null, updatedAt:null}). */
  function migrateLegacyCloudRisk(uid) {
    if (!fbApp || !uid) return Promise.resolve(null);
    var riskRef = db().ref('users/' + uid + '/panels/risk');
    return riskRef.once('value').then(function (snap) {
      var row = snap.val();
      if (!row || !row.params || typeof row.params !== 'object') return null;
      var assetId = canonAssetId(row.params.simbolo) || 'BTC';
      var childRef = db().ref('users/' + uid + '/panels/risk/' + assetId);
      return childRef.once('value').then(function (childSnap) {
        var existing = childSnap.val();
        var write = Promise.resolve(false);
        if (!existing || !existing.updatedAt || !row.updatedAt ||
            !(String(existing.updatedAt) > String(row.updatedAt))) {
          row.params.simbolo = assetId;
          write = childRef.set({ params: row.params, updatedAt: row.updatedAt });
        }
        return write.then(function () {
          return riskRef.update({ params: null, updatedAt: null });
        });
      });
    }).catch(function () { return null; /* best-effort */ });
  }

  function syncOnLogin() {
    if (!fbApp || !currentUser) return Promise.resolve([]);
    var uid = currentUser.id;
    return migrateLegacyCloudRisk(uid).then(function () {
      return pullPanels();
    }).then(function () {
      var jobs = [];
      PANELS.forEach(function (panel) {
        if (panel === 'risk') {
          // Empurra SOMENTE se o local for mais novo que a nuvem E pertencer
          // ao usuário atual. Legado/anônimo (legacy) preserva o fluxo atual.
          getRiskAssets().forEach(function (a) {
            jobs.push(panelRef(uid, panel, a).once('value').then(function (snap) {
              var row = snap.val();
              var cloudTs = (row && row.updatedAt) || null;
              var local = loadLocal(panel, a);
              var ownership = isOwnedBy(local, uid);
              if (ownership === 'other') {
                // Estado de outra sessão: descartar imediatamente, nunca empurrar.
                try { global.localStorage.removeItem(lsKey(panel, a)); } catch (e) {}
                return false;
              }
              // 'self' ou 'legacy': merge por updatedAt (comportamento original).
              if (local && local.params && newer(local.updatedAt, cloudTs)) {
                return pushPanel(panel, a, uid);
              }
              return false;
            }, function () {
              // Falha de rede: se o LS pertence a outro usuário, descarta aqui também.
              var local = loadLocal(panel, a);
              if (isOwnedBy(local, uid) === 'other') {
                try { global.localStorage.removeItem(lsKey(panel, a)); } catch (e) {}
              }
              return false;
            }));
          });
        } else {
          // Painel sim (e outros painéis não-risk)
          var local = loadLocal(panel);
          var ownership = isOwnedBy(local, uid);
          if (ownership === 'other') {
            // Estado de outra sessão: descartar imediatamente, nunca empurrar.
            try { global.localStorage.removeItem(lsKey(panel)); } catch (e) {}
            jobs.push(Promise.resolve(false));
            return;
          }
          if (!local || !local.params) {
            jobs.push(Promise.resolve(false));
            return;
          }
          // 'self' ou 'legacy': merge por updatedAt (comportamento original).
          jobs.push(panelRef(uid, panel).once('value').then(function (snap) {
            var row = snap.val();
            var cloudTs = (row && row.updatedAt) || null;
            if (newer(local.updatedAt, cloudTs)) return pushPanel(panel, null, uid);
            return false;
          }, function () {
            // Falha de rede: 'other' já descartado acima; aqui só chega 'self' ou 'legacy'.
            return false;
          }));
        }
      });
      return Promise.all(jobs);
    });
  }

  function setCurrentAsset(assetId) { currentAssetId = canonAssetId(assetId); }
  function getCurrentAsset() { return currentAssetId; }
  function saveLastAsset(assetId) {
    try { global.localStorage.setItem(LS_LAST_ASSET, canonAssetId(assetId) || ''); } catch (e) {}
  }
  function loadLastAsset() {
    try { return canonAssetId(global.localStorage.getItem(LS_LAST_ASSET)); }
    catch (e) { return null; }
  }

  var PanelSync = {
    PANELS: PANELS.slice(),
    LS_KEY_LEGACY: LS_KEY_LEGACY,
    saveLocal: saveLocal,
    loadLocal: loadLocal,
    pushPanel: pushPanel,
    pullPanels: pullPanels,
    syncOnLogin: syncOnLogin,
    schedulePush: schedulePush,
    setCurrentAsset: setCurrentAsset,
    getCurrentAsset: getCurrentAsset,
    saveLastAsset: saveLastAsset,
    loadLastAsset: loadLastAsset,
    getRiskAssets: getRiskAssets,
    migrateLegacyCloudRisk: migrateLegacyCloudRisk
  };

  // Migração do slot único legado ANTES de qualquer DOMContentLoaded:
  // risk-engine-panel.js carrega antes de auth.js e seu bind() pode rodar
  // antes do boot() daqui. Top-level do IIFE = parse do script = garantido.
  try { migrateLegacyRisk(); } catch (e) { /* best-effort */ }

  /* ---------- Modal ---------- */
  function $(id) { return global.document ? document.getElementById(id) : null; }

  function setView(view) {
    var views = ['login', 'signup', 'reset', 'verify', 'account'];
    views.forEach(function (v) {
      var el = $('eb-login-view-' + v);
      if (el) el.hidden = (v !== view);
    });
    // Aponta o diálogo para o título da view ativa (leitor de tela).
    try {
      var card = document.querySelector('#eb-login-overlay .eb-login-card');
      var titles = {
        login: 'eb-login-title', signup: 'eb-login-title-signup',
        reset: 'eb-login-title-reset', verify: 'eb-login-title-verify',
        account: 'eb-login-title-account'
      };
      if (card && titles[view]) card.setAttribute('aria-labelledby', titles[view]);
    } catch (e) {}
    setError('');
  }

  function setError(msg) {
    var el = $('eb-login-error');
    if (el) {
      el.textContent = msg || '';
      el.style.display = msg ? 'block' : 'none';
    }
  }

  function setLoading(btn, on, label, busyLabel) {
    if (!btn) return;
    if (on) {
      btn.setAttribute('data-label', btn.textContent);
      btn.textContent = busyLabel || 'Aguarde…';
      btn.disabled = true;
    } else {
      btn.textContent = label || btn.getAttribute('data-label') || btn.textContent;
      btn.disabled = false;
    }
  }

  // Mensagens genéricas em pt-BR: nunca revelam se o e-mail existe e nunca
  // devolvem o texto cru (inglês) do Firebase.
  function friendlyError(err) {
    var code = (err && err.code) || '';
    var m = String((err && err.message) || err || '');
    if (code === 'auth/email-not-verified') return 'NOT_VERIFIED';
    if (/invalid-credential|wrong-password|user-not-found|invalid-email/i.test(code + ' ' + m) ||
        /invalid login credentials/i.test(m)) return 'E-mail ou senha incorretos.';
    // Cadastro com e-mail já registrado: resposta genérica (não confirma existência).
    if (/email-already-in-use|already registered/i.test(code + ' ' + m)) return 'Não foi possível criar a conta. Se já tiver conta, tente entrar ou redefinir a senha.';
    if (/credential-already-in-use|account-exists-with-different-credential/i.test(code + ' ' + m)) return 'Este login já pertence a outra conta. Entre por ele para acessar sua carteira.';
    if (/weak-password/i.test(code)) return 'A senha precisa de 8+ caracteres.';
    if (/too-many-requests|too many/i.test(code + ' ' + m)) return 'Muitas tentativas. Aguarde alguns minutos ou redefina sua senha.';
    if (/network-request-failed/i.test(code)) return 'Sem conexão. Tente novamente.';
    if (/operation-not-allowed/i.test(code)) return 'Este método de login ainda não foi ativado.';
    return 'Não foi possível entrar agora. Tente novamente.';
  }

  // Elemento que abriu o modal (para devolver o foco ao fechar).
  var modalOpener = null;

  function openModal(view) {
    var ov = $('eb-login-overlay');
    if (!ov) return;
    try {
      var active = global.document ? document.activeElement : null;
      if (active && active !== global.document.body) modalOpener = active;
    } catch (e) {}
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
    // Devolve o foco a quem abriu o modal.
    try {
      if (modalOpener && global.document && document.contains(modalOpener)) modalOpener.focus();
    } catch (e) {}
    modalOpener = null;
  }

  // Mantém Tab/Shift+Tab dentro do modal enquanto aberto (foco preso).
  // Só conta elementos VISÍVEIS (views ocultas com [hidden] ficam de fora).
  function trapTab(ev) {
    if (!ev || ev.key !== 'Tab') return;
    var ov = $('eb-login-overlay');
    if (!ov || ov.hidden || !global.document) return;
    var card = ov.querySelector('.eb-login-card');
    if (!card) return;
    var all = card.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled])');
    var items = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].offsetParent !== null) items.push(all[i]);
    }
    if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault(); last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault(); first.focus();
    }
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
      trapTab(ev);
    });

    function gateConfigured() {
      if (isConfigured()) return true;
      setError('Login será ativado em breve. Por enquanto, suas simulações ficam salvas neste navegador.');
      return false;
    }

    // Mostrar/ocultar senha (olho dentro do campo). type=button no HTML,
    // então nunca submete o form; wireForm() lê .value e segue intacto.
    function wirePassToggle(passId, btnId) {
      var input = $(passId), btn = $(btnId);
      if (!input || !btn) return;
      input.classList.add('eb-login-pass-input');
      btn.addEventListener('click', function () {
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.classList.toggle('is-visible', show);
        btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
        btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      });
    }
    wirePassToggle('eb-login-form-login-pass', 'eb-login-form-login-pass-toggle');
    wirePassToggle('eb-login-form-signup-pass', 'eb-login-form-signup-pass-toggle');

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

    // Regras de senha por formulário: mínimo de 8 vale SÓ para o CADASTRO
    // (a redefinição é feita por link do Firebase, com policy no console).
    // O LOGIN aceita qualquer senha não vazia: usuários com senhas de 6-7
    // caracteres continuam entrando normalmente.
    var PASS_RULES = {
      'eb-login-form-login': { min: 0, emptyMsg: 'Informe sua senha.', busy: 'Entrando…' },
      'eb-login-form-signup': { min: 8, emptyMsg: 'A senha precisa de 8+ caracteres.', busy: 'Criando…' },
      'eb-login-form-reset': { min: 0, emptyMsg: '', busy: 'Enviando…' }
    };

    function wireForm(formId, btnId, fn) {
      var form = $(formId), btn = $(btnId);
      if (!form || !btn) return;
      var rule = PASS_RULES[formId] || { min: 0, emptyMsg: '', busy: 'Aguarde…' };
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        if (!gateConfigured()) return;
        var email = $(formId + '-email');
        var pass = $(formId + '-pass');
        var e = email ? String(email.value || '').trim().toLowerCase() : '';
        var p = pass ? String(pass.value || '') : '';
        if (!validEmail(e)) { setError('Informe um e-mail válido.'); return; }
        if (pass && rule.min > 0 && p.length < rule.min) {
          setError('A senha precisa de 8+ caracteres.'); return;
        }
        if (pass && rule.min === 0 && formId === 'eb-login-form-login' && !p) {
          setError(rule.emptyMsg); return;
        }
        setLoading(btn, true, null, rule.busy);
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
    whenReady: function () {
      return awaitAuthReady().then(function (fu) {
        if (fu) return normUser(fu);
        return currentUser;
      });
    },
    ensureAnonymous: ensureAnonymous,
    isAnonymousSession: isAnonymousSession,
    linkGoogle: linkGoogle,
    linkEmail: linkEmail,
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
