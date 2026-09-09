# IMPLEMENTAÇÃO — TOP 10 NOTÍCIAS DO MUNDO

## 1. OBJETIVO

Implementar no **Estude Bitcoin** um bloco chamado:

**TOP 10 NOTÍCIAS DO MUNDO**

O bloco deve apresentar somente os **10 títulos de notícias mais relevantes**, cada título sendo clicável e levando o usuário para a notícia original.

Não exibir o conteúdo da matéria.

Não copiar o texto das matérias.

Não criar sistema de notícias completo.

O objetivo é apenas:

**Título → clique → matéria original.**

---

## 2. LOCAL DA IMPLEMENTAÇÃO

A funcionalidade será destinada ao **Estude Bitcoin**.

Não implementar no Termômetro neste momento.

O Termômetro permanece focado no painel técnico/mercado.

---

## 3. ARQUITETURA OBRIGATÓRIA

A solução deve ser simples e independente.

### NÃO criar:

* múltiplos arquivos JavaScript;
* diretórios novos desnecessários;
* `news.json`;
* `rank.js`;
* `sources.js`;
* `dedupe.js`;
* banco de dados;
* API key;
* sistema complexo de backend;
* dependência de serviços pagos.

### Preferência:

Um único arquivo JavaScript de Worker contendo toda a lógica:

```text
worker.js
```

Esse Worker deve conter:

* `fetch()`;
* `scheduled()`;
* coleta RSS;
* parsing;
* normalização;
* deduplicação;
* cálculo de relevância;
* seleção do TOP 10;
* armazenamento/cache;
* endpoint HTTP;
* tratamento de erros.

---

# 4. NÃO ALTERAR O WORKER EXISTENTE SEM ANÁLISE

Existe infraestrutura existente do projeto Bitcoiniciantes, inclusive Worker relacionado ao `bitcoiniciantes-ia`.

Antes de alterar qualquer Worker existente:

1. identificar exatamente qual Worker está sendo utilizado;
2. verificar suas funções atuais;
3. verificar seus Cron Triggers;
4. verificar bindings;
5. verificar endpoints existentes;
6. verificar se a alteração pode interferir nas funções existentes.

### Preferência

Se houver risco de interferência, criar um **Worker separado exclusivamente para notícias**, contendo apenas um arquivo `worker.js`.

Não misturar a coleta de notícias com processos existentes que rodam a cada 5 minutos.

---

# 5. FONTE DAS NOTÍCIAS

Primeira opção:

**Google News RSS**

URL:

```text
https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-BR
```

Não utilizar API key.

Não fazer scraping de páginas individuais de jornais.

O RSS deve fornecer:

* título;
* link;
* fonte;
* data/hora da publicação.

---

# 6. ATUALIZAÇÃO

A atualização deve ocorrer exatamente **duas vezes por dia**, nos seguintes horários:

### Brasil

```text
07:00
14:00
```

Considerar o horário oficial de Brasília.

Como o Cloudflare Cron trabalha em UTC, os horários devem ser convertidos corretamente.

Para o horário brasileiro:

```text
07:00 BRT = 10:00 UTC
14:00 BRT = 17:00 UTC
```

Portanto, o Cron esperado é:

```text
0 10,17 * * *
```

Não usar 09:00/21:00.

Não atualizar a cada 5 minutos.

Não criar atualização contínua.

---

# 7. FLUXO DE ATUALIZAÇÃO

A cada execução do Cron:

```text
Cron
  ↓
07:00 ou 14:00 Brasil
  ↓
buscar Google News RSS
  ↓
extrair notícias
  ↓
normalizar títulos
  ↓
remover duplicidades
  ↓
calcular relevância
  ↓
ordenar
  ↓
selecionar TOP 10
  ↓
armazenar resultado
  ↓
endpoint /api/top-news
```

---

# 8. CRITÉRIO DE RELEVÂNCIA (ESCOPO REVISADO EM 2026-09-09)

Escopo decidido pelo usuário: **somente Tecnologia/IA, Bitcoin e Estados Unidos
(guerra, fatos relevantes, tragédias)**. Fora do escopo: Brasil, futebol,
política brasileira e entretenimento — filtrados por blocklist antes do ranking.

