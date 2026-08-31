/* =====================================================================
   Alerta Worker — Cloudflare Worker
   Monitoramento de background para alertas de preço S/R.
   - HTTP API: /subscribe, /alerts/sync, /unsubscribe
   - Scheduled: avaliação de alertas a cada 5min (Cron)
   - Web Push: @block65/webcrypto-web-push (Web Crypto API)

   FIXES (ver conversa):
   - sendWebPush agora lança erro real em resposta HTTP não-ok (fetch não
     lança em 4xx/5xx por padrão), e retorna o status para o caller.
   - triggered só é marcado true depois de pelo menos 1 push confirmado
     como entregue (ok: true). Se todos falharem, o alerta permanece
     "não disparado" e será reavaliado/reenviado no próximo ciclo.
   - Subscriptions mortas (410/404/400) são removidas mesmo sem exception,
     checando o status retornado.
   - Log de erro por subscription para dar visibilidade no wrangler tail.
   ===================================================================== */

import { buildPushPayload } from '@block65/webcrypto-web-push';

// ─── Helpers ───────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function generateId() {
  return crypto.randomUUID();
}

// ─── CORS preflight ────────────────────────────────────────────────

function handleOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
  });
}

// ─── KV Keys ───────────────────────────────────────────────────────

function subKey(id) { return 'sub:' + id; }
function alertKey(id) { return 'alert:' + id; }
function alertStateKey(id) { return 'state:' + id; }

// ─── Endpoints HTTP ────────────────────────────────────────────────

async function handleSubscribe(request, env) {
  const body = await request.json();
  if (!body || !body.endpoint || !body.keys || !body.keys.p256dh || !body.keys.auth) {
    return json({ error: 'Invalid subscription' }, 400);
  }

  const id = generateId();
  const subscription = {
    id,
    endpoint: body.endpoint,
    keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
    createdAt: new Date().toISOString()
  };

  await env.ALERTAS_KV.put(subKey(id), JSON.stringify(subscription));
  return json({ id, ok: true });
}

async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Missing id' }, 400);

  await env.ALERTAS_KV.delete(subKey(id));
  return json({ ok: true });
}

async function handleAlertsSync(request, env) {
  const body = await request.json();
  if (!body || !body.symbol) {
    return json({ error: 'Invalid alert config' }, 400);
  }

  const id = body.symbol;
  const alert = {
    id: id,
    symbol: body.symbol,
    support: Number(body.support),
    resistance: Number(body.resistance),
    enabled: body.enabled !== false,
    direction: body.direction || 'BOTH',
    updatedAt: new Date().toISOString()
  };

  if (!Number.isFinite(alert.support) || !Number.isFinite(alert.resistance)) {
    return json({ error: 'Invalid support/resistance' }, 400);
  }

  await env.ALERTAS_KV.put(alertKey(id), JSON.stringify(alert));

  // Seed state apenas na criação (state não existe ainda)
  const existingState = await env.ALERTAS_KV.get(alertStateKey(id));
  if (!existingState && Number.isFinite(body.lastPrice)) {
    await env.ALERTAS_KV.put(alertStateKey(id), JSON.stringify({
      lastPrice: body.lastPrice,
      triggered: false
    }));
  }

  return json({ ok: true, id: id });
}

// ─── Web Push via @block65/webcrypto-web-push ──────────────────────

/**
 * Envia um push. Lança erro se a resposta HTTP não for ok — fetch() por si
 * só NÃO lança em 4xx/5xx, então isso precisa ser checado explicitamente.
 * O erro inclui o status para o caller decidir se deve limpar a subscription.
 */
async function sendWebPush(subscription, payload, env) {
  const pushPayload = await buildPushPayload(
    { data: payload },
    {
      endpoint: subscription.endpoint,
      keys: subscription.keys,
    },
    {
      subject: env.VAPID_SUBJECT || 'mailto:bitcoiniciantes@proton.me',
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    }
  );

  const res = await fetch(subscription.endpoint, pushPayload);

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const err = new Error(`Push failed: HTTP ${res.status} ${bodyText}`.trim());
    err.status = res.status;
    throw err;
  }

  return { status: res.status, ok: true };
}

/**
 * Envia o push para todas as subscriptions. Remove subscriptions mortas
 * (410/404/400) do KV. Retorna quantos pushes foram confirmados como
 * entregues (ok: true) — usado para decidir se o alerta pode ser marcado
 * como "triggered".
 */
