# ESPECIFICAÇÃO DE IMPLEMENTAÇÃO — ALERTAS S/R DINÂMICOS
## Cripto | Lightweight Charts | WebSocket | React

**Status:** pronta para implementação  
**Objetivo:** entregar um motor simples, previsível e resistente a retriggering, adequado para implementação por uma IA de programação limitada.

---

# 1. REGRA PRINCIPAL

O sistema deve fazer somente isto:

> Quando o usuário ativar **S/R Dinâmico** no gráfico de uma criptomoeda, o sistema calcula **R1 e S1 usando a última vela fechada do timeframe selecionado**, desenha as duas linhas e passa a observar o preço em tempo real.

Quando o preço **cruzar** R1 para cima ou S1 para baixo:

- o card da criptomoeda entra em alerta visual;
- o sino do card fica animado;
- um som é reproduzido **uma vez por evento de cruzamento**;
- o alerta permanece visualmente ativo até o usuário clicar no sino;
- o motor não deve gerar vários sons enquanto o preço continuar do outro lado da linha.

**Não criar outro widget de alerta.**  
O alerta pertence ao **card da criptomoeda já existente**.

---

# 2. ESCOPO

## 2.1 Ativos monitorados

Monitorar somente os ativos da aba **CRYPTO**.

Exemplos:

- BTC
- ETH
- SOL
- LINK
- AVAX
- RENDER
- PAXG
- USDT-BRL, somente se estiver sendo tratado pelo sistema como cripto/mercado de cripto

Ativos da aba **STOCKS` não entram neste motor.

## 2.2 Fonte de preço

O gatilho deve usar o **preço em tempo real recebido pelo WebSocket de cripto já existente no projeto**.

Não criar outro WebSocket se já existir um.

Não usar o valor visual arredondado do card para disparar o alerta.

---

# 3. DEFINIÇÃO EXATA DE S/R

## 3.1 Vela utilizada

Ao ativar o recurso, utilizar a **última vela completamente fechada** do timeframe selecionado.

Nunca usar a vela atualmente em formação.

Exemplo:

- usuário selecionou `1H`;
- são 13:42;
- a vela `13:00–13:59` ainda está aberta;
- usar a vela `12:00–12:59`.

## 3.2 Fórmula

Para a vela fechada:

```text
P = (H + L + C) / 3

R1 = (2 × P) - L

