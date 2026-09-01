/* =====================================================================
   Alerta Worker — Cloudflare Worker
   Monitoramento de background para alertas de preço S/R.
   - HTTP API: /subscribe, /alerts/sync, /unsubscribe
   - Scheduled: avaliação de alertas a cada 1min (Cron — ver wrangler.toml)
   - Web Push: @block65/webcrypto-web-push (Web Crypto API)

   HISTÓRICO DE FIXES:

   v1-v4: ver git history.

   v5 (correção de quota KV — estado consolidado):
   - Estado consolidado em 'cron:states' (1 put condicional vs N puts).
   - Migração automática de chaves 'state:{id}' legadas.

   v6 (correção de quota KV — índice, zero LIST):
   - ÍNDICE 'cron:index': lista de alert IDs e sub IDs. Atualizado
     SOMENTE em /subscribe, /unsubscribe, /alerts/sync.
   - Cron faz 1 GET (index) em vez de 2 LIST por ciclo.
   - Migração: se índice vazio, cria a partir de LIST (uma única vez).
   - broadcastPush retorna deadSubIds; limpeza em batch no final do ciclo.
   - Consumo por ciclo (8 alertas, 3 subs): 1 GET index + 8 GET alerts
     + 3 GET subs + 1 GET states + 0-1 PUT states = 13 reads, 0-1 writes.
   - Consumo/dia: ~18.720 reads (18.7% de 100K) + ~0-1.440 writes.
   ===================================================================== */

import { buildPushPayload } from '@block65/webcrypto-web-push';

// ─── Helpers genéricos ─────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function generateId() {
  return crypto.randomUUID();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

const INDEX_KEY = 'cron:index';   // índice de alert IDs e sub IDs
const STATES_KEY = 'cron:states'; // estado consolidado de todos os alertas

function subKey(id) { return 'sub:' + id; }
function alertKey(id) { return 'alert:' + id; }

function buildLevelsKey(support, resistance, direction) {
  return support + '|' + resistance + '|' + direction;
}

function freshState(levelsKey, lastPrice = null) {
  return {
    lastPrice,
    resistanceTriggered: false,
    supportTriggered: false,
    pendingResistance: null,
    pendingSupport: null,
    levelsKey,
    updatedAt: new Date().toISOString()
  };
}

// ─── Index helpers (cron:index) ────────────────────────────────────

async function readIndex(env) {
  const raw = await env.ALERTAS_KV.get(INDEX_KEY);
  if (raw) return { index: JSON.parse(raw), isNew: false };
  return { index: { alerts: [], subs: [] }, isNew: true };
}

async function writeIndex(env, index) {
  await env.ALERTAS_KV.put(INDEX_KEY, JSON.stringify(index));
}

async function addSubToIndex(env, subId) {
  const { index } = await readIndex(env);
  if (!index.subs.includes(subId)) {
    index.subs.push(subId);
    await writeIndex(env, index);
  }
}

async function removeSubFromIndex(env, subId) {
  const { index } = await readIndex(env);
  const i = index.subs.indexOf(subId);
  if (i !== -1) {
    index.subs.splice(i, 1);
    await writeIndex(env, index);
  }
}

async function addAlertToIndex(env, alertId) {
  const { index } = await readIndex(env);
  if (!index.alerts.includes(alertId)) {
    index.alerts.push(alertId);
    await writeIndex(env, index);
  }
}

async function removeSubsFromIndex(env, subIds) {
  if (subIds.length === 0) return;
  const { index } = await readIndex(env);
  let changed = false;
  for (const id of subIds) {
    const i = index.subs.indexOf(id);
    if (i !== -1) { index.subs.splice(i, 1); changed = true; }
  }
  if (changed) await writeIndex(env, index);
}

// ─── Endpoints HTTP ────────────────────────────────────────────────

async function handleSubscribe(request, env) {
  try {
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
    await addSubToIndex(env, id);
    return json({ id, ok: true });

  } catch (err) {
    console.error('[Subscribe] Erro:', err?.name, err?.message);
    return json({ error: 'Subscribe failed', name: err?.name, message: err?.message }, 500);
  }
}

