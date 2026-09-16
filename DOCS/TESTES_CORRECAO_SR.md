# TESTES — CORREÇÃO ARQUITETURA ALERTAS S/R

**Data:** 2026-09-02  
**Versão:** Correção arquitetural implementada

---

## INSTRUÇÕES DE TESTE

Abrir console do navegador (F12) e seguir cada cenário abaixo.  
Verificar logs `[SR-TRACE]` para confirmar comportamento esperado.

---

## TESTE 1 — Troca de gráfico NÃO sobrescreve níveis

### Procedimento:

1. Abrir a aplicação
2. Clicar em BTC no ticker para carregar no gráfico
3. Ativar S/R Dinâmico no gráfico (botão S/R)
4. Anotar valores de support/resistance nos logs:
   ```
   [SR-TRACE] GRAPH activate { symbol: 'BTC', support: X, resistance: Y, source: 'GRAPH', timeframe: '1D' }
   [SR-TRACE] ALERT_ENGINE setAlertLevels { symbol: 'BTC', support: X, resistance: Y, source: 'GRAPH', timeframe: '1D' }
   ```
5. Clicar em ETH no ticker (trocar gráfico)
6. Aguardar 15 segundos (3 ciclos do ticker de 5s)
7. Verificar console

### Resultado esperado:

```javascript
// Após ativar S/R para BTC:
[SR-TRACE] GRAPH activate { symbol: 'BTC', support: 95000, resistance: 102000, source: 'GRAPH', timeframe: '1D' }

// Durante ciclos do ticker (a cada 5s):
[SR-TRACE] TICKER SKIPPED { symbol: 'BTC', reason: 'USER_DEFINED_LEVELS', source: 'GRAPH', timeframe: '1D' }

// BTC NÃO recebe TICKER UPDATE
// Níveis permanecem: support=95000, resistance=102000
```

### Critério de aceite:

✅ **PASSOU** se:
- Log `TICKER SKIPPED` aparece para BTC com `reason: 'USER_DEFINED_LEVELS'`
- Log `TICKER UPDATE` **NÃO aparece** para BTC
- Níveis de BTC permanecem iguais aos definidos pelo GRAPH

❌ **FALHOU** se:
- Log `TICKER UPDATE` aparece para BTC
- Níveis de BTC mudam após trocar gráfico para ETH

---

## TESTE 2 — Ticker respeitando autoridade GRAPH

### Procedimento:

1. Configurar BTC no gráfico (source=GRAPH)
2. No console, executar:
   ```javascript
   window.AlertEngine.getLevels('BTC')
   ```
3. Aguardar 10 segundos
4. Executar novamente:
   ```javascript
   window.AlertEngine.getLevels('BTC')
   ```
5. Comparar valores

### Resultado esperado:

```javascript
// Primeira execução:
{ support: 95000, resistance: 102000, source: 'GRAPH', timeframe: '1D' }

// Segunda execução (após 10s):
{ support: 95000, resistance: 102000, source: 'GRAPH', timeframe: '1D' }

// Valores IDÊNTICOS
```

### Critério de aceite:

✅ **PASSOU** se:
- `getLevels('BTC')` retorna mesmos valores após múltiplos ciclos do ticker
- `source` permanece `'GRAPH'`

❌ **FALHOU** se:
- Valores mudam
- `source` muda para `'TICKER'`

---

## TESTE 3 — Símbolo nunca configurado recebe S/R automático

### Procedimento:

1. Abrir aplicação (sem ativar S/R no gráfico)
2. Aguardar 10 segundos (2 ciclos do ticker)
3. No console, executar para cada símbolo:
   ```javascript
   window.AlertEngine.getLevels('SOL')
   window.AlertEngine.getLevels('LINK')
   window.AlertEngine.getLevels('AVAX')
   ```

### Resultado esperado:

```javascript
// SOL (nunca configurado pelo usuário):
{ support: X, resistance: Y, source: 'TICKER', timeframe: '1h' }

// LINK:
{ support: X, resistance: Y, source: 'TICKER', timeframe: '1h' }

// Console mostra:
[SR-TRACE] TICKER UPDATE { symbol: 'SOL', support: X, resistance: Y, source: 'TICKER', timeframe: '1h' }
[SR-TRACE] TICKER UPDATE { symbol: 'LINK', support: X, resistance: Y, source: 'TICKER', timeframe: '1h' }
```

