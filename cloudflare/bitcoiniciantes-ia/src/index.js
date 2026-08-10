const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const SCENARIOS = new Set(["ALTA", "BAIXA", "NEUTRO", "RISCO ELEVADO"]);

function corsHeaders(request) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
  return headers;
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}

function publicMarkerKey(url) {
  const asset = url.searchParams.get("asset") || "";
  if (!/^[a-zA-Z0-9:_.=-]{3,120}$/.test(asset)) return null;
  return `public-markers:${asset}`;
}

function cleanPublicMarkers(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((marker) => {
    if (!Number.isFinite(marker?.price) || marker.price <= 0 || marker.price >= 1e15) return [];
    if (marker.type === "text") {
      const text = typeof marker.text === "string" ? marker.text.trim().slice(0, 80) : "";
      const x = Number(marker.x);
      if (!text || !Number.isFinite(x) || x < 0 || x > 1) return [];
      return [{ type: "text", price: Number(marker.price), x, text }];
    }
    if (marker.type === "ray") {
      const x = Number(marker.x);
      const endX = Number(marker.endX);
      const endPrice = Number(marker.endPrice);
      if (![x, endX, endPrice].every(Number.isFinite) || x < 0 || x > 1 || endX < 0 || endX > 1 || endPrice <= 0 || endPrice >= 1e15 || Math.abs(endX - x) < 0.01) return [];
      return [{ type: "ray", price: Number(marker.price), x, endX, endPrice }];
    }
    return [{ type: "line", price: Number(marker.price) }];
  });
}
async function publicMarkers(request, url, env) {
  const key = publicMarkerKey(url);
  if (!key) return json(request, { error: "Ativo invalido." }, 400);
  if (!env.PUBLIC_MARKERS) return json(request, { error: "Marcacoes indisponiveis." }, 503);

  if (request.method === "GET") {
    const stored = await env.PUBLIC_MARKERS.get(key, "json");
    return json(request, {
      markers: cleanPublicMarkers(stored?.markers),
      updatedAt: Number(stored?.updatedAt) || 0,
    });
  }

  if (request.method !== "POST") return json(request, { error: "Metodo nao permitido." }, 405);
  let body;
  try {
    body = await request.json();
  } catch {
    return json(request, { error: "Envie um JSON valido." }, 400);
  }
  const payload = { markers: cleanPublicMarkers(body?.markers), updatedAt: Date.now() };
  await env.PUBLIC_MARKERS.put(key, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 180 });
  return json(request, payload);
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

const NEWS_TAGS = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", LINK: "chainlink", AVAX: "avalanche", POL: "polygon", PAXG: "pax-gold" };
const NEWS_QUERIES = {
  BTC: "Bitcoin criptomoeda",
  ETH: "Ethereum criptomoeda",
  SOL: "Solana criptomoeda",
  LINK: "Chainlink criptomoeda",
  AVAX: "Avalanche AVAX criptomoeda",
  POL: "Polygon POL criptomoeda",
  PAXG: "ouro mercado",
  MSTR: "Strategy MSTR Bitcoin",
  QBTS: "D-Wave Quantum QBTS ações",
  QUBT: "Quantum Computing QUBT ações",
  CRCL: "Circle CRCL ações",
  MP: "MP Materials ações",
  GLW: "Corning GLW ações",
  SNDK: "SanDisk SNDK ações",
  RIO: "Rio Tinto RIO ações",
  BHP: "BHP Group ações",
  SPCX: "SPCX ações",
  NVDA: "Nvidia ações",
  AMD: "AMD ações",
  TSLA: "Tesla ações",
  GOOGL: "Google Alphabet ações",
  META: "Meta ações",
  AAPL: "Apple ações",
  PRATA: "prata mercado",
  COBRE: "cobre mercado",
  URANIO: "urânio mercado",
};

