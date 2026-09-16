# Alavancagem_Pro — Documentação do Projeto

> Sistema de cálculo de risco para posições alavancadas (modelo Quantfury)
> do EstudeBitcoin: motor matemático determinístico + integração em tempo
> real com o ticker + painel ao vivo na página.
>
> Status: **em produção** (`estudebitcoin.pages.dev`) desde o commit `63e72cf`.
> Testes: **75/75 verdes** · TypeScript `strict` PASS · Paridade TS↔JS (5000 casos).

---

## 1. Visão geral

```text
ticker real (Binance WS)
      ↓  evento "estudebitcoin:ticker-price"
preço real
      ↓  RiskEngineAdapter.updateRiskPrice(precoAtual)
RiskEngine.calcularRisco()
      ↓  ResultadoRisco
painel "Posição ao Vivo" (#re-painel)
      ↓
DOM visível atualizado a cada tick
```

Três camadas com responsabilidades separadas:

| Camada | Arquivo(s) | Responsabilidade | Proibido de |
|---|---|---|---|
| Market Data | `assets/js/ticker-widget.js` (pré-existente) | Obter o preço (Binance WS/REST) e emitir o evento | Conhecer o motor |
| Adapter | `risk-engine-adapter.js` | Guardar parâmetros da posição, encaminhar preço, distribuir resultado | Conter fórmulas, rede, timers |
| Risk Engine | `risk-engine.js` / `.ts` | Matemática pura: PnL, equity, Pliq, estados | Rede, DOM, estado, arredondamento |
| UI | `risk-engine-panel.js` + seção no `index.html` | Apresentar `resultado.*` | Recalcular qualquer campo |

---

## 2. O modelo matemático (especificação congelada)

Posição definida por: `saldoCorretora`, `alavancagem`, `ordens[]` (moeda/preço/valor),
`precoAtual`, `fundingCustoAcumulado` (custo pago, ≥ 0, default 0),
`mmr` (decimal, 0 ≤ mmr < 1, default 0), `lado` (LONG/SHORT).

| Passo | Fórmula |
|---|---|
| Quantidade | `Q = Σ (valor / preco)` por ordem |
| Exposição | `V = Σ valor` |
| Preço médio | `Pmedio = V / Q` (ponderado financeiro, nunca média simples) |
| Margem retida | `M = V / alavancagem` |
| Margem livre | `saldo − M − funding` |
| PnL LONG | `(precoAtual − Pmedio) × Q` |
| PnL SHORT | `(Pmedio − precoAtual) × Q` |
| Equity | `saldo + PnL − funding` (margem **não** subtraída de novo) |
| Equity limite | `V × mmr` (**MMR incide sobre o nocional**, nunca sobre a margem) |
| Pliq LONG | `Pmedio + (EquityLimite − saldo + funding) / Q` |
| Pliq SHORT | `Pmedio − (EquityLimite − saldo + funding) / Q` |
| Distância LONG | `((precoAtual − Pliq) / precoAtual) × 100` |
| Distância SHORT | `((Pliq − precoAtual) / precoAtual) × 100` |
| Resultado equity | `((Equity − saldo) / saldo) × 100` (> 0 ganho, < 0 perda) |

### Regras invioláveis

1. **Pliq independe da alavancagem.** Fixados saldo, V, Q, Pmedio, funding e mmr,
   o Pliq é idêntico para qualquer alavancagem — ela só dimensiona margem
   retida/livre. Nunca "corrigir" a fórmula para aproximar a liquidação.
2. **Pliq ≤ 0** não é erro: significa ausência de preço positivo de liquidação →
   `precoLiquidacao = null`, distância `null`, estado `LIQUIDACAO_INATINGIVEL`.
3. **Precedência:** `Equity ≤ Limite` → `LIQUIDACAO` (absoluta, inclui posição
   que já nasce liquidada). `distancia ≤ 0` com equity acima do limite é
   inconsistência interna → `FATAL_10`, nunca estado silencioso.
