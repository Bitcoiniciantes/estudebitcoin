(function () {
  var endpoint = "https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/v1/analyze";
  var input = document.getElementById("ai-question");
  var button = document.getElementById("ai-ask");
  var result = document.getElementById("ai-result");
  var provider = document.getElementById("ai-provider");
  var disclaimer = document.getElementById("ai-disclaimer");
  var requestId = 0;
  if (!input || !button || !result) return;

  function contextValue(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim().toUpperCase().slice(0, 20) : fallback;
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

  function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function inlineMarkdown(value) {
    return escapeHtml(value).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function renderAnalysis(value) {
    return String(value).replace(/\r\n?/g, "\n").trim().split(/\n{2,}/).map(function (block) {
      var lines = block.trim().split("\n");
      var heading = block.match(/^#{1,3}\s+(.+)$/);
      if (heading) return "<h3>" + inlineMarkdown(heading[1]) + "</h3>";
      if (block.trim() === "---") return "";
      if (lines.every(function (line) { return /^[-*]\s+/.test(line); })) {
        return "<ul>" + lines.map(function (line) { return "<li>" + inlineMarkdown(line.replace(/^[-*]\s+/, "")) + "</li>"; }).join("") + "</ul>";
      }
      if (lines.every(function (line) { return /^\d+[.)]\s+/.test(line); })) {
        return "<ol>" + lines.map(function (line) { return "<li>" + inlineMarkdown(line.replace(/^\d+[.)]\s+/, "")) + "</li>"; }).join("") + "</ol>";
      }
      return "<p>" + lines.map(inlineMarkdown).join("<br>") + "</p>";
    }).join("");
  }
  function runAnalysis(context) {
    context = context || {};
    var currentRequest = ++requestId;
    var asset = contextValue(context.asset, "BTC");
    var period = contextValue(context.period, "1D");
    var question = (context.question || input.value).trim().replace(/,?\s*sem recomenda[^.]*investimento\.?$/i, "");
    if (!question) {
      input.focus();
      result.textContent = "Escreva uma pergunta sobre Bitcoin para iniciar a análise.";
      return;
    }
    input.value = question;
    button.disabled = true;
    button.textContent = "Analisando " + asset + "…";
    result.textContent = "Consultando o Analista IA para " + asset + " no período " + period + "…";
    provider.style.display = "none";

    Promise.resolve(typeof context.marketData === "string" && context.marketData.trim() ? context.marketData : marketSnapshot(asset))
      .then(function (marketData) {
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
        provider.textContent = payload.provider === "gemini" ? "Gemini" : "Groq";
        provider.style.display = "inline-block";
        disclaimer.textContent = payload.disclaimer || disclaimer.textContent;
      })
      .catch(function (error) { if (currentRequest === requestId) result.textContent = error.message || "Não foi possível gerar a análise agora. Tente novamente."; })
      .finally(function () { if (currentRequest === requestId) { button.disabled = false; button.textContent = "Analisar " + asset; } });
  }

  document.querySelectorAll("[data-question]").forEach(function (chip) {
    chip.addEventListener("click", function () { input.value = chip.getAttribute("data-question"); input.focus(); });
  });
  button.addEventListener("click", function () { runAnalysis({}); });
  window.addEventListener("message", function (event) {
    if (event.origin !== "https://bitcoiniciantes.github.io") return;
    if (event.data?.type === "termometro:ai-context-changed") {
      requestId += 1;
      var changedAsset = contextValue(event.data.asset, "BTC");
      var changedPeriod = contextValue(event.data.period, "1D");
      input.value = "";
      button.disabled = false;
      button.textContent = "Analisar " + changedAsset;
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