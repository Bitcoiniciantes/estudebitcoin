/* =====================================================================
   Orquestrador principal
   - menu mobile, FAQ, formulário de contato
   - lazy-load de cada widget quando entra na viewport
   ===================================================================== */
(function () {
  'use strict';
  var CFG = window.BI_CONFIG;

  /* ---------- Menu mobile ---------- */
  var mobileMenu = document.getElementById('mobile-menu');
  var navList = document.getElementById('nav-list');
  if (mobileMenu && navList) {
    mobileMenu.addEventListener('click', function () {
      var active = mobileMenu.classList.toggle('active');
      navList.classList.toggle('active');
      mobileMenu.setAttribute('aria-expanded', active);
    });
    document.querySelectorAll('#nav-list a').forEach(function (link) {
      link.addEventListener('click', function () {
        mobileMenu.classList.remove('active');
        navList.classList.remove('active');
        mobileMenu.setAttribute('aria-expanded', false);
      });
    });
  }

  /* ---------- FAQ accordion ---------- */
  document.querySelectorAll('.faq-q').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var item = btn.parentElement;
      var isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach(function (i) { i.classList.remove('open'); });
      if (!isOpen) item.classList.add('open');
    });
  });

  /* ---------- Formulário de contato (Formspree) ---------- */
  var consultForm = document.getElementById('consultForm');
  if (consultForm) {
    consultForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = this.querySelector('.form-submit');
      var textoOriginal = btn.textContent;
      var errEl = document.getElementById('formErrorMsg');
      if (errEl) errEl.style.display = 'none';
      btn.textContent = 'Processando…';
      btn.disabled = true;

      function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
      var data = {
        nome: val('nome'),
        email: val('email'),
        whatsapp: val('whatsapp') || 'não informado',
        cidade: val('cidade') || 'não informado',
        servico: val('servico'),
        nivel: val('nivel') || 'não informado',
        mensagem: val('mensagem'),
        _subject: '[BITCOIN INICIANTES] Nova Consulta – ' + val('nome'),
        _replyto: val('email')
      };

      function showErr(msg) {
        if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
        else { alert(msg); }
        btn.textContent = textoOriginal;
        btn.disabled = false;
      }

      try {
        var res = await fetch('https://formspree.io/f/' + CFG.formspreeId, {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        if (res.ok) {
          consultForm.style.display = 'none';
          document.getElementById('formSuccess').style.display = 'block';
        } else {
          var json = await res.json();
          var erros = json.errors ? json.errors.map(function (er) { return er.message; }).join(', ') : 'Tente novamente.';
          showErr('Falha ao enviar: ' + erros);
        }
      } catch (err) {
        showErr('Problema de conexão. Verifique seu sinal e tente novamente.');
      }
    });
  }

  /* ---------- Lazy-load dos widgets ---------- */
  // Cada widget carrega seu script só quando o container se aproxima da tela.
  function lazyWidget(anchorId, scriptSrc, initName) {
    var anchor = document.getElementById(anchorId);
    if (!anchor) return;
    BI.onVisible(anchor, function () {
      BI.loadScript(scriptSrc)
        .then(function () {
          if (window.BIWidgets && window.BIWidgets[initName]) {
            window.BIWidgets[initName]();
          }
        })
        .catch(function () {});
    });
  }

  // ticker fica no hero (acima da dobra) → margem maior para iniciar cedo
  lazyWidget('btcTickerCard', 'assets/js/widgets/btc-ticker.js', 'btcTicker');
  lazyWidget('fng-root', 'assets/js/widgets/fear-greed.js', 'fearGreed');
  lazyWidget('mempool-root', 'assets/js/widgets/mempool.js', 'mempool');
  lazyWidget('sif-root', 'assets/js/widgets/sif.js', 'sif');
  lazyWidget('dca-root', 'assets/js/widgets/dca.js?v=99', 'dca');
  lazyWidget('mural-root', 'assets/js/widgets/mural.js', 'mural')
  lazyWidget('halving-root', 'assets/js/widgets/halving.js', 'halving');
  lazyWidget('widget-etf-sosovalue', 'assets/js/widgets/etf.js?v=2', 'etfWidget');
  lazyWidget('costbasis-root', 'assets/js/widgets/costbasis.js?v=7', 'costBasis');
  lazyWidget('nupl-root', 'assets/js/widgets/nupl.js?v=3', 'nupl');
  lazyWidget('strategy-root', 'assets/js/widgets/strategy.js?v=12', 'strategyTreasury');
})();


