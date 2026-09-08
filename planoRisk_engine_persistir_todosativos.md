# PLANO TÉCNICO FINAL — Persistência Multi-Ativo do Risk Engine

> **Status:** Aprovado para implementação (revisão 2 — bugs de lógica corrigidos)
> **Escopo:** `auth.js` (PanelSync) + `risk-engine-panel.js`
> **Risco:** Médio — mitigado por fallback + testes
> **Esforço estimado:** ~250 linhas, 1-2 dias
> - **Bug 3 (crítico, achado na releitura):** `migrateLegacyCloudRisk` da rev.1 chamava `legacyRef.remove()` no path `panels/risk` — que é PAI do novo `panels/risk/{asset}`. Após a migração, todo login apagaria os dados migrados. Corrigido: nulifica só `params`/`updatedAt` via `update({params:null, updatedAt:null})`; `remove()` no nível `risk` é proibido.
>
> **Revisão 2 (correções aplicadas antes da implementação):**
> - **Bug 1 (crítico):** `pullPanels()` da rev.1 mutava a global `currentAssetId` dentro do `.map()` síncrono mas lia `lsKey()` dentro do `.then()` assíncrono — todos os pulls gravavam na chave do último asset. Corrigido: `assetId` agora é parâmetro explícito em `lsKey`/`loadLocal`/`saveLocal`/`pushPanel`/`panelRef`/`schedulePush` (com fallback para `currentAssetId`), e o loop assíncrono nunca depende da global.
> - **Bug 2 (crítico):** o listener de `change` salvava via `readParams()` DEPOIS do select já ter mudado, gravando valores de BTC sob a chave de ETH. Corrigido: `persistRiskParams()` nunca troca a identidade — escreve sob o asset rastreado (`currentAssetId`); a troca de identidade acontece só no handler de `change`, que salva o anterior, troca, e carrega o novo.
> - **Correção adicional:** debounce de push (`pushTimers`) agora é por asset (`risk:BTC`, `risk:ETH`), senão um save de BTC dentro da janela de 2.5s cancelaria o push pendente de ETH (lost-write).
> - **Menores:** `getCurrentAssetId()` definido uma vez e reutilizado (sem duplicação); `RISK_ASSETS` derivado do DOM com fallback estático; seção de identificador canônico movida para após o diagnóstico.

---

## 1. Diagnóstico confirmado

**Causa raiz:** `auth.js:226` — `lsKey(panel)` retorna `eb_panel_risk` para qualquer ativo. `auth.js:112` — `panelRef(uid, panel)` aponta para `users/{uid}/panels/risk` (nó único). Não existe lógica que varia a chave por `assetId`. Ao trocar de ativo no dropdown, `risk-engine-panel.js:159` salva o novo estado na mesma chave, sobrescrevendo o anterior.

**Por que `assetId` resolve:** Ao sufizar a chave com o identificador normalizado do ativo (`eb_panel_risk_BTC`, `eb_panel_risk_ETH`), cada ativo passa a ter slot independente. A troca de ativo deixa de ser destructiva.

---

## 1b. Identificador canônico

O projeto já usa `normalizeSymbol()` (utils.js:103) que aplica `trim().toUpperCase().replace(/USDT$/, '')`. O dropdown `#re-simbolo` (index.html:1359) já contém valores normalizados: `BTC`, `ETH`, `SOL`, `LINK`, `AVAX`, `RENDER`, `PAXG`.

**`assetId` = valor do `#re-simbolo`, canonizado em toda fronteira** (persist, restore, troca, pull, cloud). Canonização: usar `window.BI.normalizeSymbol` quando disponível, com fallback `trim().toUpperCase()`. Isso impede colisões entre formatos (`BTC` vs `BTCUSDT` vs `btc` → sempre `BTC`).

Mapeamento:

| assetId | Binance pair | MEXC pair | displayName |
|---------|-------------|-----------|-------------|
| `BTC` | `BTCUSDT` | `BTCUSDT` | Bitcoin |
| `ETH` | `ETHUSDT` | `ETHUSDT` | Ethereum |
| `SOL` | `SOLUSDT` | `SOLUSDT` | Solana |
| `LINK` | `LINKUSDT` | `LINKUSDT` | Chainlink |
| `AVAX` | `AVAXUSDT` | `AVAXUSDT` | Avalanche |
| `RENDER` | `RENDERUSDT` | `RENDERUSDT` | Render |
| `PAXG` | `PAXGUSDT` | `GOLD(PAXG)USDT` | Pax Gold |

**Invariante de identidade (vale para todo o plano):** `PanelSync.currentAssetId` é a única fonte de verdade sobre qual slot está ativo. Ela só muda em 3 pontos: (1) boot (a partir de `eb_last_risk_asset`/DOM), (2) handler de `change` do select (fluxo explícito salvar-anterior → trocar → carregar-novo), (3) pull da nuvem do asset já ativo. `persistRiskParams()` NUNCA troca a identidade — apenas escreve sob o asset rastreado.

---

## 2. Arquivos a alterar

### `assets/js/auth.js` (PanelSync)

| Trecho | Linhas | Alteração | Motivo | Risco |
|--------|--------|-----------|--------|-------|
| `var currentAssetId = null` (novo) | ~25 | Adicionar variável de closure | Default quando nenhum `asset` explícito é passado | Baixo |
| `var RISK_ASSETS` (novo) | ~26 | Derivar das `<option>` de `#re-simbolo` via DOM, com fallback estático `['BTC','ETH','SOL','LINK','AVAX','RENDER','PAXG']` | Evita duplicar a lista do index.html:1359 (novo ativo no dropdown entra no sync automaticamente) | Baixo |
| `canonAssetId(v)` (novo) | ~26 | `window.BI.normalizeSymbol` se disponível, senão `trim().toUpperCase()` | Colisões `BTC`/`BTCUSDT`/`btc` impossíveis em qualquer fronteira | Baixo |
| `function lsKey(panel, asset)` | 226 | Resolve `a = (panel === 'risk') ? canon(asset \|\| currentAssetId) : null`; se `a`, retornar `eb_panel_risk_{a}` | Chave por ativo; parâmetro explícito elimina dependência da global em código assíncrono (Bug 1) | Baixo |
| `function loadLocal(panel, asset)` | 240-248 | Repassar `asset` para `lsKey` | Leitura por ativo sem tocar global | Baixo |
| `function saveLocal(panel, params, asset)` | 228-238 | Resolve `a`, escreve em `lsKey(panel, a)`, chama `schedulePush(panel, a)` | Escrita por ativo; debounce herdado por asset | Baixo |
| `function panelRef(uid, panel, asset)` | 112 | Resolve `a` como acima; se `a`, path `users/{uid}/panels/risk/{a}` | Path por ativo no RTDB, sem global mutável no caminho | Baixo |
| `function schedulePush(panel, asset)` | 257-264 | Timer keyed por `panel + ':' + asset` (`risk:BTC`, `risk:ETH`); callback chama `pushPanel(panel, a)` com `a` capturado | Sem isso, um save de BTC dentro da janela de 2.5s cancelaria o push pendente de ETH (lost-write) | Médio |
| `function pushPanel(panel, asset)` | 266-274 | `loadLocal(panel, asset)` + `panelRef(uid, panel, asset)` — ambas chamadas síncronas com `asset` explícito | Push por ativo, sem race | Baixo |
| `function pullPanels()` | 276-303 | Itera `RISK_ASSETS` chamando `pullOneRiskAsset(uid, a)`; cada iteração computa `ref`+`key` em escopo local ANTES do `.then()`; emite `panel-pull` com `{ panel:'risk', asset:a, params, updatedAt }` | Cloud sync por ativo, race-free (Bug 1) | Médio |
| `function syncOnLogin()` | 305-321 | `migrateLegacyCloudRisk()` → `pullPanels()` → push por asset via `pushPanel(panel, a)` explícito | Push por ativo no login, sem mutar global em loop | Médio |
| `var PanelSync = {...}` | 323-331 | Adicionar `setCurrentAsset`, `getCurrentAsset`, `saveLastAsset`, `loadLastAsset`, `LS_KEY_LEGACY:'eb_panel_risk'`; `setCurrentAsset` canoniza | API pública; identidade sempre normalizada | Baixo |
| `migrateLegacyRisk()` + boot | novo | Rodar IMEDIATAMENTE na avaliação do script (não dentro de `boot()`/DOMContentLoaded) | `risk-engine-panel.js` carrega ANTES de `auth.js` e seu `bind()` roda no mesmo DOMContentLoaded — migração precisa acontecer antes de qualquer restore | Baixo |
| `function deleteMyData()` | 215-223 | **Sem mudança** — `panels.remove()` remove recursivamente `risk/BTC`, `risk/ETH`, etc. | DELETE já é recursivo | Nenhum |

