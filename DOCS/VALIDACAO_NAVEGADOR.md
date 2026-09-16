# VALIDAÇÃO EM NAVEGADOR — CORREÇÃO ARQUITETURA ALERTAS S/R

**Data:** 2026-09-02  
**Status:** EM EXECUÇÃO

---

## PREPARAÇÃO

Para executar os testes, é necessário:

1. **Deploy da aplicação:**
   - Deploy local via `wrangler pages dev` ou servidor local
   - OU acesso ao ambiente de produção

2. **Verificação de scripts carregados:**
   - Abrir DevTools (F12) → Console
   - Verificar que os arquivos modificados foram carregados:
     ```javascript
     // Verificar AlertEngine
     typeof window.AlertEngine
     typeof window.AlertEngine.hasUserDefinedLevels
     typeof window.AlertEngine.getLevels
     
     // Verificar DynamicSR
     typeof window.DynamicSR
     
     // Verificar PushSubscribe
     typeof window.PushSubscribe
     ```

3. **Logs de diagnóstico ativos:**
   - Logs `[SR-TRACE]` devem aparecer no console
   - Logs `[DynamicSR]` devem aparecer no console

---

## COMANDOS PARA EXECUTAR TESTES

Abaixo estão os comandos JavaScript que você pode copiar e colar no console do navegador para executar cada teste.

---

### TESTE CRÍTICO — PERSISTÊNCIA DO BTC

#### Etapa A: Configurar BTC no gráfico

```javascript
// 1. Clicar manualmente em BTC no ticker para carregar no gráfico
// 2. Clicar no botão S/R para ativar
// 3. Aguardar logs no console
// 4. Registrar valores:

console.log('=== ETAPA A: BTC CONFIGURADO ===');
var btcLevelsA = window.AlertEngine.getLevels('BTC');
console.log('BTC support inicial:', btcLevelsA ? btcLevelsA.support : 'NULL');
console.log('BTC resistance inicial:', btcLevelsA ? btcLevelsA.resistance : 'NULL');
console.log('BTC source:', btcLevelsA ? btcLevelsA.source : 'NULL');
console.log('BTC timeframe:', btcLevelsA ? btcLevelsA.timeframe : 'NULL');
console.log('hasUserDefinedLevels(BTC):', window.AlertEngine.hasUserDefinedLevels('BTC'));

// COPIAR ESTES VALORES PARA O RELATÓRIO
```

#### Etapa B: Aguardar ciclos do ticker (30s)

```javascript
// Aguardar 30 segundos sem fazer nada
// Observar console para logs:
// - [SR-TRACE] TICKER SKIPPED { symbol: 'BTC', reason: 'USER_DEFINED_LEVELS' }
// - NÃO deve aparecer: [SR-TRACE] TICKER UPDATE { symbol: 'BTC' }

// Após 30s, verificar que níveis permanecem:
console.log('=== ETAPA B: APÓS 30s COM TICKER ===');
var btcLevelsB = window.AlertEngine.getLevels('BTC');
console.log('BTC support após ticker:', btcLevelsB ? btcLevelsB.support : 'NULL');
console.log('BTC resistance após ticker:', btcLevelsB ? btcLevelsB.resistance : 'NULL');
console.log('BTC source:', btcLevelsB ? btcLevelsB.source : 'NULL');

// COMPARAR COM VALORES DA ETAPA A
```

#### Etapa C: Trocar gráfico para ETH