S1 = (2 × P) - H
```

Onde:

- `H` = máxima da vela fechada;
- `L` = mínima;
- `C` = fechamento.

Não implementar outros métodos de pivô nesta fase.

---

# 4. COMPORTAMENTO DO BOTÃO S/R DINÂMICO

O botão existente no gráfico será o controlador.

## Ao ligar

Executar nesta ordem:

```text
1. descobrir símbolo atual
2. descobrir timeframe atual
3. obter a última vela fechada
4. calcular P, R1 e S1
5. desenhar linha R1
6. desenhar linha S1
7. registrar R1/S1 no AlertEngine
8. preparar o áudio
9. iniciar monitoramento
```

## Ao desligar

Executar:

```text
1. parar monitoramento daquele símbolo
2. remover linha R1
3. remover linha S1
4. limpar o estado de alerta visual daquele símbolo
```

Não apagar outros símbolos que possam estar monitorados.

---

# 5. NÃO RECALCULAR AS LINHAS A CADA TICK

Essa é uma regra crítica.

Depois que R1 e S1 forem definidos:

```text
R1 permanece congelado.
S1 permanece congelado.
```

Os ticks do WebSocket servem apenas para verificar o preço.

O sistema só deve calcular novos níveis quando:

- o usuário desligar e ligar novamente o S/R; ou
- existir uma atualização explícita de período/timeframe definida pelo código.

Não recalcular R1/S1 em cada atualização de preço.

---

# 6. ESTRUTURA DO ALERTENGINE

Criar um único serviço fora do React.

Arquivo sugerido:

```text
src/services/alertEngine.js
```

Não usar Redux, Zustand, Context ou outra biblioteca somente para este motor.

A estrutura deve ser simples:

```javascript
Map<symbol, AlertState>
```

Cada entrada deve conter:

```javascript
{
    support: number,
    resistance: number,

    active: boolean,

    supportTriggered: boolean,
    resistanceTriggered: boolean,

    armedSupport: boolean,
    armedResistance: boolean,

    lastPrice: number | null,

    visualAlert: boolean
}
```

---

# 7. REGRA MAIS IMPORTANTE: DETECTAR CRUZAMENTO

Não usar somente:

```javascript
price >= resistance
```

ou:

```javascript
price <= support
```

Isso causa retriggering.

O correto é comparar o preço anterior com o preço atual.

## 7.1 Rompimento de resistência

Disparar somente quando:

```text
preço anterior < R1
E
preço atual >= R1
```

Exemplo:

```text
79.900 → 80.100
R1 = 80.000
```

Dispara.

Mas:

```text
80.100 → 80.200
80.200 → 80.350
80.350 → 80.180
```

não dispara novamente.

## 7.2 Rompimento de suporte

Disparar somente quando:

```text
preço anterior > S1
E
preço atual <= S1
```

Exemplo:

```text
62.300 → 62.100
S1 = 62.200
```

Dispara.

---

# 8. REARME DO ALERTA

Depois de cruzar uma linha, o alerta daquela direção fica desarmado.

Para permitir novo alerta no futuro, o preço precisa voltar para o lado oposto.

## Resistência

Depois de cruzar R1 para cima:

```text
armedResistance = false
```

Só rearmar quando:

```text
price < resistance
```

Depois poderá ocorrer:

```text
price < R1
→
price >= R1
```

e um novo alerta será permitido.

## Suporte

Depois de cruzar S1 para baixo:

```text
armedSupport = false
```

Só rearmar quando:

```text
price > support
```

Depois poderá ocorrer:

```text
price > S1
→
price <= S1
```

e um novo alerta será permitido.

---

# 9. ESTADO INICIAL

Ao registrar um alerta:

```javascript
{
    active: true,
    supportTriggered: false,
    resistanceTriggered: false,
    armedSupport: true,
    armedResistance: true,
    lastPrice: null,
    visualAlert: false
}
```

Porém, existe uma proteção importante:

## Não disparar imediatamente ao registrar

Se o preço atual já estiver acima de R1 no momento em que o usuário ligar o S/R, não considerar isso automaticamente um rompimento.

Da mesma forma, se já estiver abaixo de S1, não disparar.

A primeira cotação apenas inicializa:

```javascript
lastPrice = currentPrice
```

O primeiro alerta só poderá acontecer em uma mudança posterior que atravesse a linha.

---

# 10. FLUXO DE CADA TICK

A função principal deve seguir exatamente esta lógica:

```javascript
onPriceUpdate(symbol, currentPrice) {
    const alert = this.alerts.get(symbol);

    if (!alert || !alert.active) return;
    if (!Number.isFinite(currentPrice)) return;

    if (alert.lastPrice === null) {
        alert.lastPrice = currentPrice;
        this.updateArmingState(alert, currentPrice);
        return;
    }

    const previousPrice = alert.lastPrice;

    // Rearmar
    if (currentPrice < alert.resistance) {
        alert.armedResistance = true;
    }

    if (currentPrice > alert.support) {
        alert.armedSupport = true;
    }

    // Rompimento de resistência
    if (
        alert.armedResistance &&
        previousPrice < alert.resistance &&
        currentPrice >= alert.resistance
    ) {
        alert.armedResistance = false;
        this.trigger(symbol, "resistance", currentPrice, alert.resistance);
    }

    // Rompimento de suporte
    if (
        alert.armedSupport &&
        previousPrice > alert.support &&
        currentPrice <= alert.support
    ) {
        alert.armedSupport = false;
        this.trigger(symbol, "support", currentPrice, alert.support);
    }

    alert.lastPrice = currentPrice;
}
```

A implementação pode adaptar nomes, mas a lógica deve permanecer.

---

# 11. ALERTA VISUAL

Quando ocorrer um disparo:

```text
visualAlert = true
```

O card do ativo deve receber uma classe:

```text
alert-triggered
```

O efeito deve continuar até o usuário clicar no sino.

Não remover automaticamente após 1 segundo.

O cooldown de áudio não deve desligar o alerta visual.

---

# 12. SINO DO CARD

O sino deve existir somente nos cards de CRYPTO.

Não criar sino em STOCKS.

O clique do sino significa:

> "Eu vi este alerta."

Ao clicar:

```text
1. remover animação visual do card
2. parar animação do sino
3. marcar visualAlert = false
4. NÃO apagar R1/S1
5. NÃO remover o monitoramento
```

Isso é importante.

**Desarmar visualmente não significa desligar o S/R.**

O motor continua monitorando e poderá gerar novo alerta depois que ocorrer um novo cruzamento válido.

Se futuramente for necessário desligar totalmente o monitoramento, isso será função do botão S/R do gráfico, não do sino.

---

# 13. ÁUDIO

Não criar um sistema de áudio complexo.

Usar um único arquivo:

```text
public/assets/sounds/alert.mp3
```

Criar uma única instância de:

```javascript
const audio = new Audio("/assets/sounds/alert.mp3");
```

## 13.1 Desbloqueio

O melhor momento para preparar o áudio é durante uma ação explícita do usuário, preferencialmente no clique que ativa o S/R.

Exemplo:

```javascript
audio.play()
    .then(() => {
        audio.pause();
        audio.currentTime = 0;
    })
    .catch(() => {});