### `assets/js/risk-engine/risk-engine-panel.js`

| Trecho | Linhas | Alteração | Motivo | Risco |
|--------|--------|-----------|--------|-------|
| `var RISK_PANEL = 'risk'` | 106 | Manter como base | Referência base preservada | Nenhum |
| `getCurrentAssetId()` (novo) | ~106 | Lê `#re-simbolo`, canoniza (`trim().toUpperCase()`, preferindo `window.BI.normalizeSymbol`), fallback `'BTC'`; USAR NOS 4 pontos (restore, change, boot, pull) | Elimina a duplicação da expressão DOM; identidade sempre normalizada | Baixo |
| `defaultRiskParams(asset)` (novo) | ~106 | Retorna params padrão espelhando os fallbacks de `readParams()` (`lado:'LONG'`, saldo 3000, alavancagem 5, ordem preco 52000/valor 15000, funding 0, mmr 0), com `simbolo: asset` | Isola o estado do novo ativo sem contaminação do anterior | Baixo |
| `function persistRiskParams(assetOverride)` | 156-162 | Resolve `current = assetOverride \|\| getCurrentAsset()` (PanelSync); FORÇA `params.simbolo = current`; chama `saveLocal(RISK_PANEL, params, current)`; **NUNCA chama `setCurrentAsset`** | A identidade nunca é inferida do formulário em transição — só do rastreador explícito (Bug 2) | Baixo |
| `function restoreRiskParams()` | 164-171 | Usa `loadLastAsset()` para reposicionar o select no boot; `setCurrentAsset(DOM)`; fallback legacy; `loadLocal(RISK_PANEL, current)` explícito | Restore por ativo + migração, sem depender de global mutável | Médio |
| `function bind()` — reconfigurar | 251-256 | **Sem mudança estrutural** — mas documentado: em `<select>` modernos, `input` dispara ANTES de `change` na mesma interação, então `reconfigurar()` roda 2x por troca; inofensivo porque `persist` escreve sob a identidade rastreada (só o `change` troca a identidade) | Evita "corrigir" o duplo disparo quebrando o save do ativo anterior | Nenhum |
| Novo: listener `change` em `re-simbolo` | ~261 | Ordem ESTRITA: (1) `persistRiskParams(prevAsset)` — salva anterior; (2) `setCurrentAsset(new)` + `saveLastAsset(new)`; (3) `loadLocal(new)` → `applyRiskParams` ou `defaultRiskParams(new)`; (4) `reconfigurar()` | Salvar DEPOIS da mudança do select gravaria valores antigos sob a chave nova (Bug 2) | Médio |
| `restoreRiskParams()` — lógica de fallback | 164-171 | Se `loadLocal('risk', current)` retorna null, `restoreLegacyIfAvailable()` (lê `eb_panel_risk` cru, migra, remove) | Compatibilidade com dados antigos | Médio |
| Pull handler | 284-291 | Filtrar por `d.asset` (novo campo do evento) ou `d.params.simbolo` vs `getCurrentAssetId()`; `setCurrentAsset(d.params.simbolo)` antes de `applyRiskParams` + `reconfigurar()` | Pull de asset inativo ignorado; identidade sincronizada antes do apply | Baixo |

### `assets/js/calc-persist.js`

**Sem mudança.** O painel `sim` é ativo-agnóstico (iframe de calculadora). `PanelSync.saveLocal('sim', state)` continua usando chave `eb_panel_sim`.

---

## 3. Modelo de persistência

### Estrutura final no localStorage

```
eb_panel_risk_BTC  → { params: {...}, updatedAt: "..." }
eb_panel_risk_ETH  → { params: {...}, updatedAt: "..." }
eb_panel_risk_SOL  → { params: {...}, updatedAt: "..." }
eb_panel_risk_LINK → { params: {...}, updatedAt: "..." }
...
eb_panel_sim       → { params: {...}, updatedAt: "..." }  (inalterado)
eb_last_risk_asset → "BTC"                                 (novo, rastreia último ativo)
```

### Estrutura final no RTDB

```
users/{uid}/panels/
├── risk/
│   ├── BTC: { params: {...}, updatedAt: "..." }
│   ├── ETH: { params: {...}, updatedAt: "..." }
│   └── ...
└── sim: { params: {...}, updatedAt: "..." }
```

### Justificativa: chave por ativo (não mapa)

**Escolhido:** Documento/chave por ativo (`risk/{assetId}`).

**Por quê:**
- **Compatível com deleteMyData:** `panels.remove()` é recursivo — remove `risk/BTC`, `risk/ETH`, etc. automaticamente.
- **Compatível com RTDB rules existentes:** `users/$uid` com read/write por UID já cobre sub-nós.
- **Isolamento natural:** Um ativo não pode sobrescrever outro.
- **Merge simples:** Cada asset é independente, sem conflito de campos.
- **Escalável:** 7 ativos × ~200 bytes = 1.4KB total por usuário.

**Alternativa descartada:** Mapa único `{ BTC: {...}, ETH: {...} }` numa chave só — requer read/write do mapa inteiro a cada troca, risco de conflito entre abas, mais frágil.

---

## 4. Fluxo de troca de ativo

### Cenário: BTC → ETH → BTC

**Passo 1 — Estado inicial (BTC ativo):**

