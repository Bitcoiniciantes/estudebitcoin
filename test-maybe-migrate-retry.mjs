/* Retentativa de migração do painel (maybeMigrate).
 * Roda com: node --test test-maybe-migrate-retry.mjs
 * Carrega o painel-ativos-ui.js REAL num contexto vm com DOM mínimo e
 * dirige maybeMigrate() via hook PainelAtivos.maybeMigrate + getUI().
 * Sem rede, sem Firebase — o adapter é um fake controlado pelo teste.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('./assets/js/portfolio/painel-ativos-ui.js', import.meta.url), 'utf8');

function timeoutErr() {
  const e = new Error('Servidor demorou a responder. Verifique a conexão e tente de novo.');
  e.code = 'timeout';
  return e;
}

// Monta o painel real com um FirebasePortfolio fake.
// behavior: (callCount) => Promise — define o que migrateLocal() retorna.
function mount(behavior) {
  const calls = { migrate: 0, friendly: 0 };
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    document: { readyState: 'complete', getElementById: () => null },
    FirebasePortfolio: {
      migrateLocal() {
        calls.migrate++;
        return behavior(calls.migrate);
      },
      friendlyError() { calls.friendly++; return 'erro-x'; },
      clearLocal() {},
      load() { return Promise.resolve({ assets: [] }); },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'painel-ativos-ui.js' });
  const PA = sandbox.PainelAtivos;
  assert.ok(PA && typeof PA.maybeMigrate === 'function', 'hook maybeMigrate exposto');
  PA.getUI().mode = 'remote'; // isRemote() === true com o fake presente
  return { PA, calls };
}

describe('maybeMigrate: retentativa após falha', () => {
  it('(1) primeira falha não bloqueia a segunda tentativa', async () => {
    const { PA, calls } = mount((n) =>
      n === 1 ? Promise.reject(timeoutErr()) : Promise.resolve({ status: 'empty' }));
    const r1 = await PA.maybeMigrate();
    assert.equal(r1, null);
    assert.equal(calls.migrate, 1);
    const r2 = await PA.maybeMigrate(); // retentativa prometida pelo needsSync
    assert.equal(r2, null);
    assert.equal(calls.migrate, 2, 'segunda chamada tentou migrar de verdade');
  });

  it('(2) falha repetida não gera loop: 1 chamada = 1 tentativa', async () => {
    const { PA, calls } = mount(() => Promise.reject(timeoutErr()));
    for (let i = 0; i < 5; i++) {
      const r = await PA.maybeMigrate();
      assert.equal(r, null);
      assert.equal(calls.migrate, i + 1, 'sem tentativas em cascata');
    }
    assert.equal(calls.friendly, 5, 'cada falha reportou erro uma vez');
  });
});
