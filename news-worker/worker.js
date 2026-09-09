/*
==========================================================
TOP 10 NOTÍCIAS — ESTUDE BITCOIN (Worker separado)
==========================================================

UM ÚNICO ARQUIVO.

Funções:
- coleta Google News RSS (3 buscas: Bitcoin, IA/tecnologia, EUA)
- extrai títulos + links + fonte
- exclui fora do escopo (futebol, política BR, entretenimento)
- remove duplicidades (similaridade, não só igualdade exata)
- calcula relevância
- seleciona TOP 10
- mantém resultado em cache (Cache API, sem KV)
- disponibiliza GET /api/top-news
- atualização via Cron 2x/dia

ESCOPO (decisão do usuário, 2026-09-09):
- Tecnologia/IA, Bitcoin e Estados Unidos
  (guerra, fatos relevantes, tragédias)
- FORA: Brasil, futebol, política brasileira, entretenimento

IMPORTANTE:
- não usa API key
- não usa banco
- não usa KV
- não usa arquivos externos
- não usa diretórios auxiliares

Cron (horário oficial de Brasília):
07:00 BRT = 10:00 UTC
14:00 BRT = 17:00 UTC

Expressão (definida no wrangler.toml):
0 10,17 * * *
==========================================================
*/

const CONFIG = {
  ROUTE: "/api/top-news",

  // Três buscas Google News (mesma fonte, sem fallback externo):
  // Bitcoin, IA/tecnologia e Estados Unidos. `when:7d` restringe
  // a janela; o scoring refina por recência (§9).
  RSS_QUERIES: [
    "https://news.google.com/rss/search?q=Bitcoin%20OR%20BTC%20OR%20criptomoeda%20when%3A7d&hl=pt-BR&gl=BR&ceid=BR:pt-BR",
    "https://news.google.com/rss/search?q=intelig%C3%AAncia%20artificial%20OR%20IA%20OR%20ChatGPT%20OR%20OpenAI%20OR%20Nvidia%20OR%20tecnologia%20when%3A7d&hl=pt-BR&gl=BR&ceid=BR:pt-BR",
    "https://news.google.com/rss/search?q=Estados%20Unidos%20OR%20EUA%20OR%20Trump%20OR%20guerra%20OR%20Ucr%C3%A2nia%20OR%20Israel%20when%3A7d&hl=pt-BR&gl=BR&ceid=BR:pt-BR"
  ],

  TOP_N: 10,

  CACHE_KEY:
    "https://news-cache.bitcoiniciantes.internal/api/top-news",

  CACHE_TTL: 60 * 60 * 13, // 13 horas (cobre o intervalo de 7h entre coletas)

  // Janela máxima (decisão do usuário, 2026-09-09): somente
  // notícias das últimas 24 horas. Maior que isso (ou sem
  // data) é descartado antes do ranking.
  MAX_AGE_MS: 24 * 60 * 60 * 1000,

  // Google News a partir de Workers costuma pendurar ~6,5s até
  // responder 503 — timeout curto evita travar o ciclo.
  FETCH_TIMEOUT_MS: 8000,

  // 503 do Google é intermitente: cada query tenta até 2x
  // (2ª após 3s). Mesma fonte, sem fallback externo.
  FETCH_MAX_ATTEMPTS: 2,
  FETCH_RETRY_DELAY_MS: 3000,

  // Similaridade mínima (Jaccard sobre tokens) para tratar dois
  // títulos como o mesmo acontecimento (§11 do top10noticias.md).
  // 0.4 (não 0.6): títulos curtos com variação verbal
  // ("mantém" x "manter") ficam ~0.4 e precisam fundir.
  DEDUPE_SIMILARITY: 0.4
};


// ========================================================
// WORKER
// ========================================================

export default {

  // ------------------------------------------------------
  // HTTP
  // ------------------------------------------------------

  async fetch(request, env, ctx) {

    const url = new URL(request.url);

    if (url.pathname === CONFIG.ROUTE) {
      return await getNews(request, ctx);
    }

    if (url.pathname === "/") {
      return new Response(
        "EstudeBitcoin News Worker OK",
        {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8"
          }
        }
      );
    }

    return new Response("Not Found", {
      status: 404
    });
  },


  // ------------------------------------------------------
  // CRON (2x/dia: 07:00 e 14:00 BRT = 10:00 e 17:00 UTC)
  // ------------------------------------------------------

  async scheduled(controller, env, ctx) {

    /*
      Toda vez que o Cron disparar:

      1. busca RSS
      2. processa
      3. grava no cache (somente se houver resultado válido —
         falha NUNCA apaga o TOP 10 anterior)
    */

    ctx.waitUntil(updateNewsCache());
  }
};