```
localStorage:
  eb_panel_risk_BTC = { params: { simbolo: "BTC", saldo: 3000, ... }, updatedAt: "..." }
  eb_last_risk_asset = "BTC"

DOM: #re-simbolo = "BTC"
PanelSync.currentAssetId = "BTC"
```

**Passo 2 — Usuário troca para ETH (mudança no dropdown):**

Em `<select>` modernos, a mesma interação dispara `input` primeiro e `change` depois. A identidade rastreada (`currentAssetId = "BTC"`) só é trocada no `change`. O fluxo:

```
A) evento `input` (dispara PRIMEIRO):
   1. reconfigurar()
   2. readParams() → { simbolo: "ETH" (select já mudou!), saldo: <valores BTC ainda no form> }
   3. persistRiskParams()
      → tracked = getCurrentAsset() = "BTC" (AINDA não trocou)
      → FORÇA params.simbolo = "BTC"  ← descarta o valor em transição do form
      → saveLocal("risk", params, "BTC") → eb_panel_risk_BTC atualizado ✓ (save do anterior!)
   4. adapter.configure(params) → simbolo "BTC" (fração de segundo; corrigido em B)

B) evento `change` (dispara DEPOIS) — ordem ESTRITA:
   1. prevAsset = getCurrentAsset() = "BTC"
   2. persistRiskParams("BTC") → re-salva BTC (idempotente — mesmos valores, inofensivo)
   3. setCurrentAsset("ETH") + saveLastAsset("ETH")  ← AQUI a identidade troca
   4. loadLocal("risk", "ETH"):
      → Se existe: applyRiskParams(params) ← Restaura estado ETH salvo
      → Se NÃO existe: applyRiskParams(defaultRiskParams("ETH")) ← form resetado, SEM contaminação
   5. reconfigurar()
      → readParams() → { simbolo: "ETH", ...estado restaurado ou defaults }
      → persistRiskParams() → tracked = "ETH" → saveLocal("risk", params, "ETH")
      → adapter.configure(params) → filtra por "ETH" ✓
      → ticker de BTC passa a ser ignorado (handleTickerEvent L133)
```

**Passo 3 — Usuário volta para BTC:** idêntico, com os papéis invertidos. `input` salva ETH sob `eb_panel_risk_ETH`; `change` troca para BTC, restaura `eb_panel_risk_BTC` (estado EXATO), reconfigura o adapter para BTC.

**Estado inexistente (nunca configurou ETH):**

```
change handler, passo B.4:
  → loadLocal("risk", "ETH") → null
  → applyRiskParams(defaultRiskParams("ETH"))
    → #re-simbolo = "ETH", #re-lado = "LONG", saldo 3.000,00, alavancagem 5,
      preco 52.000,00, valor 15.000,00, funding 0, mmr 0
  → reconfigurar() → persiste esse estado limpo em eb_panel_risk_ETH
```

Valores de BTC jamais são escritos sob a chave de ETH (regressão do Bug 2 coberta pelo teste 27).

### Ponto correto para cada ação

| Ação | Quando | Onde no código |
|------|--------|---------------|
| Salvar estado anterior | Com identidade AINDA no ativo anterior (evento `input` já faz isso; `change` repete de forma idempotente) | `persistRiskParams(prevAsset)` — escreve sob o asset rastreado, nunca sob o valor do form |
| Trocar assetId | SOMENTE no handler de `change`, DEPOIS de salvar o anterior | `setCurrentAsset(new)` + `saveLastAsset(new)` |
| Carregar estado do novo | DEPOIS da troca de assetId | `loadLocal(RISK_PANEL, new)` explícito → `applyRiskParams` ou `defaultRiskParams(new)` |
| Limpar/Isolar anterior | Automático: chaves separadas; form resetado para defaults se o novo não tem estado | `defaultRiskParams(newAsset)` |
| Atualizar UI | Via `applyRiskParams()` (restaurado ou defaults) | handler de `change`, passo B.4 |
| Atualizar adapter | Via `reconfigurar()` (sempre por último) | handler de `change`, passo B.5 |

---

## 5. Migração do legado

### Mecanismo localStorage

```javascript
// Em auth.js — constante nova
var LS_KEY_LEGACY = LS_PREFIX + 'risk'; // 'eb_panel_risk'

// Função de migração (executada no parse do script, ANTES de qualquer restore)
function migrateLegacyRisk() {
  try {
    var raw = localStorage.getItem(LS_KEY_LEGACY);
    if (!raw) return; // sem dados legados
    var obj = JSON.parse(raw);
    if (!obj || !obj.params) {
      localStorage.removeItem(LS_KEY_LEGACY);
      return; // formato inválido, limpa
    }
    var assetId = canonAssetId(obj.params.simbolo) || 'BTC'; // canoniza; sem simbolo → BTC (preserva)
    obj.params.simbolo = assetId;
    var newKey = LS_PREFIX + 'risk_' + assetId; // 'eb_panel_risk_BTC'

    // NÃO sobrescreve dados novos
    var existing = localStorage.getItem(newKey);
    if (existing) {
      var existingObj = JSON.parse(existing);
      if (existingObj && existingObj.updatedAt && obj.updatedAt &&
          existingObj.updatedAt > obj.updatedAt) {
        // Dados novos são mais recentes — remove legado
        localStorage.removeItem(LS_KEY_LEGACY);
        return;
      }
    }

    // Migra: copia para chave nova
    localStorage.setItem(newKey, raw);
    // Remove legado
    localStorage.removeItem(LS_KEY_LEGACY);
  } catch (e) {
    // Falha silenciosa — legado permanece, será ignorado
  }
}
```

### Mecanismo RTDB (cloud)

```javascript
// ATENÇÃO: o path legado `panels/risk` é PAI do novo `panels/risk/{asset}`.
// NUNCA chamar riskRef.remove() — apagaria os filhos já migrados em TODO login.
// A migração nulifica SÓ os campos legados (`params`/`updatedAt` no nível `risk`).
function migrateLegacyCloudRisk(uid) {
  if (!fbApp) return Promise.resolve();
  var riskRef = db().ref('users/' + uid + '/panels/risk');
  return riskRef.once('value').then(function (snap) {
    var row = snap.val();
    // Pós-migração: nó só tem filhos por asset (sem `params` direto) → nada a fazer.
    if (!row || !row.params) return null;
    var assetId = canonAssetId(row.params.simbolo) || 'BTC';
    var childRef = db().ref('users/' + uid + '/panels/risk/' + assetId);
    return childRef.once('value').then(function (childSnap) {
      var existing = childSnap.val();
      var write = Promise.resolve(false);
      if (!existing || !existing.updatedAt || !row.updatedAt ||
          !(existing.updatedAt > row.updatedAt)) {
        row.params.simbolo = assetId;
        write = childRef.set({ params: row.params, updatedAt: row.updatedAt });
      }
      return write.then(function () {
        return riskRef.update({ params: null, updatedAt: null });
      });
    });
  }).catch(function () { /* cloud migration é best-effort */ });
}
```

### Requisitos verificados