Implementação (`news-worker/worker.js`): 3 buscas Google News em paralelo
(Bitcoin, IA/tecnologia, EUA) + `isExcluded()` + 3 pilares de scoring
(`pillar`), e só entra no TOP 10 quem pontuar em ao menos um pilar.

Não selecionar simplesmente os primeiros 10 itens do RSS.

Criar uma pontuação simples de relevância.

Dar maior peso para notícias relacionadas a (legado abaixo; valem os 3 pilares):

### Economia

* juros;
* inflação;
* Fed;
* bancos centrais;
* recessão;
* PIB;
* emprego;
* dólar;
* petróleo;
* ouro;
* bolsas;
* mercados.

### Geopolítica

* guerras;
* conflitos;
* EUA;
* China;
* Rússia;
* Ucrânia;
* Israel;
* Irã;
* sanções;
* tarifas;
* grandes decisões governamentais.

### Bitcoin e criptomoedas

* Bitcoin;
* BTC;
* criptomoedas;
* ETFs;
* regulação;
* grandes movimentos institucionais;
* grandes empresas do setor.

### Grandes acontecimentos mundiais

Notícias que possam provocar impacto relevante nos mercados ou na economia mundial.

---

# 9. RECÊNCIA

A notícia deve receber pontuação adicional conforme sua idade.

Priorizar:

```text
0–3 horas     peso alto
3–6 horas     peso alto
6–12 horas    peso médio
12–24 horas   peso baixo
```

O sistema deve evitar que notícias antigas dominem o TOP 10.

---

# 10. FONTES

Quando possível, dar pequeno peso adicional a fontes reconhecidas.

Exemplos:

* Reuters;
* Associated Press;
* BBC;
* Bloomberg;
* CNBC;
* Financial Times;
* Wall Street Journal.

Esse peso deve ser apenas um componente do ranking.

Não transformar o ranking em uma lista fixa dessas fontes.

---

# 11. DUPLICIDADES

Esse é um requisito importante.

Se várias fontes estiverem noticiando o mesmo acontecimento, não mostrar 5 títulos praticamente iguais.

Exemplo:

```text
Fed mantém juros...
Fed decide manter juros...
Fed mantém taxa de juros...
Fed mantém juros americanos...
```

Essas notícias devem ser tratadas como um mesmo acontecimento quando a similaridade for evidente.

O TOP 10 deve tentar representar **10 acontecimentos relevantes**, e não simplesmente 10 URLs.

---

# 12. RESULTADO DO ENDPOINT

Criar:

```text
/api/top-news
```

O endpoint deve retornar JSON semelhante a:

```json
{
  "ok": true,
  "updatedAt": "2026-09-09T10:00:00.000Z",
  "count": 10,
  "items": [
    {
      "position": 1,
      "title": "Título da notícia",
      "url": "https://...",
      "source": "Reuters",
      "publishedAt": "..."
    }
  ]
}
```

O frontend precisa somente dessas informações.

---

# 13. FRONTEND DO ESTUDE BITCOIN

O frontend deve consultar:

```text
/api/top-news
```

ou o endereço público do Worker, caso seja um Worker separado.

Mostrar somente:

```text
TOP 10 NOTÍCIAS DO MUNDO

1. Título da notícia
2. Título da notícia
3. Título da notícia
...
10. Título da notícia
```

Cada título deve ser:

```html
<a>
```

clicável.

Abrir a notícia original em nova aba:

```html
target="_blank"
rel="noopener noreferrer"
```

---

# 14. NÃO EXIBIR

Não exibir:

* resumo;
* imagem;
* texto da matéria;
* thumbnail;
* publicidade;
* conteúdo copiado;
* paywall;
* descrição longa;
* IA gerando notícia.

Somente:

**título + link original**

Opcionalmente:

**fonte**

---

# 15. CACHE

O frontend não deve provocar uma nova coleta do RSS a cada acesso.

A coleta acontece somente nos horários definidos pelo Cron.

