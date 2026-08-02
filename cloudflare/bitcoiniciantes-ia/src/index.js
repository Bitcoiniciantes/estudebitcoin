const GEMINI_MODEL = "gemini-2.5-flash";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const ALLOWED_ORIGINS = new Set([
  "https://bitcoiniciantes.github.io",
  "http://localhost:3000",
  "http://localhost:8787",
]);
const SCENARIOS = new Set(["ALTA", "BAIXA", "NEUTRO", "RISCO ELEVADO"]);

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

function num(value, fractionDigits = 2) {
  return Number.isFinite(value)
    ? value.toLocaleString("pt-BR", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })
    : "n�o informado";
}

// ---------- Notícias (RSS Cointelegraph) ----------

function decodeXml(value) {
  return value.replace("<![CDATA[", "").replace("]]>", "").replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").trim();
}
function rssTag(xml, tag) {
  const start = xml.indexOf("<" + tag);
  if (start < 0) return "";
  const open = xml.indexOf(">", start);
  const end = xml.indexOf("</" + tag + ">", open);
  return open < 0 || end < 0 ? "" : decodeXml(xml.slice(open + 1, end));
}

const NEWS_TAGS = { BTC: "bitcoin", ETH: "ethereum", LINK: "chainlink", AVAX: "avalanche", PAXG: "pax-gold" };
const NEWS_QUERIES = {
  BTC: "Bitcoin criptomoeda",
  ETH: "Ethereum criptomoeda",
  LINK: "Chainlink criptomoeda",
  AVAX: "Avalanche AVAX criptomoeda",
  PAXG: "ouro mercado",
  MSTR: "Strategy MSTR Bitcoin",
  PRATA: "prata mercado",
  COBRE: "cobre mercado",
  URANIO: "ur�nio mercado",
};

