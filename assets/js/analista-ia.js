(function () {
  var endpoint = "https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/v1/analyze";
  var input = document.getElementById("ai-question");
  var button = document.getElementById("ai-ask");
  var result = document.getElementById("ai-result");
  var provider = document.getElementById("ai-provider");
  var disclaimer = document.getElementById("ai-disclaimer");
  var facts = document.getElementById("ai-facts");
  var resultPanel = result && result.closest(".ai-analyst__result");
  var thinking = document.getElementById("ai-thinking");
  var requestId = 0;
  if (!result) return;
  if (button) button.textContent = "ANALISAR";

  function contextValue(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim().toUpperCase().slice(0, 20) : fallback;
  }

  function inferAsset(question, fallback) {
    var aliases = { BITCOIN: "BTC", BTC: "BTC", ETHEREUM: "ETH", ETH: "ETH", CHAINLINK: "LINK", LINK: "LINK", AVALANCHE: "AVAX", AVAX: "AVAX", PAXG: "PAXG" };
    var words = String(question || "").toUpperCase().match(/[A-Z0-9]{2,12}/g) || [];
    for (var i = 0; i < words.length; i += 1) {
      if (aliases[words[i]]) return aliases[words[i]];
    }
    return fallback;
  }


  function marketSnapshot(asset) {
    return fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=" + encodeURIComponent(asset + "USDT"))
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (ticker) {
        if (!ticker) return "Dados de cotação de " + asset + " indisponíveis no momento.";
        return asset + "/USDT: US$ " + Number(ticker.lastPrice).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) +
          ". Variação em 24h: " + Number(ticker.priceChangePercent).toFixed(2) + "%" +
          ". Volume em 24h: " + Number(ticker.quoteVolume).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + " USDT.";
      })
      .catch(function () { return "Dados de cotação de " + asset + " indisponíveis no momento."; });
  }

  function newsSnapshot(asset) {
    return fetch("https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/api/asset-news?asset=" + encodeURIComponent(asset))
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (payload) {
        var items = payload && Array.isArray(payload.items) ? payload.items : [];
        if (!items.length) return { prompt: "", items: [] };
        return { prompt: "Noticias publicas recentes de " + asset + ":\n" + items.map(function (item) { return "- " + item.title + (item.publishedAt ? " (" + String(item.publishedAt).slice(0, 10) + ")" : ""); }).join("\n"), items: items };
      })
      .catch(function () { return { prompt: "", items: [] }; });
  }

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function inlineMarkdown(value) {
    return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function renderAnalysis(value) {
    var html=[], paragraph=[], listType=null;
    function closeParagraph(){ if(paragraph.length){ html.push("<p>"+paragraph.map(inlineMarkdown).join("<br>")+"</p>"); paragraph=[]; } }
    function closeList(){ if(listType){ html.push("</"+listType+">"); listType=null; } }
    String(value||"").replace(/\r\n?/g,"\n").trim().split("\n").forEach(function(raw){
      var line=raw.trim(), heading=line.match(/^#{1,3}\s+(.+)$/), bullet=line.match(/^[-*]\s+(.+)$/), ordered=line.match(/^\d+[.)]\s+(.+)$/);
      if(!line||line==="---"){closeParagraph();closeList();return;}
      if(heading){closeParagraph();closeList();html.push("<h3>"+inlineMarkdown(heading[1])+"</h3>");return;}
      if(bullet||ordered){closeParagraph();var nextType=bullet?"ul":"ol";if(listType!==nextType){closeList();listType=nextType;html.push("<"+listType+">");}html.push("<li>"+inlineMarkdown((bullet||ordered)[1])+"</li>");return;}
      closeList();paragraph.push(line);
    });
    closeParagraph();closeList();return html.join("");
  }
  function renderRelevantFacts(items) {
    if(!facts)return;
    if(!Array.isArray(items)||!items.length){facts.innerHTML="<span>FATOS RELEVANTES</span><p>Sem noticias relevantes encontradas nas ultimas 48 horas.</p>";return;}
    facts.innerHTML="<span>FATOS RELEVANTES</span><ul>"+items.map(function(item){var title=escapeHtml(item.title||"Noticia"),source=escapeHtml(item.source||"Fonte"),date=item.publishedAt?" &bull; "+escapeHtml(String(item.publishedAt).slice(0,10).split("-").reverse().join("/")):"",link=item.url?'<a href="'+escapeHtml(item.url)+'" target="_blank" rel="noopener noreferrer">'+title+' &#8599;</a>':title;return "<li>"+link+"<small>"+source+date+"</small></li>";}).join("")+"</ul>";
  }

  function runAnalysis(context) {
    context = context || {};
    var currentRequest = ++requestId;
    var factsSnapshot = [];
    var period = contextValue(context.period, "1D");
    var question = (context.question || (input ? input.value : "")).trim().replace(/,?\s*sem recomenda[^.]*investimento\.?$/i, "");
    var asset = inferAsset(question, contextValue(context.asset, "BTC"));
    if (!question) {
      input?.focus();
      result.textContent = "Escreva uma pergunta sobre Bitcoin para iniciar a análise.";
      if (thinking) thinking.hidden = true;
      return;
    }
    if (input) input.value = question;
    resultPanel?.classList.add("is-visible");
    if (button) button.disabled = true;
    if (button) button.textContent = "Analisando " + asset + "…";
    result.textContent = "Consultando o Analista IA para " + asset + " no período " + period + "…";
    if (thinking) thinking.hidden = false;
    provider.style.display = "none";

    Promise.all([Promise.resolve(typeof context.marketData === "string" && context.marketData.trim() ? context.marketData : marketSnapshot(asset)), newsSnapshot(asset)])
      .then(function (parts) {
        factsSnapshot = parts[1].items;
        var marketData = [parts[0], parts[1].prompt].filter(Boolean).join("\n\n");
        return fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asset: asset, period: period, marketData: marketData, question: question }),
        });
      })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (currentRequest !== requestId) return;
        if (!payload.analysis) throw new Error(payload.error || "A análise não ficou disponível.");
        result.innerHTML = renderAnalysis(payload.analysis);
        renderRelevantFacts(factsSnapshot);
        provider.textContent = payload.provider === "gemini" ? "Gemini" : "Groq";
        provider.style.display = "inline-block";
        disclaimer.textContent = payload.disclaimer || disclaimer.textContent;
      })
      .catch(function (error) { if (currentRequest === requestId) result.textContent = error.message || "Não foi possível gerar a análise agora. Tente novamente."; })
      .finally(function () { if (thinking) thinking.hidden = true; if (currentRequest === requestId && button) { button.disabled = false; button.textContent = "ANALISAR"; } });
  }

  document.querySelectorAll("[data-question]").forEach(function (chip) {
    chip.addEventListener("click", function () { input.value = chip.getAttribute("data-question"); input.focus(); });
  });
  if (button) button.addEventListener("click", function () { runAnalysis({}); });
  window.addEventListener("message", function (event) {
    if (event.origin !== "https://bitcoiniciantes.github.io") return;
    if (event.data?.type === "termometro:ai-context-changed") {
      requestId += 1;
      var changedAsset = contextValue(event.data.asset, "BTC");
      var changedPeriod = contextValue(event.data.period, "1D");
      if (input) input.value = "";
      if (button) button.disabled = false;
      if (button) button.textContent = "ANALISAR";
      if (thinking) thinking.hidden = true;
      result.textContent = "Ativo atualizado para " + changedAsset + " no período " + changedPeriod + ". Clique no botão IA do Termômetro para gerar a leitura.";
      provider.style.display = "none";
      disclaimer.textContent = "Conteúdo informativo.";
      return;
    }
    if (event.data?.type !== "termometro:open-estudebitcoin-ai") return;
    var asset = contextValue(event.data.asset, "BTC");
    var period = contextValue(event.data.period, "1D");
    var question = "Explique o cenário técnico atual de " + asset + " no período " + period + " de forma educativa.";
    document.getElementById("analista-ia")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(function () { runAnalysis({ asset: asset, period: period, marketData: event.data.marketData, question: question }); }, 450);
  });
})();