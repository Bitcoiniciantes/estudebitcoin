/* =====================================================================
   Widget: Projeções de Preço do Bitcoin
   - Dados de instituições financeiras
   - Cálculo de retorno baseado no preço atual
   - Preço ao vivo da Binance
   ===================================================================== */
(function () {
  'use strict';

  var DATA = [
    { inst: "Standard Chartered", target: 100000, horizon: "Fim de 2026", tier: "cons",
      note: "Cortou a meta de US$ 150k → 100k. Diz que \"o fundo está quase feito\"." },
    { inst: "Galaxy Digital", target: 130000, horizon: "Mid-2026 (topo da faixa)", tier: "mid",
      note: "Faixa US$ 70k–130k. Admite que 2026 é \"volátil demais pra cravar\"." },
    { inst: "Citigroup", target: 143000, horizon: "12 meses (cenário base)", tier: "mid",
      note: "Bull US$ 189k · Bear US$ 78,5k · Recessivo US$ 58k." },
    { inst: "VanEck", target: 160000, horizon: "Fim de 2026", tier: "mid",
      note: "Baseado no par BTC/ouro voltar a 35x. Projeta US$ 2,9 milhões em 2050." },
    { inst: "JPMorgan", target: 170000, horizon: "2026", tier: "mid",
      note: "Mantém bull case mesmo após o crash. Alvo estrutural de longo prazo: US$ 266k." },
    { inst: "TD Cowen", target: 170000, horizon: "2026", tier: "mid",
      note: "Dentro do cluster US$ 140k–200k do consenso dos grandes bancos." },
    { inst: "Goldman Sachs", target: 200000, horizon: "2026 (topo cluster)", tier: "mid",
      note: "Faixa US$ 140k–200k, alinhado com Citi e Standard Chartered." },
    { inst: "Bitwise", target: 224000, horizon: "Fair value (ilustrativo)", tier: "mid",
      note: "Modelo de hedge contra default soberano. Cenário 10 anos: US$ 1 milhão." },
    { inst: "JPMorgan (estrutural)", target: 266000, horizon: "Longo prazo", tier: "mid",
      note: "Alvo estrutural baseado em paridade de risco com o ouro global." },
    { inst: "Galaxy Digital", target: 250000, horizon: "2027", tier: "mid",
      note: "Vê 2027 como ano mais plausível que 2026 para o topo do ciclo." },
    { inst: "ARK Invest", target: 1200000, horizon: "2030", tier: "moon",
      note: "Cathie Wood. Tese de \"ouro digital\" + adoção institucional e soberana." },
    { inst: "Bitwise", target: 1000000, horizon: "~10 anos", tier: "moon",
      note: "Matt Hougan: US$ 1M conforme BTC absorve parte do mercado global de ouro." }
  ];

  var tagClass = { cons: "proj-tag-cons", mid: "proj-tag-mid", moon: "proj-tag-moon" };
  var tagTxt = { cons: "Conservador", mid: "Base", moon: "Moonshot" };

  function fmt(n) {
    return "US$ " + n.toLocaleString("pt-BR");
  }

  function addTextElement(parent, className, text) {
    var element = document.createElement("div");
    element.className = className;
    element.textContent = text;
    parent.appendChild(element);
    return element;
  }

  function render(base) {
    base = Math.max(1, base);
    var projectionGrid = document.getElementById("proj-grid");
    if (!projectionGrid) return;
    var minLog = Math.log10(base);
    var maxLog = Math.max(Math.log10(base * 1.05), Math.max.apply(null, DATA.map(function (item) { return Math.log10(item.target); })));
    projectionGrid.replaceChildren();

    DATA.slice().sort(function (a, b) { return a.target - b.target; }).forEach(function (d) {
      var ret = ((d.target - base) / base) * 100;
      var up = ret >= 0;
      var pct = Math.min(100, Math.max(2, ((Math.log10(d.target) - minLog) / (maxLog - minLog)) * 100));
      var tier = Object.prototype.hasOwnProperty.call(tagClass, d.tier) ? d.tier : "mid";
      var card = document.createElement("div");
      card.className = "proj-card";
      var institution = document.createElement("div");
      institution.className = "proj-inst";
      institution.appendChild(document.createTextNode(d.inst + " "));
      var tag = document.createElement("span");
      tag.className = "proj-tag " + tagClass[tier];
      tag.textContent = tagTxt[tier];
      institution.appendChild(tag);
      card.appendChild(institution);
      addTextElement(card, "proj-horizon", d.horizon);
      addTextElement(card, "proj-target", fmt(d.target));
      addTextElement(card, "proj-ret " + (up ? "up" : "down"), (up ? "▲ +" : "▼ ") + ret.toFixed(1) + "% de " + (up ? "upside" : "downside"));
      var bar = document.createElement("div");
      bar.className = "proj-bar";
      var fill = document.createElement("div");
      fill.className = "proj-bar-fill";
      fill.style.width = pct + "%";
      bar.appendChild(fill);
      card.appendChild(bar);
      addTextElement(card, "proj-note", d.note);
      projectionGrid.appendChild(card);
    });
  }

  function init() {
    var input = document.getElementById("proj-base-price");
    if (!input) return;

    input.addEventListener("input", function () {
      render(Number(input.value) || 62000);
    });
    render(62000);

    // Busca preço ao vivo da Binance
    function fetchLivePrice() {
      fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT")
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var p = parseFloat(d.lastPrice);
          if (!isNaN(p)) {
            var el = document.getElementById("proj-live-price");
            if (el) el.textContent = "AO VIVO: " + p.toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " USD";
            input.value = Math.round(p);
            render(p);
          }
        })
        .catch(function () {
          var el = document.getElementById("proj-live-price");
          if (el) el.textContent = "AO VIVO: —";
        });
    }

    fetchLivePrice();
    setInterval(fetchLivePrice, 60000);
  }

  // Inicializa quando o DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
