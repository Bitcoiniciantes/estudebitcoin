const GEMINI_MODEL = "gemini-3.5-flash";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const ALLOWED_ORIGINS = new Set([
  "https://bitcoiniciantes.github.io",
  "http://localhost:3000",
  "http://localhost:8787",
]);

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = { "Content-Type": "application/json; charset=utf-8", "Vary": "Origin" };
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
        content: "Voce e o Analista IA do EstudeBitcoin. Responda em portugues do Brasil, com clareza para iniciantes e tom prudente. Use somente os dados fornecidos; diga explicitamente quando faltar dado. Nao invente precos, noticias ou indicadores. Nao de recomendacao financeira personalizada. Estruture a resposta em: resumo, leitura dos dados, riscos e proximo passo educativo. Seja conciso.",
      },
      {
        role: "user",
        content: `Ativo: ${asset}\nPeriodo: ${period}\nDados de mercado: ${marketData || "Nao informado"}\nPergunta do usuario: ${question || "Explique o cenario atual com base nos dados."}`,
      },
    ],
  };
}

async function generateWithGemini(env, messages) {
  if (!env.GEMINI_API_KEY) return null;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: messages
          .filter((message) => message.role !== "system")
          .map((message) => ({ role: "user", parts: [{ text: message.content }] })),
        systemInstruction: { parts: [{ text: messages[0].content }] },
        generationConfig: {
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingLevel: "MINIMAL" },
        },
      }),
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`gemini-${response.status} - Google Payload: ${errorText}`);
  }
  const payload = await response.json();
  return asText(payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join(""), 6000);
}

async function generateWithGroq(env, messages) {
  if (!env.GROQ_API_KEY) return null;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages, temperature: 0.25, max_tokens: 700 }),
  });
  if (!response.ok) throw new Error(`groq-${response.status}`);
  const payload = await response.json();
  return asText(payload?.choices?.[0]?.message?.content, 6000);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    if (request.method === "GET" && url.pathname === "/health") {
      return json(request, { ok: true, service: "bitcoiniciantes-ia", providers: ["gemini", "groq"] });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/analyze") {
      return json(request, { error: "Rota nao encontrada." }, 404);
    }
    let data;
    try { data = await request.json(); } catch { return json(request, { error: "Envie um JSON valido." }, 400); }
    const prompt = buildPrompt(data || {});
    const providers = [
      { name: "gemini", model: GEMINI_MODEL, run: () => generateWithGemini(env, prompt.messages) },
      { name: "groq", model: GROQ_MODEL, run: () => generateWithGroq(env, prompt.messages) },
    ];
    for (const provider of providers) {
      try {
        const analysis = await provider.run();
        if (!analysis) continue;
        return json(request, {
          provider: provider.name,
          model: provider.model,
          asset: prompt.asset,
          period: prompt.period,
          analysis,
          disclaimer: "Conteudo educativo; nao constitui recomendacao de investimento.",
        });
      } catch (error) {
        console.error(`${provider.name}-error`, error);
      }
    }
    return json(request, { error: "Nenhum provedor de IA esta disponivel agora." }, 503);
  },
};