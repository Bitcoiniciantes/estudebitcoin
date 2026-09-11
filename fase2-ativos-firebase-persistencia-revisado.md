# FASE 2 — Persistência por Login (Firebase)
## Documento de Referência Técnica — Minha Carteira

> STATUS: CANÔNICO — 2026-09-11
> PIVOT PRODUÇÃO (2026-09-11, custo zero): por bloqueio de Blaze para
> Firestore/Functions novos, a implementação em produção usa o RTDB
> EXISTENTE do Mural (`users/{uid}/carteira`, ramo colado nas regras em
> 2026-09-11 e verificado campo a campo). Mesma interface e mesmas regras
> de negócio desta spec; adaptador em `assets/js/portfolio/firebasePortfolio.js`,
> testes em `test-rtdb-portfolio.mjs` (15 PASS). O desenho Firestore/Functions
> abaixo permanece como referência de evolução.
> PIVOT RTDB (custo zero) — 2026-09-11: Firestore/Functions viraram apêndice
> futuro. A Fase 2 usa o RTDB EXISTENTE do Mural (`mural-bitcoiniciantes`,
> Spark), ramo novo `users/{uid}/carteira` ao lado de `panels/`. Nenhum banco
> novo, nenhum Blaze, nenhum cartão. Escritas via transação client-side na
> raiz `carteira` (atômica, com retry do SDK); validação nas RTDB Rules
> (`database-carteira-branch.json`). Lógica em `assets/js/portfolio/
> firebasePortfolio.js` (mesma interface: load/add/update/remove/removeLot/
> migrateLocal). Testes: `test-rtdb-portfolio.mjs` (13 PASS).
> REVISÃO TÉCNICA CONSOLIDADA — 2026-09-11
> Documento consolidado após revisão das rodadas anteriores.
> As decisões de venda, zeramento, reconstrução, hífen, migração e UX descritas
> abaixo são normativas para a implementação da Fase 2.

--------------------------------------------------
## 1. VISÃO GERAL DA FASE 2
--------------------------------------------------

Objetivo: migrar a persistência da "Minha Carteira" de `localStorage` / dados
de exemplo para persistência real por usuário autenticado, usando Firebase
Auth + Firestore + Cloud Functions.

Arquitetura definida para esta fase:

- Firebase Auth continua sendo a autoridade sobre identidade e sessão.
- Firestore será o banco da "Minha Carteira".
- RTDB existente continua sendo usado pelos módulos que já utilizam
  `PanelSync` (`risk` e `sim`).
- Não migrar `risk`/`sim` para Firestore nesta fase.
- Toda escrita de `assets` e `lots` passa por Cloud Function callable.
- O frontend nunca grava diretamente `assets` ou `lots`.
- `PortfolioService` passa de síncrono para assíncrono.
- O cálculo efetivo de posição/preço médio que grava no banco existe somente
  no backend.
- Cada ativo é um documento independente.
- Cada aporte é um `lot`.
- Venda é um aporte com `quantity` negativa, na mesma callable
  (`adicionarOuConsolidarAtivo`) — sem função nova para vender.
- Venda de ativo inexistente ou além do saldo é rejeitada (erro, sem escrita).
- Venda reduz a quantidade sem alterar o preço médio de aquisição.
- Posição zerada por venda NÃO apaga o histórico: o asset permanece com
  `quantity: 0` + `closedAt`, e os `lots` são preservados (auditoria e base
  para futuro P&L realizado/IR). Exclusão física só via `removerAtivo`.
- Lote de venda registra o `avgPrice` vigente na época (base futura para
  P&L realizado; o cálculo de realizado está fora do escopo desta fase).
- O schema já nasce preparado para a Fase 3 (cotação automática).
- O modo anônimo continua funcionando e pode ser vinculado a uma conta real
  preservando o mesmo UID e os dados existentes.
- Não criar um segundo sistema de autenticação paralelo ao `EstudeAuth`
  existente.

Princípio fundamental:

> RTDB e Firestore podem coexistir no projeto, mas cada dado deve ter uma
> única fonte de verdade. `risk`/`sim` continuam no RTDB; Minha Carteira
> pertence ao Firestore.

--------------------------------------------------
## 2. ESTRUTURA DO FIRESTORE
--------------------------------------------------

```text
users (collection)
 └── {userId} (document)
      ├── displayName: string
      ├── currency: string
      ├── createdAt: timestamp
      ├── localMigrationCompleted: boolean
      ├── localMigrationAt: timestamp
      │
      └── assets (subcollection)
           └── {assetId} (document)
                ├── ticker: string
                ├── name: string
                ├── type: "crypto" | "stock"
                ├── quantity: number
                ├── avgPrice: number
                ├── manualPrice: number
                ├── currentPrice: number
                ├── priceSource: "manual" | "api"
                ├── dailyChangePercent: number
                 ├── createdAt: timestamp
                 ├── updatedAt: timestamp
                 ├── closedAt: timestamp            // só em posição zerada
                 │
                 └── lots (subcollection)
                      └── {lotId} (document)
                           ├── quantity: number    // negativo em vendas
                           ├── price: number       // preço de execução
                           ├── avgPrice: number    // só em lotes de venda: custo vigente na época
                           └── date: timestamp
```

A estrutura `users/{uid}` é um documento único com os campos de perfil e de
controle de migração diretamente no documento. Não existe subdocumento
`profile` nesta fase.

### 2.1 Identificação do ativo

`assetId` = ticker normalizado. Barras viram hífen (o Firestore não aceita
`/` em ID de documento).

Exemplos:

```text
btc      → BTC
BTC      → BTC
petr4    → PETR4
BTC/USD  → BTC-USD
```

Função:

```javascript
function normalizarTicker(ticker) {
  return String(ticker || "")
    .trim()
    .toUpperCase()
    .replace(/\//g, "-");
}
```

Regra de colisão: `BTC/USD` e `BTC-USD` colapsam para o mesmo documento —
por definição são o mesmo ativo. Na migração, duplicados após normalização
são rejeitados; em aporte, o ID igual consolida (comportamento esperado).

O ticker normalizado deve ser usado tanto no frontend quanto nas Cloud
Functions — incluindo o `normTicker` da Fase 1, que precisa ganhar o mesmo
`.replace(/\//g, "-")` para o preview local não divergir do backend.

Não utilizar:

```javascript
assetsRef.add(...)
```

para ativos.

A referência será direta:

```javascript
const assetRef = db
  .collection("users")
  .doc(uid)
  .collection("assets")
  .doc(normalizarTicker(ticker));
```

Isso elimina a necessidade de consultar `.where("ticker", "==", ticker)`
para descobrir se o ativo já existe.

--------------------------------------------------
## 2.2 Normalização de tipo
--------------------------------------------------

O Firestore armazenará exclusivamente:

```text
crypto
stock
```

A entrada pode vir como:

```text
crypto
CRYPTO
Crypto
stock
STOCK
Stock
```

e deverá ser normalizada no backend:

```javascript
function normalizarTipo(type) {
  const valor = String(type || "").trim().toLowerCase();

  if (valor === "crypto") return "crypto";
  if (valor === "stock") return "stock";

  return null;
}
```

A normalização é obrigatória porque a Fase 1 pode conter valores
`"CRYPTO"` / `"STOCK"`.

--------------------------------------------------
## 2.3 Moeda da carteira
--------------------------------------------------

A carteira da Fase 1 utiliza USD.

Portanto, a migração deve preservar a moeda existente no portfolio local.

Exemplo:

```text
currency = "USD"
```

A implementação não deve converter valores automaticamente durante a
migração.

Se futuramente a carteira permitir BRL, EUR ou outra moeda, o campo
`currency` será alterado explicitamente pelo usuário ou pela configuração
da carteira.

Nunca assumir BRL simplesmente porque o usuário está no Brasil.

--------------------------------------------------
## 2.4 Por que `isAnonymous` NÃO está no Firestore
--------------------------------------------------

`isAnonymous` já existe de forma autoritativa no Firebase Auth.

Client:

```javascript
auth.currentUser.isAnonymous
```

Backend:

```javascript
context.auth.token.firebase.sign_in_provider
```

Não duplicar esse estado no Firestore.

Isso evita inconsistência entre Auth e banco.

--------------------------------------------------
## 3. REGRAS DE SEGURANÇA — FIRESTORE
--------------------------------------------------

Arquivo:

```text
firestore.rules
```

A arquitetura definida é:

- client pode ler `users/{uid}`;
- client pode ler `assets`;
- client pode ler `lots`;
- client NÃO pode escrever `assets`;
- client NÃO pode escrever `lots`;
- escrita de carteira ocorre exclusivamente por Cloud Functions;
- Admin SDK ignora Firestore Rules, portanto toda Cloud Function precisa
  validar explicitamente sua entrada.

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    function isOwner(userId) {
      return request.auth != null
        && request.auth.uid == userId;
    }

    match /users/{userId} {

      allow read: if isOwner(userId);

      // Manter esta lista atualizada: qualquer novo campo de perfil que o client
      // possa alterar precisa ser incluído explicitamente aqui. Campos de migração
      // permanecem protegidos. Esta é uma escolha deliberada de simplicidade e
      // segurança; não criar regra genérica para campos futuros nesta fase.
      allow create: if isOwner(userId)
                    && request.resource.data.keys().hasOnly([
                      "displayName",
                      "currency",
                      "createdAt"
                    ]);

      allow update: if isOwner(userId)
                    && request.resource.data.diff(resource.data)
                         .affectedKeys()
                         .hasOnly(["displayName", "currency"]);

      allow delete: if false;

      match /assets/{assetId} {

        allow read: if isOwner(userId);

        allow write: if false;

        match /lots/{lotId} {

          allow read: if isOwner(userId);

          allow write: if false;
        }
      }
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

### Integridade do documento `users/{uid}`

O client pode ler o documento do usuário, mas não pode alterar os campos de
controle da migração. `localMigrationCompleted` e `localMigrationAt` são
escritos somente pela Cloud Function `migrarCarteiraLocal`.

Se o client precisar atualizar preferências de perfil, a Rule deve limitar a
escrita aos campos explicitamente permitidos (`displayName` e `currency`).
Os demais campos do documento do usuário permanecem protegidos.

A Cloud Function usa Admin SDK e continua responsável por qualquer escrita de
`localMigrationCompleted`/`localMigrationAt`.

### Regra fundamental

Nunca usar:

```javascript
allow read, write: if true;
```

em produção.

As Rules não são uma segunda camada de validação das Cloud Functions.

A Cloud Function usa Admin SDK e, portanto, precisa validar:

- autenticação;
- ticker;
- tipo;
- quantidade;
- preço;
- campos permitidos;
- consistência da operação.

--------------------------------------------------
## 4. AUTENTICAÇÃO
--------------------------------------------------

### 4.1 Reaproveitar o `EstudeAuth` existente

O projeto já possui:

```text
window.EstudeAuth
PanelSync
auth.js
```

A Fase 2 NÃO deve criar um segundo sistema independente de autenticação.

Não criar:

```javascript
initializeApp(...)
getAuth(...)
onAuthStateChanged(...)
signInAnonymously(...)
```

em um novo módulo se o `auth.js` existente já inicializa e administra a
sessão.

A implementação deve:

1. reutilizar a instância de Auth existente;
2. reutilizar o fluxo atual de login/modal;
3. estender o `EstudeAuth`, se necessário, para suportar sessão anônima;
4. expor o usuário autenticado para o `PortfolioService`;
5. preservar o comportamento atual de `PanelSync`.

A carteira deve reagir ao mesmo usuário autenticado que o restante do site.

Não podem existir dois listeners independentes criando sessões anônimas.

### 4.2 Login anônimo → conta real

O comportamento desejado é:

```text
visitante
   ↓
sessão anônima
   ↓
carteira funcionando
   ↓
usuário cria conta
   ↓
link da credencial
   ↓
mesmo UID
   ↓
mesmos dados Firestore
```

Email/senha:

```javascript
async function vincularConta(email, password) {
  const credential =
    EmailAuthProvider.credential(email, password);

  const result = await linkWithCredential(
    auth.currentUser,
    credential
  );

  return result.user;
}
```

Google:

```javascript
async function vincularComGoogle() {
  const provider = new GoogleAuthProvider();

  const result = await linkWithPopup(
    auth.currentUser,
    provider
  );

  return result.user;
}
```

A implementação deve tratar também erros de credencial já vinculada,
conta existente e sessão não anônima.

--------------------------------------------------
## 5. PORTFOLIOSERVICE — MIGRAÇÃO PARA ASYNC
--------------------------------------------------

O `PortfolioService` atual é síncrono.

Isso não será mantido como contrato.

Com backend remoto, a interface passa a ser assíncrona.

### Interface definida

```javascript
PortfolioService.load()
PortfolioService.add(asset)
PortfolioService.update(assetId, changes)
PortfolioService.remove(assetId)
```

Todos retornam `Promise`.

Exemplo conceitual:

```javascript
const assets = await portfolioService.load();

await portfolioService.add(asset);

await portfolioService.update(assetId, changes);

await portfolioService.remove(assetId);
```

Não criar um adapter falso que finja ser síncrono.

Não utilizar `localStorage` como segunda fonte de verdade da carteira depois
da migração.

### 5.1 Responsabilidades

`PortfolioService`:

- conhece a interface da carteira;
- conhece o usuário atual;
- chama as Cloud Functions;
- lê Firestore;
- transforma os dados para o formato esperado pela UI;
- não calcula novamente o preço médio oficial.

A Cloud Function:

- valida;
- calcula;
- grava;
- retorna o estado autoritativo.

--------------------------------------------------
## 6. LEITURA DA CARTEIRA
--------------------------------------------------

A leitura dos ativos será feita diretamente no Firestore.

Exemplo:

```javascript
const assetsRef = collection(
  db,
  "users",
  uid,
  "assets"
);

const snapshot = await getDocs(assetsRef);

const assets = snapshot.docs.map(doc => ({
  id: doc.id,
  ...doc.data()
}));
```

Com poucos ativos, filtro e ordenação podem continuar sendo feitos no client.

Não é necessário criar consultas complexas apenas para ordenar uma carteira
pessoal.

Não usar `onSnapshot` por padrão.

A carteira será carregada:

- no login;
- após uma operação de escrita bem-sucedida;
- quando o usuário solicitar atualização.

--------------------------------------------------
## 7. ESCRITA — CLOUD FUNCTIONS
--------------------------------------------------

Toda escrita em:

```text
users/{uid}/assets/{assetId}
users/{uid}/assets/{assetId}/lots/{lotId}
```

deve passar por Cloud Function callable.

Funções previstas:

```text
adicionarOuConsolidarAtivo
atualizarAtivo
removerAtivo
removerLote
migrarCarteiraLocal
```

A função de `removerLote` fica preparada para permitir futuramente desfazer
um aporte específico mantendo os demais lotes.

--------------------------------------------------
## 8. MÓDULO COMPARTILHADO DAS FUNCTIONS
--------------------------------------------------

Não duplicar `normalizarTicker`, `normalizarTipo`, validações ou cálculo em
vários arquivos.

Estrutura recomendada:

```text
functions/
 ├── index.js
 └── carteira/
      ├── normalizacao.js
      ├── validacao.js
      └── calculos.js
```

Exemplo:

```javascript
// carteira/normalizacao.js

function normalizarTicker(ticker) {
  return String(ticker || "")
    .trim()
    .toUpperCase()
    .replace(/\//g, "-");
}

function normalizarTipo(type) {
  const valor = String(type || "").trim().toLowerCase();

  if (valor === "crypto") return "crypto";
  if (valor === "stock") return "stock";

  return null;
}

module.exports = {
  normalizarTicker,
  normalizarTipo
};
```

--------------------------------------------------
## 9. CÁLCULO CENTRAL — PREÇO MÉDIO
--------------------------------------------------

O cálculo efetivo de consolidação existe somente no backend.

A entrada de um novo aporte usa:

```text
purchasePrice
```

O documento consolidado usa:

```text
avgPrice
```

Nunca usar `avgPrice` como nome do preço pago em um novo aporte.

### Fórmula

```javascript
// aporte.quantity pode ser negativo (VENDA). Compra recalcula o médio;
// venda desconta a quantidade mantendo o custo de aquisição intacto.
function consolidarPosicao(posicaoExistente, aporte) {
  const qtdExistente = posicaoExistente.quantity;
  const qtdMovimento = aporte.quantity;

  const novaQuantidade =
    qtdExistente + qtdMovimento;

  if (novaQuantidade < 0) {
    throw new Error(
      "Saldo insuficiente: a venda supera a quantidade em carteira."
    );
  }

  let novoAvgPrice;

  if (qtdMovimento > 0) {
    // COMPRA: médio ponderado.
    const custoExistente =
      qtdExistente * posicaoExistente.avgPrice;
    const custoNovo =
      qtdMovimento * aporte.purchasePrice;
    novoAvgPrice =
      (custoExistente + custoNovo) /
      novaQuantidade;
  } else {
    // VENDA: custo de aquisição intacto. Se zerou, o chamador fecha
    // a posição (quantity 0 + closedAt, lots preservados) — ver §11.
    novoAvgPrice =
      novaQuantidade === 0
        ? 0
        : posicaoExistente.avgPrice;
  }

  return {
    quantity: novaQuantidade,

    avgPrice: novoAvgPrice,

    currentPrice: aporte.currentPrice,

    manualPrice: aporte.currentPrice,

    dailyChangePercent:
      aporte.dailyChangePercent
  };
}
```

O frontend pode apresentar estimativas visuais, mas não pode gravar o
resultado estimado como verdade.

O preview de merge da UI usa o `previewMerge` local (matemática pura da
Fase 1) rotulado como estimativa; o valor gravado vem exclusivamente da
resposta da callable.

--------------------------------------------------
## 10. VALIDAÇÃO DE APORTE
--------------------------------------------------

A validação deve aceitar os formatos existentes na Fase 1 e normalizá-los.

```javascript
function validarEntradaAporte(data) {
  const erros = [];

  const ticker =
    normalizarTicker(data.ticker);

  const type =
    normalizarTipo(data.type);

  if (!ticker) {
    erros.push("ticker inválido");
  }

  if (
    typeof data.name !== "string" ||
    data.name.trim().length === 0
  ) {
    erros.push("name inválido");
  }

  if (!type) {
    erros.push("type inválido: use crypto ou stock");
  }

  if (
    typeof data.quantity !== "number" ||
    !Number.isFinite(data.quantity) ||
    data.quantity === 0
  ) {
    erros.push(
      "quantity deve ser um número finito diferente de zero " +
      "(positivo = compra, negativo = venda)"
    );
  }

  if (
    typeof data.purchasePrice !== "number" ||
    !Number.isFinite(data.purchasePrice) ||
    data.purchasePrice < 0
  ) {
    erros.push(
      "purchasePrice deve ser um número finito maior ou igual a zero"
    );
  }

  if (
    typeof data.currentPrice !== "number" ||
    !Number.isFinite(data.currentPrice) ||
    data.currentPrice < 0
  ) {
    erros.push(
      "currentPrice deve ser um número finito maior ou igual a zero"
    );
  }

  const dailyChangePercent =
    data.dailyChangePercent == null
      ? 0
      : Number(data.dailyChangePercent);

  if (!Number.isFinite(dailyChangePercent)) {
    erros.push(
      "dailyChangePercent deve ser um número finito"
    );
  }

  return {
    ticker,
    type,
    dailyChangePercent,
    erros
  };
}
```

`dailyChangePercent` será normalizado para `0` quando não fornecido.

Nunca enviar `undefined` ao Firestore.

--------------------------------------------------
## 11. ADICIONAR / CONSOLIDAR ATIVO
--------------------------------------------------

Callable:

```text
adicionarOuConsolidarAtivo
```

Entrada:

```javascript
{
  ticker,
  name,
  type,
  quantity,
  purchasePrice,
  currentPrice,
  dailyChangePercent
}
```

Comportamento:

### Ativo inexistente

Venda de ativo inexistente é rejeitada (`failed-precondition`), sem escrita.

Compra cria:

```text
quantity = quantidade do aporte
avgPrice = purchasePrice
```

e cria o primeiro `lot`.

### Ativo existente

Calcula:

```text
novo custo total
nova quantidade
novo preço médio
```

e atualiza o documento.

Depois cria o `lot` correspondente.

Asset + lot devem ser gravados na mesma transação.

Exemplo:

```javascript
exports.adicionarOuConsolidarAtivo =
  functions.https.onCall(async (data, context) => {

    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Login necessário."
      );
    }

    const validacao =
      validarEntradaAporte(data);

    if (validacao.erros.length > 0) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        validacao.erros.join("; ")
      );
    }

    const uid = context.auth.uid;

    const {
      ticker,
      type,
      dailyChangePercent
    } = validacao;

    const {
      name,
      quantity,
      purchasePrice,
      currentPrice
    } = data;

    const db = admin.firestore();

    const assetRef = db
      .collection("users")
      .doc(uid)
      .collection("assets")
      .doc(ticker);

    const resultado = await db.runTransaction(
      async (tx) => {

        const snapshot =
          await tx.get(assetRef);

        const lotRef =
          assetRef.collection("lots").doc();

        let novoEstado;

        if (!snapshot.exists) {

          if (quantity < 0) {
            throw new functions.https.HttpsError(
              "failed-precondition",
              "Não é possível vender um ativo inexistente."
            );
          }

          novoEstado = {
            ticker,
            name: name.trim(),
            type,
            quantity,
            avgPrice: purchasePrice,
            manualPrice: currentPrice,
            currentPrice,
            priceSource: "manual",
            dailyChangePercent,
            createdAt:
              admin.firestore.FieldValue.serverTimestamp(),
            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          };

          tx.set(assetRef, novoEstado);
          tx.set(lotRef, {
            quantity,
            price: purchasePrice,
            date:
              admin.firestore.FieldValue.serverTimestamp()
          });

          return {
            ...novoEstado,
            action: "created"
          };

        } else {

          let consolidado;

          try {
            consolidado =
              consolidarPosicao(
                snapshot.data(),
                {
                  quantity,
                  purchasePrice,
                  currentPrice,
                  dailyChangePercent
                }
              );
          } catch (err) {
            throw new functions.https.HttpsError(
              "failed-precondition",
              err.message
            );
          }

          if (consolidado.quantity === 0) {
            // Zeramento por venda: FECHA a posição, não apaga.
            // Asset fica com quantity 0 + closedAt; lots preservados
            // (auditoria e base futura de P&L realizado/IR).
            tx.update(assetRef, {
              quantity: 0,
              avgPrice: 0,
              currentPrice,
              manualPrice: currentPrice,
              dailyChangePercent,
              closedAt:
                admin.firestore.FieldValue.serverTimestamp(),
              updatedAt:
                admin.firestore.FieldValue.serverTimestamp()
            });
            // Lote de venda guarda o custo vigente na época.
            tx.set(lotRef, {
              quantity,
              price: purchasePrice,
              avgPrice: snapshot.data().avgPrice,
              date:
                admin.firestore.FieldValue.serverTimestamp()
            });
            return {
              action: "closed",
              quantity: 0
            };
          }

          novoEstado = {
            ...consolidado,
            name: name.trim(),
            type,
            closedAt:
              admin.firestore.FieldValue.delete(),
            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          };

          tx.update(assetRef, novoEstado);
        }

        // Lote do movimento. Vendas carregam o custo vigente na época
        // (base futura para P&L realizado); compras não precisam.
        const lote = {
          quantity,
          price: purchasePrice,
          date:
            admin.firestore.FieldValue.serverTimestamp()
        };

        if (quantity < 0) {
          lote.avgPrice = snapshot.data().avgPrice;
        }

        tx.set(lotRef, lote);

        // O ramo de criação já retornou acima com action "created".
        return {
          ...novoEstado,
          action:
            quantity < 0 ? "sold" : "updated"
        };
      }
    );

    if (resultado.action === "closed") {
      return {
        status: "ok",
        ticker,
        action: "closed",
        quantity: 0
      };
    }

    return {
      status: "ok",
      ticker,
      action: resultado.action,
      quantity: resultado.quantity,
      avgPrice: resultado.avgPrice
    };
  });
}
```

--------------------------------------------------
## 12. EDITAR ATIVO
--------------------------------------------------

Callable:

```text
atualizarAtivo
```

### Regra importante

`quantity` e `avgPrice` não são campos livremente editáveis pelo client.

Eles são derivados dos `lots`.

Portanto, `atualizarAtivo` altera somente campos cadastrais e de cotação:

```text
name
type
manualPrice
currentPrice
priceSource
dailyChangePercent
```

Não aceitar:

```text
quantity
avgPrice
```

como valores arbitrários enviados pelo frontend.

Isso evita que o documento consolidado fique diferente dos lotes.

`atualizarAtivo` não usa transação nesta fase. A política definida para seus
campos cadastrais/de cotação é **last-writer-wins**: a última atualização aceita
substitui a anterior. Essa função não altera `quantity`, `avgPrice` ou `lots`.

Exemplo:

```javascript
exports.atualizarAtivo =
  functions.https.onCall(async (data, context) => {

    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Login necessário."
      );
    }

    const uid = context.auth.uid;
    const ticker =
      normalizarTicker(data.ticker);

    const type =
      normalizarTipo(data.type);

    if (!ticker) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "ticker inválido."
      );
    }

    if (
      typeof data.name !== "string" ||
      data.name.trim().length === 0
    ) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "name inválido."
      );
    }

    if (!type) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "type inválido."
      );
    }

    const currentPrice =
      Number(data.currentPrice);

    const manualPrice =
      Number(data.manualPrice);

    const dailyChangePercent =
      data.dailyChangePercent == null
        ? 0
        : Number(data.dailyChangePercent);

    if (!Number.isFinite(currentPrice) ||
        currentPrice < 0) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "currentPrice inválido."
      );
    }

    if (!Number.isFinite(manualPrice) ||
        manualPrice < 0) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "manualPrice inválido."
      );
    }

    if (!Number.isFinite(dailyChangePercent)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "dailyChangePercent inválido."
      );
    }

    // Fase 2 usa somente preço manual. "api" fica reservado à Fase 3.
    if (data.priceSource !== "manual") {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "priceSource inválido: na Fase 2 use apenas manual."
      );
    }

    const db = admin.firestore();

    const assetRef = db
      .collection("users")
      .doc(uid)
      .collection("assets")
      .doc(ticker);

    const snapshot =
      await assetRef.get();

    if (!snapshot.exists) {
      throw new functions.https.HttpsError(
        "not-found",
        "Ativo não encontrado."
      );
    }

    await assetRef.update({
      name: data.name.trim(),
      type,
      manualPrice,
      currentPrice,
      priceSource: data.priceSource,
      dailyChangePercent,
      updatedAt:
        admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      status: "ok",
      ticker
    };
  });
```

### Correção de quantidade/preço de custo

Se no futuro a UI precisar corrigir quantidade ou custo de um lote, isso deve
ser feito através de uma operação específica sobre `lots`, nunca sobrescrevendo
diretamente `asset.quantity` ou `asset.avgPrice`.

Mapeamento com a UX da Fase 1: o botão "Editar" da tabela passa a alterar
somente cadastro e cotação (via `atualizarAtivo`). Corrigir quantidade ou
custo = `removerLote` do lote errado + novo aporte correto (via
`adicionarOuConsolidarAtivo`). Não existe "editar lote" nesta fase. Como a correção é uma sequência de duas
operações, a UI deve executar a segunda somente após confirmar o sucesso da
primeira e tratar explicitamente falha/rollback visual; não fazer as duas em
paralelo.

--------------------------------------------------
## 13. REMOVER LOTE
 --------------------------------------------------

 Callable:

 ```text
 removerLote
 ```

 Assinatura:

 ```text
 removerLote({ ticker, lotId })
 ```

 Objetivo:

- excluir um aporte específico;
- recalcular a posição a partir dos lotes restantes;
- manter `asset.quantity` e `asset.avgPrice` consistentes.

Função de reconstrução (única definição válida — lotes de venda existem
nesta fase, então o médio sai SOMENTE dos lotes positivos):

```javascript
function reconstruirPosicaoDosLotes(lotes) {

  // Quantidade soma com sinal (vendas descontam).
  const quantity =
    lotes.reduce(
      (soma, lote) =>
        soma + lote.quantity,
      0
    );

  // Custo considera só compras: venda não altera custo de aquisição.
  const positivos =
    lotes.filter(
      (lote) => lote.quantity > 0
    );

  const qtdPositiva =
    positivos.reduce(
      (soma, lote) =>
        soma + lote.quantity,
      0
    );

  const custoPositivo =
    positivos.reduce(
      (soma, lote) =>
        soma + lote.quantity * lote.price,
      0
    );

  if (quantity < 0) {
    throw new Error(
      "Remoção deixaria saldo negativo."
    );
  }

  return {
    quantity,
    avgPrice:
      qtdPositiva > 0
        ? custoPositivo / qtdPositiva
        : 0,
    // Zerou: mantém fechado (closedAt), não apaga (ver §11).
    closed: quantity === 0
  };
}
```

A operação deve:

1. autenticar;
2. localizar o asset;
3. ler os lotes;
4. excluir o lote solicitado;
5. reconstruir a posição pela função acima;
6. atualizar o asset (`quantity`, `avgPrice`; `closedAt` setado se zerou,
   removido com `FieldValue.delete()` se reabriu);
7. executar tudo na mesma transação.

Assim o consolidado nunca fica divergente dos lotes.

### Esqueleto da callable

O esqueleto abaixo define o fluxo mínimo obrigatório. A implementação real deve
reutilizar os módulos de normalização/validação já definidos neste documento e
manter toda a operação dentro de uma única transação.

```javascript
exports.removerLote =
  functions.https.onCall(async (data, context) => {

    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Login necessário."
      );
    }

    const uid = context.auth.uid;
    const ticker = normalizarTicker(data.ticker);
    const lotId = typeof data.lotId === "string"
      ? data.lotId.trim()
      : "";

    if (!ticker || !lotId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "ticker e lotId são obrigatórios."
      );
    }

    const db = admin.firestore();
    const assetRef = db
      .collection("users").doc(uid)
      .collection("assets").doc(ticker);

    await db.runTransaction(async (tx) => {
      const assetSnap = await tx.get(assetRef);

      if (!assetSnap.exists) {
        throw new functions.https.HttpsError(
          "not-found",
          "Ativo não encontrado."
        );
      }

      const lotsSnap = await tx.get(
        assetRef.collection("lots")
      );
      const lotRef = assetRef.collection("lots").doc(lotId);

      if (!lotsSnap.docs.some((doc) => doc.id === lotId)) {
        throw new functions.https.HttpsError(
          "not-found",
          "Lote não encontrado."
        );
      }

      const lotesRestantes = lotsSnap.docs
        .filter((doc) => doc.id !== lotId)
        .map((doc) => doc.data());

      let reconstruida;

      try {
        reconstruida =
          reconstruirPosicaoDosLotes(lotesRestantes);
      } catch (err) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          err.message
        );
      }

      tx.delete(lotRef);

      tx.update(assetRef, {
        quantity: reconstruida.quantity,
        avgPrice: reconstruida.avgPrice,
        ...(reconstruida.closed
          ? {
              closedAt:
                admin.firestore.FieldValue.serverTimestamp()
            }
          : {
              closedAt:
                admin.firestore.FieldValue.delete()
            }),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return {
      status: "ok",
      ticker,
      lotId
    };
  });
```

Se o lote solicitado for o último e a reconstrução resultar em `quantity = 0`,
o asset permanece no Firestore com `closedAt`; não apagar o asset por causa da
remoção do último lot.

--------------------------------------------------
## 14. REMOVER ATIVO
--------------------------------------------------

Callable:

```text
removerAtivo
```

Remover um documento pai do Firestore não apaga automaticamente sua
subcoleção `lots`.

Portanto, `removerAtivo` deve:

1. autenticar;
2. localizar o asset;
3. listar todos os `lots`;
4. excluir todos os lotes;
5. excluir o asset;
6. executar as exclusões na mesma operação transacional, respeitando os
   limites do Firestore.

Exemplo conceitual:

```javascript
exports.removerAtivo =
  functions.https.onCall(async (data, context) => {

    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Login necessário."
      );
    }

    const uid = context.auth.uid;
    const ticker =
      normalizarTicker(data.ticker);

    if (!ticker) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "ticker inválido."
      );
    }

    const db = admin.firestore();

    const assetRef = db
      .collection("users")
      .doc(uid)
      .collection("assets")
      .doc(ticker);

    await db.runTransaction(async (tx) => {

      const assetSnap =
        await tx.get(assetRef);

      if (!assetSnap.exists) {
        throw new functions.https.HttpsError(
          "not-found",
          "Ativo não encontrado."
        );
      }

      const lotsSnap =
        await tx.get(
          assetRef.collection("lots")
        );

      // Limite de produto: N lots + 1 asset por transação.
      if (lotsSnap.size > 400) {
        throw new functions.https.HttpsError(
          "out-of-range",
          "Ativo com lotes demais para exclusão atômica."
        );
      }

      lotsSnap.docs.forEach((lot) => {
        tx.delete(lot.ref);
      });

      tx.delete(assetRef);
    });

    return {
      status: "ok",
      ticker
    };
  });
```

Para a carteira pessoal prevista, a quantidade de lotes deverá permanecer
muito abaixo dos limites operacionais do Firestore. A implementação deve
rejeitar a operação antes do commit se o número de exclusões ultrapassar o
limite seguro configurado para a transação; nunca fazer exclusão parcial.

--------------------------------------------------
## 15. HISTÓRICO DE APORTES
--------------------------------------------------

`lots` NÃO é opcional na Fase 2.

Cada aporte cria um lote.

Estrutura:

```text
users/{uid}/assets/{assetId}/lots/{lotId}

quantity      // negativo em vendas
price         // preço de execução do movimento
avgPrice      // só em lotes de venda: custo vigente na época
date
```

Exemplo em USD (com venda):

```text
BTC
  quantity = 1
  avgPrice = 50000

lots
  ├── lote 1 → +1 BTC @ 45000
  ├── lote 2 → +0.5 BTC @ 60000
  └── lote 3 → −0.5 BTC @ 70000 (avgPrice 50000 na época)
```

O preço médio:

```text
só sobre positivos: (1 × 45000 + 0.5 × 60000) / 1.5
= 50000   (a venda não altera o custo)
```

Posição zerada por venda mantém asset (`quantity: 0` + `closedAt`) e lots.
Exclusão física só via `removerAtivo`. P&L realizado está fora do escopo
desta fase; o `avgPrice` do lote de venda registra o custo médio vigente na
execução e serve como base para um futuro cálculo por custo médio. Este campo,
sozinho, não constitui ainda um motor fiscal/FIFO completo.

Os lotes permitem:

- reconstruir o custo de aquisição;
- desfazer aportes;
- auditoria (inclusive de posições encerradas);
- preparar relatórios futuros;
- evitar depender exclusivamente do valor consolidado.

--------------------------------------------------
## 16. MIGRAÇÃO LOCALSTORAGE → FIRESTORE
--------------------------------------------------

### 16.1 Chave correta

A Fase 1 utiliza:

```text
eb_portfolio_v2
```

Não utilizar:

```text
carteira
```

A migração deve reaproveitar a sanitização existente da Fase 1.

Exemplo:

```javascript
const raw =
  localStorage.getItem("eb_portfolio_v2");
```

Não criar uma segunda estrutura paralela de armazenamento local.

--------------------------------------------------
## 16.2 Migração em uma Cloud Function

A migração será executada por:

```text
migrarCarteiraLocal
```

O client envia todos os ativos locais em uma única chamada.

A Cloud Function:

1. autentica;
2. valida todos os itens;
3. normaliza ticker;
4. normaliza tipo;
5. verifica o estado da migração;
6. verifica se já existem ativos no Firestore;
7. executa a migração dentro de uma única transação;
8. cria assets;
9. cria os respectivos lots;
10. marca `localMigrationCompleted = true`.

Não fazer:

```javascript
for (...) {
  await adicionarOuConsolidarAtivo(...)
}
```

no client.

Isso poderia deixar a migração parcial.

--------------------------------------------------
## 16.3 Política de conflito entre dispositivos
--------------------------------------------------

A regra de produto é:

> Primeiro estado válido que migrar vence. Não existe merge automático entre
> carteiras locais de dispositivos diferentes.

Existem três situações.

### Situação A — ainda não há migração e não há ativos no Firestore

A carteira local é importada.

### Situação B — `localMigrationCompleted == true`

A migração já ocorreu.

O client descarta sua cópia local.

### Situação C — algum ticker da lista já existe no Firestore

Não fazer merge silencioso.

A verificação cobre somente os tickers enviados (não a coleção inteira):
se qualquer um deles já existir no remoto, a função retorna:

```text
status = "remote_exists"
```

sem modificar os dados. Tickers sem sobreposição importados em chamada
separada não conflitam (importação aditiva segura).

O client NÃO deve descartar automaticamente o `eb_portfolio_v2` local. Deve
informar o usuário sobre a existência da carteira remota e somente remover a
cópia local após uma ação explícita de descarte/conflito.

Isso evita a situação perigosa em que:

```text
BTC local
+
BTC remoto
=
posição inesperadamente duplicada
```

--------------------------------------------------
## 16.4 Transação de migração
--------------------------------------------------

Conceitualmente:

```text
client
  │
  └── migrarCarteiraLocal(itens[])
        │
        ▼
  Cloud Function
        │
        ├── autentica
        ├── valida todos os itens
        ├── normaliza ticker/type
        ├── lê users/{uid}
        │
        ├── se migrationCompleted:
        │       retorna already_migrated
        │
        ├── lê assets existentes
        │
        ├── se já existem assets:
        │       retorna remote_exists
        │
        ├── cria todos os assets
        ├── cria todos os lots
        ├── marca migrationCompleted = true
        │
        ▼
       COMMIT
```

Se qualquer validação ou operação falhar:

```text
NENHUMA alteração deve ser considerada concluída.
```

A transação deve ser abortada.

--------------------------------------------------
## 16.5 Código conceitual da migração
--------------------------------------------------

```javascript
exports.migrarCarteiraLocal =
  functions.https.onCall(async (data, context) => {

    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Login necessário."
      );
    }

    const uid = context.auth.uid;

    if (!Array.isArray(data.itens)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "itens deve ser um array."
      );
    }

    const itensValidados =
      data.itens.map((item) => {

        const validacao =
          validarEntradaAporte(item);

        if (validacao.erros.length > 0) {
          throw new functions.https.HttpsError(
            "invalid-argument",
            `Item "${item.ticker}": ${
              validacao.erros.join("; ")
            }`
          );
        }

        // A migração importa posições consolidadas da Fase 1, não movimentos.
        // Portanto, quantity precisa ser estritamente positiva.
        if (typeof item.quantity !== "number" ||
            !Number.isFinite(item.quantity) ||
            item.quantity <= 0) {
          throw new functions.https.HttpsError(
            "invalid-argument",
            `Item "${item.ticker}": quantity deve ser maior que zero na migração.`
          );
        }

        return {
          ...item,
          ticker: validacao.ticker,
          type: validacao.type,
          dailyChangePercent:
            validacao.dailyChangePercent
        };
      });

    // Limite de produto da Fase 2: evita transações excessivamente grandes
    // e mantém margem operacional. 200 ativos geram aproximadamente
    // 401 writes (200 assets + 200 lots + 1 atualização do usuário).
    if (itensValidados.length > 200) {
      throw new functions.https.HttpsError(
        "out-of-range",
        "A migração permite no máximo 200 ativos por operação."
      );
    }

    const tickers = new Set();

    for (const item of itensValidados) {

      if (tickers.has(item.ticker)) {
        throw new functions.https.HttpsError(
          "invalid-argument",
          `Ticker duplicado na migração: ${item.ticker}`
        );
      }

      tickers.add(item.ticker);
    }

    const db = admin.firestore();

    const userRef =
      db.collection("users").doc(uid);

    const resultado =
      await db.runTransaction(async (tx) => {

        const userSnap =
          await tx.get(userRef);

        if (
          userSnap.exists &&
          userSnap.data().localMigrationCompleted === true
        ) {
          return {
            status: "already_migrated"
          };
        }

        const assetRefs =
          itensValidados.map((item) =>
            userRef
              .collection("assets")
              .doc(item.ticker)
          );

        // Leitura em lote: um roundtrip em vez de N gets.
        const assetSnaps =
          await tx.getAll(...assetRefs);

        const existemAtivosRemotos =
          assetSnaps.some(
            (snap) => snap.exists
          );

        if (existemAtivosRemotos) {
          return {
            status: "remote_exists"
          };
        }

        itensValidados.forEach((item, index) => {

          const assetRef =
            assetRefs[index];

          const lotRef =
            assetRef
              .collection("lots")
              // ID determinístico na migração: reescrita idempotente fecha
              // a janela de duplicação em migração simultânea (ver §16.3).
              .doc("mig_" + item.ticker);

          tx.set(assetRef, {

            ticker: item.ticker,

            name:
              item.name.trim(),

            type:
              item.type,

            quantity:
              item.quantity,

            avgPrice:
              item.purchasePrice,

            manualPrice:
              item.currentPrice,

            currentPrice:
              item.currentPrice,

            priceSource:
              "manual",

            dailyChangePercent:
              item.dailyChangePercent,

            createdAt:
              admin.firestore.FieldValue.serverTimestamp(),

            updatedAt:
              admin.firestore.FieldValue.serverTimestamp()
          });

          tx.set(lotRef, {

            quantity:
              item.quantity,

            price:
              item.purchasePrice,

            date:
              admin.firestore.FieldValue.serverTimestamp()
          });
        });

        tx.set(
          userRef,
          {
            // Prioridade: moeda enviada pelo client (portfolio local) →
            // moeda já existente no remoto → padrão USD.
            // Checagem de tipo: não gravar lixo não-string no perfil.
            currency:
              typeof data.currency === "string" &&
              data.currency.trim().length > 0
                ? data.currency.trim().slice(0, 8)
                : (userSnap.exists &&
                  userSnap.data().currency
                    ? userSnap.data().currency
                    : "USD"),

            localMigrationCompleted:
              true,

            localMigrationAt:
              admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );

        return {
          status: "migrated",
          itens: itensValidados.length
        };
      });

    return resultado;
  });
```

--------------------------------------------------
## 16.6 Client da migração
--------------------------------------------------

O client deve ler:

```javascript
eb_portfolio_v2
```

e enviar os dados sanitizados.

Exemplo:

```javascript
async function migrarDadosLocaisSeNecessario() {

  const raw =
    localStorage.getItem(
      "eb_portfolio_v2"
    );

  if (!raw) {
    return null;
  }

  let state;

  try {
    state =
      JSON.parse(raw);
  } catch {
    return null;
  }

  // eb_portfolio_v2 é um objeto { version, portfolio, assets } — não um array.
  const lista =
    Array.isArray(state?.assets)
      ? state.assets
      : [];

  if (lista.length === 0) {
    return null;
  }

  // Posições zeradas não são patrimônio e seriam rejeitadas pela validação
  // (quantity > 0), travando a migração inteira por um item. Elas são ignoradas
  // somente no client, mas o usuário deve ser informado sobre isso.
  const descartados =
    lista
      .filter((a) => Number(a.quantity) <= 0)
      .map((a) => normalizarTicker(a.ticker) || String(a.ticker || "?") );

  const listaUtil =
    lista.filter(
      (a) => Number(a.quantity) > 0
    );

  if (listaUtil.length === 0) {
    if (descartados.length > 0) {
      // Exibir na UI: "N posições não migradas porque estavam zeradas: …".
      mostrarMensagemMigracao(
        `N posições não migradas porque estavam zeradas: ${descartados.join(", ")}`
      );
    }
    return null;
  }

  const migrarCarteiraLocal =
    httpsCallable(
      functions,
      "migrarCarteiraLocal"
    );

  const resultado =
    await migrarCarteiraLocal({
      currency:
        state.portfolio?.currency,
      itens: listaUtil.map((ativo) => ({
        ticker: ativo.ticker,
        name: ativo.name,
        type: ativo.type,
        quantity: Number(ativo.quantity) || 0,

        // Fase 1 possui preço médio consolidado em `averagePrice`.
        // Na migração ele representa o custo do lote inicial.
        purchasePrice:
          Number(ativo.averagePrice) || 0,

        currentPrice:
          Number(ativo.currentPrice) || 0,

        dailyChangePercent:
          Number(ativo.dailyVariation ?? 0)
      }))
    });

  const status =
    resultado.data?.status;

  if (
    status === "migrated" ||
    status === "already_migrated"
  ) {
    localStorage.removeItem(
      "eb_portfolio_v2"
    );
  }

  if (status === "remote_exists") {
    // Não apagar silenciosamente uma carteira local que não foi migrada.
    // A UI deve obrigatoriamente apresentar o conflito e pedir ação explícita.
    const descartar = await confirmarMigracaoRemota(
      "Já existe carteira remota. Deseja descartar a cópia local?"
    );

    if (descartar) {
      localStorage.removeItem("eb_portfolio_v2");
    }
  }

  if (descartados.length > 0) {
    // Exibir na UI: "N posições não migradas porque estavam zeradas: …".
    mostrarMensagemMigracao(
      `N posições não migradas porque estavam zeradas: ${descartados.join(", ")}`
    );
  }

  return resultado.data;
}
```

A UI de `remote_exists` deve usar exatamente a mensagem:

```text
Já existe carteira remota. Deseja descartar a cópia local?
```

e oferecer dois botões explícitos:

```text
[Descartar cópia local] [Cancelar]
```

Cancelar mantém `eb_portfolio_v2` intacto. Não usar confirmação implícita, timeout
ou descarte automático.

A sanitização real da Fase 1 deve ser reaproveitada antes dessa transformação.

--------------------------------------------------
## 16.7 Limite operacional da migração
--------------------------------------------------

Cada ativo migrado gera aproximadamente:

```text
1 escrita do asset
1 escrita do lot
```

mais a atualização do documento do usuário.

Portanto:

```text
N ativos ≈ 2N + 1 writes
```

Uma carteira pessoal com dezenas de ativos permanece dentro do limite
operacional esperado.

A implementação deve validar a quantidade de itens antes de abrir a
transação e rejeitar uma carteira que ultrapasse o limite seguro definido
para a função. O limite deve considerar o total de writes da transação, não
apenas o número de ativos.

Não tentar suportar milhares de ativos nesta fase.

--------------------------------------------------
## 17. UI ASSÍNCRONA E ESTADOS DE OPERAÇÃO
--------------------------------------------------

A mudança de síncrono para assíncrono é parte explícita do escopo.

A UI deverá possuir estados:

```text
idle
loading
saving
success
error
```

Exemplo:

```text
Adicionando BTC...
[aguardando]

BTC adicionado.
```

Em caso de erro:

```text
Não foi possível salvar BTC.
Tente novamente.
```

### 17.1 Não criar segunda fonte de verdade para "otimismo"

Como o cálculo oficial de `avgPrice` pertence ao backend, a UI não deve
inventar um novo `avgPrice` local e tratá-lo como definitivo.

Para operações que dependem de cálculo do backend:

```text
usuário → pending
        → Cloud Function
        → resposta autoritativa
        → UI atualizada
```

Para exclusão, a UI pode remover visualmente o item imediatamente e fazer
rollback caso a operação falhe.

Para adição/consolidação, pode exibir estado pendente até receber a resposta
autoritativa.

### 17.2 Entrada de venda

Venda usa a mesma callable (`quantity` negativa) — sem tela separada de
"corretora". A UI oferece a ação (ex: aba/botão "Vender" no formulário) que
envia `quantity` negativa e exige `currentPrice` da data da venda
(`purchasePrice` recebe o preço de execução da venda). Posição zerada sai da alocação
(valor zero) mas permanece listável como encerrada (`closedAt`).

--------------------------------------------------
## 18. OFFLINE
--------------------------------------------------

Não implementar fila local de mutações na Fase 2.

Motivo:

- Cloud Functions dependem de conexão;
- uma fila local criaria uma segunda camada de persistência;
- aumentaria a complexidade;
- poderia duplicar aportes;
- exigiria controle de idempotência adicional.

Comportamento definido:

### Leitura offline

Se a persistência offline do Firestore estiver habilitada e houver cache,
a UI poderá exibir os dados disponíveis.

### Escrita offline

Operações que dependem de Cloud Function devem falhar explicitamente quando
não houver conexão.

A UI deve mostrar:

```text
Sem conexão. Não foi possível salvar a alteração.
```

Não fingir que o aporte foi salvo.

--------------------------------------------------
## 19. INTEGRAÇÃO COM O ESTADO ATUAL DO PROJETO
--------------------------------------------------

O projeto já utiliza:

```text
Firebase
RTDB
users/{uid}/panels/risk
users/{uid}/panels/sim
PanelSync
EstudeAuth
auth.js
```

A Fase 2 não deve substituir essa arquitetura.

Resultado esperado:

```text
Firebase
│
├── Authentication
│
├── RTDB
│   └── users/{uid}/panels/
│       ├── risk
│       └── sim
│
└── Firestore
    └── users/{uid}/
        ├── displayName
        ├── currency
        ├── localMigrationCompleted
        ├── localMigrationAt
        └── assets/
            ├── BTC
            │   └── lots/
            ├── ETH
            │   └── lots/
            └── ...
```

A identidade é a mesma.

O banco utilizado depende do módulo.

Não duplicar dados de risk/sim no Firestore.

Não colocar carteira no RTDB apenas para reaproveitar `PanelSync`.

--------------------------------------------------
## 20. CAMPOS PREPARADOS PARA FASE 3
--------------------------------------------------

| Campo | Fase 1/2 | Fase 3 |
|---|---|---|
| `manualPrice` | preço informado manualmente | fallback/histórico |
| `currentPrice` | preço utilizado nos cálculos | cotação da API |
| `priceSource` | `"manual"` | `"api"` |
| `dailyChangePercent` | valor manual ou `0` | valor da API |
| `updatedAt` | atualização da posição | atualização da cotação |

**Regra da Fase 2:** `priceSource` aceita somente `"manual"`. O valor `"api"` é
reservado à Fase 3 e não deve ser enviado por `atualizarAtivo` nesta fase.

Os cálculos da carteira sempre utilizam:

```text
currentPrice
```

Independentemente de sua origem.

O frontend não deve precisar saber se o preço veio da entrada manual ou da
API para calcular:

- valor atual;
- lucro/prejuízo;
- alocação.

--------------------------------------------------
## 21. TIMEZONE E VARIAÇÃO DIÁRIA
--------------------------------------------------

`updatedAt`:

```javascript
admin.firestore.FieldValue.serverTimestamp()
```

Não utilizar horário local do navegador como autoridade.

`dailyChangePercent` é salvo como valor já calculado no momento da atualização.

Não recalcular a "variação do dia" no client baseado no horário local.

--------------------------------------------------
## 22. ÍNDICES
--------------------------------------------------

Como o ativo é acessado diretamente por:

```text
users/{uid}/assets/{ticker}
```

não existe necessidade de índice para encontrar um ativo específico.

Para a carteira atual, como existem poucos ativos, a implementação pode
carregar os documentos e ordenar/filtrar no client.

Portanto, não criar índice composto preventivamente apenas por precaução.

Se futuramente surgir uma query que exija índice composto, o Firestore
normalmente fornecerá o link para criação do índice necessário.

O arquivo `firestore.indexes.json` pode permanecer sem índices específicos
até existir uma query que realmente os exija.

--------------------------------------------------
## 23. CUSTOS
--------------------------------------------------

Objetivo: permanecer dentro dos recursos gratuitos enquanto o volume for
pequeno.

Boas práticas:

- não utilizar `onSnapshot` sem necessidade;
- carregar carteira com `getDocs()`;
- atualizar após operações relevantes;
- não fazer polling da carteira;
- não criar chamadas Cloud Function por campo;
- consolidar operações quando possível;
- manter poucos documentos;
- não consultar todos os usuários no client;
- não duplicar dados;
- Fase 3 deve atualizar cotações de forma agrupada.

A carteira pessoal possui dezenas de ativos, não milhares.

Não adicionar infraestrutura de escala antes de existir necessidade real.

--------------------------------------------------
## 24. SEGURANÇA DAS CLOUD FUNCTIONS
--------------------------------------------------

Toda callable deve verificar:

```javascript
if (!context.auth) {
  throw new functions.https.HttpsError(
    "unauthenticated",
    "Login necessário."
  );
}
```

O `uid` deve vir exclusivamente de:

```javascript
context.auth.uid
```

Nunca aceitar:

```javascript
data.uid
```

como autoridade.

Exemplo proibido:

```javascript
const uid = data.uid;
```

Correto:

```javascript
const uid = context.auth.uid;
```

O caminho Firestore sempre deve ser construído com esse UID.

--------------------------------------------------
## 25. IDEMPOTÊNCIA E DUPLO CLIQUE
--------------------------------------------------

Ações de escrita podem sofrer:

- duplo clique;
- retry;
- timeout da resposta;
- usuário recarregando a página.

A UI deve desabilitar o botão durante uma operação em andamento.

Para operações financeiras da carteira, a implementação futura deve considerar
um `operationId`/idempotency key se houver risco de retry criar um aporte
duplicado após timeout.

Nesta Fase 2, pelo menos:

- botão fica bloqueado durante `saving`;
- resposta só é aplicada uma vez;
- erro não deve provocar retry automático silencioso.

A migração já possui proteção própria através da flag transacional.

--------------------------------------------------
## 26. CHECKLIST DE IMPLEMENTAÇÃO
--------------------------------------------------

### Firebase / banco

- [ ] Usar o Firebase já existente no projeto.
- [ ] Manter RTDB para `risk`/`sim`.
- [ ] Criar Firestore para Minha Carteira.
- [ ] Ativar Firestore em modo produção.
- [ ] Publicar `firestore.rules`.
- [ ] Não usar `allow read, write: if true`.
- [ ] Não criar índice composto sem necessidade real.

### Auth

- [ ] Reaproveitar `EstudeAuth`/`auth.js`.
- [ ] Não criar segundo inicializador de Auth.
- [ ] Implementar/estender sessão anônima.
- [ ] Permitir vinculação com email/senha.
- [ ] Permitir vinculação com Google.
- [ ] Preservar o mesmo UID durante o link.
- [ ] Não persistir `isAnonymous` no Firestore.

### Firestore

- [ ] Usar `users/{uid}/assets/{ticker}`.
- [ ] Normalizar ticker para uppercase + `/` → `-` (colisão = mesmo ativo).
- [ ] Sincronizar o `replace` de `/` no `normTicker` do frontend.
- [ ] Normalizar type para lowercase.
- [ ] Persistir `currency` preservando a moeda da carteira local.
- [ ] Usar USD como padrão da Fase 1 atual.
- [ ] Criar `lots` desde o primeiro aporte.
- [ ] Lote de venda registra `avgPrice` vigente na época.
- [ ] Posição zerada mantém asset (`quantity: 0` + `closedAt`) e lots.
- [ ] Usar `purchasePrice` para o preço do aporte.
- [ ] Usar `avgPrice` somente para o preço médio consolidado.
- [ ] Nunca aceitar `quantity`/`avgPrice` arbitrários em atualização cadastral.

### Cloud Functions

- [ ] Criar módulo central de normalização.
- [ ] Criar módulo central de validação.
- [ ] Criar módulo central de cálculos.
- [ ] Implementar `adicionarOuConsolidarAtivo` (compra e venda).
- [ ] Rejeitar venda de ativo inexistente e venda além do saldo.
- [ ] Testar venda exata do saldo.
- [ ] Testar venda concorrente em duas abas (A vende 0,7 + B vende 0,7 de saldo 1,0; somente uma operação pode concluir).
- [ ] Confirmar reabertura após compra/reconstrução voltar a `quantity > 0`.
- [ ] Retornar `action` (`created`/`updated`/`sold`/`closed`) com shape por ação.
- [ ] Implementar `atualizarAtivo`.
- [ ] Aceitar somente `priceSource: "manual"` na Fase 2; `"api"` fica reservado à Fase 3.
- [ ] Implementar `removerLote` (médio só sobre lotes positivos; reabre se voltar a > 0).
- [ ] Implementar `removerAtivo`.
- [ ] Implementar `migrarCarteiraLocal`.
- [ ] Validar autenticação em todas as funções.
- [ ] Usar `context.auth.uid`.
- [ ] Nunca confiar em `data.uid`.
- [ ] Nunca escrever `undefined` no Firestore.
- [ ] Normalizar `dailyChangePercent` para `0` quando ausente.
- [ ] Manter asset + lot atomicamente consistentes.

### PortfolioService

- [ ] Migrar interface para `Promise`.
- [ ] Implementar `load()`.
- [ ] Implementar `add()`.
- [ ] Implementar `update()`.
- [ ] Implementar `remove()`.
- [ ] Remover dependência síncrona de `LocalPortfolioStorage`.
- [ ] Não criar segunda fonte de verdade em localStorage.

### UI

- [ ] Adaptar chamadas para `async/await`.
- [ ] Entrada de venda (quantity negativa + `currentPrice` obrigatório).
- [ ] Exibir posições encerradas (`closedAt`) fora da alocação.
- [ ] Implementar estado `loading`.
- [ ] Implementar estado `saving`.
- [ ] Implementar estado `error`.
- [ ] Desabilitar botões durante operações.
- [ ] Não mostrar operação como concluída antes da resposta do backend.
- [ ] Implementar rollback visual quando uma exclusão otimista falhar.
- [ ] Definir comportamento explícito quando estiver offline.

### Migração

- [ ] Ler `eb_portfolio_v2`.
- [ ] Reaproveitar sanitização da Fase 1.
- [ ] Normalizar ticker.
- [ ] Normalizar type.
- [ ] Preservar currency.
- [ ] Converter `avgPrice` local para `purchasePrice` do lote inicial.
- [ ] Executar toda a migração em uma única Cloud Function.
- [ ] Usar uma única transação.
- [ ] Não fazer loop de callables no client.
- [ ] Rejeitar tickers duplicados na entrada.
- [ ] Não fazer merge silencioso com dados remotos.
- [ ] Primeiro estado válido vence.
- [ ] Se `localMigrationCompleted == true`, não migrar novamente.
- [ ] Se já existem ativos remotos sem flag, retornar `remote_exists`.
- [ ] Limpar `eb_portfolio_v2` somente após migração confirmada (`migrated`/`already_migrated`).
- [ ] Em `remote_exists`, não apagar local automaticamente; exigir ação explícita.
- [ ] Rejeitar `quantity <= 0` na entrada da migração.
- [ ] Limitar a migração a no máximo 200 ativos por operação.
- [ ] Informar ao usuário as posições com `quantity <= 0` que não foram migradas.
- [ ] Testar falha de validação no meio da lista.
- [ ] Confirmar que nenhum documento foi escrito após falha.
- [ ] Testar dois dispositivos com dados locais diferentes.
- [ ] Confirmar que apenas um conjunto é importado.

### Segurança / QA

- [ ] Testar Firestore Rules com Emulator.
- [ ] Confirmar leitura isolada por UID.
- [ ] Confirmar que usuário A não lê usuário B.
- [ ] Confirmar que client não escreve assets.
- [ ] Confirmar que client não escreve lots.
- [ ] Confirmar que Cloud Functions conseguem escrever via Admin SDK.
- [ ] Testar duas abas adicionando o mesmo ativo.
- [ ] Testar edição simultânea.
- [ ] Testar exclusão de ativo com vários lots.
- [ ] Testar exclusão do último lot.
- [ ] Confirmar reconstrução correta de `quantity`.
- [ ] Confirmar reconstrução correta de `avgPrice`.
- [ ] Testar reload rápido durante autenticação.
- [ ] Testar logout/login.
- [ ] Testar sessão anônima → conta real.
- [ ] Confirmar preservação do UID.
- [ ] Confirmar ausência de `admin.firestore()` no código do navegador.
- [ ] Confirmar que nenhuma escrita direta em assets/lots permanece no frontend.
- [ ] Em `remote_exists`, exibir "Já existe carteira remota. Deseja descartar a cópia local?" com ação explícita de descartar ou cancelar.
- [ ] Testar venda exata do saldo, venda concorrente além do saldo e reabertura da posição.

--------------------------------------------------
## 27. CRITÉRIOS DE ACEITE DA FASE 2
--------------------------------------------------

A Fase 2 será considerada concluída somente quando:

1. Um usuário anônimo consegue abrir a carteira e utilizá-la.
2. O usuário consegue vincular a sessão a uma conta real sem perder o UID.
3. Cada usuário enxerga somente sua própria carteira.
4. Ativos são armazenados individualmente no Firestore.
5. Aporte novo cria ou consolida corretamente o ativo.
6. Cada aporte gera um `lot` (venda gera lot negativo com `avgPrice` da época).
7. `avgPrice` é calculado exclusivamente no backend.
8. O client não consegue escrever diretamente em `assets`/`lots`.
9. Editar dados cadastrais funciona através de Cloud Function.
10. Remover ativo remove também seus lots.
11. Remover lote reconstrói corretamente a posição (médio só de positivos).
12. Venda reduz quantidade sem alterar o médio; além do saldo é rejeitada.
13. Zeramento fecha a posição (`closedAt`) preservando lots — nada é apagado.
14. A carteira local `eb_portfolio_v2` pode ser migrada sem perda parcial.
15. A migração não duplica ativos entre dispositivos.
16. Dados em USD não são convertidos indevidamente para BRL.
17. `CRYPTO`/`STOCK` da Fase 1 são aceitos e normalizados.
18. `dailyChangePercent` nunca é gravado como `undefined`.
19. O `PortfolioService` funciona integralmente com `async/await`.
20. A UI possui estados de carregamento e erro.
21. Offline não é apresentado como se uma escrita tivesse sido salva.
22. RTDB/PanelSync de `risk` e `sim` continua funcionando sem alteração.
23. Firestore e RTDB permanecem separados por responsabilidade.
24. Nenhuma regra de produção deixa o banco aberto.
25. Nenhum segundo sistema de Auth é criado.
26. Nenhum cálculo crítico é duplicado entre frontend e backend.
27. `atualizarAtivo` aplica last-writer-wins apenas sobre cadastro/cotação.
28. `remote_exists` nunca apaga silenciosamente a carteira local.
29. Migração rejeita posições com `quantity <= 0`.
30. Cliente não consegue alterar flags de migração no documento `users/{uid}`.
31. Migração rejeita mais de 200 ativos por operação.
32. UI informa posições `quantity <= 0` que não foram migradas.
33. `priceSource` da Fase 2 aceita somente `"manual"`; `"api"` fica reservado à Fase 3.
34. `remote_exists` exige mensagem e ação explícita: "Já existe carteira remota. Deseja descartar a cópia local?".
35. Venda exata do saldo funciona e venda concorrente além do saldo não gera saldo negativo nem escrita parcial.
36. Reabertura após compra ou reconstrução que volte a `quantity > 0` remove `closedAt`.
37. Normalização `/` → `-` é idêntica no frontend e no backend.
38. Remoção de lotes/ativos respeita limite seguro da transação e nunca deixa
    exclusão parcial.

--------------------------------------------------
## 28. DECISÕES FECHADAS APÓS REVISÃO
--------------------------------------------------

As questões que poderiam gerar novas interpretações ficam encerradas nesta
versão:

1. **Zeramento:** venda que leva a `quantity = 0` fecha o asset com `closedAt`;
   não apaga o documento nem os `lots`.
2. **Reabertura:** nova compra ou reconstrução que resultar em `quantity > 0`
   remove `closedAt` e reabre a posição.
3. **P&L realizado:** permanece fora do escopo da Fase 2. O lote de venda
   conserva `avgPrice` da época como base histórica para futuro cálculo por
   custo médio; não existe motor fiscal nesta fase.
4. **`atualizarAtivo`:** não usa transação nesta fase. Para cadastro e cotação,
   vale last-writer-wins. A função não pode alterar quantidade, médio ou lots.
5. **Correção de quantidade/custo:** não existe edição direta de lote. O fluxo
   definido é `removerLote` + novo `adicionarOuConsolidarAtivo`.
6. **Migração com carteira remota existente:** retorna `remote_exists` e não
   apaga automaticamente a cópia local. O descarte local exige ação explícita.
7. **Migração:** só aceita posições consolidadas com `quantity > 0`; vendas ou
   posições negativas não são uma entrada válida da migração.
8. **Ticker:** frontend e backend usam a mesma normalização uppercase + `/` → `-`.
9. **Preço de venda:** na mesma callable, `purchasePrice` representa o preço de
   execução da venda; `currentPrice` permanece obrigatório para atualizar a
   cotação exibida no asset.
10. **Idempotência:** a UI não faz retry automático de mutações financeiras.
    Um mecanismo de `operationId`/idempotência é hardening futuro e deve ser
    considerado antes de adicionar retries automáticos.

--------------------------------------------------
## 29. FORA DE ESCOPO NESTA FASE
--------------------------------------------------

Permanecem fora de escopo, sem necessidade de nova arquitetura nesta revisão:

- P&L realizado completo;
- FIFO/LIFO ou motor fiscal/IR;
- fila offline de mutações;
- retries automáticos de mutações financeiras;
- `operationId`/idempotência completa para mutações financeiras;
- cotação automática via API (`priceSource: "api"`), reservada à Fase 3.

Esses itens não devem ser reabertos durante a implementação da Fase 2, salvo se
surgir uma falha concreta de integridade, segurança ou perda de dados.

--------------------------------------------------
## 30. RESULTADO ARQUITETURAL FINAL
--------------------------------------------------

```text
                    FIREBASE
                       │
          ┌────────────┴────────────┐
          │                         │
       AUTH                       DADOS
          │                         │
          │              ┌──────────┴──────────┐
          │              │                     │
          │             RTDB               FIRESTORE
          │              │                     │
          │        PanelSync               Minha Carteira
          │              │                     │
          │        ┌─────┴─────┐        users/{uid}
          │        │           │             │
          │       risk        sim         assets/
          │                                  │
          │                              ┌───┴───┐
          │                             BTC     ETH
          │                              │       │
          │                            lots     lots
          │
          └──────────────┐
                         │
                    EstudeAuth
                         │
                         ▼
                  PortfolioService
                         │
                   async/await
                         │
             ┌───────────┴───────────┐
             │                       │
          leitura                  escrita
             │                       │
             ▼                       ▼
         Firestore             Cloud Functions
                                   │
                        ┌──────────┼──────────┐
                        │          │          │
                      add       update      remove
                        │          │          │
                        └──────────┼──────────┘
                                   │
                              cálculo central
                                   │
                              avgPrice/lots
```

Decisões definitivas desta Fase 2:

```text
Banco da carteira: Firestore
Banco de risk/sim: RTDB
Autenticação: EstudeAuth/Firebase Auth existente
Escrita da carteira: Cloud Functions
Leitura da carteira: Firestore client
Cálculo oficial: backend
Preço do aporte: purchasePrice
Preço médio consolidado: avgPrice
Venda: quantity negativa, mesma callable (sem função nova)
Zeramento: closedAt + lots preservados (nunca apagar)
Lote de venda: carrega avgPrice da época
Histórico: lots
ID do ativo: ticker normalizado (/ vira -)
Moeda atual: USD
Migração local: eb_portfolio_v2
PortfolioService: assíncrono
Offline: leitura possível / escrita remota não garantida
Merge entre dispositivos: NÃO
Conflito `remote_exists`: não apagar local automaticamente
P&L realizado: fora de escopo (base histórica gravada para futuro custo médio)
`atualizarAtivo`: last-writer-wins para cadastro/cotação
Fonte de verdade: Firestore após migração
```

A Fase 2 não deve introduzir arquitetura adicional além do necessário para
implementar essas decisões.