async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'Missing id' }, 400);

  await env.ALERTAS_KV.delete(subKey(id));
  await removeSubFromIndex(env, id);
  return json({ ok: true });
}

async function handleAlertsSync(request, env) {
  const body = await request.json();
  if (!body || !body.symbol) {
    return json({ error: 'Invalid alert config' }, 400);
  }

  const id = body.symbol;
  const support = Number(body.support);
  const resistance = Number(body.resistance);
  const direction = body.direction || 'BOTH';

  if (!Number.isFinite(support) || !Number.isFinite(resistance)) {
    return json({ error: 'Invalid support/resistance' }, 400);
  }
  if (support >= resistance) {
    return json({ error: 'Support must be below resistance' }, 400);
  }

  const levelsKey = buildLevelsKey(support, resistance, direction);

  const alert = {
    id,
    symbol: body.symbol,
    support,
    resistance,
    enabled: body.enabled !== false,
    direction,
    levelsKey,
    updatedAt: new Date().toISOString()
  };
  await env.ALERTAS_KV.put(alertKey(id), JSON.stringify(alert));
  await addAlertToIndex(env, id);

  // Ler estado consolidado
  const statesRaw = await env.ALERTAS_KV.get(STATES_KEY);
  const allStates = statesRaw ? JSON.parse(statesRaw) : {};
  const state = allStates[id] || null;

  if (!state) {
    const seedPrice = Number.isFinite(body.lastPrice) ? body.lastPrice : null;
    allStates[id] = freshState(levelsKey, seedPrice);
    await env.ALERTAS_KV.put(STATES_KEY, JSON.stringify(allStates));
    return json({ ok: true, id });
  }

  const levelsChanged = !state.levelsKey || state.levelsKey !== levelsKey;

  if (levelsChanged) {
    allStates[id] = freshState(levelsKey, null);
    await env.ALERTAS_KV.put(STATES_KEY, JSON.stringify(allStates));
  }

  return json({ ok: true, id });
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

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const err = new Error(`Push failed: HTTP ${res.status} ${bodyText}`.trim());
    err.status = res.status;
    throw err;
  }

  return { status: res.status, ok: true };
}

async function broadcastPush(subscriptions, payload, env) {
  let delivered = 0;
  const deadSubIds = [];

  for (const sub of subscriptions) {
    try {
      await sendWebPush(sub, payload, env);
      delivered++;
    } catch (e) {
      console.error('[Push] Falha para sub ' + sub.id + ': ' + e.message);

      const deadStatuses = [400, 404, 410];
      if (deadStatuses.includes(e.status)) {
        deadSubIds.push(sub.id);
        console.error('[Push] Subscription ' + sub.id + ' marcada para remoção (status ' + e.status + ')');
      }
    }
  }

  return { delivered, deadSubIds };
}

// ─── Preço (MEXC Spot — crypto + BRL via USDCBRL) ───────────────────
// MEXC: API pública, sem chave, sem cache agressivo, preço em tempo real.
// PAXG mapeado como GOLD(PAXG)USDT (renomeado na MEXC em Feb/2026).
// BRL via par USDCBRL na própria MEXC (elimina dependência de API externa).

const SYMBOL_TO_MEXC = {
  'BTC': 'BTCUSDT',
  'ETH': 'ETHUSDT',
  'SOL': 'SOLUSDT',
  'LINK': 'LINKUSDT',
  'AVAX': 'AVAXUSDT',
  'RENDER': 'RENDERUSDT',
  'PAXG': 'GOLD(PAXG)USDT',
  'USDT-BRL': 'USDCBRL'
};