```

Não depender do primeiro tick do WebSocket para tentar liberar áudio.

## 13.2 Disparo

No evento de alerta:

```javascript
audio.currentTime = 0;
audio.play().catch(() => {});
```

Se o navegador ainda bloquear áudio, o alerta visual deve continuar funcionando normalmente.

Nunca deixar erro de áudio quebrar o motor.

---

# 14. COOLDOWN DE ÁUDIO

Não usar cooldown global de 60 segundos para o motor inteiro.

O problema de um cooldown global é:

```text
BTC rompe resistência
→ som

3 segundos depois
ETH rompe suporte
→ som deveria tocar
→ mas o cooldown global bloquearia
```

O correto é controlar por símbolo/direção.

Estrutura:

```javascript
lastSoundAt: {
    BTC: {
        resistance: timestamp,
        support: timestamp
    }
}
```

Cooldown sugerido:

```text
5 segundos
```

O objetivo do cooldown é apenas proteger contra duplicação acidental.

O mecanismo de cruzamento + rearme já é a proteção principal contra retriggering.

---

# 15. EVENTO PARA A UI

O motor não deve chamar `setState` a cada tick.

Ele só comunica a UI quando algo realmente acontece.

Usar um evento simples:

```javascript
window.dispatchEvent(
    new CustomEvent("PriceAlertTriggered", {
        detail: {
            symbol,
            direction,
            price,
            level
        }
    })
);
```

Exemplo:

```javascript
{
    symbol: "BTC",
    direction: "resistance",
    price: 80437.99,
    level: 80000
}
```

Não disparar evento a cada preço.

Somente em:

```text
CRUZAMENTO VÁLIDO
```

---

# 16. EVENTO DE DESARME

Para simplificar, o clique do sino pode chamar diretamente:

```javascript
alertEngine.dismissVisualAlert(symbol);
```

Não é necessário criar um CustomEvent para isso.

Implementação:

```javascript
dismissVisualAlert(symbol) {
    const alert = this.alerts.get(symbol);
    if (!alert) return;

    alert.visualAlert = false;

    window.dispatchEvent(
        new CustomEvent("PriceAlertDismissed", {
            detail: { symbol }
        })
    );
}
```

---

# 17. INTEGRAÇÃO COM O CARD REACT

O card deve ouvir somente eventos de alerta.

Não colocar um listener de WebSocket dentro de cada card.

Estrutura simples:

```javascript
useEffect(() => {
    const onAlert = (event) => {
        if (event.detail.symbol !== assetSymbol) return;

        setVisualAlert(true);
    };

    const onDismiss = (event) => {
        if (event.detail.symbol !== assetSymbol) return;

        setVisualAlert(false);
    };

    window.addEventListener("PriceAlertTriggered", onAlert);
    window.addEventListener("PriceAlertDismissed", onDismiss);

    return () => {
        window.removeEventListener("PriceAlertTriggered", onAlert);
        window.removeEventListener("PriceAlertDismissed", onDismiss);
    };
}, [assetSymbol]);
```

É permitido usar `setState` aqui porque isso acontece somente quando há um alerta, e não a cada tick.

---

# 18. NÃO MANIPULAR DOM DIRETAMENTE

A especificação anterior sugeria:

```javascript
cardRef.current.classList.add(...)
```

Não é necessário.

Para uma implementação mais estável em React, usar estado:

```javascript
className={`crypto-card ${visualAlert ? "alert-triggered" : ""}`}
```

Isso é mais simples para uma IA limitada e reduz risco de estado visual ficar dessincronizado.

---

# 19. INTEGRAÇÃO COM O WEBSOCKET

Localizar o ponto do projeto onde o preço recebido pelo WebSocket já é processado.

Depois do símbolo e preço serem normalizados:

```javascript
alertEngine.onPriceUpdate(symbol, price);
```

Essa chamada deve acontecer antes da atualização visual, mas não deve bloquear o processamento.

Exemplo:

```javascript
function handleMarketTick(symbol, price) {
    alertEngine.onPriceUpdate(symbol, price);

    // código existente da aplicação
    updateMarketData(symbol, price);
}
```

Não criar outro `WebSocket`.

Não criar outro `setInterval` para observar preço.

---

# 20. NORMALIZAÇÃO DO SÍMBOLO

O símbolo usado pelo gráfico, WebSocket e card precisa ser exatamente o mesmo.

Exemplo:

```text
BTC
ETH
SOL
```

ou, se o projeto usar:

```text
BTCUSDT
ETHUSDT
SOLUSDT
```

Escolher o padrão já utilizado no projeto e não misturar formatos.

O AlertEngine deve receber o símbolo já normalizado.

---

# 21. INTEGRAÇÃO COM O GRÁFICO

Criar uma função simples:

```javascript
activateDynamicSR(symbol, previousCandle, chartSeries)
```

Ela deve:

```text
1. validar previousCandle
2. calcular P
3. calcular R1
4. calcular S1
5. criar linha R1
6. criar linha S1
7. registrar níveis no AlertEngine
8. retornar referências das linhas
```

Exemplo de cálculo:

```javascript
const pivot = (high + low + close) / 3;
const resistance = (2 * pivot) - low;
const support = (2 * pivot) - high;
```

---

# 22. VALIDAÇÕES OBRIGATÓRIAS

Antes de registrar:

```javascript
if (!Number.isFinite(high)) return;
if (!Number.isFinite(low)) return;
if (!Number.isFinite(close)) return;
if (high < low) return;
```

Depois do cálculo:

```javascript
if (!Number.isFinite(support)) return;
if (!Number.isFinite(resistance)) return;
```

Não registrar alerta com valores `undefined`, `NaN`, `0` acidental ou strings.

---

# 23. TROCA DE TIMEFRAME

Se o usuário alterar o timeframe enquanto S/R estiver ligado:

```text
1. desligar os níveis antigos
2. remover R1 antigo
3. remover S1 antigo
4. obter a última vela fechada do novo timeframe
5. recalcular
6. desenhar novos níveis
7. substituir o registro do AlertEngine
8. reiniciar lastPrice
```

Não manter níveis do timeframe anterior.

---

# 24. TROCA DE ATIVO

Se o usuário trocar:

```text
BTC → ETH
```

o S/R exibido deve acompanhar o novo ativo.

O registro de BTC não deve ser apagado se o projeto permitir monitoramento simultâneo dos cards.

Porém, o gráfico deve monitorar somente o ativo atualmente selecionado.

---

# 25. INDEPENDÊNCIA DO GRÁFICO E DOS CARDS

O motor deve continuar funcionando mesmo se:

- o gráfico deixar de renderizar por alguns instantes;
- o usuário mudar de tela;
- um card sofrer re-render;
- o timeframe visual mudar.

A fonte da verdade do alerta é:

```text
WebSocket → AlertEngine
```

O gráfico serve para:

```text
calcular + desenhar níveis
```

O card serve para:

```text
mostrar o alerta
```

---

# 26. CSS

Usar animação simples.

```css
@keyframes alertFlash {
    0%, 100% {
        opacity: 1;
    }

    50% {
        opacity: 0.55;
    }
}