const BING_QUERIES = {
  BTC: "Bitcoin cryptocurrency price news",
  ETH: "Ethereum cryptocurrency price news",
  SOL: "Solana SOL price news",
  LINK: "Chainlink LINK price news",
  AVAX: "Avalanche AVAX price news",
  POL: "Polygon POL price news",
  PAXG: "gold price market news",
  MSTR: "Strategy MSTR MicroStrategy Bitcoin",
  QBTS: "D-Wave Quantum QBTS stock news",
  QUBT: "Quantum Computing QUBT stock news",
  CRCL: "Circle CRCL stock news",
  MP: "MP Materials stock news",
  GLW: "Corning GLW stock news",
  SNDK: "SanDisk SNDK stock news",
  RIO: "Rio Tinto RIO stock news",
  BHP: "BHP Group stock news",
  SPCX: "SPCX stock news",
  NVDA: "Nvidia stock news",
  AMD: "AMD Advanced Micro Devices stock",
  TSLA: "Tesla stock news",
  GOOGL: "Alphabet Google stock news",
  META: "Meta stock news",
  AAPL: "Apple stock news",
  PRATA: "silver price market news",
  COBRE: "copper price market news",
  URANIO: "uranium price market news",
};


const SEC_TICKERS = new Set([
  "MSTR", "NVDA", "AMD", "TSLA", "GOOGL", "META", "AAPL", "QBTS", "QUBT",
  "SNDK", "GLW", "CRCL", "MP", "RIO", "BHP", "SPCX",
]);
const SEC_FORMS = new Set(["8-K", "10-Q", "10-K", "20-F", "40-F", "6-K"]);
const SEC_USER_AGENT = "Bitcoiniciantes/1.0 (contato: joelhamad@yahoo.com.br)";
const SEC_TICKERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
function parseRssItems(xml, defaultSource, limit = 60) {
  return xml.split("<item>").slice(1, limit + 1).map((raw) => {
    const item = raw.split("</item>")[0];
    const title = rssTag(item, "title");
    const url = rssTag(item, "link");
    const publishedAt = rssTag(item, "pubDate");
    const description = rssTag(item, "description");
    return {
      title,
      url,
      description,
      source: rssTag(item, "source") || defaultSource,
      publishedAt: publishedAt && !Number.isNaN(Date.parse(publishedAt)) ? new Date(publishedAt).toISOString() : null,
    };
  }).filter((item) => item.title && (item.url.startsWith("https://") || item.url.startsWith("http://")));
}