O resultado deve permanecer disponível entre as atualizações.

Fluxo:

```text
07:00
↓
gera TOP 10
↓
resultado fica disponível
↓
usuários acessam durante o dia
↓
todos recebem o mesmo resultado
↓
14:00
↓
nova coleta
↓
novo TOP 10
```

---

# 16. FALLBACK

Se a coleta das 07:00 falhar:

* não apagar o resultado anterior;
* manter o último TOP 10 válido;
* registrar o erro no log.

Se a coleta das 14:00 falhar:

* manter o resultado das 07:00;
* não retornar lista vazia se já existir uma versão válida.

Nunca substituir uma versão válida por:

```json
{
  "items": []
}
```

por causa de uma falha temporária de rede/RSS.

---

# 17. SEGURANÇA

O frontend nunca deve possuir API key.

Não colocar credenciais no JavaScript público.

Não utilizar `eval`.

Validar URLs antes de enviá-las ao frontend.

Usar:

```html
rel="noopener noreferrer"
```

nos links externos.

---

# 18. CUSTO

Priorizar solução sem custo adicional.

Não adicionar:

* banco pago;
* API paga;
* servidor dedicado;
* VPS;
* GCP;
* Cloudflare Workers pago;
* serviço externo desnecessário.

O objetivo é aproveitar a infraestrutura gratuita disponível.

---

# 19. NÃO FAZER REFACTOR GERAL

Esta implementação é isolada.

Não modificar:

* sistema de mercado;
* alertas;
* indicadores;
* autenticação;
* persistência existente;
* módulos do Termômetro;
* Worker existente sem necessidade;
* arquitetura geral do Estude Bitcoin.

Alterar somente o necessário para adicionar o recurso.

---

# 20. VALIDAÇÃO OBRIGATÓRIA

Antes de considerar concluído, testar:

### Worker

* `GET /`
* `GET /api/top-news`
* RSS disponível;
* parsing funcionando;
* 10 itens;
* títulos preenchidos;
* URLs preenchidas;
* duplicidades removidas;
* ranking funcionando;
* cache funcionando.

### Cron

Confirmar:

```text
10:00 UTC = 07:00 Brasil
17:00 UTC = 14:00 Brasil
```

### Frontend

Confirmar:

* TOP 10 aparece;
* somente títulos são exibidos;
* títulos são clicáveis;
* links levam para a fonte original;
* abre em nova aba;
* atualização não exige rebuild do site.

---

# 21. LOGS

Adicionar logs objetivos no Worker, por exemplo:

```text
[NEWS] Coleta iniciada
[NEWS] RSS recebido
[NEWS] Notícias encontradas: XX
[NEWS] Após deduplicação: XX
[NEWS] TOP 10 gerado
[NEWS] Cache atualizado
[NEWS] Atualização concluída
```

Em caso de erro:

```text
[NEWS] ERRO: ...
```

Não gerar logs excessivos.

---

# 22. REGRA PRINCIPAL

Não complicar a solução.

O objetivo final é:

```text
Google News RSS
       ↓
Worker único
       ↓
TOP 10
       ↓
cache
       ↓
/api/top-news
       ↓
Estude Bitcoin
       ↓
10 títulos clicáveis
```

Atualização:

```text
07:00 Brasil
14:00 Brasil
```

Nada além disso deve ser criado sem necessidade técnica comprovada.

---

# 23. CÓDIGO

Usar o código fornecido abaixo como base da implementação.

Não reescrever a arquitetura sem motivo.

Antes de modificar código existente, identificar exatamente onde a funcionalidade será integrada e apresentar:

1. arquivos que serão alterados;
2. arquivos que serão criados;
3. motivo de cada alteração;
4. confirmação de que nenhuma funcionalidade existente será afetada.

Se for possível fazer tudo em um único Worker separado, essa é a opção preferencial.

[COLE AQUI O CÓDIGO DO WORKER]

# FIM DA ORIENTAÇÃO
.......