// ========================================================
// OBTER NOTÍCIAS
// ========================================================

async function getNews(request, ctx) {

  const cache = caches.default;

  const cacheRequest = new Request(
    CONFIG.CACHE_KEY,
    {
      method: "GET"
    }
  );

  // ------------------------------------------------------
  // PRIMEIRO: tenta cache
  // ------------------------------------------------------

  const cached = await cache.match(cacheRequest);

  if (cached) {

    const response = new Response(
      cached.body,
      cached
    );

    response.headers.set(
      "X-News-Cache",
      "HIT"
    );

    return response;
  }


  // ------------------------------------------------------
  // SE NÃO HOUVER CACHE
  // faz uma coleta imediatamente.
  // Este é o único caminho que pode retornar vazio, e só
  // ocorre quando nenhum TOP 10 válido foi gerado ainda.
  // ------------------------------------------------------

  try {

    const data = await collectNews();

    const response = createNewsResponse(data);

    ctx.waitUntil(
      cache.put(
        cacheRequest,
        response.clone()
      )
    );

    response.headers.set(
      "X-News-Cache",
      "MISS"
    );

    return response;

  } catch (error) {

    console.error("[NEWS] ERRO:", error);

    return jsonResponse(
      {
        ok: false,
        error: "Falha ao obter notícias",
        items: []
      },
      500
    );
  }
}


// ========================================================
// ATUALIZA CACHE (chamado pelo Cron)
// ========================================================

async function updateNewsCache() {

  try {

    console.log("[NEWS] Coleta iniciada");

    const data = await collectNews();

    if (!data.items.length) {

      // REGRA (§16): falha ou RSS vazio NUNCA substitui um
      // resultado válido anterior.
      console.error(
        "[NEWS] Nenhuma notícia encontrada. Mantendo TOP 10 anterior."
      );

      return;
    }

    const response =
      createNewsResponse(data);

    const cache =
      caches.default;

    const cacheRequest =
      new Request(
        CONFIG.CACHE_KEY,
        {
          method: "GET"
        }
      );

    await cache.put(
      cacheRequest,
      response
    );

    console.log(
      `[NEWS] TOP 10 gerado`
    );
    console.log(
      `[NEWS] Cache atualizado`
    );
    console.log(
      `[NEWS] Atualização concluída`
    );

  } catch (error) {

    // REGRA (§16): erro de rede/RSS mantém o último TOP 10
    // válido; apenas registra o erro no log.
    console.error(
      "[NEWS] ERRO:",
      error
    );
  }
}


// ========================================================
// COLETA RSS
// ========================================================

async function fetchRSS(url) {

  let lastError = new Error("RSS vazio");

  for (let attempt = 1; attempt <= CONFIG.FETCH_MAX_ATTEMPTS; attempt++) {

    if (attempt > 1) {

      await new Promise(resolve =>
        setTimeout(resolve, CONFIG.FETCH_RETRY_DELAY_MS)
      );
    }

    try {

      return await fetchOnce(url);

    } catch (error) {

      lastError = error;

      console.error(
        `[NEWS] Tentativa ${attempt} falhou:`,
        error && error.message ? error.message : error
      );
    }
  }

  throw lastError;
}


async function fetchOnce(url) {

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    CONFIG.FETCH_TIMEOUT_MS
  );

  try {

    const response = await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/126.0.0.0 Safari/537.36"
        },
        signal: controller.signal
      }
    );

    if (!response.ok) {

      throw new Error(
        `RSS HTTP ${response.status}`
      );
    }

    return await response.text();

  } finally {

    clearTimeout(timeout);
  }
}


