/* =====================================================================
   AUDITORIA P0 — simulação determinística do AlertEngine (client)
   ---------------------------------------------------------------------
   Replica a SEMÂNTICA EXATA do alertEngine.js (crossover, rearm sem
   histerese, cooldown 120s, dedup de 0.1% no setAlertLevels) e reexecuta
   os PREÇOS REAIS de BTC da janela 02:28:12–02:29:33 UTC (2026-09-03),
   extraídos dos logs [BTC ALERT TRACE] VERIFICAÇÃO DE CRUZAMENTO.

   Objetivo: verificar qual resistance do motor é consistente com o
   silêncio observado (ZERO disparo de BTC na janela, apesar dos
   cruzamentos de 77.559) e demonstrar o congelamento por dedup 0.1%
   (Categoria B — nível divergente motor × gráfico).

   Uso: node test-auditoria-p0-freeze.mjs
   ===================================================================== */

'use strict';

// ─── Preços reais (sequência contínua de currs, com o prev inicial) ───
// Fonte: logs colados pelo usuário (02:28:12Z → 02:29:33Z).
const FIRST_PREV = 77546.91;
const PRICES = [
  77546.9, 77546.91, 77546.91, 77546.91, 77546.91, 77546.91, 77546.91, 77546.91, 77546.91, 77546.91, // :12-:21 (parte)
  77546.9,                                                                                          // :21
  77550.8, 77550.8, 77550.8, 77550.81, 77550.81, 77550.8, 77550.81, 77550.81, 77550.81, 77550.8,     // :22-:31
  77560, 77560, 77560.01, 77560, 77560, 77560.01, 77560, 77560, 77560,                                // :32-:40
  77588.98, 77589, 77588.99, 77599, 77599, 77598.99, 77598.99, 77599, 77598.99, 77599, 77599, 77599, // :41-:52
  77599.99, 77603.61, 77603.61, 77603.61, 77603.61, 77603.62, 77603.61, 77603.61, 77603.61, 77603.62, // :53-02:29:02
  77603.62, 77609.38, 77609.38, 77609.38, 77609.38, 77609.38, 77609.37, 77609.37,                    // :03-:10
  77603.67, 77603.67, 77603.67, 77603.67, 77603.67, 77603.67,                                        // :11-:16
  77597.59, 77597.59, 77593.57, 77590.11, 77593.57, 77603.67, 77603.67, 77603.66, 77603.67, 77603.67, // :17-:26
  77603.66, 77603.67, 77603.66,                                                                      // :27-:29
  77617.64, 77617.63, 77617.63, 77612.55                                                             // :30-:33
];

const COOLDOWN_MS = 120000;

// ─── Réplica do motor (semântica de assets/js/services/alertEngine.js) ──
function makeEngine(resistance, support, source) {
  return {
    config: { support, resistance, source },
    state: {
      active: true,
      lastPrice: FIRST_PREV, // âncora já estabelecida antes da janela
      armedSupport: true,
      armedResistance: true
    },
    lastSoundAt: { resistance: -1e15, support: -1e15 }, // sentinela: 1º disparo da sessão nunca é bloqueado
    nowMs: 0,
    events: []
  };
}

function onPriceUpdate(engine, price, tickMs) {
  const { config, state } = engine;
  if (!state.active || !Number.isFinite(price)) return;

  // Rearme (alertEngine.js L249-261 — rearm SEM banda de histerese)
  if (price < config.resistance) {
    state.armedResistance = true;
  }
  if (price > config.support) {
    state.armedSupport = true;
  }

  const prev = state.lastPrice;
  const t0 = engine.nowMs;

  // Rompimento de resistência (L264-271)
  if (state.armedResistance && prev < config.resistance && price >= config.resistance) {
    state.armedResistance = false;
    const elapsed = t0 - (engine.lastSoundAt.resistance || 0);
    const blocked = elapsed < COOLDOWN_MS;
    engine.events.push({ tick: tickMs, kind: blocked ? 'DISPARO_BLOQUEADO' : 'DISPARO', dir: 'resistance', price, level: config.resistance, elapsedMs: elapsed });
    if (!blocked) engine.lastSoundAt.resistance = t0;
  }
  // Rompimento de suporte (L273-281)
  if (state.armedSupport && prev > config.support && price <= config.support) {
    state.armedSupport = false;
    const elapsed = t0 - (engine.lastSoundAt.support || 0);
    const blocked = elapsed < COOLDOWN_MS;
    engine.events.push({ tick: tickMs, kind: blocked ? 'DISPARO_BLOQUEADO' : 'DISPARO', dir: 'support', price, level: config.support, elapsedMs: elapsed });
    if (!blocked) engine.lastSoundAt.support = t0;
  }

  state.lastPrice = price;
}