const NEWS_FETCH_TIMEOUT_MS = 8000;
const NEWS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function fetchWithTimeout(url, timeoutMs = NEWS_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" }, signal: controller.signal });
    if (!response.ok) throw new Error(`news-${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRssItems(url, defaultSource, attempts = 1, timeoutMs = NEWS_FETCH_TIMEOUT_MS) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, timeoutMs);
      return parseRssItems(await response.text(), defaultSource);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("news-failed");
}

async function fetchSecTickerMap() {
  const cacheKey = "https://bitcoiniciantes-ia.workers.dev/_cache/sec/company-tickers";
  try {
    const cached = await caches.default.match(cacheKey);
    const cachedAt = Number(cached?.headers.get("X-Cached-At")) || 0;
    if (cached && Date.now() - cachedAt < SEC_TICKERS_CACHE_TTL_MS) return cached.json();
  } catch {}
  const response = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate" },
  });
  if (!response.ok) throw new Error(`sec-tickers-${response.status}`);
  const payload = await response.json();
  try {
    await caches.default.put(cacheKey, new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json", "X-Cached-At": String(Date.now()) },
    }));
  } catch {}
  return payload;
}

async function fetchSecFilings(symbol) {
  if (!SEC_TICKERS.has(symbol)) return [];
  try {
    const tickers = await fetchSecTickerMap();
    const ticker = Object.values(tickers).find((item) => String(item?.ticker || "").toUpperCase() === symbol);
    if (!ticker?.cik_str) return [];
    const cik = String(ticker.cik_str).padStart(10, "0");
    const response = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { "User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate" },
    });
    if (!response.ok) throw new Error(`sec-submissions-${response.status}`);
    const filings = (await response.json())?.filings?.recent || {};
    const cutoff = Date.now() - NEWS_MAX_AGE_MS;
    return (filings.form || []).flatMap((form, index) => {
      if (!SEC_FORMS.has(form)) return [];
      const date = filings.filingDate?.[index];
      const publishedAt = date && !Number.isNaN(Date.parse(date)) ? new Date(`${date}T12:00:00Z`).toISOString() : null;
      if (publishedAt && Date.parse(publishedAt) < cutoff) return [];
      const accession = String(filings.accessionNumber?.[index] || "").replaceAll("-", "");
      const document = String(filings.primaryDocument?.[index] || "");
      if (!accession || !document) return [];
      return [{
        title: `${form} protocolado por ${ticker.title || symbol}`,
        description: "Documento oficial registrado na SEC.",
        url: `https://www.sec.gov/Archives/edgar/data/${Number(ticker.cik_str)}/${accession}/${document}`,
        source: "SEC EDGAR",
        publishedAt,
      }];
    });
  } catch {
    return [];
  }
}
function newsQuery(asset) {
  const symbol = String(asset || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
  if (!symbol) return "financial markets";
  return NEWS_QUERIES[symbol] || `${symbol} cryptocurrency market`;
}

const NEWS_PATTERNS = {
  BTC: /\b(?:bitcoin|btc)\b/i,
  ETH: /\b(?:ethereum|ether|eth)\b/i,
  SOL: /\b(?:solana|sol)\b/i,
  LINK: /\b(?:chainlink|link)\b/i,
  AVAX: /\b(?:avalanche|avax)\b/i,
  POL: /\b(?:polygon|pol)\b/i,
  PAXG: /\b(?:pax gold|paxg|gold|ouro)\b/i,
  MSTR: /\b(?:strategy|microstrategy|mstr)\b/i,
  QBTS: /\b(?:d-wave|d wave|qbts)\b/i,
  QUBT: /\b(?:quantum computing|qubt)\b/i,
  CRCL: /\b(?:circle|crcl)\b/i,
  MP: /\b(?:mp materials|mp)\b/i,
  GLW: /\b(?:corning|glw)\b/i,
  SNDK: /\b(?:sandisk|sndk)\b/i,
  RIO: /\b(?:rio tinto|\brio\b)\b/i,
  BHP: /\b(?:bhp)\b/i,
  SPCX: /\b(?:spcx)\b/i,
  NVDA: /\b(?:nvidia|nvda)\b/i,
  AMD: /\b(?:amd|advanced micro devices)\b/i,
  TSLA: /\b(?:tesla|tsla)\b/i,
  GOOGL: /\b(?:google|alphabet|googl)\b/i,
  META: /\b(?:meta|facebook)\b/i,
  AAPL: /\b(?:apple|aapl)\b/i,
  PRATA: /\b(?:silver|prata)\b/i,
  COBRE: /\b(?:copper|cobre)\b/i,
  URANIO: /\b(?:uranium|uranio|urânio)\b/i,
};
const LOW_QUALITY_NEWS = /\b(?:casino|price prediction|top sites|betting|gambling)\b/i;

const NICHE_SOURCES = {
  PAXG: [
    ["https://goldsilver.com/feed/", "GoldSilver.com"],
    ["https://investingnews.com/feed/", "Investing News Network"],
  ],
  PRATA: [
    ["https://silverdoctors.com/feed/", "Silver Doctors"],
    ["https://goldsilver.com/feed/", "GoldSilver.com"],
    ["https://investingnews.com/feed/", "Investing News Network"],
    ["https://www.mining.com/feed/", "Mining.com"],
  ],
  COBRE: [
    ["https://investingnews.com/feed/", "Investing News Network"],
    ["https://www.mining.com/feed/", "Mining.com"],
    ["https://www.nasdaq.com/feed/rssoutbound?category=Commodities", "Nasdaq Commodities"],
  ],
  URANIO: [
    ["https://www.world-nuclear-news.org/rss", "World Nuclear News"],
    ["https://investingnews.com/feed/", "Investing News Network"],
    ["https://www.mining.com/feed/", "Mining.com"],
  ],
};

function isRelevantNews(item, symbol) {
  if (LOW_QUALITY_NEWS.test(item.title)) return false;
  const pattern = NEWS_PATTERNS[symbol] || new RegExp(`\\b${symbol.replace(/[^A-Z0-9]/g, "")}\\b`, "i");
  return pattern.test(item.title) || (item.description && pattern.test(item.description.slice(0, 400)));
}

async function fetchAssetNewsItems(asset) {
  const symbol = String(asset || "").toUpperCase();
  const tag = NEWS_TAGS[symbol];
  const cutoff = Date.now() - NEWS_MAX_AGE_MS;
  const secItemsPromise = fetchSecFilings(symbol);

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

  const fulfilled = (results) => results.flatMap((result) => result.status === "fulfilled" ? result.value : []);

  const localRequests = [fetchRssItems("https://www.criptofacil.com/feed/", "CriptoF\u00e1cil")];
  if (tag) localRequests.push(fetchRssItems("https://cointelegraph.com/rss/tag/" + tag, "Cointelegraph"));
  const localItems = clean(fulfilled(await Promise.allSettled(localRequests)));
  const secItems = clean(await secItemsPromise);
  if (localItems.length >= 3) return clean([...secItems, ...localItems]).slice(0, 3);

  const generalRequests = [
    fetchRssItems("https://www.theblock.co/rss.xml", "The Block"),
    fetchRssItems("https://decrypt.co/feed", "Decrypt"),
    fetchRssItems("https://www.coindesk.com/arc/outboundfeeds/rss/", "CoinDesk"),
    fetchRssItems("https://www.infomoney.com.br/feed/", "InfoMoney"),
    fetchRssItems("https://livecoins.com.br/feed/", "LiveCoins"),
    fetchRssItems("https://exame.com/feed/", "Exame"),
    fetchRssItems("https://beincrypto.com/feed/", "BeInCrypto"),
    fetchRssItems("https://ambcrypto.com/feed/", "AMBCrypto"),
  ];
  const generalItems = clean(fulfilled(await Promise.allSettled(generalRequests)));
  const merged = clean([...localItems, ...generalItems]);
  if (merged.length >= 3) return clean([...secItems, ...merged]).slice(0, 3);

  const nicheSources = NICHE_SOURCES[symbol] || [];
  const nicheItems = clean(fulfilled(await Promise.allSettled(
    nicheSources.map(([url, source]) => fetchRssItems(url, source)),
  )));
  const mergedNiche = clean([...localItems, ...generalItems, ...nicheItems]);
  if (mergedNiche.length >= 3) return clean([...secItems, ...mergedNiche]).slice(0, 3);

  const bingUrl = `https://www.bing.com/news/search?format=rss&q=${encodeURIComponent(BING_QUERIES[symbol] || `${symbol} market news`)}`;
  const bingItems = clean(fulfilled(await Promise.allSettled([
    fetchRssItems(bingUrl, "Bing Notícias", 1, NEWS_FETCH_TIMEOUT_MS),
  ])));

  const googleUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(`${newsQuery(symbol)} when:7d`)}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
  const fallbackQueries = {
    BTC: "Bitcoin cryptocurrency",
    ETH: "Ethereum cryptocurrency",
    SOL: "Solana cryptocurrency",
    LINK: "Chainlink cryptocurrency",
    AVAX: "Avalanche AVAX cryptocurrency",
    POL: "Polygon POL cryptocurrency",
    PAXG: "gold market",
    MSTR: "Strategy MSTR Bitcoin",
  QBTS: "D-Wave Quantum QBTS ações",
  QUBT: "Quantum Computing QUBT ações",
  CRCL: "Circle CRCL ações",
  MP: "MP Materials ações",
  GLW: "Corning GLW ações",
  SNDK: "SanDisk SNDK ações",
  RIO: "Rio Tinto RIO ações",
  BHP: "BHP Group ações",
  SPCX: "SPCX ações",
    NVDA: "Nvidia stock",
    AMD: "AMD stock",
    TSLA: "Tesla stock",
    GOOGL: "Google Alphabet stock",
    META: "Meta stock",
    AAPL: "Apple stock",
    PRATA: "silver market price",
    COBRE: "copper market price",
    URANIO: "uranium market price",
  };
  const fallbackQuery = `${fallbackQueries[symbol] || symbol} when:7d`;
  const globalGoogleUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(fallbackQuery)}&hl=en-US&gl=US&ceid=US:en`;
  const googleItems = clean(fulfilled(await Promise.allSettled([
    fetchRssItems(googleUrl, "Google News Brasil", 1, NEWS_FETCH_TIMEOUT_MS),
    fetchRssItems(globalGoogleUrl, "Google News Internacional", 1, NEWS_FETCH_TIMEOUT_MS),
  ])));

  return clean([...secItems, ...localItems, ...generalItems, ...nicheItems, ...bingItems, ...googleItems]).slice(0, 3);
}

const NEWS_CACHE_TTL_MS = 5 * 60 * 1000;

async function cachedNewsBody(symbol) {
  try {
    const key = `https://bitcoiniciantes-ia.workers.dev/_cache/news/${symbol}`;
    const cached = await caches.default.match(key);
    if (!cached) return null;
    const stale = Date.now() - (Number(cached.headers.get("X-Cached-At")) || 0) > NEWS_CACHE_TTL_MS;
    if (stale) return null;
    return cached.json();
  } catch {
    return null;
  }
}