async function collectNews() {

  // Três buscas em paralelo (mesma fonte: Google News).
  // Se uma query falhar (503/timeout), as demais sustentam
  // a coleta — sem fonte alternativa.
  const results = await Promise.allSettled(
    CONFIG.RSS_QUERIES.map(fetchRSS)
  );

  const fulfilled =
    results.filter(r => r.status === "fulfilled");

  if (!fulfilled.length) {

    const reason =
      results[0].status === "rejected"
        ? results[0].reason
        : new Error("RSS vazio");

    throw reason instanceof Error
      ? reason
      : new Error(`RSS HTTP ${reason}`);
  }

  for (const r of results) {
    if (r.status === "rejected") {
      console.error("[NEWS] Query falhou:", r.reason);
    }
  }

  console.log(
    `[NEWS] RSS recebido (${fulfilled.length}/${results.length} queries)`
  );

  let rawItems = [];

  for (const r of fulfilled) {
    rawItems = rawItems.concat(parseRSS(r.value));
  }

  console.log(
    `[NEWS] Notícias encontradas: ${rawItems.length}`
  );

  // ------------------------------------------------------
  // NORMALIZA
  // ------------------------------------------------------

  let items =
    rawItems
      .map(normalizeItem)
      .filter(Boolean);


  // ------------------------------------------------------
  // EXCLUI FORA DO ESCOPO
  // (futebol, política BR, entretenimento)
  // ------------------------------------------------------

  const beforeScope = items.length;

  items =
    items.filter(item => !isExcluded(item));

  console.log(
    `[NEWS] No escopo: ${items.length} (de ${beforeScope})`
  );


  // ------------------------------------------------------
  // JANELA DE 24H (decisão do usuário, 2026-09-09)
  // ------------------------------------------------------

  const beforeAge = items.length;

  items =
    items.filter(isFresh);

  console.log(
    `[NEWS] Últimas 24h: ${items.length} (de ${beforeAge})`
  );


  // ------------------------------------------------------
  // REMOVE DUPLICIDADES
  // ------------------------------------------------------

  const beforeDedupe = items.length;

  items =
    removeDuplicates(items);

  console.log(
    `[NEWS] Após deduplicação: ${items.length} (de ${beforeDedupe})`
  );


  // ------------------------------------------------------
  // CALCULA RELEVÂNCIA + FILTRA PELOS PILARES
  // Só entra no TOP 10 o que pontuar em ao menos um pilar
  // (Bitcoin, IA/tecnologia ou EUA). Recência/fonte sozinhas
  // não classificam.
  // ------------------------------------------------------

  items =
    items.map(item => ({
      ...item,
      ...calculateScore(item)
    }))
    .filter(item => item.pillar > 0);


  // ------------------------------------------------------
  // ORDENA
  // ------------------------------------------------------

  items.sort(
    (a, b) => b.score - a.score
  );


  // ------------------------------------------------------
  // TOP 10
  // ------------------------------------------------------

  items =
    items
      .slice(0, CONFIG.TOP_N)
      .map((item, index) => ({
        position: index + 1,
        title: item.title,
        url: item.url,
        source: item.source,
        publishedAt: item.publishedAt
      }));


  return {

    updatedAt:
      new Date().toISOString(),

    count:
      items.length,

    items
  };
}


// ========================================================
// PARSER RSS
// ========================================================

function parseRSS(xml) {

  const items = [];

  const matches =
    xml.matchAll(
      /<item>([\s\S]*?)<\/item>/gi
    );

  for (const match of matches) {

    const block = match[1];

    const title =
      extractTag(
        block,
        "title"
      );

    const link =
      extractTag(
        block,
        "link"
      );

    const pubDate =
      extractTag(
        block,
        "pubDate"
      );

    const source =
      extractTag(
        block,
        "source"
      );

    if (!title || !link)
      continue;

    items.push({
      title,
      url: link,
      source:
        source || "Google News",
      publishedAt:
        pubDate || null
    });
  }

  return items;
}


// ========================================================
// EXTRAI TAG XML
// ========================================================

function extractTag(
  xml,
  tag
) {

  const regex =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  const match =
    xml.match(regex);

  if (!match)
    return null;

  return decodeXML(
    stripHTML(
      match[1]
    ).trim()
  );
}


// ========================================================
// NORMALIZA
// ========================================================