.crypto-card.alert-triggered {
    animation: alertFlash 0.8s infinite;
}

@keyframes bellShake {
    0%, 100% {
        transform: rotate(0deg);
    }

    25% {
        transform: rotate(-12deg);
    }

    75% {
        transform: rotate(12deg);
    }
}

.crypto-card.alert-triggered .bell-btn {
    animation: bellShake 0.45s infinite;
}
```

Não alterar o layout dos cards.

Não criar uma nova área visual para alertas.

---

# 27. LINHAS DO GRÁFICO

As linhas R1 e S1 devem continuar sendo visíveis enquanto o S/R estiver ligado.

Sugestão:

```text
R1 → linha horizontal tracejada
S1 → linha horizontal tracejada
```

Usar os padrões visuais já existentes no gráfico.

Não criar outro gráfico.

Não criar painel lateral para S/R nesta fase.

---

# 28. ESTRUTURA DE ARQUIVOS SUGERIDA

Manter poucos arquivos:

```text
src/
├─ services/
│  └─ alertEngine.js
│
├─ chart/
│  └─ dynamicSR.js
│
├─ components/
│  └─ CryptoCard.jsx
│
└─ ...

public/
└─ assets/
   └─ sounds/
      └─ alert.mp3
```

Se o projeto já possuir arquivos equivalentes, **adaptar os existentes** em vez de duplicar arquivos.

---

# 29. O QUE NÃO FAZER

Não implementar:

```text
❌ novo WebSocket
❌ novo polling de preço
❌ Redux somente para alertas
❌ Context somente para alertas
❌ atualização React a cada tick
❌ recálculo R1/S1 a cada tick
❌ alerta sempre que price >= R1
❌ alerta sempre que price <= S1
❌ cooldown global de 60 segundos
❌ desligamento do monitoramento ao clicar no sino
❌ novos cards
❌ novo widget de alertas
❌ notificação do navegador nesta primeira versão
❌ banco de dados para guardar alertas
❌ persistência em localStorage
❌ vários objetos Audio
```

---

# 30. TESTES OBRIGATÓRIOS

A IA que implementar deve testar pelo menos estes cenários.

## Teste 1 — resistência

```text
R1 = 100

