(function () {
  var endpoint = "https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/v1/analyze";
  var input = document.getElementById("ai-question");
  var button = document.getElementById("ai-ask");
  var result = document.getElementById("ai-result");
  var provider = document.getElementById("ai-provider");
  var disclaimer = document.getElementById("ai-disclaimer");
  var facts = document.getElementById("ai-facts");
  var resultPanel = result && result.closest(".ai-analyst__result");
  var loadingBox = document.getElementById("ai-loading");
  var loadingPhrases = document.getElementById("ai-loading-phrases");
  var requestId = 0;
  if (!result) return;
  if (button) button.textContent = "ANALISAR";
  var currentAsset = "BTC";
  var currentPeriod = "1D";
  var currentMarketData = "";
  var elapsedEl = document.getElementById("ai-elapsed");
  var elapsedTimer = null;
  var elapsedStartedAt = 0;

  function updateElapsedText(secs) {
    if (elapsedEl) elapsedEl.textContent = String(secs).padStart(2, "0") + "s";
  }

  function startElapsed() {
    stopElapsed();
    elapsedStartedAt = Date.now();
    updateElapsedText(0);
    elapsedTimer = window.setInterval(function () {
      updateElapsedText(Math.round((Date.now() - elapsedStartedAt) / 1000));
    }, 1000);
  }

  function stopElapsed() {
    if (elapsedTimer) window.clearInterval(elapsedTimer);
    elapsedTimer = null;
    if (elapsedStartedAt) {
      updateElapsedText(Math.round((Date.now() - elapsedStartedAt) / 1000));
      elapsedStartedAt = 0;
    }
  }

  function contextValue(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim().toUpperCase().slice(0, 20) : fallback;
  }

  function inferAsset(question, fallback) {
    var aliases = { BITCOIN: "BTC", BTC: "BTC", ETHEREUM: "ETH", ETH: "ETH", CHAINLINK: "LINK", LINK: "LINK", AVALANCHE: "AVAX", AVAX: "AVAX", PAXG: "PAXG", PRATA: "PRATA", SILVER: "PRATA", COBRE: "COBRE", COPPER: "COBRE", URANIO: "URANIO", URANIUM: "URANIO", MSTR: "MSTR", POL: "POL", POLYGON: "POL" };
    var words = String(question || "").toUpperCase().match(/[A-Z0-9]{2,12}/g) || [];
    for (var i = 0; i < words.length; i += 1) {
      if (aliases[words[i]]) return aliases[words[i]];
    }
    return fallback;
  }


  var QUOTE_VIA_WORKER = { PRATA: true, COBRE: true, URANIO: true };

  var widgetFrame = typeof document !== "undefined" ? document.querySelector(".termometro-widget") : null;
  var analystPanel = typeof document !== "undefined" ? document.getElementById("analista-ia") : null;
  var widgetResizeObserver = null;
  var widgetResizeTimer = null;

  function syncWidgetHeight() {
    if (!widgetFrame || !widgetFrame.contentWindow) return;
    try {
      var doc = widgetFrame.contentDocument || widgetFrame.contentWindow.document;
      if (!doc || !doc.documentElement) return;
      var widgetRoot = doc.querySelector(".widgetEmbed");
      var nextHeight = widgetRoot ? widgetRoot.getBoundingClientRect().height : (doc.body ? doc.body.scrollHeight : 0);
      if (nextHeight > 0 && Math.abs(widgetFrame.offsetHeight - nextHeight) > 1) {
        widgetFrame.style.height = Math.ceil(nextHeight) + "px";
      }
    } catch (_) {
      // O widget compartilha a origem no GitHub Pages; a altura fixa permanece como fallback.
    }
  }

  function scheduleWidgetResize() {
    window.clearTimeout(widgetResizeTimer);
    window.requestAnimationFrame(syncWidgetHeight);
    widgetResizeTimer = window.setTimeout(syncWidgetHeight, 180);
  }

  function watchWidgetHeight() {
    syncWidgetHeight();
    try {
      var doc = widgetFrame.contentDocument || widgetFrame.contentWindow.document;
      if (widgetResizeObserver) widgetResizeObserver.disconnect();
      widgetResizeObserver = new ResizeObserver(scheduleWidgetResize);
      var widgetRoot = doc.querySelector(".widgetEmbed");
      if (widgetRoot) widgetResizeObserver.observe(widgetRoot);
      else if (doc.body) widgetResizeObserver.observe(doc.body);
      window.setTimeout(syncWidgetHeight, 500);
      window.setTimeout(syncWidgetHeight, 1500);
    } catch (_) {}
  }

  if (widgetFrame) {
    widgetFrame.setAttribute("scrolling", "no");
    widgetFrame.addEventListener("load", watchWidgetHeight);
    window.addEventListener("resize", scheduleWidgetResize, { passive: true });
    if (widgetFrame.contentDocument && widgetFrame.contentDocument.readyState === "complete") watchWidgetHeight();
  }

  function requestContextFromWidget() {
    return new Promise(function (resolve) {
      if (!widgetFrame || !widgetFrame.contentWindow) return resolve(null);
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onReply);
        resolve(value);
      }
      function onReply(event) {
        if ((event.origin !== "https://termometroalerta.pages.dev" && event.origin !== "https://termometroalerta.pages.dev")) return;
        if (event.data && event.data.type === "termometro:ai-context-reply") {
          finish({ asset: event.data.asset, period: event.data.period, marketData: event.data.marketData });
        }
      }
      window.addEventListener("message", onReply);
      widgetFrame.contentWindow.postMessage({ type: "estudebitcoin:request-context" }, "https://termometroalerta.pages.dev");
      window.setTimeout(function () { finish(null); }, 1500);
    });
  }

  function marketSnapshot(asset) {
    if (QUOTE_VIA_WORKER[asset]) {
      return fetch("https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/api/quote?asset=" + encodeURIComponent(asset))
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (quote) {
          if (!quote || typeof quote.price !== "number") return "Dados de cotação de " + asset + " indisponíveis no momento.";
          return asset + ": US$ " + Number(quote.price).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) +
            (typeof quote.changePercent === "number" ? ". Variação em 24h: " + Number(quote.changePercent).toFixed(2) + "%" : "") +
            (typeof quote.volume === "number" && quote.volume > 0 ? ". Volume: " + Number(quote.volume).toLocaleString("pt-BR", { maximumFractionDigits: 0 }) + "." : "");
        })
        .catch(function () { return "Dados de cotação de " + asset + " indisponíveis no momento."; });
    }
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

  var loadingTimer = null;
  var loadingPhraseTimer = null;
  var loadingStartedAt = 0;
  var loadingPhraseIndex = 0;

  function startLoading(asset, period) {
    if (!loadingPhrases) return;
    stopLoading();
    var timeEl = document.getElementById("ai-loading-time");
    var phrases = [
      "Consultando o Analista IA para " + asset + "…",
      "Período " + period + " em análise…",
      "Lendo os dados públicos de mercado…",
      "Buscando notícias recentes…",
      "Interpretando os sinais técnicos…",
      "Montando a resposta educativa…"
    ];
    loadingPhraseIndex = 0;
    loadingPhrases.textContent = phrases[0];
    loadingStartedAt = Date.now();
    if (timeEl) timeEl.textContent = "0s";
    loadingPhraseTimer = window.setInterval(function () {
      loadingPhraseIndex = (loadingPhraseIndex + 1) % phrases.length;
      loadingPhrases.textContent = phrases[loadingPhraseIndex];
    }, 2400);
    loadingTimer = window.setInterval(function () {
      var elapsed = Math.round((Date.now() - loadingStartedAt) / 1000);
      if (timeEl) timeEl.textContent = elapsed + "s";
    }, 1000);
  }

  function stopLoading() {
    if (loadingPhraseTimer) window.clearInterval(loadingPhraseTimer);
    if (loadingTimer) window.clearInterval(loadingTimer);
    loadingPhraseTimer = null;
    loadingTimer = null;
  }

  function runAnalysis(context) {
    context = context || {};
    var currentRequest = ++requestId;
    var factsSnapshot = [];
    var period = contextValue(context.period, "1D");
    var question = (context.question || (input ? input.value : "")).trim().replace(/,?\s*sem recomenda[^.]*investimento\.?$/i, "");
    var asset = inferAsset(question, contextValue(context.asset, currentAsset));
    if (!question) question = "Explique o cenário técnico atual de " + asset + " no período " + period + " de forma educativa.";
    if (context.asset) currentAsset = contextValue(context.asset, currentAsset);
    if (context.period) currentPeriod = period;
    if (typeof context.marketData === "string") currentMarketData = context.marketData;
    if (input) input.value = question;
    resultPanel?.classList.add("is-visible");
    if (button) button.disabled = true;
    if (button) button.textContent = "Analisando " + asset + "…";
    result.textContent = "Consultando o Analista IA para " + asset + " no período " + period + "…";
    startElapsed();
    startLoading(asset, period);
    if (loadingBox) loadingBox.hidden = false;
    if (provider) provider.style.display = "none";
    if (facts) facts.innerHTML = "<span>FATOS RELEVANTES</span><p>Buscando notícias recentes…</p>";

    var providedMarketData = typeof context.marketData === "string" && context.marketData.trim() ? context.marketData : (currentMarketData && currentAsset === asset && currentPeriod === period ? currentMarketData : "");
    var marketDataPromise = providedMarketData ? Promise.resolve(providedMarketData) : requestContextFromWidget().then(function (reply) {
      if (reply && reply.marketData) {
        currentAsset = reply.asset || currentAsset;
        currentPeriod = reply.period || currentPeriod;
        return reply.marketData;
      }
      return marketSnapshot(asset);
    });

    var newsPromise = newsSnapshot(asset);
    newsPromise.then(function (news) {
      if (currentRequest !== requestId) return;
      factsSnapshot = news.items;
      renderRelevantFacts(factsSnapshot);
    });
    var timelyNewsPromise = Promise.race([
      newsPromise,
      new Promise(function (resolve) { window.setTimeout(function () { resolve({ prompt: "", items: [] }); }, 4500); }),
    ]);

    Promise.all([marketDataPromise, timelyNewsPromise])
      .then(function (parts) {
        factsSnapshot = parts[1].items;
        var marketData = [parts[0], parts[1].prompt].filter(Boolean).join("\n\n");
        return fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asset: asset, period: period, marketData: marketData, question: question }),
        });
      })
      .then(function (response) {
        if (!response.ok) throw new Error("A análise falhou no servidor (HTTP " + response.status + "). Tente novamente.");
        return response.json();
      })
      .then(function (payload) {
        if (currentRequest !== requestId) return;
        if (!payload.analysis) throw new Error(payload.error || "A análise não ficou disponível.");
        result.innerHTML = renderAnalysis(payload.analysis);
        renderRelevantFacts(factsSnapshot);
        if (provider) provider.textContent = payload.provider === "gemini" ? "Gemini" : "Groq";
        if (provider) provider.style.display = "inline-block";
        if (disclaimer) disclaimer.textContent = payload.disclaimer || disclaimer.textContent;
      })
      .catch(function (error) { if (currentRequest === requestId) result.textContent = error.message || "Não foi possível gerar a análise agora. Tente novamente."; })
      .finally(function () { stopLoading(); stopElapsed(); if (loadingBox) loadingBox.hidden = true; if (currentRequest === requestId && button) { button.disabled = false; button.textContent = "ANALISAR"; } });
  }

  document.querySelectorAll("[data-question]").forEach(function (chip) {
    chip.addEventListener("click", function () { input.value = chip.getAttribute("data-question"); input.focus(); });
  });
  if (button) button.addEventListener("click", function () { runAnalysis({ asset: currentAsset, period: currentPeriod, marketData: currentMarketData }); });
  window.addEventListener("message", function (event) {
    if ((event.origin !== "https://termometroalerta.pages.dev" && event.origin !== "https://termometroalerta.pages.dev")) return;
    if (event.data?.type === "termometro:ai-context-changed") {
      requestId += 1;
      var changedAsset = contextValue(event.data.asset, "BTC");
      var changedPeriod = contextValue(event.data.period, "1D");
      currentAsset = changedAsset;
      currentPeriod = changedPeriod;
      currentMarketData = "";
      stopElapsed();
      updateElapsedText(0);
      if (input) input.value = "";
      if (button) button.disabled = false;
      if (button) button.textContent = "ANALISAR";
      stopLoading();
      if (loadingBox) loadingBox.hidden = true;
      result.textContent = "Ativo atualizado para " + changedAsset + " no período " + changedPeriod + ". Clique em ANALISAR ou no botão IA do Termômetro para gerar a leitura.";
      if (provider) provider.style.display = "none";
      if (disclaimer) disclaimer.textContent = "Conteúdo informativo.";
      if (facts) renderRelevantFacts([]);
      return;
    }
    if (event.data?.type !== "termometro:open-estudebitcoin-ai") return;
    var asset = contextValue(event.data.asset, "BTC");
    var period = contextValue(event.data.period, "1D");
    var question = "Explique o cenário técnico atual de " + asset + " no período " + period + " de forma educativa.";
    currentAsset = asset;
    currentPeriod = period;
    currentMarketData = typeof event.data.marketData === "string" ? event.data.marketData : "";
    if (analystPanel) analystPanel.classList.add("is-open");
    window.setTimeout(function () {
      if (analystPanel) analystPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    window.setTimeout(function () { runAnalysis({ asset: asset, period: period, marketData: event.data.marketData, question: question }); }, 260);
  });
})();