async function broadcastPush(subscriptions, payload, env) {
  let delivered = 0;

  for (const sub of subscriptions) {
    try {
      await sendWebPush(sub, payload, env);
      delivered++;
    } catch (e) {
      console.error('[Push] Falha para sub ' + sub.id + ': ' + e.message);

      const deadStatuses = [400, 404, 410];
      if (deadStatuses.includes(e.status)) {
        await env.ALERTAS_KV.delete(subKey(sub.id));
        console.error('[Push] Subscription ' + sub.id + ' removida (status ' + e.status + ')');
      }
      // Outros status (401/403 = VAPID errado, 5xx = falha temporária do
      // provedor) NÃO removem a subscription — provavelmente vale tentar
      // de novo no próximo ciclo.
    }
  }

  return delivered;
}

// ─── Preço (batch via CoinGecko + mempool.space) ─────────────────

const SYMBOL_TO_COINGECKO = {
  'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'LINK': 'chainlink',
  'AVAX': 'avalanche-2', 'RENDER': 'render-token', 'PAXG': 'pax-gold',
  'USDT-BRL': 'tether'
};

const SYMBOL_CURRENCY = {
  'USDT-BRL': 'brl'
};

async function fetchPrices(symbols) {
  const prices = new Map();

  // BTC via mempool.space (funciona de Workers, sem rate limit)
  if (symbols.includes('BTC')) {
    try {
      const res = await fetch('https://mempool.space/api/v1/prices');
      if (res.ok) {
        const data = await res.json();
        if (data.USD) prices.set('BTC', Number(data.USD));
      } else {
        console.error('[Prices] mempool.space respondeu ' + res.status);
      }
    } catch (e) {
      console.error('[Prices] mempool.space falhou: ' + e.message);
    }
  }

  // Demais via CoinGecko (batch: uma única chamada, inclui usd+brl)
  const coingeckoIds = [];
  const symbolByCoinId = {};
  for (const sym of symbols) {
    if (sym === 'BTC' && prices.has('BTC')) continue;
    const coinId = SYMBOL_TO_COINGECKO[sym];
    if (coinId) {
      coingeckoIds.push(coinId);
      symbolByCoinId[coinId] = sym;
    }
  }

  if (coingeckoIds.length > 0) {
    try {
      const url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + coingeckoIds.join(',') + '&vs_currencies=usd,brl';
      const res = await fetch(url, { headers: { 'User-Agent': 'EstudeBitcoin-AlertWorker/1.0' } });
      if (res.ok) {
        const data = await res.json();
        for (const [coinId, sym] of Object.entries(symbolByCoinId)) {
          const cur = SYMBOL_CURRENCY[sym] || 'usd';
          if (data[coinId] && data[coinId][cur]) prices.set(sym, Number(data[coinId][cur]));
        }
      } else {
        console.error('[Prices] CoinGecko respondeu ' + res.status);
      }
    } catch (e) {
      console.error('[Prices] CoinGecko falhou: ' + e.message);
    }
  }

  return prices;
}

// ─── Evaluação de Crossover (semelhante ao alertEngine.js) ────────

/**
 * Avalia crossover usando min/max observados desde a última checagem,
 * não só o preço pontual atual. Isso captura cruzamentos que aconteceram
 * e reverteram entre dois ciclos do Cron (ex: preço tocou a resistência
 * e voltou pra dentro da faixa em menos de 5min) — o Worker só via um
 * ponto por ciclo antes, e perdia esses casos.
 *
 * minPrice/maxPrice vêm do state acumulado; currentPrice é sempre incluído
 * na comparação.
 */
function evaluateCrossover(minPrice, maxPrice, support, resistance, direction) {
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) return null;

  if (direction === 'BOTH' || direction === 'RESISTANCE') {
    if (maxPrice >= resistance) {
      return { type: 'RESISTANCE', level: resistance };
    }
  }

  if (direction === 'BOTH' || direction === 'SUPPORT') {
    if (minPrice <= support) {
      return { type: 'SUPPORT', level: support };
    }
  }

  return null;
}

// ─── Scheduled Handler ─────────────────────────────────────────────