99 → 99.5 → 100.1

Resultado:
ALERTA
```

## Teste 2 — permanência acima

```text
100.1 → 100.2 → 101 → 100.5

Resultado:
somente 1 alerta
```

## Teste 3 — retorno abaixo

```text
100.5 → 99.8

Resultado:
rearma resistência
```

## Teste 4 — novo rompimento

```text
99.8 → 100.2

Resultado:
novo alerta
```

## Teste 5 — suporte

```text
S1 = 100

101 → 100.2 → 99.8

Resultado:
ALERTA
```

## Teste 6 — permanência abaixo

```text
99.8 → 99.5 → 98.9 → 99.2

Resultado:
somente 1 alerta
```

## Teste 7 — áudio bloqueado

Simular:

```javascript
audio.play() rejeitado
```

Resultado:

```text
alerta visual continua funcionando
aplicação não quebra
```

## Teste 8 — preço inicial já acima

```text
R1 = 100
primeiro preço recebido = 101
```

Resultado:

```text
NÃO ALERTAR
```

## Teste 9 — dois ativos

```text
BTC rompe R1
ETH permanece normal
```

Resultado:

```text
somente BTC entra em alerta
```

## Teste 10 — STOCKS

Uma ação recebe atualização.

Resultado:

```text
não dispara AlertEngine
não mostra sino de alerta
```

---

# 31. CRITÉRIOS DE ACEITE

A implementação só pode ser considerada concluída quando todos estes pontos forem verdadeiros:

- [ ] S/R é calculado a partir da última vela fechada.
- [ ] R1 e S1 aparecem no gráfico.
- [ ] Os níveis ficam congelados até nova ativação/reconfiguração.
- [ ] O preço usado no alerta vem do WebSocket real.
- [ ] O sistema detecta cruzamento, não simples permanência acima/abaixo.
- [ ] Um rompimento contínuo gera somente um alerta.
- [ ] O preço precisa retornar ao outro lado para rearmar.
- [ ] BTC e ETH possuem estados independentes.
- [ ] O clique do sino remove apenas o alerta visual.
- [ ] O clique do sino não desliga o monitoramento.
- [ ] STOCKS não entram no motor.
- [ ] O som toca somente no disparo.
- [ ] Falha de áudio não quebra o sistema.
- [ ] A UI não recebe atualização React a cada tick.
- [ ] Não foi criado um segundo WebSocket.
- [ ] Não foi criado um segundo widget de alertas.

---

# 32. ORDEM DE IMPLEMENTAÇÃO PARA A IA

A IA deve trabalhar exatamente nesta ordem para reduzir erros.

## Fase A — localizar o código existente

Antes de alterar qualquer coisa:

```text
1. localizar o WebSocket de cripto
2. localizar o componente dos cards
3. localizar o gráfico Lightweight Charts
4. localizar o botão/toolbar onde S/R será ligado
5. localizar o código que obtém OHLC
```

Não criar arquivos duplicados antes de verificar o que já existe.

## Fase B — criar o motor

Criar:

```text
alertEngine.js
```

Implementar primeiro:

```text
setAlertLevels()
onPriceUpdate()
trigger()
dismissVisualAlert()
disable()
```

Testar isoladamente.

## Fase C — conectar o WebSocket

Adicionar somente:

```javascript
alertEngine.onPriceUpdate(symbol, price);
```

Não alterar o fluxo de dados já existente.

## Fase D — conectar o gráfico

Implementar o cálculo de:

```text
P
R1
S1
```

Desenhar as linhas.

Registrar os níveis no motor.

## Fase E — conectar os cards

Adicionar:

```text
PriceAlertTriggered
PriceAlertDismissed
```

Adicionar o sino somente aos cards CRYPTO.

## Fase F — áudio

Adicionar `alert.mp3`.

Desbloquear no clique do S/R.

Tocar no disparo.

## Fase G — testes

Executar todos os testes da seção 30 antes de considerar concluído.

---

# 33. REGRA CONTRA INTERPRETAÇÃO DA IA

A implementação deve **preservar o comportamento descrito neste documento mesmo que existam maneiras diferentes de programá-lo**.

Quando houver dúvida, aplicar esta prioridade:

```text
1. comportamento deste documento
2. código existente do projeto
3. simplicidade
4. performance
5. melhorias futuras
```

Não adicionar funcionalidades não solicitadas.

Não refatorar partes não relacionadas.

Não trocar a biblioteca do gráfico.

Não trocar o WebSocket existente.

Não criar arquitetura maior do que a necessária.

---

# 34. RESULTADO ESPERADO NA TELA

A aparência atual deve permanecer essencialmente a mesma:

```text
[ BTC ] [ ETH ] [ SOL ] [ LINK ] [ AVAX ] [ RENDER ] ...

                    gráfico

        R1 ─────────────────────────

        candles

        S1 ─────────────────────────
