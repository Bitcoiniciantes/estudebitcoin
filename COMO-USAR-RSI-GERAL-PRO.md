# RSI Geral Pro — versão consolidada

O indicador reúne oito períodos fixos: **5m, 15m, 1h, 4h, 12h, 1D, 1S e 1M**. A ordem não pode ser alterada; os períodos 5m, 15m e 1h confirmam as reversões rápidas.

## Painel

- Flutua no canto inferior direito do gráfico.
- O cabeçalho acompanha automaticamente o ativo selecionado.
- RSI igual ou superior a 80 recebe verde forte.
- RSI igual ou inferior a 25 recebe vermelho forte.
- Entre 25 e 80, a intensidade da cor muda gradualmente.
- O consenso mostra quantos timeframes estão acima e abaixo de 50.
- O gauge “FORÇA” posiciona o RSI Geral na escala de 0 a 100.
- Alinhamento total aparece quando os oito períodos apontam para o mesmo lado.

## Atualização em tempo real

Deixe **Modo de cálculo = Em formação (tempo real)**. O indicador recalcula quando o TradingView recebe um novo tick do ativo. A cor dos números alterna entre branco e amarelo e o rodapé alterna `●/◉`, mostrando que houve atualização.

O pulso não é controlado por relógio: se o mercado não enviar um novo negócio, ele fica parado. Isso é normal. Em ativos líquidos, o contador “atualização por tick” deve avançar continuamente.

Por padrão, **Confirmar sinais só no fechamento** fica ligado. O painel e os números continuam em tempo real, mas as etiquetas só são confirmadas no fechamento. A trava anti-repetição permite apenas um momentum por ciclo e respeita um intervalo padrão de 12 candles. Para máxima velocidade, desligue a confirmação — sabendo que sinais intrabar podem desaparecer antes do fechamento.

## Cálculo e filtros

- **Curto prazo:** favorece os períodos rápidos.
- **Equilibrado:** aumenta progressivamente o peso dos períodos maiores.
- **Macro:** prioriza diário, semanal e mensal.
- **EMA:** filtra momentum pela tendência do preço.
- **ATR:** filtro opcional de expansão de volatilidade; vem desligado por padrão.
- **Reversão:** exige que pelo menos dois entre 5m, 15m e 1h já tenham mudado de direção.

No modo em formação, somente as oito consultas ao vivo são executadas. No modo confirmado, somente as oito consultas de candles fechados são executadas.

## Alertas

Há alertas separados para momentum, reversão, faixas 80/25 e alinhamento total 8/8. As mensagens dinâmicas incluem ativo, preço, RSI Geral e percentual de consenso.

Para usar todas as mensagens em um único alerta, selecione **Qualquer chamada de função alert()** no TradingView.

## Painel contrário — medo e ganância

O segundo painel fica na região inferior esquerda, deslocado aproximadamente 12% para a direita para não cobrir o logotipo do TradingView, e funciona simultaneamente ao painel de tendência:

- RSI Geral igual ou abaixo de 20: medo extremo em vermelho; aguarda a virada.
- Compra contrária: confirma quando o RSI cruza 20 para cima e pelo menos dois entre 5m, 15m e 1h estão subindo.
- 40–50: Neutro Bear.
- 50–70: Neutro.
- 70–90: região de ganância/venda.
- RSI Geral igual ou acima de 90: ganância extrema em verde; aguarda a virada.
- Venda contrária: confirma quando o RSI cruza 90 para baixo e pelo menos dois entre 5m, 15m e 1h estão caindo.

Os marcadores `C 20` e `V 90` vêm escondidos para evitar poluição visual. Eles podem ser ativados em **6. Leitura contrária → Mostrar C/V no gráfico**. O painel contrário pode ser ocultado sem afetar o painel principal.
## Instalação

1. Abra o Editor Pine no TradingView.
2. Copie todo o conteúdo de `tradingview-rsi-geral-pro.pine`.
3. Substitua o código anterior, salve e adicione ao gráfico novamente.
4. Se o TradingView preservar configurações da versão antiga, remova o indicador antigo do gráfico antes de adicionar esta versão.

O indicador é uma ferramenta de contexto; não substitui gerenciamento de risco nem constitui recomendação financeira.