async function scheduledHandler(event, env) {
  const alertList = await env.ALERTAS_KV.list({ prefix: 'alert:' });
  if (alertList.keys.length === 0) return;

  const subList = await env.ALERTAS_KV.list({ prefix: 'sub:' });
  if (subList.keys.length === 0) return;

  const subscriptions = [];
  for (const key of subList.keys) {
    const val = await env.ALERTAS_KV.get(key.name);
    if (val) subscriptions.push(JSON.parse(val));
  }

  const symbolAlerts = new Map();
  for (const key of alertList.keys) {
    const val = await env.ALERTAS_KV.get(key.name);
    if (!val) continue;
    const alert = JSON.parse(val);
    if (!alert.enabled) continue;
    if (!symbolAlerts.has(alert.symbol)) symbolAlerts.set(alert.symbol, []);
    symbolAlerts.get(alert.symbol).push(alert);
  }

  // Buscar preços de todos os symbols de uma vez (batch)
  const allSymbols = [...symbolAlerts.keys()];
  const prices = await fetchPrices(allSymbols);

  for (const [symbol, alerts] of symbolAlerts) {
    const currentPrice = prices.get(symbol);
    if (currentPrice === null || currentPrice === undefined) {
      console.error('[Cron] Sem preço para ' + symbol + ' neste ciclo — pulando avaliação.');
      continue;
    }

    for (const alert of alerts) {
      const stateRaw = await env.ALERTAS_KV.get(alertStateKey(alert.id));
      const state = stateRaw
        ? JSON.parse(stateRaw)
        : { lastPrice: null, triggered: false, minPrice: null, maxPrice: null };

      if (state.lastPrice === null) {
        state.lastPrice = currentPrice;
        state.minPrice = currentPrice;
        state.maxPrice = currentPrice;
        state.triggered = false;
        await env.ALERTAS_KV.put(alertStateKey(alert.id), JSON.stringify(state));
        continue;
      }

      // Acumula extremos desde a última vez que o alerta NÃO estava
      // "triggered" — reduz (mas não elimina) a janela cega entre
      // amostras do Cron.
      const minPrice = Math.min(state.minPrice ?? currentPrice, currentPrice);
      const maxPrice = Math.max(state.maxPrice ?? currentPrice, currentPrice);

      const crossover = evaluateCrossover(minPrice, maxPrice, alert.support, alert.resistance, alert.direction);

      if (crossover) {
        if (!state.triggered) {
          const symbolName = symbol.replace('USDT', '').replace('BRL', '');
          const dirLabel = crossover.type === 'RESISTANCE' ? 'Resistência' : 'Suporte';
          const isBRL = symbol.includes('BRL');
          const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: isBRL ? 'BRL' : 'USD' });
          const payload = {
            title: symbolName + ' — ' + dirLabel + ' rompida',
            body: symbolName + ' cruzou ' + dirLabel + ' em ' + fmt.format(crossover.level) + ' (preço atual: ' + fmt.format(currentPrice) + ')',
            url: '/',
            symbol: symbol,
            level: crossover.level,
            direction: crossover.type
          };

          const delivered = await broadcastPush(subscriptions, payload, env);

          // Só marca como disparado se pelo menos 1 push foi CONFIRMADO
          // como entregue. Se todos falharem, tenta de novo no próximo
          // ciclo em vez de silenciosamente desistir.
          if (delivered > 0) {
            state.triggered = true;
            state.minPrice = currentPrice;
            state.maxPrice = currentPrice;
          } else {
            console.error('[Cron] Crossover de ' + symbol + ' detectado mas 0 pushes entregues — tentando de novo no próximo ciclo.');
          }
        }
      } else {
        if (state.triggered) {
          const awayFromResistance = currentPrice < alert.resistance;
          const awayFromSupport = currentPrice > alert.support;
          if (awayFromResistance || awayFromSupport) {
            state.triggered = false;
          }
        }
        state.minPrice = minPrice;
        state.maxPrice = maxPrice;
      }

      state.lastPrice = currentPrice;
      await env.ALERTAS_KV.put(alertStateKey(alert.id), JSON.stringify(state));
    }
  }
}

// ─── Main Handler ──────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return handleOptions();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/subscribe' && request.method === 'POST') {
        return handleSubscribe(request, env);
      }
      if (path === '/unsubscribe' && request.method === 'POST') {
        return handleUnsubscribe(request, env);
      }
      if (path === '/alerts/sync' && request.method === 'POST') {
        return handleAlertsSync(request, env);
      }
      if (path === '/' && request.method === 'GET') {
        return json({ service: 'alerta-worker', status: 'ok', version: '1.0.0' });
      }
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    try {
      await scheduledHandler(event, env);
    } catch (err) {
      console.error('[Scheduled] Error:', err.message);
    }
  }
};