```

No card:

```text
BTC     🔔
+%
$ preço
```

Quando houver rompimento:

```text
BTC     🔔  ← sino animado
+%
$ preço
```

O card pisca continuamente até o usuário clicar no sino.

Depois do clique:

```text
BTC     🔔  ← normal
+%
$ preço
```

As linhas continuam no gráfico enquanto S/R estiver ligado.

---

# 35. DECISÃO ARQUITETURAL FINAL

A arquitetura final é:

```text
                    ┌────────────────────┐
                    │ Binance WebSocket  │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │   AlertEngine      │
                    │                    │
                    │ R1 / S1            │
                    │ preço anterior     │
                    │ cruzamento         │
                    │ rearme             │
                    └──────┬───────┬─────┘
                           │       │
                 alerta    │       │ áudio
                           │       │
                           ▼       ▼
                    ┌──────────┐  ┌───────┐
                    │ Crypto   │  │Audio  │
                    │ Cards    │  │       │
                    └──────────┘  └───────┘

                    ┌────────────────────┐
                    │ Lightweight Charts │
                    │                    │
                    │ calcula R1/S1      │
                    │ desenha linhas     │
                    └─────────┬──────────┘
                              │
                              ▼
                         AlertEngine
```

### Regra essencial

```text
GRÁFICO
    ↓
calcula níveis

WEBSOCKET
    ↓
entrega preço

ALERTENGINE
    ↓
detecta cruzamento

CARD
    ↓
mostra alerta

SIN0
    ↓
dispensa visualmente

NÃO EXISTE SEGUNDO WIDGET.
NÃO EXISTE SEGUNDO WEBSOCKET.
```

---

# 36. INSTRUÇÃO FINAL PARA A IA IMPLEMENTADORA

Implementar somente o que está descrito neste documento.

Antes de terminar, informar:

```text
- arquivos alterados
- arquivos criados
- testes executados
- testes aprovados
- eventuais limitações
```

Se algo já existir no projeto, reutilizar.

Se alguma parte deste documento entrar em conflito com uma implementação existente, parar naquela parte e informar o conflito em vez de criar uma segunda implementação concorrente.
