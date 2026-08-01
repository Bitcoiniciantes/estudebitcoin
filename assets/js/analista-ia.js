(function () {
  var endpoint = "https://bitcoiniciantes-ia.bitcoiniciantes.workers.dev/v1/analyze";
  var input = document.getElementById("ai-question");
  var button = document.getElementById("ai-ask");
  var result = document.getElementById("ai-result");
  var provider = document.getElementById("ai-provider");
  var disclaimer = document.getElementById("ai-disclaimer");
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

  function runAnalysis(context) {
    context = context || {};
    var asset = contextValue(context.asset, "BTC");
    var period = contextValue(context.period, "1D");
    var question = (context.question || input.value).trim();
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

    marketSnapshot(asset)
      .then(function (marketData) {
        return fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ asset: asset, period: period, marketData: marketData, question: question }),
        });
      })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (!payload.analysis) throw new Error(payload.error || "A análise não ficou disponível.");
        result.textContent = payload.analysis.replace(/\*\*/g, "").replace(/^- /gm, "• ");
        provider.textContent = payload.provider === "gemini" ? "Gemini" : "Groq";
        provider.style.display = "inline-block";
        disclaimer.textContent = payload.disclaimer || disclaimer.textContent;
      })
      .catch(function (error) { result.textContent = error.message || "Não foi possível gerar a análise agora. Tente novamente."; })
      .finally(function () { button.disabled = false; button.textContent = "Analisar " + asset; });
  }

  document.querySelectorAll("[data-question]").forEach(function (chip) {
    chip.addEventListener("click", function () { input.value = chip.getAttribute("data-question"); input.focus(); });
  });
  button.addEventListener("click", function () { runAnalysis({}); });
  window.addEventListener("message", function (event) {
    if (event.origin !== "https://bitcoiniciantes.github.io" || event.data?.type !== "termometro:open-estudebitcoin-ai") return;
    var asset = contextValue(event.data.asset, "BTC");
    var period = contextValue(event.data.period, "1D");
    var question = "Explique o cenário técnico atual de " + asset + " no período " + period + " de forma educativa, sem recomendação de investimento.";
    document.getElementById("analista-ia")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(function () { runAnalysis({ asset: asset, period: period, question: question }); }, 450);
  });
})();