async function fetchPrices(symbols) {
  const prices = new Map();
  const fetchPromises = [];

  for (const sym of symbols) {
    const mexcSymbol = SYMBOL_TO_MEXC[sym];
    if (mexcSymbol) {
      const p = fetch('https://api.mexc.com/api/v3/ticker/price?symbol=' + mexcSymbol)
        .then(res => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(data => {
          const price = Number(data.price);
          if (Number.isFinite(price)) {
            prices.set(sym, price);
            console.log('[Prices] MEXC ' + sym + ': $' + price);
          }
        })
        .catch(e => console.error('[Prices] MEXC ' + sym + ': ' + e.message));
      fetchPromises.push(p);
    }
  }

  await Promise.all(fetchPromises);
  return prices;
}

/**
 * Busca preços 3x dentro da MESMA execução do Cron (~15s entre leituras).
 * Reduz — não elimina — a janela cega entre ticks do Cron: um crossover
 * que acontece e reverte inteiramente entre duas amostras (ex: dentro de
 * um intervalo de ~10s) ainda não é visto. É amostragem discreta, não um
 * stream contínuo de mercado.
 */
async function fetchPriceSequences(symbols, samples = 3, intervalMs = 15000) {
  const seqMap = new Map();

  for (let i = 0; i < samples; i++) {
    const prices = await fetchPrices(symbols);
    for (const [sym, price] of prices) {
      if (!seqMap.has(sym)) seqMap.set(sym, []);
      seqMap.get(sym).push(price);
    }
    if (i < samples - 1) await sleep(intervalMs);
  }

  return seqMap;
}

// ─── Crossover direcional ──────────────────────────────────────────

function crossedResistance(previousPrice, currentPrice, resistance) {
  return previousPrice < resistance && currentPrice >= resistance;
}

function crossedSupport(previousPrice, currentPrice, support) {
  return previousPrice > support && currentPrice <= support;
}

function buildAlertPayload(symbol, directionType, level, priceAtEvent) {
  const symbolName = symbol.replace('USDT', '').replace('BRL', '');
  const dirLabel = directionType === 'RESISTANCE' ? 'Resistência' : 'Suporte';
  const isBRL = symbol.includes('BRL');
  const fmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: isBRL ? 'BRL' : 'USD' });

  return {
    title: symbolName + ' — ' + dirLabel + ' rompida',
    body: symbolName + ' cruzou ' + dirLabel + ' em ' + fmt.format(level) + ' (preço no momento: ' + fmt.format(priceAtEvent) + ')',
    url: '/',
    symbol,
    level,
    direction: directionType
  };
}

// ─── Scheduled Handler (v6 — índice + estado consolidado, zero LIST) ─

