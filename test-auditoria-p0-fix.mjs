/* =====================================================================
   AUDITORIA P0 — teste de unidade da correção (setAlertLevels, GRAPH→GRAPH)
   ---------------------------------------------------------------------
   Carrega o CÓDIGO REAL de assets/js/services/alertEngine.js em Node
   (com stubs mínimos de browser) e valida os Casos A–E da orientação:

   A — GRAPH muda pouco (77.546,9 → 77.559, delta < 0.1%): motor DEVE atualizar
   B — mudança insignificante (< epsilon 1e-4): pode continuar ignorada
   C — TICKER não sobrescreve GRAPH (proteção via hasUserDefinedLevels,
       como no fluxo real ticker-widget.js L150–184)
   D — TICKER → GRAPH: GRAPH assume autoridade
   E — crossover segue funcionando após nível GRAPH atualizado

   Uso: node test-auditoria-p0-fix.mjs
   ===================================================================== */

'use strict';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ─── Stubs mínimos de browser p/ carregar o IIFE do engine ──────────────
const dispatched = [];
global.window = global;
global.document = {
  readyState: 'complete',
  addEventListener() {},
  removeEventListener() {}
};
Object.defineProperty(global, 'navigator', { value: {}, configurable: true });
global.CustomEvent = function (type, opts) {
  return { type, detail: opts && opts.detail };
};
global.window.dispatchEvent = function (ev) {
  dispatched.push(ev);
  return true;
};

require('./assets/js/services/alertEngine.js');
const engine = global.AlertEngine;

let failures = 0;
function assert(cond, label, extra) {
  if (cond) {
    console.log('  PASS  ' + label);
  } else {
    failures++;
    console.error('  FAIL  ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''));
  }
}
function levels(sym) {
  const l = engine.getLevels(sym);
  return l ? { support: l.support, resistance: l.resistance, source: l.source } : null;
}

// ─── Caso A — GRAPH→GRAPH com delta < 0.1% (> epsilon 1e-4) ─────────────
console.log('\nCaso A — GRAPH→GRAPH 77.546,9 → 77.559 (delta 12,1 < 77,6; epsilon 7,75):');
engine.setAlertLevels('AAA', 76968, 77546.9, { source: 'GRAPH', timeframe: '1H' });
engine.setAlertLevels('AAA', 76968, 77559, { source: 'GRAPH', timeframe: '1H' });
const a = levels('AAA');
assert(a && a.resistance === 77559 && a.source === 'GRAPH', 'motor atualiza para R=77.559 (não fica congelado em 77.546,9)', a);

// ─── Caso B — mudança abaixo do epsilon técnico é ignorada ───────────────
console.log('\nCaso B — GRAPH→GRAPH com delta < epsilon (1e-4 relativo ≈ 7,75):');
engine.setAlertLevels('BBB', 76968, 77559, { source: 'GRAPH' });
engine.setAlertLevels('BBB', 76968, 77559.5, { source: 'GRAPH' }); // delta 0,5 < 7,75
const b = levels('BBB');
assert(b && b.resistance === 77559, 'motor mantém R=77.559 (delta 0,5 ignorado)', b);

// ─── Caso C — TICKER não sobrescreve GRAPH (guarda do fluxo real) ────────
console.log('\nCaso C — proteção GRAPH > TICKER (fluxo ticker-widget L150–184):');
engine.setAlertLevels('CCC', 76968, 77559, { source: 'GRAPH' });
const protectedSym = engine.hasUserDefinedLevels('CCC');
// Replica a decisão do ticker-widget.js L150-160: só chama setAlertLevels(TICKER)
// se NÃO houver níveis do usuário (GRAPH).
if (protectedSym) {
  // ticker SKIP — não escreve
} else {
  engine.setAlertLevels('CCC', 76968, 77500, { source: 'TICKER' });
}
const c = levels('CCC');
assert(protectedSym === true, 'hasUserDefinedLevels(CCC) = true após GRAPH', protectedSym);
assert(c && c.resistance === 77559 && c.source === 'GRAPH', 'motor permanece R=77.559 source=GRAPH (ticker não escreveu)', c);

// ─── Caso D — TICKER → GRAPH assume autoridade ───────────────────────────
console.log('\nCaso D — TICKER → GRAPH (upgrade de autoridade):');
engine.setAlertLevels('DDD', 76800, 77500, { source: 'TICKER' });
engine.setAlertLevels('DDD', 76968, 77559, { source: 'GRAPH' }); // delta 59 < 77,6 → depende do upgrade
const d = levels('DDD');
assert(d && d.resistance === 77559 && d.source === 'GRAPH', 'motor vira GRAPH R=77.559 (upgrade TICKER→GRAPH mesmo com delta < 0.1%)', d);

// ─── Caso E — crossover continua funcionando com o nível GRAPH novo ──────
console.log('\nCaso E — crossover após nível GRAPH atualizado:');
engine.setAlertLevels('EEE', 76968, 77559, { source: 'GRAPH' });
engine.onPriceUpdate('EEE', 77540); // ancora lastPrice (estado fresh, lastPrice null)
engine.onPriceUpdate('EEE', 77550.8); // abaixo de R — rearm (já armado)
dispatched.length = 0;
engine.onPriceUpdate('EEE', 77560); // prev 77550,8 < 77.559 ≤ 77560 → dispara
const st = engine.alerts.get('EEE').state;
const soundTs = engine.lastSoundAt['EEE'] && engine.lastSoundAt['EEE'].resistance;
const fired = dispatched.some(e => e.type === 'PriceAlertTriggered' && e.detail && e.detail.symbol === 'EEE' && e.detail.direction === 'resistance');
assert(fired === true, 'PriceAlertTriggered(resistance) disparado no cruzamento 77.550,8 → 77.560 (R=77.559)', { dispatched: dispatched.map(e => e.type) });
assert(!!soundTs, 'cooldown registrado (lastSoundAt.resistance > 0)', soundTs);
assert(st && st.visualAlert === true, 'visualAlert = true após disparo', st.visualAlert);

console.log('\n' + (failures === 0 ? 'TODOS OS CASOS A–E: PASS' : failures + ' CASO(S) FALHARAM'));
process.exit(failures === 0 ? 0 : 1);