function normalizeItem(item) {

  let title =
    item.title
      .replace(/\s+/g, " ")
      .trim();

  if (!title)
    return null;

  const source =
    item.source
      .replace(/\s+/g, " ")
      .trim();

  // Google News embute artefatos no título: prefixo "Notícia(s) " e
  // sufixo " - Fonte" (a fonte já é exibida em campo próprio).
  title = title
    .replace(/^notícias?\s+/i, "")
    .replace(/^noticias?\s+/i, "");

  if (/^notícias?$/i.test(title) || /^noticias?$/i.test(title)) {
    title = "";
  }

  const suffix = " - " + source;

  if (
    source.length > 1 &&
    title.toLowerCase().endsWith(suffix.toLowerCase())
  ) {
    title =
      title.slice(0, title.length - suffix.length).trim();
  }

  if (!title)
    return null;

  const url = item.url.trim();

  // Segurança (§17): só URLs http/https chegam ao frontend.
  if (!/^https?:\/\//i.test(url))
    return null;

  return {
    title,

    url,

    source,

    publishedAt:
      item.publishedAt
  };
}


// ========================================================
// DUPLICIDADES (§11: 10 acontecimentos, não 10 URLs)
//
// Igualdade exata não basta: "Fed mantém juros..." e
// "Fed decide manter juros..." normalizam para chaves
// diferentes. Usa similaridade de Jaccard sobre tokens;
// acima do limiar, é o mesmo acontecimento (mantém o
// primeiro, que é o mais recente no RSS).
// ========================================================

const DEDUPE_STOPWORDS = new Set(
  "de da do das dos a o as os e em para por com um uma uns umas no na nos nas ao aos se que como mais foi são era sua seu suas seus este esta isto isso".split(" ")
);

function tokenize(title) {

  const tokens =
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // marcas de acento combinadas (U+0300-U+036F)
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(word => word && !DEDUPE_STOPWORDS.has(word));

  return new Set(tokens);
}

function jaccard(setA, setB) {

  if (!setA.size || !setB.size)
    return 0;

  let intersection = 0;

  for (const token of setA) {
    if (setB.has(token))
      intersection++;
  }

  const union = setA.size + setB.size - intersection;

  return union ? intersection / union : 0;
}

function removeDuplicates(items) {

  const kept = [];
  const keptTokens = [];

  for (const item of items) {

    const tokens = tokenize(item.title);

    let isDuplicate = false;

    for (const other of keptTokens) {
      if (jaccard(tokens, other) >= CONFIG.DEDUPE_SIMILARITY) {
        isDuplicate = true;
        break;
      }
    }

    if (isDuplicate)
      continue;

    keptTokens.push(tokens);
    kept.push(item);
  }

  return kept;
}


// EXCLUSÃO DE ESCOPO (decisão do usuário, 2026-09-09)
// Fora: futebol, política brasileira, entretenimento/BR.
// A comparação ignora acentos e casa (ver foldText).
// ========================================================

const EXCLUDED_TERMS = [

  // Futebol (BR e internacional)
  "futebol", "flamengo", "corinthians", "palmeiras", "são paulo",
  "sao paulo fc", "vasco", "santos fc", "grêmio", "gremio", "cruzeiro",
  "botafogo", "atlético", "atletico mineiro", "internacional fc",
  "brasileirão", "brasileirao", "libertadores", "copa do brasil",
  "seleção brasileira", "selecao brasileira", "champions league",
  "real madrid", "barcelona", "neymar", "vinicius", "vini jr",
  "cbf", "cartola", "escalação", "escalacao", "convocação", "convocacao",

  // Política brasileira
  "lula", "bolsonaro", "stf", "supremo tribunal", "moraes",
  "câmara dos deputados", "camara dos deputados", "senado federal",
  "haddad", "boulos", "marçal", "marcal", "tarcísio", "tarcisio",
  "cpi", "vereador", "prefeito", "governador",

  // Entretenimento / variedades BR
  "bbb", "big brother", "novela", "fazenda", "reality",
  "carnaval", "sertanejo", "funk", "show de"
];

function foldText(text) {

  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // marcas de acento (U+0300-U+036F)
  );
}

function isExcluded(item) {

  const text = foldText(item.title + " " + item.source);

  for (const term of EXCLUDED_TERMS) {

    if (text.includes(foldText(term))) {
      return true;
    }
  }

  return false;
}


// Somente últimas 24h: descarta sem data ou mais velho que MAX_AGE_MS.
function isFresh(item) {

  if (!item.publishedAt)
    return false;

  const timestamp = Date.parse(item.publishedAt);

  if (Number.isNaN(timestamp))
    return false;

  return (Date.now() - timestamp) <= CONFIG.MAX_AGE_MS;
}


// ========================================================
// RANKING (pilares: Bitcoin, IA/tecnologia, EUA
// + §9 recência + §10 bônus de fonte)
// ========================================================