| Requisito | Status | Mecanismo |
|-----------|--------|-----------|
| Não perder dados | OK | Cópia para chave nova ANTES de remover legado; `simbolo` ausente → canoniza para BTC em vez de descartar |
| Não duplicar indefinidamente | OK | Local: chave legada removida. RTDB: SÓ os campos `params`/`updatedAt` do nível `risk` são nulificados — filhos por asset preservados (`riskRef.remove()` é PROIBIDO: apagaria tudo a cada login) |
| Não sobrescrever dados novos | OK | Verificação de `updatedAt` — se chave nova já existe e é mais recente, não sobrescreve |
| Ser idempotente | OK | Se legado não existe, retorna cedo. Se chave nova já existe com dados mais recentes, apenas remove legado |
| Funcionar para usuários existentes | OK | Migração roda no boot, detecta `eb_panel_risk` |
| Não quebrar usuários sem dados legados | OK | `localStorage.getItem(LS_KEY_LEGACY)` retorna null → retorna cedo |

---

## 6. Login / logout / reload

### Login

```
1. onAuthStateChanged(fu) → afterUser(fu)
2. PanelSync.syncOnLogin()
   → migrateLegacyCloudRisk(uid)    ← migra dados legados RTDB
   → pullPanels()
     → Para CADA asset em RISK_ASSETS (derivado do DOM):
       → pullOneRiskAsset(uid, asset): ref+key computados em escopo local
         (panelRef(uid,'risk',asset).once('value')) — NENHUMA global mutada
       → Merge "último vence" com localStorage
       → emit('estudebitcoin:panel-pull', { panel:'risk', asset, params, updatedAt })
       → consumer filtra por d.asset (ou d.params.simbolo) vs getCurrentAssetId()
   → push por asset:
     → Para CADA asset com dados locais:
       → pushPanel('risk', asset) → salva na nuvem
   → Debounce de push é por asset (pushTimers['risk:BTC'], ['risk:ETH'], ...)
```

**Resultado:** Todos os ativos do usuário são sincronizados. Dados locais e nuvem ficam consistentes.

### Logout

```
1. signOut() → currentUser = null
2. PanelSync: currentAssetId permanece (localStorage continua)
3. risk-engine-panel: persistRiskParams() → schedulePush() retorna cedo (sem currentUser)
4. Dados locais PRESERVADOS — funcionam sem login
```

**Resultado:** Logout não apaga nada. Usuário anônimo continua com localStorage.

### Reload (com dados locais)

```
1. Avaliação de auth.js (antes de qualquer DOMContentLoaded):
   → migrateLegacyRisk() — eb_panel_risk → eb_panel_risk_{assetId}
2. DOMContentLoaded
3. risk-engine-panel: bind()
   → restoreRiskParams()
     → loadLastAsset() → "BTC" → setSelect('re-simbolo', "BTC")
     → setCurrentAsset(getCurrentAssetId())  ← identidade = DOM
     → restoreLegacyIfAvailable() (best-effort, caso a migração do passo 1 tenha falhado)
     → loadLocal("risk", "BTC") → eb_panel_risk_BTC
     → applyRiskParams(params) ← restaura BTC
   → adapter.configure(readParams())
   → adapter.attach()
4. calc-persist: bind() → restoreNow() → eb_panel_sim (inalterado)
```

**Resultado:** Reload restaura exatamente o último ativo com seus dados.

### Reload (sem dados = usuário novo)

```
1. restoreRiskParams()
   → eb_last_risk_asset = null → usa fallback "BTC" (primeira opção do dropdown)
   → loadLocal("risk") → null
   → NÃO applyRiskParams()
   → Campos mantêm defaults do DOM
2. adapter.configure(readParams()) → defaults
```

**Resultado:** Usuário novo começa com defaults.

---

## 7. Concorrência

### Cenário: duas abas

**Risco identificado:** Aba A salva BTC, Aba B troca para ETH quase simultaneamente.

**Análise do fluxo:**

```
Aba A (tracked="BTC"): reconfigurar() → persistRiskParams()
  → força params.simbolo = "BTC" → saveLocal("risk", params, "BTC")
                                                        ↓
                                           eb_panel_risk_BTC = btcParams  ← OK

Aba B (tracked="ETH"): reconfigurar() → persistRiskParams()
  → força params.simbolo = "ETH" → saveLocal("risk", params, "ETH")
                                                        ↓
                                           eb_panel_risk_ETH = ethParams  ← OK
```

**Resultado:** Não há conflito porque cada ativo tem sua chave e a identidade é rastreada por aba (closure por contexto `window`), nunca inferida do formulário em transição. A sobrescrita só acontece na mesma chave.

**Debounce entre assets (mesma aba):** `pushTimers` é keyed por `risk:{assetId}`, então salvar BTC não cancela nem atrasa o push pendente de ETH — cada asset tem seu próprio timer de 2.5s.

**Risco residual:** Aba A e Aba B ambas com BTC ativo, editando ao mesmo tempo. `last-write-wins` — comportamento idêntico ao atual. Não piora.

### Proteção adicional (recomendada)

No `restoreRiskParams`, antes de aplicar dados do pull, verificar se o `currentAssetId` ainda corresponde ao ativo que está no DOM:

```javascript
host.addEventListener('estudebitcoin:panel-pull', function (ev) {
  var d = ev && ev.detail;
  if (!d || d.panel !== RISK_PANEL || !d.params) return;
  var currentAsset = getCurrentAssetId();
  var pullAsset = d.params.simbolo;
  if (pullAsset && pullAsset !== currentAsset) return; // pull de asset inativo — ignora
  applyRiskParams(d.params);
  reconfigurar();
});
```

---

## 8. Testes de aceitação

### Testes unitários

| # | Teste | Critério |
|---|-------|----------|
| 1 | `saveLocal('risk', btcParams)` com `currentAssetId='BTC'` escreve em `eb_panel_risk_BTC` | `localStorage.getItem('eb_panel_risk_BTC')` contém `params.simbolo === 'BTC'` |
| 2 | `saveLocal('risk', ethParams)` com `currentAssetId='ETH'` escreve em `eb_panel_risk_ETH` | `localStorage.getItem('eb_panel_risk_ETH')` contém `params.simbolo === 'ETH'` |
| 3 | `loadLocal('risk')` com `currentAssetId='BTC'` lê de `eb_panel_risk_BTC` | Retorna params com `simbolo === 'BTC'` |
| 4 | `loadLocal('risk')` com `currentAssetId='ETH'` lê de `eb_panel_risk_ETH` | Retorna params com `simbolo === 'ETH'` |
| 5 | `loadLocal('risk')` para asset inexistente retorna `null` | `eb_panel_risk_SOL` não existe → `null` |
| 6 | BTC e ETH coexistem: save BTC, save ETH, load BTC, load ETH | Cada um retorna seus próprios params |
| 7 | `PanelSync.setCurrentAsset('btcusdt')` → `PanelSync.getCurrentAsset() === 'BTC'` | Setter canoniza (colisão `BTC`/`BTCUSDT` impossível) |

### Testes de integração (simulação DOM)