4. **Funding (semântica B):** custo de posição já existente que corrói a equity;
   nunca invalida retroativamente via `FATAL_09` (que dispara só com `M > saldo`).
5. **Resultado da equity ≠ PnL:** PnL > 0 com resultado < 0 é válido (funding
   supera o ganho). UI exibe `+12%` como ganho, nunca "perda de −12%".
6. **Sem arredondamento** no motor (`toFixed` só na UI). Sem rede, sem estado,
   sem `fetch`/WebSocket/DOM no motor. Não usar fórmulas de Binance/Bybit/OKX.

### Estados de risco

`SEGURO` (distância > 10%) · `ATENCAO` (5–10%) · `CRITICO` (0–5%) ·
`LIQUIDACAO` (equity ≤ limite) · `LIQUIDACAO_INATINGIVEL` (sem Pliq positivo).

### Erros (fail-fast, nesta ordem)

`FATAL_01` ordem inválida · `FATAL_02` lista vazia · `FATAL_03` moeda incompatível ·
`FATAL_04` saldo · `FATAL_05` alavancagem < 1 · `FATAL_06` preço atual ·
`FATAL_07` funding < 0 · `FATAL_08` mmr fora de [0,1) · `FATAL_09` margem > saldo ·
`FATAL_10` resultado não finito / inconsistência interna.

---

## 3. Referência da API

### `RiskEngine.calcularRisco(input): ResultadoRisco`

```javascript
// Browser (scripts inclusos via <script>): window.RiskEngine.calcularRisco(...)
// Node: const { calcularRisco } = require("assets/js/risk-engine/risk-engine.js");
const r = RiskEngine.calcularRisco({
  moedaConta: "USD",
  saldoCorretora: 30000,
  alavancagem: 10,
  ordens: [{ moeda: "USD", preco: 60000, valor: 60000 }],
  precoAtual: 66000,          // fornecido pela camada de market data
  fundingCustoAcumulado: 0,   // opcional, default 0
  mmr: 0,                     // opcional, default 0
  lado: "LONG",               // "LONG" | "SHORT"
});
if (!r.sucesso) {
  // r.codigoErro: "FATAL_01"..."FATAL_10"; r.mensagem: texto
} else {
  // r.quantidadeAtivo, r.valorExposicao, r.precoMedio,
  // r.margemRetida, r.margemLivre, r.saldoInicial,
  // r.fundingCustoAcumulado, r.pnlNaoRealizado, r.equityAtual,
  // r.equityLiquidacao, r.precoLiquidacao (number|null),
  // r.distanciaLiquidacaoPercentual (number|null),
  // r.resultadoEquityPercentual, r.estadoRisco, r.lado
}
```

Exemplo: entrada acima → `Pliq 30000`, `PnL +6000`, `equity 36000`, `SEGURO`.

### `RiskEngineAdapter` — `risk-engine-adapter.js`

```javascript
RiskEngineAdapter.configure({ simbolo: "BTC", /* + mesmos campos do input */ });
RiskEngineAdapter.attach();                       // ouve o ticker p/ o símbolo
RiskEngineAdapter.onResult((resultado) => { /* ResultadoRisco */ });
RiskEngineAdapter.updateRiskPrice(preco);         // chamada direta (qualquer fonte)
RiskEngineAdapter.getLastResult();                // último resultado (cache leitura)
RiskEngineAdapter.getLastPrice();
RiskEngineAdapter.detach();
```

Eventos: assina `estudebitcoin:ticker-price`; emite `riskengine:result`.
Sem parâmetros configurados, `updateRiskPrice` retorna `null` (sem inventar FATAL).

### `RiskEnginePanel.buildViewModel(resultado)` — `risk-engine-panel.js`

