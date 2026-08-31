/* =====================================================================
   Alerta Worker — Cloudflare Worker
   Monitoramento de background para alertas de preço S/R.
   - HTTP API: /subscribe, /alerts/sync, /unsubscribe
   - Scheduled: avaliação de alertas a cada 1min (Cron — ver wrangler.toml)
   - Web Push: @block65/webcrypto-web-push (Web Crypto API)

   HISTÓRICO DE FIXES (ver conversa):

   v1:
   - sendWebPush lança erro real em resposta HTTP não-ok.
   - Alerta só marcado como disparado após push confirmado entregue.
   - Subscriptions mortas (400/404/410) removidas checando status.
   - Multi-sample (3 leituras/ciclo) para reduzir (não eliminar) a janela
     cega entre ticks do Cron.

   v2:
   - Crossover agora é sempre direcional (lastPrice < nível && current >=
     nível), não mais "tocou o nível em algum momento" (min/max
     acumulado, que disparava mesmo sem cruzamento real).
   - resistanceTriggered / supportTriggered independentes (antes um
     único "triggered" global impedia o segundo lado de disparar).
   - levelsKey: reset do estado de disparo quando support/resistance/
     direction mudam, pra histórico do nível antigo não vazar pro novo.

   v3 (correção de bug crítico apontado em revisão externa):
   - BUG CRÍTICO CORRIGIDO: se o push falhasse na hora do crossover, o
     código atualizava lastPrice mesmo assim e o evento era perdido pra
     sempre — o comentário dizia "tenta de novo" mas isso não acontecia
     de fato. Agora existe pendingResistance/pendingSupport: quando um
     crossover é detectado mas a entrega falha (delivered === 0), o
     evento fica pendente e é RETENTADO em todo ciclo seguinte até ser
     confirmado como entregue — só então vira "triggered".
   - Reancoragem no reset de S/R agora usa o preço do próprio oracle do
     Worker (mempool/CoinGecko), não o lastPrice mandado pelo browser —
     evita reintroduzir divergência entre a visão do client e a do
     Worker logo no momento mais sensível (mudança de nível).
   - Validação: support deve ser menor que resistance.
   - Validação: preços não-finitos (NaN/Infinity) nunca entram no state.
   - Comentário do multi-sample corrigido: reduz a janela cega, não
     "captura" agulhadas de forma geral (ainda é amostragem discreta a
     cada ~15s, não um stream contínuo).

   v4:
   - SUBSTITUIÇÃO DE ORACLE: remoção de mempool.space e CoinGecko.
     Adoção da MEXC Spot API para todos os pares (crypto + BRL via
     USDCBRL). Contorna o cache agressivo de 1-5 min da API gratuita
     do CoinGecko e o WAF da Binance. Oráculo único, sem dependência
     de APIs externas adicionais.
   - PAXG mapeado como GOLD(PAXG)USDT (renomeado na MEXC em Feb/2026).

   DECISÕES CONHECIDAS, NÃO RESOLVIDAS NESTA VERSÃO:
   - Concorrência de escrita no KV entre o Cron e /alerts/sync rodando
     ao mesmo tempo não tem lock/CAS. "Risco baixo" no volume de uso
     atual, mas isso é uma afirmação sobre probabilidade, não uma prova
     de que está resolvido — revisitar se o projeto crescer.
   - env.ALERTAS_KV.list() não pagina; funciona bem na escala atual
     (poucos alertas/subscriptions), mas não escalaria indefinidamente.
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

function subKey(id) { return 'sub:' + id; }
function alertKey(id) { return 'alert:' + id; }
function alertStateKey(id) { return 'state:' + id; }

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

  const stateRaw = await env.ALERTAS_KV.get(alertStateKey(id));
  const state = stateRaw ? JSON.parse(stateRaw) : null;

  if (!state) {
    // Primeira vez: não há preço do próprio Worker ainda disponível aqui
    // (isso é um endpoint HTTP, não o Cron), então usamos o lastPrice do
    // client só nesse caso específico, como baseline temporária. O
    // próximo tick do Cron já vai atualizar com o preço do oracle.
    const seedPrice = Number.isFinite(body.lastPrice) ? body.lastPrice : null;
    await env.ALERTAS_KV.put(alertStateKey(id), JSON.stringify(freshState(levelsKey, seedPrice)));
    return json({ ok: true, id });
  }

  const levelsChanged = !state.levelsKey || state.levelsKey !== levelsKey;

  if (levelsChanged) {
    // Reset: NÃO usamos body.lastPrice aqui (poderia divergir do oracle
    // do Worker). lastPrice fica null e é reancorado pelo próprio Cron
    // no ciclo seguinte, com o preço que o Worker realmente vê.
    await env.ALERTAS_KV.put(alertStateKey(id), JSON.stringify(freshState(levelsKey, null)));
  }
  // Níveis iguais: state fica intocado (preserva triggered/pending/lastPrice).

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
    }
  }

  return delivered;
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

  const allSymbols = [...symbolAlerts.keys()];
  const sequences = await fetchPriceSequences(allSymbols);

  for (const [symbol, alerts] of symbolAlerts) {
    const seq = sequences.get(symbol);
    if (!seq || seq.length === 0) {
      console.error('[Cron] Sem preço para ' + symbol + ' neste ciclo — pulando avaliação.');
      continue;
    }
    const currentPrice = seq[seq.length - 1];

    for (const alert of alerts) {
      const levelsKey = buildLevelsKey(alert.support, alert.resistance, alert.direction);
      const stateRaw = await env.ALERTAS_KV.get(alertStateKey(alert.id));
      let state = stateRaw ? JSON.parse(stateRaw) : freshState(levelsKey, null);

      // Migração/rede de segurança: formato antigo ou levels divergentes.
      if (!state.levelsKey || state.levelsKey !== levelsKey) {
        state = freshState(levelsKey, currentPrice);
        await env.ALERTAS_KV.put(alertStateKey(alert.id), JSON.stringify(state));
        continue; // primeira leitura pós-reset só ancora a referência
      }

      if (state.lastPrice === null) {
        state.lastPrice = currentPrice;
        await env.ALERTAS_KV.put(alertStateKey(alert.id), JSON.stringify(state));
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
        const delivered = await broadcastPush(subscriptions, payload, env);
        if (delivered > 0) {
          state.resistanceTriggered = true;
          state.pendingResistance = null;
        } else {
          console.error('[Cron] Retry de RESISTÊNCIA pendente (' + symbol + ') ainda falhou — tenta de novo no próximo ciclo.');
        }
      }
      if (state.pendingSupport) {
        const payload = buildAlertPayload(symbol, 'SUPPORT', alert.support, state.pendingSupport.price);
        const delivered = await broadcastPush(subscriptions, payload, env);
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
        const delivered = await broadcastPush(subscriptions, payload, env);
        if (delivered > 0) {
          state.resistanceTriggered = true;
        } else {
          state.pendingResistance = { level: alert.resistance, price: resistanceCrossPrice, detectedAt: new Date().toISOString() };
          console.error('[Cron] Crossover de RESISTÊNCIA em ' + symbol + ' detectado mas 0 pushes entregues — marcado pendente, retry no próximo ciclo.');
        }
      }

      if (supportCrossPrice !== null) {
        const payload = buildAlertPayload(symbol, 'SUPPORT', alert.support, supportCrossPrice);
        const delivered = await broadcastPush(subscriptions, payload, env);
        if (delivered > 0) {
          state.supportTriggered = true;
        } else {
          state.pendingSupport = { level: alert.support, price: supportCrossPrice, detectedAt: new Date().toISOString() };
          console.error('[Cron] Crossover de SUPORTE em ' + symbol + ' detectado mas 0 pushes entregues — marcado pendente, retry no próximo ciclo.');
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
        return json({ service: 'alerta-worker', status: 'ok', version: '3.0.0' });
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
