# Bitcoin Iniciantes — Checklist de Implementação IA

> Resumo executivo de todas as features implementadas por IA.
> Para detalhes técnicos, ver `CHANGES.md`.

---

## Features Implementadas

### Fase A: Motor de Alertas
- [x] `alertEngine.js` — IIFE `window.AlertEngine`
- [x] Detecção de crossover (não apenas acima/abaixo)
- [x] Rearme automático ao retornar para o outro lado
- [x] Cooldown 5s por símbolo/direção
- [x] Web Audio API (880Hz, 300ms, sem .mp3)
- [x] AudioContext lazy (desbloqueio na primeira interação)
- [x] CustomEvent `PriceAlertTriggered` / `PriceAlertDismissed`
- [x] Acesso seguro a `lastSoundAt[symbol]`

### Fase B: Integração com WebSocket
- [x] `AlertEngine.onPriceUpdate()` chamado em `updateLivePrice()`
- [x] Apenas para criptomoedas (`isCrypto()`)
- [x] Não para ações

### Fase C: S/R Dinâmico no Canvas
- [x] `dynamicSR.js` — IIFE `window.DynamicSR`
- [x] Fórmula: maior HIGH / menor LOW das 20 velas fechadas
- [x] Exclui vela em formação (`candles.slice(0, -1)`)
- [x] Linha Resistência: vermelho `#ff4343`, tracejada
- [x] Linha Suporte: verde `#4caf50`, tracejada
- [x] Labels à esquerda do gráfico com fundo semi-transparente
- [x] Botão "S/R" no toolbar do gráfico
- [x] Desativa ao trocar timeframe
- [x] Recalcula ao trocar de ativo (não desativa)

### Fase D: Cards com Alertas
- [x] Botão sino (`.tq-bell`) nos cards de crypto
- [x] Posição: canto inferior esquerdo
- [x] Oculto por padrão, visível no hover
- [x] Visível quando alerta dispara (mesmo sem hover)
- [x] Animação chacoalhar (`bellShake`)
- [x] Card pisca (`alertFlash`) com borda dourada
- [x] Label `R`/`S` indicando nível rompido
- [x] Click no sino remove visual (monitoramento continua)
- [x] Restauração de estado após `refresh()` (bug fix)

### Fase E: Escala Y do Gráfico
- [x] Padding 7% acima/abaixo dos candles
- [x] Drag no eixo Y para esticar/comprimir escala
- [x] Duplo clique no eixo Y reseta para auto-scale
- [x] Cursor `ns-resize` durante drag
- [x] Limites de escala (15% a 500%)

---

## Arquivos Modificados/Criados

| Arquivo | Ação | Linhas |
|---------|------|--------|
| `assets/js/services/alertEngine.js` | CRIADO | 190 |
| `assets/js/chart/dynamicSR.js` | CRIADO | 267 |
| `assets/js/ticker-widget.js` | MODIFICADO | 373 |
| `assets/js/conversor.js` | MODIFICADO | 1242 |
| `index.html` | MODIFICADO | 1352 |
| `assets/css/widgets.css` | MODIFICADO | 1116 |
| `.agents/CHANGES.md` | CRIADO | — |
| `.agents/README.md` | CRIADO | — |

---

## Testes Pendentes

1. Abrir `http://127.0.0.1:8080`
2. Verificar sino aparece no hover dos cards crypto
3. Clicar botão S/R → linhas R/S aparecem no gráfico
4. Aguardar preço cruzar S ou R → card pisca + sino treme + label aparece
5. Clicar sino → visual some, monitoramento continua
6. Trocar ativo → S/R recalcula para novo ativo
7. Trocar timeframe → S/R desativa
8. Arrastar no eixo Y → escala muda
9. Duplo clique no eixo Y → volta auto-scale

---

## Pendências

- [ ] Remover logs `[DynamicSR]` do console após validação
- [ ] Testar em mobile (responsividade do sino)
- [ ] Verificar conflito com markerLines