| # | Teste | Critério |
|---|-------|----------|
| 8 | Boot com `eb_panel_risk_BTC` existente: `restoreRiskParams()` aplica BTC | `#re-simbolo.value === 'BTC'`, campos preenchidos |
| 9 | Boot com `eb_panel_risk_ETH` existente + `eb_last_risk_asset='ETH'`: restaura ETH | `#re-simbolo.value === 'ETH'` |
| 10 | Boot sem dados: mantém defaults | `#re-simbolo.value === 'BTC'` (fallback), campos com defaults |
| 11 | Troca BTC → ETH (com ETH sem estado): `eb_panel_risk_BTC` preservado; form resetado para defaults; `eb_panel_risk_ETH` criado SÓ com defaults | `eb_panel_risk_BTC.saldo` intacto; `eb_panel_risk_ETH.simbolo === 'ETH'` e saldo === default (nunca o saldo de BTC) |
| 12 | Troca ETH → BTC: `reconfigurar()` salva em `eb_panel_risk_BTC` com dados atualizados | `localStorage.getItem('eb_panel_risk_BTC')` válido |
| 13 | Reload após BTC + ETH: `eb_last_risk_asset` determina qual restaura | Último ativo usado é restaurado |
| 14 | `panel-pull` com `panel:'risk'` e `params.simbolo='BTC'`: aplica se asset atual é BTC | `applyRiskParams` chamado |
| 15 | `panel-pull` com `panel:'risk'` e `params.simbolo='ETH'`: ignora se asset atual é BTC | `applyRiskParams` NÃO chamado |

### Testes de migração

| # | Teste | Critério |
|---|-------|----------|
| 16 | `eb_panel_risk` com `simbolo='BTC'` → migra para `eb_panel_risk_BTC` | `eb_panel_risk` removido, `eb_panel_risk_BTC` existe com mesmos params |
| 17 | `eb_panel_risk` com `simbolo='BTC'` + `eb_panel_risk_BTC` já existe mais recente | `eb_panel_risk` removido, `eb_panel_risk_BTC` intocado |
| 18 | `eb_panel_risk` com `simbolo='BTC'` + `eb_panel_risk_BTC` já existe mais antigo | `eb_panel_risk_BTC` atualizado, `eb_panel_risk` removido |
| 19 | `eb_panel_risk` não existe (usuário novo) | Migração retorna cedo, nada acontece |
| 20 | `eb_panel_risk` com `params` sem `simbolo` | Migrado como `eb_panel_risk_BTC` (preserva dados, nunca descarta) |
| 20b | RTDB `panels/risk` pós-migração (só filhos, sem `params` direto): `migrateLegacyCloudRisk` roda de novo | Retorna sem tocar em nada (NUNCA `remove()` no nível `risk`) |
| 21 | Migração executada duas vezes (idempotente) | Segunda execução: legado já removido, retorna cedo |

### Testes de regressão

| # | Teste | Critério |
|---|-------|----------|
| 22 | `calc-persist.js` (`eb_panel_sim`) funciona normalmente | `saveLocal('sim', ...)` escreve em `eb_panel_sim` |
| 23 | Adapter filtra por `params.simbolo` — evento BTC ignorado quando ETH configurado | `handleTickerEvent` retorna sem chamar `updateRiskPrice` |
| 24 | `deleteMyData()` remove todos os `risk/*` | RTDB `panels/risk` removido recursivamente |
| 25 | Usuário anônimo (sem login): funciona só com localStorage | `schedulePush` retorna cedo, save/load locais funcionam |
| 26 | **(Bug 1)** Pull de 3 assets (BTC+ETH+SOL com dados na nuvem): cada um gravado na sua chave | `eb_panel_risk_BTC/ETH/SOL` contêm os params corretos (nenhum contém dados de outro asset) |
| 27 | **(Bug 2)** Troca para ativo sem estado NÃO contamina: BTC com saldo 9999 → troca para SOL (virgem) | `eb_panel_risk_SOL` ou inexistente ou com defaults; nunca contém `saldo === 9999` |
| 28 | Duplo disparo `input`+`change` no select não mistura estados | Após a troca, `eb_panel_risk_BTC.simbolo === 'BTC'` e `eb_panel_risk_ETH.simbolo === 'ETH'` |
| 29 | Novo `<option>` no `#re-simbolo` entra no sync sem mexer em `auth.js` | `RISK_ASSETS` derivado do DOM inclui o novo ativo |

---

## 9. Critérios de não-regressão

| Componente | Status | Evidência |
|-----------|--------|-----------|
| Risk Engine (`risk-engine.js`) | NÃO MUDA | Função pura `calcularRisco(input)` — sem referência a ativo, persistência ou localStorage |
| Adapter (`risk-engine-adapter.js`) | NÃO MUDA | `configure(p)` recebe params genéricos; `handleTickerEvent` filtra por `params.simbolo` — já multi-ativo |
| Ticker (`ticker-widget.js`) | NÃO MUDA | Despacha `CustomEvent("estudebitcoin:ticker-price", { symbol, price })` para TODOS os ativos |
| WebSocket | NÃO MUDA | Conecta streams de TODOS os cryptos (line 285: `CRYPTO.map(...)`) |
| AlertEngine | NÃO MUDA | Mapa por normalized symbol, 7+ ativos suportados |
| DynamicSR | NÃO MUDA | Parâmetro `symbol`, sem persistência |
| Worker (`alerta-worker`) | NÃO MUDA | KV por símbolo (`alert:BTC`), já multi-ativo |
| Push | NÃO MUDA | Sincroniza BTC via `syncToWorker` — sem relação com risk panel |
| S/R | NÃO MUDA | Calculada por DynamicSR, não por risk panel |
| Conversor | NÃO MUDA | Gráfico, sem persistência de risk panel |
| calc-persist.js (sim) | NÃO MUDA | Painel `sim` permanece ativo-agnóstico |
| Mural | NÃO MUDA | Wall de mensagens, sem relação |
| DCA widget | NÃO MUDA | Widget de DCA, sem relação |
| Strategy widget | NÃO MUDA | Widget de Strategy, sem relação |

---

## 10. Plano de implementação

### Etapa 1 — PanelSync: chave dinâmica por asset

**Arquivo:** `assets/js/auth.js`

**Mudanças:**

1. Adicionar estado + helpers (linha ~25, após `PUSH_DEBOUNCE_MS`):
```javascript
var currentAssetId = null; // default quando nenhum asset explícito é passado
var LS_LAST_ASSET = 'eb_last_risk_asset';

function canonAssetId(v) {
  try {
    if (global.BI && global.BI.normalizeSymbol) return global.BI.normalizeSymbol(v) || null;
  } catch (e) {}
  var s = String(v == null ? '' : v).trim().toUpperCase();
  return s ? s.replace(/USDT$/, '') : null;
}

// Derivado do DOM (index.html:1359) — novo <option> entra no sync sem mexer aqui.
function readRiskAssets() {
  try {
    var sel = global.document && document.getElementById('re-simbolo');
    if (sel && sel.options && sel.options.length) {
      var out = [];
      for (var i = 0; i < sel.options.length; i++) {
        var v = canonAssetId(sel.options[i].value || sel.options[i].text);
        if (v && out.indexOf(v) === -1) out.push(v);
      }
      if (out.length) return out;
    }
  } catch (e) {}
  return ['BTC', 'ETH', 'SOL', 'LINK', 'AVAX', 'RENDER', 'PAXG']; // fallback
}
var RISK_ASSETS = readRiskAssets();

function resolveRiskAsset(asset) {
  return canonAssetId(asset || currentAssetId);
}
```