// ─── Réplica do dedup de setAlertLevels (espelha alertEngine.js PÓS-fix) ──
// Retorna true se o motor FOI atualizado, false se congelou (early return).
// P0: GRAPH→GRAPH usa epsilon 1e-4 (mínimo técnico); demais casos mantêm 0.1%.
function setAlertLevels(engine, support, resistance, source) {
  const existing = engine.config;
  const graphToGraph = existing.source === 'GRAPH' && source === 'GRAPH';
  const epsilon = graphToGraph ? 1e-4 : 0.001;
  const sameSupport = Math.abs(existing.support - support) < support * epsilon;
  const sameResistance = Math.abs(existing.resistance - resistance) < resistance * epsilon;
  if (sameSupport && sameResistance) {
    const isAuthorityUpgrade = existing.source === 'TICKER' && source === 'GRAPH';
    if (!isAuthorityUpgrade) return false; // congelado — mantém nível antigo
  }
  engine.config = { support, resistance, source };
  engine.state.armedSupport = true;
  engine.state.armedResistance = true;
  return true;
}

function replay(engine, label) {
  engine.events = [];
  let tickMs = 0;
  for (const p of PRICES) {
    tickMs += 1000;
    engine.nowMs = tickMs;
    onPriceUpdate(engine, p, tickMs);
  }
  const disparos = engine.events.filter(e => e.kind === 'DISPARO');
  const bloqueados = engine.events.filter(e => e.kind === 'DISPARO_BLOQUEADO');
  console.log(label);
  console.log(`  resistance=${engine.config.resistance}  support=${engine.config.support}  source=${engine.config.source}`);
  console.log(`  disparos na janela (som tocaria): ${disparos.length}`);
  for (const e of disparos) console.log(`    ${e.kind} ${e.dir} tick=${String(Math.round(e.tick / 1000)).padStart(2, '0')}s price=${e.price} level=${e.level}`);
  for (const e of bloqueados) console.log(`    ${e.kind} ${e.dir} tick=${String(Math.round(e.tick / 1000)).padStart(2, '0')}s price=${e.price} level=${e.level} elapsed=${e.elapsedMs}ms (<120s)`);
  return disparos.length;
}

// ─── Cenários ──────────────────────────────────────────────────────────
console.log('=== Janela real: 02:28:12–02:29:33 UTC (tick 0 = 02:28:12) ===\n');

// (a) Motor com o nível que o GRÁFICO desenhava (77.559) — expectativa: DISPARA às 23:28:32
const eChart = makeEngine(77559, 76968, 'GRAPH');
replay(eChart, '(a) R=77.559 (nível visível no gráfico)');

// (b) Motor congelado pelo dedup 0.1% num nível stale (≤ 77.546,9) — expectativa: SILÊNCIO
const eStale = makeEngine(77546.5, 76968, 'GRAPH');
replay(eStale, '(b) R=77.546,5 (nível stale congelado) — reproduz o silêncio observado?');

// (c) Motor com R acima de todo o preço da janela — expectativa: silêncio (mas beep pré-janela impossível)
const eHigh = makeEngine(77650, 76968, 'GRAPH');
replay(eHigh, '(c) R=77.650 (acima da janela)');

console.log('\n=== Dedup (PÓS-fix): gráfico recalcula 77.546,9 → 77.559; o motor atualiza? ===\n');
const freeze = makeEngine(77546.9, 76968, 'GRAPH'); // nível antigo do motor (mesma fonte GRAPH)
const updated = setAlertLevels(freeze, 76968, 77559, 'GRAPH');
console.log(`motor antes:  R=${77546.9} (GRAPH)`);
console.log(`recalc gráfico: srLevels → 77.559; setAlertLevels(GRAPH, 77559)`);
console.log(`motor depois: R=${freeze.config.resistance}  | atualizou? ${updated ? 'SIM' : 'NÃO — CONGELADO'}`);
console.log(`delta: ${(77559 - 77546.9).toFixed(1)} USD | epsilon GRAPH→GRAPH (1e-4): ${(77559 * 1e-4).toFixed(1)} USD | epsilon antigo (0.1%): ${(77559 * 0.001).toFixed(1)} USD`);
if (updated && freeze.config.resistance === 77559) {
  console.log('\nRESULTADO: PASS — cenário real 77.546,9 → 77.559 atualiza o motor (correção P0)');
} else {
  console.error('\nRESULTADO: FAIL — motor não atualizou');
  process.exit(1);
}
