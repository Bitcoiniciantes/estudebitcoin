const MODEL = "@cf/openai/gpt-oss-120b";
const ALLOWED_ORIGINS = new Set([
  "https://bitcoiniciantes.github.io",
  "http://localhost:3000",
  "http://localhost:8787",
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }

  return headers;
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}

function asText(value, maxLength = 1800) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function buildPrompt(data) {
  const asset = asText(data.asset, 24).toUpperCase() || "BTC";
  const period = asText(data.period, 12) || "1D";
  const marketData = asText(data.marketData, 3000);
  const question = asText(data.question, 700);

  return {
    asset,
    period,
    messages: [
      {
        role: "system",
        content:
          "Voce e o Analista IA do EstudeBitcoin. Responda em portugues do Brasil, com clareza para iniciantes e tom prudente. Use somente os dados fornecidos; diga explicitamente quando faltar dado. Nao invente precos, noticias ou indicadores. Nao de recomendacao financeira personalizada. Estruture a resposta em: resumo, leitura dos dados, riscos e proximo passo educativo. Seja conciso.",
      },
      {
        role: "user",
        content:
          `Ativo: ${asset}\nPeriodo: ${period}\nDados de mercado: ${marketData || "Nao informado"}\nPergunta do usuario: ${question || "Explique o cenario atual com base nos dados."}`,
      },
    ],
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json(request, { ok: true, service: "bitcoiniciantes-ia", model: MODEL });
    }

    if (request.method !== "POST" || url.pathname !== "/v1/analyze") {
      return json(request, { error: "Rota nao encontrada." }, 404);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return json(request, { error: "Envie um JSON valido." }, 400);
    }

    const prompt = buildPrompt(data || {});
    try {
      const result = await env.AI.run(MODEL, {
        messages: prompt.messages,
        max_tokens: 700,
        temperature: 0.25,
      });
      const analysis = asText(result.response, 6000);

      if (!analysis) {
        return json(request, { error: "A IA nao retornou uma analise utilizavel." }, 502);
      }

      return json(request, {
        provider: "cloudflare-workers-ai",
        model: MODEL,
        asset: prompt.asset,
        period: prompt.period,
        analysis,
        disclaimer: "Conteudo educativo; nao constitui recomendacao de investimento.",
      });
    } catch (error) {
      console.error("workers-ai-error", error);
      return json(request, { error: "Nao foi possivel gerar a analise agora." }, 502);
    }
  },
};