2. Modificar `lsKey(panel, asset)` (L226) — parâmetro explícito com fallback:
```javascript
function lsKey(panel, asset) {
  var a = (panel === 'risk') ? resolveRiskAsset(asset) : null;
  if (a) return LS_PREFIX + panel + '_' + a;
  return LS_PREFIX + panel;
}
```

3. Modificar `loadLocal(panel, asset)` (L240) e `saveLocal(panel, params, asset)` (L228) — repassar `asset`:
```javascript
function saveLocal(panel, params, asset) {
  if (PANELS.indexOf(panel) === -1) return false;
  var a = (panel === 'risk') ? resolveRiskAsset(asset) : null;
  try {
    global.localStorage.setItem(lsKey(panel, a), JSON.stringify({
      params: params || null,
      updatedAt: new Date().toISOString()
    }));
    schedulePush(panel, a);
    return true;
  } catch (e) { return false; }
}

function loadLocal(panel, asset) {
  try {
    var a = (panel === 'risk') ? resolveRiskAsset(asset) : null;
    var raw = global.localStorage.getItem(lsKey(panel, a));
    if (!raw) return null;
    var obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return { params: obj.params || null, updatedAt: obj.updatedAt || null };
  } catch (e) { return null; }
}
```

4. Modificar `panelRef(uid, panel, asset)` (L112) — sem global mutável no caminho:
```javascript
function panelRef(uid, panel, asset) {
  var path = 'users/' + uid + '/panels/' + panel;
  var a = (panel === 'risk') ? resolveRiskAsset(asset) : null;
  if (a) path += '/' + a;
  return db().ref(path);
}
```

5. Modificar `schedulePush(panel, asset)` (L257) — timer por asset:
```javascript
var pushTimers = {};
function schedulePush(panel, asset) {
  if (!currentUser || !currentUser.verified) return; // anônimo/não verificado: só local
  var a = (panel === 'risk') ? resolveRiskAsset(asset) : null;
  var timerKey = panel + (a ? ':' + a : '');
  if (pushTimers[timerKey]) global.clearTimeout(pushTimers[timerKey]);
  pushTimers[timerKey] = global.setTimeout(function () {
    pushTimers[timerKey] = null;
    pushPanel(panel, a).catch(function () { /* retry no próximo save/login */ });
  }, PUSH_DEBOUNCE_MS);
}
```

6. Modificar `pushPanel(panel, asset)` (L266) — `ref`+`load` com asset explícito:
```javascript
function pushPanel(panel, asset) {
  var a = (panel === 'risk') ? resolveRiskAsset(asset) : null;
  var local = loadLocal(panel, a);
  if (!local || !local.params) return Promise.resolve(false);
  if (!fbApp || !currentUser) return Promise.resolve(false);
  return panelRef(currentUser.id, panel, a).set({
    params: local.params,
    updatedAt: local.updatedAt || new Date().toISOString()
  }).then(function () { return true; });
}
```

7. Reescrever `pullPanels()` (L276-303) — race-free: `ref`+`key` computados em escopo local ANTES do `.then()`:
```javascript
function pullOneRiskAsset(uid, assetId) {
  var ref = panelRef(uid, 'risk', assetId);
  var key = lsKey('risk', assetId);
  return ref.once('value').then(function (snap) {
    var row = snap.val();
    if (!row || !row.params) return null;
    var local = loadLocal('risk', assetId);
    if (newer(row.updatedAt, local && local.updatedAt)) {
      try {
        global.localStorage.setItem(key, JSON.stringify({
          params: row.params, updatedAt: row.updatedAt
        }));
      } catch (e) { /* segue emitindo para a UI */ }
      emit('estudebitcoin:panel-pull', {
        panel: 'risk', asset: assetId, params: row.params, updatedAt: row.updatedAt
      });
      return 'risk:' + assetId;
    }
    return null;
  }, function () { return null; });
}

function pullPanels() {
  if (!fbApp || !currentUser) return Promise.resolve({});
  var uid = currentUser.id;
  var jobs = PANELS.map(function (panel) {
    if (panel === 'risk') {
      return Promise.all(RISK_ASSETS.map(function (a) {
        return pullOneRiskAsset(uid, a);
      }));
    }
    return panelRef(uid, panel).once('value').then(function (snap) {
      var row = snap.val();
      if (!row || !row.params) return null;
      var local = loadLocal(panel);
      if (newer(row.updatedAt, local && local.updatedAt)) {
        try {
          global.localStorage.setItem(lsKey(panel), JSON.stringify({
            params: row.params, updatedAt: row.updatedAt
          }));
        } catch (e) { /* segue emitindo para a UI */ }
        emit('estudebitcoin:panel-pull', {
          panel: panel, params: row.params, updatedAt: row.updatedAt
        });
        return panel;
      }
      return null;
    }, function () { return null; });
  });
  return Promise.all(jobs).then(function (done) {
    var applied = {};
    done.forEach(function (group) {
      (Array.isArray(group) ? group : [group]).forEach(function (p) {
        if (p) applied[p] = true;
      });
    });
    return applied;
  });
}
```

8. Modificar `syncOnLogin()` (L305-321) — push por asset, sem mutar global:
```javascript
function syncOnLogin() {
  return migrateLegacyCloudRisk(currentUser.id).then(function () {
    return pullPanels();
  }).then(function () {
    var jobs = [];
    PANELS.forEach(function (panel) {
      if (panel === 'risk') {
        RISK_ASSETS.forEach(function (a) {
          jobs.push(pushPanel(panel, a).catch(function () { return false; }));
        });
      } else {
        jobs.push(pushPanel(panel).catch(function () { return false; }));
      }
    });
    return Promise.all(jobs);
  });
}
```

9. Adicionar funções e exportar:
```javascript
function setCurrentAsset(assetId) { currentAssetId = canonAssetId(assetId); }
function getCurrentAsset() { return currentAssetId; }
function saveLastAsset(assetId) {
  try { global.localStorage.setItem(LS_LAST_ASSET, canonAssetId(assetId) || ''); } catch (e) {}
}
function loadLastAsset() {
  try { return canonAssetId(global.localStorage.getItem(LS_LAST_ASSET)); } catch (e) { return null; }
}
```

10. Atualizar `var PanelSync = {...}` (L323) — adicionar `setCurrentAsset`, `getCurrentAsset`, `saveLastAsset`, `loadLastAsset`, `LS_KEY_LEGACY: LS_PREFIX + 'risk'`