/*
==========================================================
TOP 10 NOTÍCIAS — BITCOINICIANTES
==========================================================

UM ÚNICO ARQUIVO.

Funções:
- coleta Google News RSS
- extrai títulos + links + fonte
- remove duplicidades
- calcula relevância
- seleciona TOP 10
- mantém resultado em cache
- disponibiliza GET /api/top-news
- atualização via Cron 2x/dia

IMPORTANTE:
- não usa API key
- não usa banco
- não usa KV
- não usa arquivos externos
- não usa diretórios auxiliares

Cron sugerido:
09:00 BRT = 12:00 UTC
21:00 BRT = 00:00 UTC

Expressão:
0 0,12 * * *
==========================================================
*/

const CONFIG = {
  ROUTE: "/api/top-news",

  RSS_URL:
    "https://news.google.com/rss?hl=pt-BR&gl=BR&ceid=BR:pt-BR",

  TOP_N: 10,

  CACHE_KEY:
    "https://news-cache.bitcoiniciantes.internal/api/top-news",

  CACHE_TTL: 60 * 60 * 13 // 13 horas
};


// ========================================================
// WORKER
// ========================================================

export default {

  // ------------------------------------------------------
  // HTTP
  // ------------------------------------------------------

  async fetch(request, env, ctx) {

    const url = new URL(request.url);

    if (url.pathname === CONFIG.ROUTE) {
      return await getNews(request, ctx);
    }

    if (url.pathname === "/") {
      return new Response(
        "Bitcoiniciantes News Worker OK",
        {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8"
          }
        }
      );
    }

    return new Response("Not Found", {
      status: 404
    });
  },


  // ------------------------------------------------------
  // CRON
  // ------------------------------------------------------

  async scheduled(controller, env, ctx) {

    /*
      Toda vez que o Cron disparar:

      1. busca RSS
      2. processa
      3. grava no cache
    */

    ctx.waitUntil(updateNewsCache());
  }
};


// ========================================================
// OBTER NOTÍCIAS
// ========================================================

async function getNews(request, ctx) {

  const cache = caches.default;

  const cacheRequest = new Request(
    CONFIG.CACHE_KEY,
    {
      method: "GET"
    }
  );

  // ------------------------------------------------------
  // PRIMEIRO: tenta cache
  // ------------------------------------------------------

  const cached = await cache.match(cacheRequest);

  if (cached) {

    const response = new Response(
      cached.body,
      cached
    );

    response.headers.set(
      "X-News-Cache",
      "HIT"
    );

    return response;
  }


  // ------------------------------------------------------
  // SE NÃO HOUVER CACHE
  // faz uma coleta imediatamente
  // ------------------------------------------------------

  try {

    const data = await collectNews();

    const response = createNewsResponse(data);

    ctx.waitUntil(
      cache.put(
        cacheRequest,
        response.clone()
      )
    );

    response.headers.set(
      "X-News-Cache",
      "MISS"
    );

    return response;

  } catch (error) {

    return jsonResponse(
      {
        ok: false,
        error: "Falha ao obter notícias",
        items: []
      },
      500
    );
  }
}


// ========================================================
// ATUALIZA CACHE
// ========================================================

async function updateNewsCache() {

  try {

    console.log(
      "[NEWS] Iniciando atualização..."
    );

    const data = await collectNews();

    if (!data.items.length) {

      console.error(
        "[NEWS] Nenhuma notícia encontrada."
      );

      return;
    }

    const response =
      createNewsResponse(data);

    const cache =
      caches.default;

    const cacheRequest =
      new Request(
        CONFIG.CACHE_KEY,
        {
          method: "GET"
        }
      );

    await cache.put(
      cacheRequest,
      response
    );

    console.log(
      `[NEWS] ${data.items.length} notícias armazenadas.`
    );

  } catch (error) {

    console.error(
      "[NEWS] Erro:",
      error
    );
  }
}


// ========================================================
// COLETA RSS
// ========================================================