function calculateScore(item) {

  // Espaços nas bordas para casar siglas isoladas (" ia ").
  const text =
    " " + foldText(item.title) + " ";

  let pillar = 0;
  let score = 0;


  // ------------------------------------------------------
  // PILAR 1 — BITCOIN
  // ------------------------------------------------------

  const bitcoin = [

    "bitcoin",
    "btc",
    "criptomoeda",
    "criptomoedas",
    "cripto",
    "ethereum",
    "blockchain",
    "stablecoin",
    "halving",
    "satoshi"
  ];


  for (const word of bitcoin) {

    if (text.includes(word)) {

      pillar += 10;
    }
  }


  // ------------------------------------------------------
  // PILAR 2 — IA / TECNOLOGIA
  // ------------------------------------------------------

  const tech = [

    "inteligencia artificial",
    " ia ",
    "chatgpt",
    "openai",
    "anthropic",
    "nvidia",
    "machine learning",
    "deep learning",
    "robo",
    "robotica",
    "semicondutor",
    "semicondutores",
    "data center",
    "microsoft",
    "google",
    "apple",
    "tesla",
    "spacex",
    "startup",
    "chip"
  ];


  for (const word of tech) {

    if (text.includes(word)) {

      pillar += 10;
    }
  }


  // ------------------------------------------------------
  // PILAR 3 — ESTADOS UNIDOS
  // (guerra, fatos relevantes, tragédias)
  // ------------------------------------------------------

  const usa = [

    "estados unidos",
    " eua ",
    "trump",
    "casa branca",
    "pentagono",
    "guerra",
    "ataque",
    "invasao",
    "ucrania",
    "israel",
    "ira",
    "russia",
    "china",
    "taiwan",
    "tragedia",
    "terremoto",
    "furacao",
    "tornado",
    "atentado",
    "refem",
    "cessar-fogo",
    "cessar fogo",
    "otan",
    " onu "
  ];


  for (const word of usa) {

    if (text.includes(word)) {

      pillar += 10;
    }
  }

  score += pillar;


  // ------------------------------------------------------
  // RECÊNCIA (§9)
  // ------------------------------------------------------

  if (item.publishedAt) {

    const timestamp =
      Date.parse(
        item.publishedAt
      );

    if (!Number.isNaN(timestamp)) {

      const hours =
        (
          Date.now() - timestamp
        ) / 3600000;

      if (hours <= 3)
        score += 10;

      else if (hours <= 6)
        score += 7;

      else if (hours <= 12)
        score += 4;

      else if (hours <= 24)
        score += 1;
    }
  }


  // ------------------------------------------------------
  // BÔNUS DE FONTE POR TIER (§10 + regra de qualidade 2026-09-09)
  // Tier A (alta confiança): +8. Tier B (aceitável): +3.
  // Fonte desconhecida: +0 (nunca excluída — o ranking não é
  // uma lista fixa dessas fontes).
  // ------------------------------------------------------

  const source =
    foldText(" " + item.source + " ");

  const tierA = [

    "agencia brasil",
    "reuters",
    "bloomberg",
    "coindesk",
    "exame",
    "estadao",
    "valor",
    "bbc",
    "associated press",
    "ap news",
    "financial times",
    "wall street journal",
    "cnbc"
  ];

  const tierB = [

    "kinvo",
    "money times",
    "seu dinheiro",
    "infomoney",
    "livecoins",
    "criptofacil",
    "decrypt",
    "the block",
    "uol economia",
    "g1",
    "oglobo",
    "veja",
    "dw"
  ];

  let tierBonus = 0;

  for (const trusted of tierA) {

    if (source.includes(trusted)) {

      tierBonus = 8;
      break;
    }
  }

  if (!tierBonus) {

    for (const ok of tierB) {

      if (source.includes(ok)) {

        tierBonus = 3;
        break;
      }
    }
  }

  score += tierBonus;


  return { score, pillar };
}


// ========================================================
// RESPONSE
// ========================================================

function createNewsResponse(data) {

  return new Response(
    JSON.stringify(
      {
        ok: true,
        ...data
      },
      null,
      2
    ),
    {
      status: 200,

      headers: {

        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "public, max-age=300",

        "access-control-allow-origin":
          "*"
      }
    }
  );
}


// ========================================================
// JSON
// ========================================================

function jsonResponse(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "access-control-allow-origin":
          "*"
      }
    }
  );
}


// ========================================================
// XML / HTML
// ========================================================

function stripHTML(text) {

  return text
    .replace(
      /<!\[CDATA\[/gi,
      ""
    )
    .replace(
      /\]\]>/g,
      ""
    )
    .replace(
      /<[^>]*>/g,
      ""
    );
}


function decodeXML(text) {

  return text
    .replace(
      /&amp;/g,
      "&"
    )
    .replace(
      /&lt;/g,
      "<"
    )
    .replace(
      /&gt;/g,
      ">"
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&#39;/g,
      "'"
    )
    .replace(
      /&#(\d+);/g,
      (_, n) =>
        String.fromCharCode(
          Number(n)
        )
    );
}