**Teste:**
- Abrir console no browser
- `PanelSync.setCurrentAsset('BTC')`
- `PanelSync.saveLocal('risk', { simbolo: 'BTC', saldo: 5000 })`
- `localStorage.getItem('eb_panel_risk_BTC')` → contém params com `simbolo: 'BTC'`
- `PanelSync.setCurrentAsset('ETH')`
- `PanelSync.saveLocal('risk', { simbolo: 'ETH', saldo: 7000 })`
- `localStorage.getItem('eb_panel_risk_ETH')` → contém params com `simbolo: 'ETH'`
- `localStorage.getItem('eb_panel_risk_BTC')` → ainda existe e é diferente de ETH

**Critério de sucesso:** Chaves por asset funcionam independentemente.

---

### Etapa 2 — Risk Panel: persistência por asset

**Arquivo:** `assets/js/risk-engine/risk-engine-panel.js`

**Mudanças:**

0. Adicionar helpers (após `RISK_PANEL`, L106) — usados nos 4 pontos, sem duplicação:
```javascript
function getCurrentAssetId() {
  try {
    var el = document.getElementById('re-simbolo');
    var v = el && el.value ? String(el.value) : '';
    if (host.BI && host.BI.normalizeSymbol) return host.BI.normalizeSymbol(v) || 'BTC';
    return v.trim().toUpperCase() || 'BTC';
  } catch (e) { return 'BTC'; }
}

// Defaults espelhando os fallbacks de readParams() — isolamento do novo ativo.
function defaultRiskParams(asset) {
  return {
    simbolo: asset || 'BTC',
    moedaConta: 'USD',
    saldoCorretora: 3000,
    alavancagem: 5,
    ordens: [{ moeda: 'USD', preco: 52000, valor: 15000 }],
    fundingCustoAcumulado: 0,
    mmr: 0,
    lado: 'LONG'
  };
}
```

1. Modificar `persistRiskParams(assetOverride)` (L156-162) — NUNCA troca a identidade:
```javascript
function persistRiskParams(assetOverride) {
  try {
    var params = readParams();
    var current = assetOverride
      || (host.PanelSync && host.PanelSync.getCurrentAsset && host.PanelSync.getCurrentAsset())
      || params.simbolo || 'BTC';
    current = String(current).toUpperCase();
    params.simbolo = current; // identidade rastreada, nunca o form em transição
    if (host.PanelSync && host.PanelSync.saveLocal) {
      host.PanelSync.saveLocal(RISK_PANEL, params, current);
    }
  } catch (e) { /* persistência opcional */ }
}
```

2. Modificar `restoreRiskParams()` (L164-171):
```javascript
function restoreRiskParams() {
  try {
    // Boot: último asset usado reposiciona o select antes de qualquer leitura.
    var bootAsset = host.PanelSync && host.PanelSync.loadLastAsset
      ? host.PanelSync.loadLastAsset() : null;
    if (bootAsset) setSelect('re-simbolo', bootAsset);
    var currentSymbol = getCurrentAssetId();
    if (host.PanelSync && host.PanelSync.setCurrentAsset) {
      host.PanelSync.setCurrentAsset(currentSymbol);
    }
    restoreLegacyIfAvailable();
    if (host.PanelSync && host.PanelSync.loadLocal) {
      var saved = host.PanelSync.loadLocal(RISK_PANEL, currentSymbol);
      if (saved && saved.params) applyRiskParams(saved.params);
    }
  } catch (e) { /* segue com os padrões */ }
}
```

3. Adicionar função `restoreLegacyIfAvailable()`:
```javascript
function restoreLegacyIfAvailable() {
  try {
    var store = host.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return;
    var raw = store.getItem('eb_panel_risk');
    if (!raw) return;
    var obj = JSON.parse(raw);
    if (obj && obj.params && obj.params.simbolo) {
      if (host.PanelSync && host.PanelSync.setCurrentAsset) {
        host.PanelSync.setCurrentAsset(obj.params.simbolo);
      }
      if (host.PanelSync && host.PanelSync.saveLocal) {
        // Asset explícito: independe de qualquer global.
        host.PanelSync.saveLocal(RISK_PANEL, obj.params, obj.params.simbolo);
      }
      applyRiskParams(obj.params);
      store.removeItem('eb_panel_risk');
    } else {
      store.removeItem('eb_panel_risk');
    }
  } catch (e) { /* legado é best-effort */ }
}
```

4. Adicionar `change` listener no `#re-simbolo` (após L261) — ordem ESTRITA (Bug 2):
```javascript
var simboloEl = document.getElementById('re-simbolo');
if (simboloEl) {
  simboloEl.addEventListener('change', function () {
    var newAsset = getCurrentAssetId(); // select JÁ mudou — este é o NOVO
    var prevAsset = (host.PanelSync && host.PanelSync.getCurrentAsset
      && host.PanelSync.getCurrentAsset()) || newAsset;
    // 1) Salva o ANTERIOR (idempotente: o evento `input` pode já tê-lo feito).
    persistRiskParams(prevAsset);
    // 2) Troca a identidade — ÚNICO ponto de troca fora do boot/pull.
    if (host.PanelSync && host.PanelSync.setCurrentAsset) {
      host.PanelSync.setCurrentAsset(newAsset);
    }
    if (host.PanelSync && host.PanelSync.saveLastAsset) {
      host.PanelSync.saveLastAsset(newAsset);
    }
    // 3) Carrega o NOVO (ou defaults isolados — nunca valores do anterior).
    var saved = (host.PanelSync && host.PanelSync.loadLocal)
      ? host.PanelSync.loadLocal(RISK_PANEL, newAsset) : null;
    if (saved && saved.params) {
      applyRiskParams(saved.params);
    } else {
      applyRiskParams(defaultRiskParams(newAsset));
    }
    // 4) Reconfigura (persiste o estado do novo + atualiza o adapter).
    reconfigurar();
  });
}
```

> **Nota sobre o duplo disparo `input`+`change`:** em `<select>` modernos, a mesma interação dispara `input` (primeiro) e `change` (depois). O `input` → `reconfigurar()` → `persistRiskParams()` escreve sob a identidade AINDA antiga — ou seja, funciona como o "save do anterior" e é idempotente com o passo 1 do `change`. Não remover nem "unificar": a ordem `input`-antes-`change` é justamente o que garante que o anterior seja salvo.

5. No boot, após `restoreRiskParams()` (L294), salvar último asset via helper:
```javascript
if (host.PanelSync && host.PanelSync.saveLastAsset) {
  host.PanelSync.saveLastAsset(getCurrentAssetId());
}
```

6. Modificar pull handler (L284-291) — filtra por `d.asset`, sincroniza identidade:
```javascript
host.addEventListener('estudebitcoin:panel-pull', function (ev) {
  var d = ev && ev.detail;
  if (!d || d.panel !== RISK_PANEL || !d.params) return;
  var currentAsset = getCurrentAssetId();
  var pullAsset = d.asset || d.params.simbolo || null;
  if (pullAsset && pullAsset !== currentAsset) return; // asset inativo — ignora
  if (host.PanelSync && host.PanelSync.setCurrentAsset) {
    host.PanelSync.setCurrentAsset(pullAsset || currentAsset);
  }
  applyRiskParams(d.params);
  reconfigurar();
});
```