```javascript
// 1. Clicar em ETH no ticker (troca gráfico)
// 2. Aguardar 30 segundos
// 3. Observar console:
//    - BTC deve continuar: [SR-TRACE] TICKER SKIPPED
//    - ETH deve mostrar: [SR-TRACE] GRAPH activate (se ativar S/R)

console.log('=== ETAPA C: APÓS TROCAR PARA ETH ===');
var btcLevelsC = window.AlertEngine.getLevels('BTC');
console.log('BTC support após trocar gráfico:', btcLevelsC ? btcLevelsC.support : 'NULL');
console.log('BTC resistance após trocar gráfico:', btcLevelsC ? btcLevelsC.resistance : 'NULL');
console.log('BTC source:', btcLevelsC ? btcLevelsC.source : 'NULL');
console.log('hasUserDefinedLevels(BTC):', window.AlertEngine.hasUserDefinedLevels('BTC'));

// CRITÉRIO DE APROVAÇÃO:
// support Etapa A === support Etapa C
// resistance Etapa A === resistance Etapa C
// source === 'GRAPH'
```

---

### TESTE 2 — TICKER PARA SÍMBOLO SEM CONFIGURAÇÃO

```javascript
console.log('=== TESTE 2: SOL (nunca configurado) ===');

// Verificar que SOL não tem níveis USER_DEFINED
console.log('hasUserDefinedLevels(SOL):', window.AlertEngine.hasUserDefinedLevels('SOL'));

// Aguardar 10 segundos (2 ciclos do ticker)
// Após 10s, verificar:
setTimeout(function() {
  var solLevels = window.AlertEngine.getLevels('SOL');
  console.log('SOL support:', solLevels ? solLevels.support : 'NULL');
  console.log('SOL resistance:', solLevels ? solLevels.resistance : 'NULL');
  console.log('SOL source:', solLevels ? solLevels.source : 'NULL');
  console.log('SOL timeframe:', solLevels ? solLevels.timeframe : 'NULL');
  
  // RESULTADO ESPERADO:
  // - source: 'TICKER'
  // - timeframe: '1h'
  // - Console deve ter mostrado: [SR-TRACE] TICKER UPDATE { symbol: 'SOL' }
}, 10000);
```

---

### TESTE 3 — PUSH OFF PRESERVA ALERTAS

```javascript
console.log('=== TESTE 3: PUSH OFF ===');

// 1. Verificar estado ANTES de desligar Push
var btcBeforePushOff = window.AlertEngine.getLevels('BTC');
console.log('BTC antes de Push OFF:', btcBeforePushOff);

// 2. Clicar manualmente no botão "Ativar alertas" para LIGAR
// 3. Clicar novamente para DESLIGAR
// 4. Observar console: [AlertEngine] disableAll() chamado - alertas locais preservados

// 5. Verificar estado DEPOIS de desligar Push
var btcAfterPushOff = window.AlertEngine.getLevels('BTC');
console.log('BTC depois de Push OFF:', btcAfterPushOff);

// CRITÉRIO DE APROVAÇÃO:
// btcBeforePushOff === btcAfterPushOff
// Console mostra: "alertas locais preservados"
```

---

### TESTE 4 — SINO DISMISS SEM ABRIR CARD

```javascript
console.log('=== TESTE 4: SINO ===');

// 1. Simular trigger de alerta para BTC (se não houver alerta real)
window.AlertEngine.trigger('BTC', 'resistance', 102000, 102000);

// 2. Verificar que card BTC tem classe .alert-triggered
var btcCard = document.querySelector('.tq[data-tq="BTC"]');
console.log('Card BTC tem classe alert-triggered:', btcCard ? btcCard.classList.contains('alert-triggered') : false);

// 3. Clicar manualmente no SINO do card BTC (não no card)
// 4. Observar console: (não há mais logs [DIAGNÓSTICO], handler é silencioso)
// 5. Observar visual:
//    - Classe .alert-triggered deve ser removida
//    - Gráfico NÃO deve mudar de ativo

// 6. Verificar que alerta visual foi removido mas configuração permanece
var btcAfterDismiss = window.AlertEngine.getLevels('BTC');
console.log('BTC após dismiss:', btcAfterDismiss);
console.log('Configuração permanece:', btcAfterDismiss !== null);

// CRITÉRIO DE APROVAÇÃO:
// - Classe .alert-triggered removida
// - Gráfico não mudou de ativo
// - getLevels('BTC') retorna configuração (não null)
```