function parseRssItems(xml, defaultSource, limit = 20) {
  return xml.split("<item>").slice(1, limit + 1).map((raw) => {
    const item = raw.split("</item>")[0];
    const title = rssTag(item, "title");
    const url = rssTag(item, "link");
    const publishedAt = rssTag(item, "pubDate");
    return {
      title,
      url,
      source: rssTag(item, "source") || defaultSource,
      publishedAt: publishedAt && !Number.isNaN(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : null,
    };
  }).filter((item) => item.title && item.url.startsWith("https://"));
}

async function fetchRssItems(url, defaultSource) {
  const response = await fetch(url, { headers: { "User-Agent": "BitcoiniciantesIA/1.0" } });
  if (!response.ok) throw new Error(`news-${response.status}`);
  return parseRssItems(await response.text(), defaultSource);
}

function newsQuery(asset) {
  const symbol = String(asset || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
  if (!symbol) return "financial markets";
  return NEWS_QUERIES[symbol] || `${symbol} cryptocurrency market`;
}

const NEWS_PATTERNS = {
  BTC: /\b(?:bitcoin|btc)\b/i,
  ETH: /\b(?:ethereum|ether|eth)\b/i,
  LINK: /\b(?:chainlink|link)\b/i,
  AVAX: /\b(?:avalanche|avax)\b/i,
  PAXG: /\b(?:pax gold|paxg|gold)\b/i,
  MSTR: /\b(?:strategy|microstrategy|mstr)\b/i,
  PRATA: /\bsilver\b/i,
  COBRE: /\bcopper\b/i,
  URANIO: /\buranium\b/i,
};
const LOW_QUALITY_NEWS = /\b(?:casino|price prediction|top sites|betting|gambling)\b/i;

function isRelevantNews(item, symbol) {
  if (LOW_QUALITY_NEWS.test(item.title)) return false;
  const pattern = NEWS_PATTERNS[symbol] || new RegExp(`\\b${symbol.replace(/[^A-Z0-9]/g, "")}\\b`, "i");
  return pattern.test(item.title);
}

async function fetchAssetNewsItems(asset) {
  const symbol = String(asset || "").toUpperCase();
  const tag = NEWS_TAGS[symbol];
  const query = `${newsQuery(symbol)} when:2d`;
  const googleUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;

  const clean = (items) => {
    const seen = new Set();
    return items
      .filter((item) => isRelevantNews(item, symbol))
      .filter((item) => !item.publishedAt || Date.parse(item.publishedAt) >= cutoff)
      .filter((item) => {
        const key = item.title.toLowerCase().replace(/\s+-\s+[^-]+$/, "").replace(/\s+/g, " ").trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  };

  const regional = await Promise.allSettled([
    fetchRssItems(googleUrl, "Google News Brasil"),
    fetchRssItems("https://www.criptofacil.com/feed/", "CriptoF\u00e1cil"),
  ]);
  const localItems = clean(regional.flatMap((result) => result.status === "fulfilled" ? result.value : []));
  if (localItems.length >= 3) return localItems.slice(0, 3);

  const fallbackQueries = {
    BTC: "Bitcoin cryptocurrency",
    ETH: "Ethereum cryptocurrency",
    LINK: "Chainlink cryptocurrency",
    AVAX: "Avalanche AVAX cryptocurrency",
    PAXG: "gold market",
    MSTR: "Strategy MSTR Bitcoin",
    PRATA: "silver market price",
    COBRE: "copper market price",
    URANIO: "uranium market price",
  };
  const fallbackQuery = `${fallbackQueries[symbol] || symbol} when:2d`;
  const globalGoogleUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(fallbackQuery)}&hl=en-US&gl=US&ceid=US:en`;
  const globalRequests = [fetchRssItems(globalGoogleUrl, "Google News Internacional")];
  if (tag) globalRequests.push(fetchRssItems("https://cointelegraph.com/rss/tag/" + tag, "Cointelegraph"));
  const global = await Promise.allSettled(globalRequests);
  return clean([
    ...localItems,
    ...global.flatMap((result) => result.status === "fulfilled" ? result.value : []),
  ]).slice(0, 3);
}

async function assetNews(request, asset) {
  const items = await fetchAssetNewsItems(asset);
  return json(request, { asset, updatedAt: new Date().toISOString(), items });
}

// ---------- Prompt: EstudeBitcoin (chat livre, sem mudança) ----------

function buildEstudeBitcoinPrompt(data) {
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
        content: "Voce e o Analista IA do EstudeBitcoin. Responda em portugues do Brasil, com clareza para iniciantes, tom prudente e sem recomendacao financeira personalizada. Use somente os dados fornecidos; quando faltar dado, diga isso de forma direta. Nao invente precos, indicadores ou noticias.\n\nRetorne SOMENTE em Markdown, exatamente nesta ordem, deixando uma linha em branco apos cada titulo:\n## Resumo\nUm paragrafo de no maximo 45 palavras.\n\n## Dados-chave\nDe 4 a 5 bullets curtos. Comece cada bullet com um rotulo em negrito, como **Preco atual:** ou **RSI:**. Priorize preco, variacao, nota/confianca, RSI, suporte/resistencia e volume quando existirem.\n\n## Riscos\nNo maximo 2 bullets; cite somente riscos sustentados pelos dados recebidos.\n\n## Proximo passo educativo\nNo maximo 2 bullets objetivos, ensinando o que observar ou estudar.\n\nCalibracao obrigatoria do RSI: abaixo de 30 = sobrevenda; de 30 ate abaixo de 45 = zona neutra-baixa; de 45 ate 55 = zona neutra; acima de 55 ate 70 = zona neutra-alta; acima de 70 = sobrecompra. Um RSI de 43,9 NAO e sobrevenda e nao significa reversao iminente. Use numeros no formato brasileiro e no maximo duas casas decimais.",
      },
      {
        role: "user",
        content: `Ativo: ${asset}\nPeriodo: ${period}\nDados de mercado: ${marketData || "Nao informado"}\nPergunta do usuario: ${question || "Explique o cenario atual com base nos dados."}`,
      },
    ],
  };
}

// ---------- Prompt: Termômetro (JSON estruturado) ----------

const TERMOMETRO_SYSTEM_PROMPT = `Você é o Analista Digital do Termômetro. Interprete os dados técnicos e as notícias recebidas.

Regras obrigatórias:
- Use SOMENTE os dados fornecidos. Nunca invente preços, indicadores, sinais ou notícias que não estejam nos dados.
- Cite pelo menos 2 sinais individuais pelo nome exato (campo "title" da lista de sinais), explicando como cada um pesa a favor ou contra o cenário.
- Se alguma notícia recebida for relevante para o período analisado, conecte-a à leitura em até 1 frase. Se nenhuma for relevante, não mencione notícias.
- Proibido usar frases genéricas e vagas como "sinais divididos entre tendência e força relativa" ou equivalentes — sempre aponte o sinal específico por trás da afirmação.
- Aponte também o que enfraquece ou contradiz o cenário (não seja unilateral).
- Nunca dê recomendação de compra/venda direta. É conteúdo educacional, não é conselho financeiro.
- Português do Brasil, tom direto e técnico, sem enrolação, sem markdown.

Responda SOMENTE com um JSON válido, sem nenhum texto fora dele, neste formato exato:
{
  "headline": "string curta, até 12 palavras",
  "scenario": "ALTA" | "BAIXA" | "NEUTRO" | "RISCO ELEVADO",
  "summary": "string, até 90 palavras, um parágrafo só",
  "strategy": ["2 a 3 itens curtos, ações/condições a observar"],
  "risks": ["1 a 3 itens curtos"],
  "invalidation": "string curta: o que invalidaria essa leitura"
}`;

function formatSignals(signals) {
  if (!Array.isArray(signals) || !signals.length) return "Nenhum sinal individual recebido.";
  return signals
    .slice(0, 12)
    .map((s) => `- ${asText(s?.title, 60) || "?"} [${asText(s?.group, 30) || "?"}] nota ${Number.isFinite(s?.score) ? s.score : "?"}: ${asText(s?.summary, 140)}`)
    .join("\n");
}

function formatNews(items) {
  if (!items?.length) return "Nenhuma notícia relevante encontrada nas últimas horas.";
  return items.map((n) => `- ${asText(n.title, 140)} (${asText(n.source, 40)})`).join("\n");
}

function formatTermometroContext(data, news) {
  const multiRsi = data.multiRsi
    ? `RSI geral: ${num(data.multiRsi.general)} (alta: ${num(data.multiRsi.bullCount)} / baixa: ${num(data.multiRsi.bearCount)}, sinal: ${asText(data.multiRsi.signal, 30)})`
    : "RSI multi-período: não informado";
  return [
    `Ativo: ${asText(data.asset, 24) || "?"}`,
    `Período: ${asText(data.period, 12) || "?"}`,
    `Preço atual: ${num(data.currentPrice)}`,
    `Nota (score, -100 a 100): ${num(data.score)}`,
    `Confiança (concordância dos sinais, %): ${num(data.confidence)}`,
    `Variação recente (%): ${num(data.change)}`,
    `Suporte: ${num(data.support)} | Resistência: ${num(data.resistance)}`,
    `Entrada condicional: ${num(data.entry)} | Stop: ${num(data.stop)} | Alvo: ${num(data.target)}`,
    `Volume relativo à média: ${num(data.volumeRatio)}x`,
    multiRsi,
    "",
    "Sinais individuais:",
    formatSignals(data.signals),
    "",
    "Notícias recentes do ativo:",
    formatNews(news),
  ].join("\n");
}

function buildTermometroPrompt(data, news) {
  const localScenario = asText(data?.localPreview?.scenario, 20).toUpperCase();
  const requiredScenario = SCENARIOS.has(localScenario) ? localScenario : null;
  return {
    asset: asText(data.asset, 24).toUpperCase() || "BTC",
    period: asText(data.period, 12) || "1D",
    requiredScenario,
    messages: [
      { role: "system", content: TERMOMETRO_SYSTEM_PROMPT },
      { role: "user", content: `Cenario oficial calculado pelo Termometro: ${requiredScenario || "nao informado"}. O campo scenario, o headline, o summary, a estrategia, os riscos e a invalidacao DEVEM ser coerentes com esse cenario oficial. Nao escolha outro cenario. Para pre�os, n�veis e propor��es, use formato brasileiro com no m�ximo 2 casas decimais, como 66.123,23.` },
      { role: "user", content: `Dados do Termômetro:\n${formatTermometroContext(data, news)}\n\nResponda SOMENTE com o JSON pedido.` },
    ],
  };
}

function parseTermometroAnalysis(raw) {
  if (!raw) return null;
  try {
    // alguns modelos ainda envolvem o JSON em ```json ... ``` mesmo em modo estruturado
    const cleaned = raw.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    const obj = JSON.parse(cleaned);
    const ok =
      typeof obj.headline === "string" &&
      SCENARIOS.has(obj.scenario) &&
      typeof obj.summary === "string" &&
      Array.isArray(obj.strategy) && obj.strategy.every((s) => typeof s === "string") &&
      Array.isArray(obj.risks) && obj.risks.every((s) => typeof s === "string") &&
      typeof obj.invalidation === "string";
    return ok ? obj : null;
  } catch {
    return null;
  }
}

function boundedText(value, fallback, maxLength) {
  const text = asText(value, maxLength);
  return text || fallback;
}
function boundedItems(value, fallback, maxItems = 3) {
  if (!Array.isArray(value)) return fallback;
  const items = value.map((item) => asText(item, 180)).filter(Boolean).slice(0, maxItems);
  return items.length ? items : fallback;
}
function normalizeScenarioText(value) {
  return asText(value, 2400).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function contradictsScenario(value, scenario) {
  const text = normalizeScenarioText(value);
  const bearish = /\b(?:tendencia|cenario|vies|direcao|movimento|pressao)\s+(?:de\s+)?(?:baixa|baixista)\b|\bem baixa\b/.test(text);
  const bullish = /\b(?:tendencia|cenario|vies|direcao|movimento|pressao)\s+(?:de\s+)?(?:alta|altista)\b|\bem alta\b/.test(text);
  if (scenario === "NEUTRO") return bearish || bullish;
  if (scenario === "ALTA") return bearish || /\bcenario neutro\b|\bsem direcao\b/.test(text);
  if (scenario === "BAIXA") return bullish || /\bcenario neutro\b|\bsem direcao\b/.test(text);
  return false;
}

// ---------- Provedores ----------

async function generateWithGemini(env, messages, { jsonMode = false } = {}) {
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
          temperature: 0.35,
          maxOutputTokens: 900,
          ...(jsonMode ? { responseMimeType: "application/json" } : {}),
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

async function generateWithGroq(env, messages, { jsonMode = false } = {}) {
  if (!env.GROQ_API_KEY) return null;
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.35,
      max_tokens: 900,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!response.ok) throw new Error(`groq-${response.status}`);
  const payload = await response.json();
  return asText(payload?.choices?.[0]?.message?.content, 6000);
}

// ---------- Handler ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

    if (request.method === "GET" && url.pathname === "/health") {
      return json(request, { ok: true, service: "bitcoiniciantes-ia", providers: ["gemini", "groq"] });
    }
    if (request.method === "GET" && (url.pathname === "/v1/news" || url.pathname === "/api/asset-news")) {
      return assetNews(request, url.searchParams.get("asset"));
    }

    const isTermometro = url.pathname === "/api/ai-analysis";
    const isEstudeBitcoin = url.pathname === "/v1/analyze";
    if (request.method !== "POST" || (!isTermometro && !isEstudeBitcoin)) {
      return json(request, { error: "Rota nao encontrada." }, 404);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return json(request, { error: "Envie um JSON valido." }, 400);
    }

    if (isEstudeBitcoin) {
      const prompt = buildEstudeBitcoinPrompt(data || {});
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
    }

    // ---- Termômetro ----
    const local = data?.localPreview || {};
    const news = await fetchAssetNewsItems(data?.asset);
    const prompt = buildTermometroPrompt(data || {}, news);
    const providers = [
      { name: "gemini", run: () => generateWithGemini(env, prompt.messages, { jsonMode: true }) },
      { name: "groq", run: () => generateWithGroq(env, prompt.messages, { jsonMode: true }) },
    ];

    for (const provider of providers) {
      try {
        const raw = await provider.run();
        if (!raw) continue;
        const parsed = parseTermometroAnalysis(raw);
        if (!parsed) continue;
        if (prompt.requiredScenario && parsed.scenario !== prompt.requiredScenario) {
          console.warn(`${provider.name}-scenario-mismatch`, { expected: prompt.requiredScenario, received: parsed.scenario });
          continue;
        }
        const narrative = [parsed.summary, ...parsed.strategy, ...parsed.risks, parsed.invalidation].join(" ");
        if (prompt.requiredScenario && contradictsScenario(narrative, prompt.requiredScenario)) {
          console.warn(`${provider.name}-narrative-mismatch`, { expected: prompt.requiredScenario });
          continue;
        }
        // Fallback campo-a-campo: usa o que a IA gerou; se algo faltar ou vier
        // malformado, cai de volta pro template local só naquele campo.
        return json(request, {
          headline: boundedText(local.headline, `${prompt.asset} em ${prompt.period}`, 120),
          scenario: prompt.requiredScenario || parsed.scenario || "NEUTRO",
          summary: boundedText(parsed?.summary, local.summary || "", 700),
          strategy: boundedItems(parsed?.strategy, local.strategy || []),
          risks: boundedItems(parsed?.risks, local.risks || []),
          invalidation: boundedText(parsed?.invalidation, local.invalidation || "", 240),
          provider: provider.name,
          generatedAt: new Date().toISOString(),
        });
      } catch (error) {
        console.error(`${provider.name}-error`, error);
      }
    }

    // Nenhum provedor respondeu: devolve o template local puro, mas sinaliza
    // isso pro front-end (o AiAnalysisCard pode usar esse campo se quiser
    // avisar o usuário que a IA não confirmou a leitura).
    return json(request, { ...local, provider: null, degraded: true, generatedAt: new Date().toISOString() });
  },
};