### Critério de aceite:

✅ **PASSOU** se:
- Símbolos nunca configurados recebem S/R do ticker
- `source` é `'TICKER'`
- `timeframe` é `'1h'`

❌ **FALHOU** se:
- `getLevels()` retorna `null`
- Ticker não escreve níveis

---

## TESTE 4 — Push OFF não destrói alertas locais

### Procedimento:

1. Configurar BTC no gráfico (source=GRAPH)
2. Anotar níveis:
   ```javascript
   window.AlertEngine.getLevels('BTC')
   ```
3. Clicar no botão "Ativar alertas" (sino) para ativar Push
4. Clicar novamente para desligar Push
5. Verificar console:
   ```
   [AlertEngine] disableAll() chamado - alertas locais preservados
   ```
6. Executar:
   ```javascript
   window.AlertEngine.getLevels('BTC')
   ```

### Resultado esperado:

```javascript
// Antes de desligar Push:
{ support: 95000, resistance: 102000, source: 'GRAPH', timeframe: '1D' }

// Após desligar Push:
{ support: 95000, resistance: 102000, source: 'GRAPH', timeframe: '1D' }

// Console:
[AlertEngine] disableAll() chamado - alertas locais preservados
```

### Critério de aceite:

✅ **PASSOU** se:
- `getLevels('BTC')` retorna mesmos valores antes e depois
- Console mostra "alertas locais preservados"
- Configuração S/R não é apagada

❌ **FALHOU** se:
- `getLevels('BTC')` retorna `null` após desligar Push
- Alertas são destruídos

---

## TESTE 5 — Sino dismisses visual sem abrir card

### Procedimento:

1. Configurar BTC no gráfico
2. Aguardar alerta disparar (ou simular com):
   ```javascript
   window.AlertEngine.trigger('BTC', 'resistance', 102000, 102000)
   ```
3. Verificar que card BTC possui classe `.alert-triggered` e sino está chacoalhando
4. Clicar diretamente no sino do card BTC
5. Verificar comportamento

### Resultado esperado:

```javascript
// Console:
[PriceAlertDismissed] { symbol: 'BTC' }

// Visual:
- Classe `.alert-triggered` removida do card
- Sino para de chacoalhar
- Label S/R desaparece do card
- Gráfico NÃO muda de ativo
- Card NÃO dispara evento `estudebitcoin:load-asset`
```

### Critério de aceite:

✅ **PASSOU** se:
- Clique no sino remove apenas alerta visual
- Gráfico não muda de ativo
- Níveis S/R permanecem configurados (getLevels retorna valores)

❌ **FALHOU** se:
- Clique no sino abre card e troca ativo no gráfico
- Configuração S/R é apagada

---

## TESTE 6 — Atualização explícita pelo gráfico

### Procedimento:

1. Configurar BTC no gráfico em timeframe 1D
2. Anotar níveis:
   ```javascript
   window.AlertEngine.getLevels('BTC')
   // { support: 95000, resistance: 102000, source: 'GRAPH', timeframe: '1D' }
   ```
3. Trocar timeframe do gráfico para 1W
4. Desativar S/R Dinâmico (botão S/R OFF)
5. Reativar S/R Dinâmico (botão S/R ON)
6. Verificar console:
   ```
   [SR-TRACE] GRAPH activate { symbol: 'BTC', support: Y, resistance: Z, source: 'GRAPH', timeframe: '1W' }
   ```
7. Executar:
   ```javascript
   window.AlertEngine.getLevels('BTC')
   ```

### Resultado esperado:

```javascript
// Após recalcular em 1W:
{ support: 93000, resistance: 104000, source: 'GRAPH', timeframe: '1W' }

// Console:
[SR-TRACE] GRAPH activate { symbol: 'BTC', support: 93000, resistance: 104000, source: 'GRAPH', timeframe: '1W' }
[SR-TRACE] ALERT_ENGINE setAlertLevels { symbol: 'BTC', support: 93000, resistance: 104000, source: 'GRAPH', timeframe: '1W' }

// Ticker continua respeitando autoridade:
[SR-TRACE] TICKER SKIPPED { symbol: 'BTC', reason: 'USER_DEFINED_LEVELS', source: 'GRAPH', timeframe: '1W' }
```

### Critério de aceite:

✅ **PASSOU** se:
- Níveis são atualizados pelo gráfico
- `source` permanece `'GRAPH'`
- `timeframe` muda para `'1W'`
- Ticker continua sem autoridade sobre BTC

❌ **FALHOU** se:
- Níveis não são atualizados
- Ticker sobrescreve após recalcular

---

## TESTE CRÍTICO — Cenário principal de aceite

### Procedimento:

1. Configurar BTC no gráfico em 1D
2. Anotar níveis iniciais
3. Trocar gráfico para ETH
4. Aguardar 30 segundos
5. Verificar níveis BTC:
   ```javascript
   window.AlertEngine.getLevels('BTC')
   ```

### Resultado esperado:

```
BTC configurado no gráfico (1D)
support = 95.000
resistance = 102.000

→ usuário muda para ETH
→ ticker continua rodando a cada 5s
→ níveis BTC NÃO mudam

Após 30 segundos:
support = 95.000  (IGUAL)
resistance = 102.000  (IGUAL)
source = 'GRAPH'  (INALTERADO)
```

### Critério de aceite:

✅ **PASSOU** se níveis BTC permanecem **EXATAMENTE IGUAIS**  
❌ **FALHOU** se qualquer valor mudou

---

## RESUMO DE LOGS ESPERADOS

### Fluxo correto (após correção):

```javascript
// Usuário ativa S/R para BTC:
[SR-TRACE] GRAPH activate { symbol: 'BTC', support: 95000, resistance: 102000, source: 'GRAPH', timeframe: '1D' }
[SR-TRACE] ALERT_ENGINE setAlertLevels { symbol: 'BTC', support: 95000, resistance: 102000, source: 'GRAPH', timeframe: '1D' }

// Ticker cicla (a cada 5s):
[SR-TRACE] TICKER SKIPPED { symbol: 'BTC', reason: 'USER_DEFINED_LEVELS', source: 'GRAPH', timeframe: '1D' }

// ETH não configurado pelo usuário:
[SR-TRACE] TICKER UPDATE { symbol: 'ETH', support: 3100, resistance: 3300, source: 'TICKER', timeframe: '1h' }
[SR-TRACE] ALERT_ENGINE setAlertLevels { symbol: 'ETH', support: 3100, resistance: 3300, source: 'TICKER', timeframe: '1h' }

// SOL não configurado:
[SR-TRACE] TICKER UPDATE { symbol: 'SOL', support: 150, resistance: 160, source: 'TICKER', timeframe: '1h' }
[SR-TRACE] ALERT_ENGINE setAlertLevels { symbol: 'SOL', support: 150, resistance: 160, source: 'TICKER', timeframe: '1h' }

// BTC continua protegido:
[SR-TRACE] TICKER SKIPPED { symbol: 'BTC', reason: 'USER_DEFINED_LEVELS', source: 'GRAPH', timeframe: '1D' }
```

---

## VALIDAÇÃO FINAL

Após executar todos os testes, preencher:

| Teste | Status | Notas |
|-------|--------|-------|
| 1. Troca de gráfico | ⬜ PASSOU / ⬜ FALHOU | |
| 2. Ticker respeita autoridade | ⬜ PASSOU / ⬜ FALHOU | |
| 3. Símbolo nunca configurado | ⬜ PASSOU / ⬜ FALHOU | |
| 4. Push OFF preserva alertas | ⬜ PASSOU / ⬜ FALHOU | |
| 5. Sino dismiss visual | ⬜ PASSOU / ⬜ FALHOU | |
| 6. Atualização explícita GRAPH | ⬜ PASSOU / ⬜ FALHOU | |
| **CRÍTICO: Cenário principal** | ⬜ PASSOU / ⬜ FALHOU | |

**Correção aprovada se:** TODOS os testes passaram ✅

---

## COMANDOS ÚTEIS (CONSOLE)

```javascript
// Ver níveis de um símbolo:
window.AlertEngine.getLevels('BTC')

// Ver todos os alertas:
window.AlertEngine.alerts

// Verificar se símbolo tem níveis USER_DEFINED:
window.AlertEngine.hasUserDefinedLevels('BTC')

// Simular trigger de alerta:
window.AlertEngine.trigger('BTC', 'resistance', 102000, 102000)

// Ver estado do DynamicSR:
window.DynamicSR.isActive()
window.DynamicSR.getSymbol()
window.DynamicSR.getLevels()
```