---

### TESTE 5 — ATUALIZAÇÃO EXPLÍCITA PELO GRÁFICO

```javascript
console.log('=== TESTE 5: ATUALIZAÇÃO EXPLÍCITA ===');

// 1. BTC já configurado em 1D (do teste anterior)
var btcBefore = window.AlertEngine.getLevels('BTC');
console.log('BTC antes de reconfigurar:', btcBefore);

// 2. Trocar timeframe do gráfico para 1W
// 3. Desativar S/R (botão S/R OFF)
// 4. Reativar S/R (botão S/R ON)
// 5. Observar console: [SR-TRACE] GRAPH activate { ..., timeframe: '1W' }

// 6. Verificar que níveis foram atualizados
var btcAfter = window.AlertEngine.getLevels('BTC');
console.log('BTC após reconfigurar 1W:', btcAfter);
console.log('Source ainda é GRAPH:', btcAfter ? btcAfter.source : 'NULL');
console.log('Timeframe mudou para 1W:', btcAfter ? btcAfter.timeframe : 'NULL');

// 7. Aguardar 10s e confirmar que ticker continua respeitando
setTimeout(function() {
  console.log('hasUserDefinedLevels(BTC) após reconfigurar:', window.AlertEngine.hasUserDefinedLevels('BTC'));
  // Deve continuar true
  // Console deve continuar mostrando: [SR-TRACE] TICKER SKIPPED { symbol: 'BTC' }
}, 10000);
```

---

### TESTE 6 — REARME E TRIGGER

```javascript
console.log('=== TESTE 6: MOTOR DE CROSSOVER ===');

// Verificar estrutura interna do alerta BTC
var btcAlert = window.AlertEngine.alerts.get('BTC');
console.log('BTC alert completo:', btcAlert);

if (btcAlert) {
  console.log('Config:', btcAlert.config);
  console.log('State:', btcAlert.state);
  console.log('  - active:', btcAlert.state.active);
  console.log('  - lastPrice:', btcAlert.state.lastPrice);
  console.log('  - armedSupport:', btcAlert.state.armedSupport);
  console.log('  - armedResistance:', btcAlert.state.armedResistance);
  console.log('  - visualAlert:', btcAlert.state.visualAlert);
}

// TESTE MANUAL:
// 1. Observar preço BTC em tempo real (WebSocket)
// 2. Aguardar aproximação de support ou resistance
// 3. Quando crossover acontecer, verificar:
//    - Beep toca
//    - Vibração (mobile)
//    - CustomEvent PriceAlertTriggered
//    - visualAlert vira true
//    - Classe .alert-triggered adicionada ao card
// 4. Aguardar preço voltar para dentro da faixa
// 5. Verificar rearme (armed volta para true)

console.log('Observar comportamento em tempo real durante crossover.');
```

---

## TEMPLATE DE RELATÓRIO

Após executar todos os testes, preencher:

```markdown
# RELATÓRIO DE VALIDAÇÃO — NAVEGADOR

## TESTE CRÍTICO — PERSISTÊNCIA BTC

### Etapa A: Configuração inicial
- BTC support inicial: [VALOR]
- BTC resistance inicial: [VALOR]
- BTC source: GRAPH
- BTC timeframe: 1D
- hasUserDefinedLevels(BTC): true

### Etapa B: Após 30s com ticker
- Logs observados: [TICKER SKIPPED apareceu X vezes]
- TICKER UPDATE para BTC: [SIM/NÃO]
- BTC support após ticker: [VALOR]
- BTC resistance após ticker: [VALOR]
- Valores IGUAIS à Etapa A: [SIM/NÃO]

### Etapa C: Após trocar para ETH
- BTC support após troca: [VALOR]
- BTC resistance após troca: [VALOR]
- Valores IGUAIS à Etapa A: [SIM/NÃO]
- Logs observados: [TICKER SKIPPED continuou aparecendo]

### RESULTADO: [PASS/FAIL]
### CRITÉRIO: [Valores IGUAIS em A, B, C]

---

## TESTE 2 — SOL SEM CONFIGURAÇÃO

- hasUserDefinedLevels(SOL): false
- SOL support: [VALOR]
- SOL resistance: [VALOR]
- SOL source: TICKER
- SOL timeframe: 1h
- Log TICKER UPDATE apareceu: [SIM/NÃO]

### RESULTADO: [PASS/FAIL]

---

## TESTE 3 — PUSH OFF

- BTC antes de Push OFF: [OBJETO]
- Console mostrou "alertas locais preservados": [SIM/NÃO]
- BTC depois de Push OFF: [OBJETO]
- Valores IGUAIS: [SIM/NÃO]

### RESULTADO: [PASS/FAIL]

---

## TESTE 4 — SINO

- Card tinha .alert-triggered: [SIM/NÃO]
- Após clicar no sino:
  - Classe removida: [SIM/NÃO]
  - Gráfico mudou de ativo: [SIM/NÃO]
  - getLevels('BTC') retorna config: [SIM/NÃO]

### RESULTADO: [PASS/FAIL]

---

## TESTE 5 — ATUALIZAÇÃO EXPLÍCITA

- BTC timeframe antes: 1D
- BTC timeframe depois: 1W
- Source permanece GRAPH: [SIM/NÃO]
- hasUserDefinedLevels continua true: [SIM/NÃO]
- Ticker continua SKIPPED: [SIM/NÃO]

### RESULTADO: [PASS/FAIL]

---

## TESTE 6 — MOTOR DE CROSSOVER

- Estrutura alert.config separada: [SIM/NÃO]
- Estrutura alert.state separada: [SIM/NÃO]
- Crossover funcionou: [SIM/NÃO/NÃO TESTADO]
- Rearme funcionou: [SIM/NÃO/NÃO TESTADO]

### RESULTADO: [PASS/FAIL/SKIP]

---

## CONCLUSÃO GERAL

TODOS OS TESTES PASSARAM: [SIM/NÃO]

PRIMEIRO PONTO DE DIVERGÊNCIA (SE HOUVER):
[Descrever exatamente onde o comportamento divergiu do esperado]

APROVAÇÃO DA CORREÇÃO: [APROVADA/REPROVADA]
```

---

## NOTAS IMPORTANTES

### ⚠️ Não posso executar navegador

Como agente de IA, não tenho acesso a um navegador real para executar esses testes.

### ✅ Você precisa executar

Os comandos acima foram preparados para que você possa:

1. Abrir a aplicação no navegador
2. Abrir console (F12)
3. Copiar e colar os comandos JavaScript
4. Observar os resultados
5. Preencher o template de relatório

### 🔍 O que observar

Durante os testes, você verá:

**COMPORTAMENTO CORRETO:**
```javascript
[SR-TRACE] GRAPH activate { symbol: 'BTC', support: 95000, resistance: 102000, source: 'GRAPH' }
[SR-TRACE] TICKER SKIPPED { symbol: 'BTC', reason: 'USER_DEFINED_LEVELS', source: 'GRAPH' }
[SR-TRACE] TICKER UPDATE { symbol: 'SOL', support: 150, resistance: 160, source: 'TICKER' }
```

**COMPORTAMENTO INCORRETO (se houver bug):**
```javascript
[SR-TRACE] TICKER UPDATE { symbol: 'BTC', support: 95500, resistance: 101500, source: 'TICKER' }
// ↑ ISSO NÃO DEVE ACONTECER para BTC com source=GRAPH
```

### 📋 Após executar

Retorne o relatório preenchido com evidências objetivas de cada teste.

Se qualquer teste FALHAR, pare e reporte exatamente o primeiro ponto de divergência antes de modificar o código.