async function storeNewsBody(symbol, body) {
  try {
    const key = `https://bitcoiniciantes-ia.workers.dev/_cache/news/${symbol}`;
    const response = new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", "X-Cached-At": String(Date.now()) },
    });
    await caches.default.put(key, response);
  } catch {
    // cache opcional
  }
}

async function assetNews(request, asset) {
  const symbol = String(asset || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || "BTC";
  const cached = await cachedNewsBody(symbol);
  if (cached) return json(request, cached);
  const items = await fetchAssetNewsItems(symbol);
  const body = { asset, updatedAt: new Date().toISOString(), items };
  if (items.length) await storeNewsBody(symbol, body);
  return json(request, body);
}

// ---------- Cotações (Yahoo Finance) para ativos sem par na Binance ----------

const QUOTE_SYMBOLS = {
  PRATA: "SI=F",
  COBRE: "HG=F",
  URANIO: "URNM",
};

function parseYahooQuote(raw, symbol) {
  const result = raw && Array.isArray(raw.chart?.result) ? raw.chart.result[0] : null;
  if (!result) return null;
  const meta = result.meta || {};
  if (typeof meta.regularMarketPrice !== "number") return null;
  const prev = typeof meta.chartPreviousClose === "number" ? meta.chartPreviousClose : typeof meta.previousClose === "number" ? meta.previousClose : null;
  const changePercent = prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : null;
  return {
    symbol: meta.symbol || symbol,
    price: meta.regularMarketPrice,
    changePercent,
    volume: typeof meta.regularMarketVolume === "number" ? meta.regularMarketVolume : null,
    currency: meta.currency || "USD",
  };
}

async function cachedQuoteBody(symbol) {
  try {
    const key = `https://bitcoiniciantes-ia.workers.dev/_cache/quote/${symbol}`;
    const cached = await caches.default.match(key);
    if (!cached) return null;
    const stale = Date.now() - (Number(cached.headers.get("X-Cached-At")) || 0) > NEWS_CACHE_TTL_MS;
    if (stale) return null;
    return cached.json();
  } catch {
    return null;
  }
}

async function storeQuoteBody(symbol, body) {
  try {
    const key = `https://bitcoiniciantes-ia.workers.dev/_cache/quote/${symbol}`;
    const response = new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", "X-Cached-At": String(Date.now()) },
    });
    await caches.default.put(key, response);
  } catch {
    // cache opcional
  }
}

