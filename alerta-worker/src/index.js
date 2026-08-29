/* =====================================================================
   Alerta Worker — Cloudflare Worker
   Monitoramento de background para alertas de preço S/R.
   - HTTP API: /subscribe, /alerts/sync, /unsubscribe
   - Scheduled: avaliação de alertas a cada 5min (Cron)
   - Web Push: @block65/webcrypto-web-push (Web Crypto API)
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
  if (!body || !body.id || !body.symbol) {
    return json({ error: 'Invalid alert config' }, 400);
  }

  const alert = {
    id: body.id,
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

  await env.ALERTAS_KV.put(alertKey(alert.id), JSON.stringify(alert));
  return json({ ok: true });
}

// ─── Web Push via @block65/webcrypto-web-push ──────────────────────

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
  return { status: res.status, ok: res.ok };
}

// ─── Preço (Binance REST) ─────────────────────────────────────────

async function fetchPrice(symbol) {
  const url = 'https://api.binance.com/api/v3/ticker/price?symbol=' + encodeURIComponent(symbol);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  return Number(data.price);
}

// ─── Evaluação de Crossover (semelhante ao alertEngine.js) ────────

function evaluateCrossover(previousPrice, currentPrice, support, resistance, direction) {
  if (!Number.isFinite(previousPrice) || !Number.isFinite(currentPrice)) return null;

  if (direction === 'BOTH' || direction === 'RESISTANCE') {
    if (previousPrice < resistance && currentPrice >= resistance) {
      return { type: 'RESISTANCE', level: resistance };
    }
  }

  if (direction === 'BOTH' || direction === 'SUPPORT') {
    if (previousPrice > support && currentPrice <= support) {
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

  for (const [symbol, alerts] of symbolAlerts) {
    const currentPrice = await fetchPrice(symbol);
    if (currentPrice === null) continue;

    for (const alert of alerts) {
      const stateRaw = await env.ALERTAS_KV.get(alertStateKey(alert.id));
      const state = stateRaw ? JSON.parse(stateRaw) : { lastPrice: null, triggered: false };

      if (state.lastPrice === null) {
        state.lastPrice = currentPrice;
        state.triggered = false;
        await env.ALERTAS_KV.put(alertStateKey(alert.id), JSON.stringify(state));
        continue;
      }

      const crossover = evaluateCrossover(state.lastPrice, currentPrice, alert.support, alert.resistance, alert.direction);

      if (crossover) {
        if (!state.triggered) {
          state.triggered = true;

          const symbolName = symbol.replace('USDT', '').replace('BRL', '');
          const dirLabel = crossover.type === 'RESISTANCE' ? 'Resistência' : 'Suporte';
          const payload = {
            title: symbolName + ' — ' + dirLabel + ' rompida',
            body: symbolName + ' cruzou ' + dirLabel + ' em ' + new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(crossover.level) + ' (preço atual: ' + new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(currentPrice) + ')',
            url: '/',
            symbol: symbol,
            level: crossover.level,
            direction: crossover.type
          };

          for (const sub of subscriptions) {
            try {
              await sendWebPush(sub, payload, env);
            } catch (e) {
              if (e.message && e.message.includes('410')) {
                await env.ALERTAS_KV.delete(subKey(sub.id));
              }
            }
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

      return json({ error: 'Not found' }, 404);
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