async function scheduledHandler(event, env) {
  // ── Ler índice (1 GET) ────────────────────────────────────────────
  const { index, isNew } = await readIndex(env);

  // ── Migração: se índice NÃO EXISTE, criar a partir de LIST ────────
  if (isNew) {
    console.log('[Cron] Índice inexistente — criando a partir de LIST...');
    const alertList = await env.ALERTAS_KV.list({ prefix: 'alert:' });
    const subList = await env.ALERTAS_KV.list({ prefix: 'sub:' });
    index.alerts = alertList.keys.map(k => k.name.replace('alert:', ''));
    index.subs = subList.keys.map(k => k.name.replace('sub:', ''));
    await writeIndex(env, index);
    console.log('[Cron] Índice criado: ' + index.alerts.length + ' alertas, ' + index.subs.length + ' subs');
  }

  if (index.alerts.length === 0) return;

  // ── Ler alert configs (N GETs — necessário) ───────────────────────
  const symbolAlerts = new Map();
  for (const alertId of index.alerts) {
    const val = await env.ALERTAS_KV.get(alertKey(alertId));
    if (!val) continue;
    const alert = JSON.parse(val);
    if (!alert.enabled) continue;
    if (!symbolAlerts.has(alert.symbol)) symbolAlerts.set(alert.symbol, []);
    symbolAlerts.get(alert.symbol).push(alert);
  }

  // ── Ler subscriptions (N GETs — necessário para push) ─────────────
  const subscriptions = [];
  for (const subId of index.subs) {
    const val = await env.ALERTAS_KV.get(subKey(subId));
    if (val) subscriptions.push(JSON.parse(val));
  }

  if (subscriptions.length === 0) return;

  // ── Ler estado consolidado (1 GET) ────────────────────────────────
  const statesRaw = await env.ALERTAS_KV.get(STATES_KEY);
  let allStates = statesRaw ? JSON.parse(statesRaw) : {};

  // ── Migração: se states NÃO EXISTE, consolidar chaves 'state:{id}' ─
  if (statesRaw === null) {
    const legacyKeys = await env.ALERTAS_KV.list({ prefix: 'state:' });
    for (const key of legacyKeys.keys) {
      const raw = await env.ALERTAS_KV.get(key.name);
      if (raw) {
        const id = key.name.replace('state:', '');
        if (!allStates[id]) allStates[id] = JSON.parse(raw);
      }
      await env.ALERTAS_KV.delete(key.name);
    }
    if (legacyKeys.keys.length > 0) {
      console.log('[Cron] Migração: ' + legacyKeys.keys.length + ' chaves state:* consolidadas em cron:states');
    }
    // Persistir resultado da migração (ou objeto vazio se sem legado)
    await env.ALERTAS_KV.put(STATES_KEY, JSON.stringify(allStates));
  }

  // ── Snapshot de eventos ANTES do processamento ────────────────────
  const eventSnapshot = {};
  for (const [id, state] of Object.entries(allStates)) {
    eventSnapshot[id] = {
      rt: state.resistanceTriggered,
      st: state.supportTriggered,
      pr: state.pendingResistance,
      ps: state.pendingSupport,
      lk: state.levelsKey,
      lp: state.lastPrice
    };
  }

  const allSymbols = [...symbolAlerts.keys()];
  const sequences = await fetchPriceSequences(allSymbols);

  const allDeadSubIds = [];

  for (const [symbol, alerts] of symbolAlerts) {
    const seq = sequences.get(symbol);
    if (!seq || seq.length === 0) {
      console.error('[Cron] Sem preço para ' + symbol + ' neste ciclo — pulando avaliação.');
      continue;
    }
    const currentPrice = seq[seq.length - 1];

    for (const alert of alerts) {
      const levelsKey = buildLevelsKey(alert.support, alert.resistance, alert.direction);
      let state = allStates[alert.id] || freshState(levelsKey, null);

      // Migração/rede de segurança: formato antigo ou levels divergentes.
      if (!state.levelsKey || state.levelsKey !== levelsKey) {
        state = freshState(levelsKey, currentPrice);
        allStates[alert.id] = state;
        continue; // primeira leitura pós-reset só ancora a referência
      }

      if (state.lastPrice === null) {
        state.lastPrice = currentPrice;
        allStates[alert.id] = state;
        continue;
      }

      const wantsResistance = alert.direction === 'BOTH' || alert.direction === 'RESISTANCE';
      const wantsSupport = alert.direction === 'BOTH' || alert.direction === 'SUPPORT';

      // ── 1) Reenviar eventos pendentes primeiro (retry de push que já
      //    falhou antes). Enquanto pendente, não detectamos um NOVO
      //    crossover na mesma direção — só reenviamos o evento original
      //    até ele ser confirmado como entregue.
      if (state.pendingResistance) {
        const payload = buildAlertPayload(symbol, 'RESISTANCE', alert.resistance, state.pendingResistance.price);
        const { delivered, deadSubIds } = await broadcastPush(subscriptions, payload, env);
        allDeadSubIds.push(...deadSubIds);
        if (delivered > 0) {
          state.resistanceTriggered = true;
          state.pendingResistance = null;
        } else {
          console.error('[Cron] Retry de RESISTÊNCIA pendente (' + symbol + ') ainda falhou — tenta de novo no próximo ciclo.');
        }
      }
      if (state.pendingSupport) {
        const payload = buildAlertPayload(symbol, 'SUPPORT', alert.support, state.pendingSupport.price);
        const { delivered, deadSubIds } = await broadcastPush(subscriptions, payload, env);
        allDeadSubIds.push(...deadSubIds);
        if (delivered > 0) {
          state.supportTriggered = true;
          state.pendingSupport = null;
        } else {
          console.error('[Cron] Retry de SUPORTE pendente (' + symbol + ') ainda falhou — tenta de novo no próximo ciclo.');
        }
      }

      // ── 2) Rearme: volta pra dentro da faixa libera o alerta pra
      //    disparar de novo nessa direção.
      if (state.resistanceTriggered && currentPrice < alert.resistance) {
        state.resistanceTriggered = false;
      }
      if (state.supportTriggered && currentPrice > alert.support) {
        state.supportTriggered = false;
      }

      // ── 3) Detectar NOVOS crossovers (só se não estiver pendente nem
      //    já triggered nessa direção) andando pela sequência de
      //    amostras deste ciclo.
      let resistanceCrossPrice = null;
      let supportCrossPrice = null;
      let prev = state.lastPrice;
      for (const price of seq) {
        if (wantsResistance && !state.resistanceTriggered && !state.pendingResistance && resistanceCrossPrice === null) {
          if (crossedResistance(prev, price, alert.resistance)) resistanceCrossPrice = price;
        }
        if (wantsSupport && !state.supportTriggered && !state.pendingSupport && supportCrossPrice === null) {
          if (crossedSupport(prev, price, alert.support)) supportCrossPrice = price;
        }
        prev = price;
      }

      if (resistanceCrossPrice !== null) {
        const payload = buildAlertPayload(symbol, 'RESISTANCE', alert.resistance, resistanceCrossPrice);
        const { delivered, deadSubIds } = await broadcastPush(subscriptions, payload, env);
        allDeadSubIds.push(...deadSubIds);
        if (delivered > 0) {
          state.resistanceTriggered = true;
        } else {
          state.pendingResistance = { level: alert.resistance, price: resistanceCrossPrice, detectedAt: new Date().toISOString() };
          console.error('[Cron] Crossover de RESISTÊNCIA em ' + symbol + ' detectado mas 0 pushes entregues — marcado pendente, retry no próximo ciclo.');
        }
      }

      if (supportCrossPrice !== null) {
        const payload = buildAlertPayload(symbol, 'SUPPORT', alert.support, supportCrossPrice);
        const { delivered, deadSubIds } = await broadcastPush(subscriptions, payload, env);
        allDeadSubIds.push(...deadSubIds);
        if (delivered > 0) {
          state.supportTriggered = true;
        } else {
          state.pendingSupport = { level: alert.support, price: supportCrossPrice, detectedAt: new Date().toISOString() };
          console.error('[Cron] Crossover de SUPORTE em ' + symbol + ' detectado mas 0 pushes entregues — marcado pendente, retry no próximo ciclo.');
        }
      }

      state.lastPrice = currentPrice;
      allStates[alert.id] = state;
    }
  }

  // ── Limpar subs mortas (1 DELETE + 1 put do index) ───────────────
  const uniqueDeadSubIds = [...new Set(allDeadSubIds)];
  for (const deadId of uniqueDeadSubIds) {
    await env.ALERTAS_KV.delete(subKey(deadId));
  }
  await removeSubsFromIndex(env, uniqueDeadSubIds);

  // ── Escrita condicional: só grava se campos de evento mudaram ─────
  let stateChanged = uniqueDeadSubIds.length > 0;
  if (!stateChanged) {
    for (const [id, state] of Object.entries(allStates)) {
      const prev = eventSnapshot[id];
      if (!prev) { stateChanged = true; break; }
      if (state.resistanceTriggered !== prev.rt) { stateChanged = true; break; }
      if (state.supportTriggered !== prev.st) { stateChanged = true; break; }
      if (JSON.stringify(state.pendingResistance) !== JSON.stringify(prev.pr)) { stateChanged = true; break; }
      if (JSON.stringify(state.pendingSupport) !== JSON.stringify(prev.ps)) { stateChanged = true; break; }
      if (state.levelsKey !== prev.lk) { stateChanged = true; break; }
      if (prev.lp === null && state.lastPrice !== null) { stateChanged = true; break; }
    }
    // Verificar alertas removidos
    if (!stateChanged) {
      for (const id of Object.keys(eventSnapshot)) {
        if (!allStates[id]) { stateChanged = true; break; }
      }
    }
  }

  if (stateChanged) {
    await env.ALERTAS_KV.put(STATES_KEY, JSON.stringify(allStates));
    console.log('[Cron] Estado salvo em cron:states (' + Object.keys(allStates).length + ' alertas)');
  } else {
    console.log('[Cron] Nenhuma mudança — put omitido');
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
        return json({ service: 'alerta-worker', status: 'ok', version: '6.1.0' });
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