async function assetQuote(request, asset) {
  const symbol = String(asset || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
  const yahooSymbol = QUOTE_SYMBOLS[symbol];
  if (!yahooSymbol) return json(request, { error: "Ativo sem fonte de cotacao.", asset }, 404);
  const cached = await cachedQuoteBody(symbol);
  if (cached) return json(request, cached);
  let quote = null;
  try {
    const response = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`);
    quote = parseYahooQuote(await response.json(), yahooSymbol);
  } catch (error) {
    console.error(`quote-${symbol}-error`, error);
  }
  const body = quote
    ? { asset, ...quote, source: "Yahoo Finance", updatedAt: new Date().toISOString() }
    : { asset, error: "Cotacao indisponivel." };
  if (quote) await storeQuoteBody(symbol, body);
  return json(request, body);
}

// ---------- Widget de cotações em lote (CRIPTO via Binance no browser; STOCKS via Yahoo aqui) ----------

const QUOTE_CACHE_TTL_MS = 10 * 1000;
const QUOTE_WINDOWS = {
  "1h": {
    range: "1d",
    interval: "60m",
    windowMs: 60 * 60 * 1000,
    fallbacks: [{ range: "1mo", interval: "1d", windowMs: 24 * 60 * 60 * 1000 }],
  },
  "24h": { range: "1mo", interval: "1d", windowMs: 24 * 60 * 60 * 1000 },
  "7d": { range: "1mo", interval: "1d", windowMs: 7 * 24 * 60 * 60 * 1000 },
  "30d": { range: "3mo", interval: "1d", windowMs: 30 * 24 * 60 * 60 * 1000 },
};

function downsample(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i += 1) out.push(points[Math.round(i * step)]);
  return out;
}

function computeQuote(raw, symbol, cfg) {
  const result = raw && Array.isArray(raw.chart?.result) ? raw.chart.result[0] : null;
  if (!result) return null;
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = result.indicators?.quote?.[0]?.close;
  if (!timestamps.length || !Array.isArray(closes)) return null;
  const volumes = result.indicators?.quote?.[0]?.volume;
  const points = timestamps
    .map((time, index) => ({ time, close: closes[index], volume: volumes ? volumes[index] : undefined }))
    .filter((point) => Number.isFinite(point.close));
  const last = points[points.length - 1];
  if (!last) return null;
  const baseTime = last.time - cfg.windowMs / 1000;
  let base = points[0];
  for (const point of points) {
    if (point.time <= baseTime) base = point;
    else break;
  }
  if (base.time >= last.time) base = points[Math.max(0, points.length - 2)] || base;
  const changePct = base.close ? ((last.close - base.close) / base.close) * 100 : 0;
  const meta = result.meta || {};
  return {
    symbol: meta.symbol || symbol,
    name: meta.shortName || meta.longName || symbol,
    price: last.close,
    changePct,
    volume: Number.isFinite(last.volume) ? last.volume : null,
    currency: meta.currency || "USD",
    closes: downsample(points.map((point) => point.close), 40),
  };
}

async function cachedQuotesBody(key) {
  try {
    const cached = await caches.default.match(`https://bitcoiniciantes-ia.workers.dev/_cache/quotes/${key}`);
    if (!cached) return null;
    const stale = Date.now() - (Number(cached.headers.get("X-Cached-At")) || 0) > QUOTE_CACHE_TTL_MS;
    if (stale) return null;
    return cached.json();
  } catch {
    return null;
  }
}

async function storeQuotesBody(key, body) {
  try {
    const response = new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", "X-Cached-At": String(Date.now()) },
    });
    await caches.default.put(`https://bitcoiniciantes-ia.workers.dev/_cache/quotes/${key}`, response);
  } catch {
    // cache opcional
  }
}