Mapeamento 1:1 `resultado.*` → view-model (§9 da especificação).
Em falha retorna `{ ok: false, codigo, mensagem }` sem tocar campos de sucesso.

---

## 4. Integração com o ticker

`assets/js/ticker-widget.js`, em `updateLivePrice()` (única alteração, +9 linhas
aditivas, mesmo padrão `CustomEvent` já usado no arquivo):

```javascript
window.dispatchEvent(new CustomEvent("estudebitcoin:ticker-price",
  { detail: { symbol: symbol, price: price } }));
```

Garantias: nenhum segundo WebSocket/polling/fetch (adapter e painel contêm zero
dessas primitivas); broadcast em `try/catch` — nunca quebra o ticker.

## 5. Painel ao vivo (`index.html` → `#re-painel`)

Seção "Posição ao Vivo — Risk Engine" após o simulador legado. Inputs: ativo do
ticker (BTC/ETH/SOL/LINK/AVAX/RENDER/PAXG), lado, saldo, alavancagem, preço de
entrada, valor, MMR, funding. Saídas: preço atual, quantidade, preço médio,
margens, PnL, equity, liquidação, distância, resultado da equity, estado
(colorido por `data-estado`) e caixa de erro `FATAL_*` (`#re-erro`).

## 6. O que NÃO foi integrado (decisão registrada)

A calculadora legada (`calculadora-liquidacao-dca/`, bundle React fechado) **não
expõe API, bridge, evento ou global** (auditado: `dispatchEvent`/`postMessage`
são internals do React; preço via polling próprio fechado). Por isso foi criada
a camada visual nova em vez de desmontar o bundle. Intocados: Worker, AlertEngine,
Push, `dynamicSR.js`, bundle legado.

---

## 7. Testes

```text
node --test assets/js/risk-engine/risk-engine.test.mjs               # 60 (FATAL, cálculos, fronteiras, invariantes)
node --test assets/js/risk-engine/risk-engine.integration.test.mjs   # 5  (cadeia preço→LIQUIDACAO, realtime)
node --test assets/js/risk-engine/risk-engine-adapter.test.mjs       # 7  (§9, §11–§14 via adapter)
node --test assets/js/risk-engine/risk-engine-chain.test.mjs         # 3  (evento→adapter→motor→view-model)
npx typescript -p assets/js/risk-engine/tsconfig.json --noEmit       # strict PASS
node --check assets/js/risk-engine/*.js assets/js/ticker-widget.js   # syntax PASS
```

Validação em browser real (Chrome via CDP): 20 ticks BTC reais → painel
(`$79.812 / Pliq $30.000 / PnL +$19.812 / SEGURO`), LONG/SHORT direcionais,
alavancagem 2–50x com Pliq único, `FATAL_04` na UI, liquidação com preço real,
reload sem duplicação de WS.

## 8. Arquivos

```text
assets/js/risk-engine/
  risk-engine.ts                  fonte da verdade (TS strict, documentada)
  risk-engine.js                  build JS puro (browser global + Node)
  risk-engine.d.ts                tipos
  risk-engine-adapter.js          glue ticker → motor
  risk-engine-panel.js            view-model + binding DOM
  risk-engine.test.mjs            60 testes unitários
  risk-engine.integration.test.mjs 5 testes de cadeia/tempo real
  risk-engine-adapter.test.mjs    7 testes (§9–§14)
  risk-engine-chain.test.mjs      3 testes evento→motor→painel
  tsconfig.json                   strict:true
index.html                        seção #re-painel + 3 <script>
assets/js/ticker-widget.js        dispatch "estudebitcoin:ticker-price" (+9 linhas)
```

## 9. Deploy

Commit `63e72cf` na `main` → Cloudflare Pages publica `estudebitcoin.pages.dev`
automaticamente. Verificação pós-deploy: `GET /assets/js/risk-engine/risk-engine.js`
→ 200; painel responde a ticks ao vivo.