async function collectNews() {

  const response = await fetch(
    CONFIG.RSS_URL,
    {
      headers: {
        "User-Agent":
          "Bitcoiniciantes-News/1.0"
      }
    }
  );

  if (!response.ok) {

    throw new Error(
      `RSS HTTP ${response.status}`
    );
  }

  const xml =
    await response.text();

  const rawItems =
    parseRSS(xml);

  // ------------------------------------------------------
  // NORMALIZA
  // ------------------------------------------------------

  let items =
    rawItems
      .map(normalizeItem)
      .filter(Boolean);


  // ------------------------------------------------------
  // REMOVE DUPLICIDADES
  // ------------------------------------------------------

  items =
    removeDuplicates(items);


  // ------------------------------------------------------
  // CALCULA RELEVÂNCIA
  // ------------------------------------------------------

  items =
    items.map(item => ({
      ...item,
      score: calculateScore(item)
    }));


  // ------------------------------------------------------
  // ORDENA
  // ------------------------------------------------------

  items.sort(
    (a, b) => b.score - a.score
  );


  // ------------------------------------------------------
  // TOP 10
  // ------------------------------------------------------

  items =
    items
      .slice(0, CONFIG.TOP_N)
      .map((item, index) => ({
        position: index + 1,
        title: item.title,
        url: item.url,
        source: item.source,
        publishedAt: item.publishedAt
      }));


  return {

    updatedAt:
      new Date().toISOString(),

    count:
      items.length,

    items
  };
}


// ========================================================
// PARSER RSS
// ========================================================

function parseRSS(xml) {

  const items = [];

  const matches =
    xml.matchAll(
      /<item>([\s\S]*?)<\/item>/gi
    );

  for (const match of matches) {

    const block = match[1];

    const title =
      extractTag(
        block,
        "title"
      );

    const link =
      extractTag(
        block,
        "link"
      );

    const pubDate =
      extractTag(
        block,
        "pubDate"
      );

    const source =
      extractTag(
        block,
        "source"
      );

    if (!title || !link)
      continue;

    items.push({
      title,
      url: link,
      source:
        source || "Google News",
      publishedAt:
        pubDate || null
    });
  }

  return items;
}


// ========================================================
// EXTRAI TAG XML
// ========================================================

function extractTag(
  xml,
  tag
) {

  const regex =
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    );

  const match =
    xml.match(regex);

  if (!match)
    return null;

  return decodeXML(
    stripHTML(
      match[1]
    ).trim()
  );
}


// ========================================================
// NORMALIZA
// ========================================================

function normalizeItem(item) {

  const title =
    item.title
      .replace(/\s+/g, " ")
      .trim();

  if (!title)
    return null;

  return {
    title,

    url:
      item.url.trim(),

    source:
      item.source
        .replace(/\s+/g, " ")
        .trim(),

    publishedAt:
      item.publishedAt
  };
}


// ========================================================
// DUPLICIDADES
// ========================================================

function removeDuplicates(items) {

  const seen =
    new Set();

  const result = [];

  for (const item of items) {

    /*
      Remove palavras comuns para detectar
      notícias que são essencialmente iguais.
    */

    const key =
      item.title
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\w\s]/g, "")
        .replace(
          /\b(de|da|do|das|dos|a|o|as|os|e|em|para|por|com)\b/g,
          ""
        )
        .replace(/\s+/g, " ")
        .trim();

    if (seen.has(key))
      continue;

    seen.add(key);

    result.push(item);
  }

  return result;
}


// ========================================================
// RANKING
// ========================================================