function mapLimit(items, limit, worker) {
  return new Promise((resolve) => {
    const results = new Array(items.length);
    let index = 0;
    let running = 0;
    (function next() {
      while (running < limit && index < items.length) {
        const i = index;
        index += 1;
        running += 1;
        Promise.resolve()
          .then(() => worker(items[i], i))
          .then((value) => { results[i] = value; })
          .catch(() => { results[i] = null; })
          .finally(() => {
            running -= 1;
            if (running === 0 && index >= items.length) resolve(results);
            else next();
          });
      }
    })();
  });
}

async function assetQuotes(request) {
  const url = new URL(request.url);
  const rawAssets = (url.searchParams.get("assets") || "")
    .split(",")
    .map((item) => item.trim().toUpperCase().replace(/[^A-Z0-9^.\-=]/g, ""))
    .filter((item) => item && item.length <= 12)
    .slice(0, 26);
  const windowKey = QUOTE_WINDOWS[url.searchParams.get("window")] ? url.searchParams.get("window") : "24h";
  if (!rawAssets.length) return json(request, { error: "Informe assets." }, 400);
  const cfg = QUOTE_WINDOWS[windowKey];
  const cacheKey = `${rawAssets.join(",")}|${windowKey}`;
  const cached = await cachedQuotesBody(cacheKey);
  if (cached) return json(request, cached);
  const configs = [cfg].concat(cfg.fallbacks || []);
  const results = await mapLimit(rawAssets, 4, async (symbol) => {
    for (const item of configs) {
      try {
        const response = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${item.interval}&range=${item.range}`);
        const raw = await response.json();
        const quote = computeQuote(raw, symbol, item);
        if (quote) return quote;
      } catch (error) {
        // tenta a próxima configuração
      }
    }
    return null;
  });
  const quotes = results.filter(Boolean);
  const body = { window: windowKey, updatedAt: new Date().toISOString(), quotes };
  if (quotes.length) await storeQuotesBody(cacheKey, body);
  return json(request, body);
}

// ---------- Candles OHLC (Yahoo) para ações/ETFs no Termômetro ----------

const CANDLE_PERIODS = {
  "15M": { interval: "15m", range: "1mo", group: 1 },
  "1H": { interval: "1h", range: "6mo", group: 1 },
  "4H": { interval: "1h", range: "6mo", group: 4 },
  "1D": { interval: "1d", range: "1y", group: 1 },
  "1S": { interval: "1wk", range: "5y", group: 1 },
  "1M": { interval: "1mo", range: "max", group: 1 },
};
const CANDLE_SYMBOL_ALIAS = { PRATA: "SI=F", COBRE: "HG=F", URANIO: "URNM" };

function buildCandles(raw, groupSize) {
  const result = raw && Array.isArray(raw.chart?.result) ? raw.chart.result[0] : null;
  if (!result) return null;
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0];
  if (!timestamps.length || !quote) return null;
  const opens = quote.open, highs = quote.high, lows = quote.low, closes = quote.close, volumes = quote.volume;
  const points = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const open = opens[i], high = highs[i], low = lows[i], close = closes[i];
    if (![open, high, low, close].every(Number.isFinite)) continue;
    points.push({
      time: timestamps[i] * 1000,
      open, high, low, close,
      volume: Number.isFinite(volumes?.[i]) ? volumes[i] : 0,
    });
  }
  if (!points.length) return null;
  if (groupSize > 1) {
    const grouped = [];
    for (let i = 0; i < points.length; i += groupSize) {
      const chunk = points.slice(i, i + groupSize);
      if (!chunk.length) continue;
      grouped.push({
        time: chunk[0].time,
        open: chunk[0].open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((s, c) => s + c.volume, 0),
      });
    }
    return grouped;
  }
  return points;
}

const CANDLE_CACHE_TTL_MS = 60 * 1000;

async function cachedCandlesBody(key) {
  try {
    const cached = await caches.default.match(`https://bitcoiniciantes-ia.workers.dev/_cache/candles/${key}`);
    if (!cached) return null;
    const stale = Date.now() - (Number(cached.headers.get("X-Cached-At")) || 0) > CANDLE_CACHE_TTL_MS;
    if (stale) return null;
    return cached.json();
  } catch {
    return null;
  }
}

async function storeCandlesBody(key, body) {
  try {
    const response = new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json", "X-Cached-At": String(Date.now()) },
    });
    await caches.default.put(`https://bitcoiniciantes-ia.workers.dev/_cache/candles/${key}`, response);
  } catch {
    // cache opcional
  }
}

async function assetCandles(request, asset, period) {
  const symbol = String(asset || "").toUpperCase().trim().replace(/[^A-Z0-9^.\-=]/g, "").slice(0, 20);
  if (!symbol) return json(request, { error: "Informe asset." }, 400);
  const yahooSymbol = CANDLE_SYMBOL_ALIAS[symbol] || symbol;
  const periodKey = CANDLE_PERIODS[period] ? period : "1D";
  const cfg = CANDLE_PERIODS[periodKey];
  const cacheKey = `${symbol}|${periodKey}`;
  const cached = await cachedCandlesBody(cacheKey);
  if (cached) return json(request, cached);
  let candles = null;
  try {
    const response = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=${cfg.interval}&range=${cfg.range}`);
    candles = buildCandles(await response.json(), cfg.group);
  } catch (error) {
    console.error(`candles-${symbol}-error`, error);
  }
  if (candles) candles = candles.slice(-130);
  const body = candles && candles.length
    ? { asset: symbol, symbol: yahooSymbol, pair: `${symbol}/USD`, source: "Yahoo Finance via Worker", updatedAt: Date.now(), period: periodKey, candles }
    : { asset: symbol, error: "Candles indisponíveis." };
  if (candles && candles.length) await storeCandlesBody(cacheKey, body);
  return json(request, body);
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
  return items.map((n) => {
    const summary = asText(n.description, 260);
    return `- ${asText(n.title, 140)} (${asText(n.source, 40)})${summary ? `: ${summary}` : ""}`;
  }).join("\n");
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
    if (request.method === "GET" && url.pathname === "/api/quote") {
      return assetQuote(request, url.searchParams.get("asset"));
    }
    if (request.method === "GET" && url.pathname === "/api/quotes") {
      return assetQuotes(request);
    }
    if (request.method === "GET" && url.pathname === "/api/candles") {
      return assetCandles(request, url.searchParams.get("asset"), url.searchParams.get("period"));
    }

    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/public-markers") {
      return publicMarkers(request, url, env);
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
    const news = await Promise.race([
      fetchAssetNewsItems(data?.asset),
      new Promise((resolve) => setTimeout(() => resolve([]), 5000)),
    ]);
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