**Teste:**
- Configurar BTC com saldo 5000
- Trocar para ETH (virgem)
- Verificar: `eb_panel_risk_BTC` contém saldo 5000; form mostra defaults; `eb_panel_risk_ETH` criado SÓ com defaults (saldo 3000, nunca 5000)
- Voltar para BTC
- Verificar: saldo 5000 restaurado

**Critério de sucesso:** Troca de ativo preserva estado de cada ativo, sem contaminação cruzada.

---

### Etapa 3 — Migração de dados legados

**Arquivo:** `assets/js/auth.js`

**Mudanças:**

1. Adicionar `migrateLegacyRisk()` (localStorage) — conforme Seção 5

2. Adicionar `migrateLegacyCloudRisk(uid)` (RTDB) — conforme Seção 5

3. Chamar `migrateLegacyRisk()` IMEDIATAMENTE na avaliação do script (top-level do IIFE, fora de `boot()`):
```javascript
// auth.js — top-level, antes de qualquer DOMContentLoaded:
try { migrateLegacyRisk(); } catch (e) { /* best-effort */ }
```
Motivo: `risk-engine-panel.js` é carregado ANTES de `auth.js` (index.html) e seu `bind()` roda no mesmo `DOMContentLoaded`. Se a migração ficasse dentro de `boot()` de `auth.js`, o restore do painel poderia rodar antes dela. Em top-level, a migração executa no parse do script — garantidamente antes de qualquer restore. (`restoreLegacyIfAvailable()` no painel permanece como segunda linha de defesa.)

4. Chamar `migrateLegacyCloudRisk(uid)` em `syncOnLogin()`, ANTES de `pullPanels()` (já incluído na Etapa 1)

**Teste:**
- Criar `eb_panel_risk` manualmente no console: `localStorage.setItem('eb_panel_risk', JSON.stringify({ params: { simbolo: 'BTC', saldo: 8000, alavancagem: 10, ordens: [{ moeda: 'USD', preco: 60000, valor: 8000 }], fundingCustoAcumulado: 0, mmr: 0, lado: 'LONG', moedaConta: 'USD' }, updatedAt: '2026-09-08T12:00:00.000Z' }))`
- Recarregar
- Verificar: `eb_panel_risk` removido, `eb_panel_risk_BTC` existe com saldo 8000

**Critério de sucesso:** Dados legados migrados silenciosamente.

---

### Etapa 4 — Validação e testes

**Arquivo:** Novo ou extensão de `assets/js/risk-engine/risk-engine.test.mjs`

**Testes a implementar:** Todos da Seção 8 (30 testes, incluindo 20b e 26–29 de regressão dos Bugs 1–3).

**Ordem de execução e dependências:**

```
Etapa 1 (PanelSync)
  ↓
Etapa 2 (Risk Panel) ← depende da Etapa 1
  ↓
Etapa 3 (Migração) ← depende da Etapa 1
  ↓
Etapa 4 (Testes) ← depende de todas
```

**Reversibilidade:** Cada etapa pode ser revertida removendo as mudanças naquele arquivo.

**Deploy:** Todas as etapas podem ser publicadas juntas no Pages. Não há dependência de Worker, push ou backend.

---

## Apêndice — identificador canônico

Movido para a **Seção 1b** (logo após o diagnóstico), por ser conceito-base de todo o plano.

---

## 11. Registro de implementação (entrega)

> **Status:** IMPLEMENTADO e validado. Spec v2 acima preservado como referência; esta seção registra o que foi executado.

### Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `assets/js/auth.js` | `canonAssetId`, `getRiskAssets()` lazy, `resolveRiskAsset`, `lsKey/panelRef/saveLocal/loadLocal/pushPanel/schedulePush` com `asset` explícito, `pullOneRiskAsset` race-free, `pullPanels`/`syncOnLogin` por asset, `migrateLegacyRisk` (top-level) + `migrateLegacyCloudRisk` (update-nulls), `setCurrentAsset/getCurrentAsset/saveLastAsset/loadLastAsset` exportados |
| `assets/js/risk-engine/risk-engine-panel.js` | `getCurrentAssetId()`, `defaultRiskParams()`, `persistRiskParams(assetOverride)` sem troca de identidade, `restoreRiskParams` + `restoreLegacyIfAvailable`, listener `change` em ordem estrita, pull handler com filtro por asset, `saveLastAsset` no boot |
| `assets/js/panel-sync.multativo.test.mjs` (novo) | 18 testes PanelSync |
| `assets/js/risk-engine/risk-engine-panel.multativo.test.mjs` (novo) | 10 testes painel (código real via `vm`) |

Não tocados: `risk-engine.js`, adapter, ticker, AlertEngine, DynamicSR, Worker, Push, `calc-persist.js`, `eb_panel_sim`.

### Testes — 103/103 passando (75 existentes + 28 novos)

Comandos:

```bash
node --test assets/js/risk-engine/risk-engine.test.mjs assets/js/risk-engine/risk-engine-adapter.test.mjs assets/js/risk-engine/risk-engine-chain.test.mjs assets/js/risk-engine/risk-engine.integration.test.mjs
node --test assets/js/risk-engine/risk-engine-panel.multativo.test.mjs assets/js/panel-sync.multativo.test.mjs
```

Regressões dos 3 bugs com teste dedicado (comportamental + guard estrutural que audita todos os `.then/.catch/setTimeout` do fonte de `auth.js`).

### `git diff --check`

Limpo nos 4 arquivos.

### Auditoria `currentAssetId`

2 atribuições: declaração + `setCurrentAsset`. Zero leituras em callbacks assíncronos (provado por teste estrutural).

### Auditoria `eb_panel_risk`

Restam só `LS_KEY_LEGACY` (migração) e `restoreLegacyIfAvailable` (segunda linha de defesa). Nenhum caminho escreve o slot único fora da migração.

### Scripts (verificado no HTML real)

`index.html`: panel L1615 → `auth.js` L1627, ambos síncronos sem `defer/async`, após `#re-simbolo` (L1359). `indexsemalavancagem.html`: só `auth.js`, sem painel/select.

### `RISK_ASSETS`

`getRiskAssets()` lazy, sem cache (página sem-alavancagem não tem o select; futuro `defer` quebraria cache silenciosamente).

### Desvios da spec v2

Nenhum desvio arquitetural. Ajustes menores fiéis ao plano: `syncOnLogin` com guard `!fbApp || !currentUser` no topo; `persistRiskParams` força `toUpperCase` no asset rastreado; `restoreRiskParams` re-sincroniza identidade após apply.

### Riscos restantes

1. Save antes do primeiro restore escreveria a chave legada — impossível no fluxo real (listeners só existem pós-`bind`); se ocorresse, a migração a recolhe.
2. Testes usam Firebase/RTDB falsos — smoke-test logado em staging recomendado antes do deploy.
3. Commit NÃO criado (working tree contém modificações pré-existentes não relacionadas); deploy não feito.