function calculateScore(item) {

  const text =
    item.title.toLowerCase();

  let score = 0;


  // ------------------------------------------------------
  // TERMOS DE ALTO IMPACTO
  // ------------------------------------------------------

  const highImpact = [

    "guerra",
    "ataque",
    "invasão",
    "iran",
    "israel",
    "russia",
    "rússia",
    "ucrânia",
    "china",
    "eua",
    "estados unidos",

    "fed",
    "juros",
    "inflação",
    "recessão",
    "crise",
    "tarifa",
    "sanção",
    "sancao",

    "petróleo",
    "petroleo",
    "ouro",

    "bitcoin",
    "btc",
    "criptomoeda",
    "cripto",

    "bolsa",
    "nasdaq",
    "s&p",
    "dólar",
    "dolar"
  ];


  for (const word of highImpact) {

    if (text.includes(word)) {

      score += 10;
    }
  }


  // ------------------------------------------------------
  // TERMOS ECONÔMICOS
  // ------------------------------------------------------

  const economic = [

    "mercado",
    "economia",
    "banco central",
    "bancos centrais",
    "economista",
    "emprego",
    "desemprego",
    "gdp",
    "pib",
    "fmi",
    "economia global"
  ];


  for (const word of economic) {

    if (text.includes(word)) {

      score += 5;
    }
  }


  // ------------------------------------------------------
  // TERMOS POLÍTICOS
  // ------------------------------------------------------

  const political = [

    "presidente",
    "governo",
    "eleição",
    "eleicoes",
    "eleições",
    "congresso",
    "parlamento",
    "trump",
    "putin",
    "xi jinping"
  ];


  for (const word of political) {

    if (text.includes(word)) {

      score += 3;
    }
  }


  // ------------------------------------------------------
  // RECÊNCIA
  // ------------------------------------------------------

  if (item.publishedAt) {

    const timestamp =
      Date.parse(
        item.publishedAt
      );

    if (!Number.isNaN(timestamp)) {

      const hours =
        (
          Date.now() - timestamp
        ) / 3600000;

      if (hours <= 3)
        score += 10;

      else if (hours <= 6)
        score += 7;

      else if (hours <= 12)
        score += 4;

      else if (hours <= 24)
        score += 1;
    }
  }


  // ------------------------------------------------------
  // BÔNUS DE FONTE
  // ------------------------------------------------------

  const source =
    item.source.toLowerCase();

  const trustedSources = [

    "reuters",
    "associated press",
    "ap news",
    "bbc",
    "bloomberg",
    "cnbc",
    "financial times",
    "wall street journal"
  ];

  for (const trusted of trustedSources) {

    if (source.includes(trusted)) {

      score += 5;
      break;
    }
  }


  return score;
}


// ========================================================
// RESPONSE
// ========================================================

function createNewsResponse(data) {

  return new Response(
    JSON.stringify(
      {
        ok: true,
        ...data
      },
      null,
      2
    ),
    {
      status: 200,

      headers: {

        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "public, max-age=300",

        "access-control-allow-origin":
          "*"
      }
    }
  );
}


// ========================================================
// JSON
// ========================================================

function jsonResponse(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "access-control-allow-origin":
          "*"
      }
    }
  );
}


// ========================================================
// XML / HTML
// ========================================================

function stripHTML(text) {

  return text
    .replace(
      /<[^>]*>/g,
      ""
    );
}


function decodeXML(text) {

  return text
    .replace(
      /&amp;/g,
      "&"
    )
    .replace(
      /&lt;/g,
      "<"
    )
    .replace(
      /&gt;/g,
      ">"
    )
    .replace(
      /&quot;/g,
      '"'
    )
    .replace(
      /&#39;/g,
      "'"
    )
    .replace(
      /&#(\d+);/g,
      (_, n) =>
        String.fromCharCode(
          Number(n)
        )
    );
}




,,,,,,,,,,,,,,,,,,,,,,,,,,,
Eu faria um Worker separado, mas com um único arquivo JS:

Cloudflare Worker
       │
       └── worker.js
             ├── fetch()
             │     └── /api/top-news
             │
             └── scheduled()
                   └── 2x por dia

................................
E o Estude Bitcoin só precisa disso

fetch("https://SEU-WORKER.workers.dev/api/top-news")
  .then(r => r.json())
  .then(data => {

    const container =
      document.getElementById("top-news");

    container.innerHTML =
      data.items.map(item => `
        <a
          href="${item.url}"
          target="_blank"
          rel="noopener noreferrer"
        >
          ${item.title}
        </a>
      `).join("");

  });
..........................
Na prática, o usuário verá:

TOP 10 NOTÍCIAS DO MUNDO

Fed mantém juros e sinaliza próximos passos
Bitcoin reage às novas expectativas do mercado
China anuncia novas medidas econômicas
Petróleo dispara após...
...............

......................
