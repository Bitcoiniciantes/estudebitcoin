# alertaMelhorado2.md

# ALERTAS EM BACKGROUND — WEB PUSH + PWA + CLOUDFLARE WORKER

**Projeto:** Termômetro / Observatório  
**Versão:** 2.0 — arquitetura revisada  
**Data:** 29/08/2026  
**Status:** especificação técnica para implementação faseada  
**Objetivo:** adicionar alertas em background sem substituir o motor de alertas em primeiro plano já existente.

---

## 0. OBJETIVO E PRINCÍPIO ARQUITETURAL

O sistema deverá permitir que um alerta de preço seja entregue ao usuário mesmo quando:

- o site estiver fechado;
- a aba estiver fechada;
- o celular estiver bloqueado;
- o PWA estiver em segundo plano.

A solução utilizará:

1. PWA + Service Worker;
2. Web Push;
3. VAPID;
4. Cloudflare Worker;
5. Cloudflare KV;
6. Cron Trigger;
7. o motor de alertas existente como autoridade para o comportamento em tempo real.

### Regra fundamental

**O sistema de Push em background é um complemento do motor existente. Não é uma substituição.**

Quando o site estiver aberto, o motor realtime existente continua responsável por detectar os cruzamentos imediatamente.

Quando o site estiver fechado ou sem execução do JavaScript do painel, o Worker fornece uma capacidade de fallback/background.

Não criar dois motores de alerta com regras diferentes.

---

# 1. ARQUITETURA EXISTENTE QUE DEVE SER PRESERVADA

O projeto já possui:

- `GlobalAlertContext`;
- `AlertEngine`;
- `useLivePrices`;
- alertas de suporte/resistência;
- cálculo de níveis pelo gráfico;
- detecção direcional de crossover;
- estado de alerta;
- `frozenUntil`;
- alertas em primeiro plano com som/vibração.

A implementação nova NÃO deve remover, substituir ou duplicar essas responsabilidades.

## 1.1 Fonte dos níveis

Os níveis de suporte e resistência continuam sendo definidos pelo fluxo existente.

Quando o gráfico fornece:

```text
symbol
support
resistance
period
enabled
```

esses valores são a configuração lógica do alerta.

A implementação em background deverá receber uma representação sincronizada dessa configuração.

---

# 2. PROBLEMA QUE ESTA VERSÃO CORRIGE

A especificação anterior armazenava basicamente:

```text
subscription → KV
```

Isso não é suficiente.

O Worker precisa conhecer também os alertas que deve monitorar.

A estrutura lógica passa a ser:

```text
USER
 ├── PUSH SUBSCRIPTIONS
 │    └── endpoint + keys + metadata
 │
 └── ALERT CONFIGS
      ├── symbol
      ├── support
      ├── resistance
      ├── direction
      ├── enabled
      └── alert identity
```

E deve existir estado mínimo para impedir notificações repetidas:

```text
ALERT STATE
 ├── last observed price
 ├── last trigger
 ├── triggered/fired state
 └── timestamp
```

---

# 3. NÃO CRIAR UM SEGUNDO MOTOR DE ALERTA

Este é um requisito crítico.

O sistema não deve ter:

```text
Motor A = navegador
Motor B = Worker
```

com regras diferentes.

O Worker deverá implementar somente a lógica mínima necessária para avaliar uma configuração sincronizada quando o navegador não estiver executando.

A semântica deve ser equivalente à do motor existente:

### Resistência

Disparo somente quando:

```text
previousPrice < resistance
AND
currentPrice >= resistance
```

### Suporte

Disparo somente quando:

```text
previousPrice > support
AND
currentPrice <= support
```

### Estado

Depois de disparar:

```text
triggered = true
```

O mesmo cruzamento não deve produzir notificações repetidas em cada execução do Cron.

A reativação deverá ocorrer somente segundo a política de reset/rearme já definida pelo motor existente.

**A IA não deve inventar uma nova política de retriggering.**

---

# 4. LIMITAÇÃO FUNDAMENTAL DO CRON

O Cron não é realtime.

Exemplo:

```text
Cron = a cada 5 minutos
```

Se o preço fizer:

```text
14:02:10 → 115.000
14:03:00 → 114.950
14:05:00 → 114.900
```

o Worker poderá nunca observar o cruzamento.

Portanto:

```text
WEB SOCKET / MOTOR REALTIME
        ↓
alerta imediato quando o painel está executando


CRON / WORKER
        ↓
monitoramento de background
```

O sistema deve documentar claramente que **Cron de 5 minutos não oferece garantia de captura de todo cruzamento intraperíodo**.

Se a precisão em background exigir monitoramento realtime, a arquitetura terá de ser revista posteriormente. Não tentar simular realtime com Cron.

---

# 5. FASE 0 — PRÉ-REQUISITOS HUMANOS

Esta fase não deve ser executada automaticamente pela IA.

## Checklist

- [ ] Criar/confirmar conta Cloudflare.
- [ ] Instalar Wrangler.
- [ ] Executar `wrangler login`.
- [ ] Confirmar `wrangler --version`.
- [ ] Confirmar que o login está autenticado.
- [ ] Confirmar qual projeto/repositório receberá somente o código client.
- [ ] Confirmar onde o Worker será criado.

### Checkpoint

A IA deve parar.

Só avançar após confirmação explícita de:

```text
WRANGLER LOGIN = OK
```

---

# 6. FASE 1 — VAPID

VAPID identifica e autentica o servidor de envio de Web Push.

Gerar uma única vez:

```bash
npx web-push generate-vapid-keys
```

## Armazenamento

### Público

A chave pública pode estar no client:

```text
VAPID_PUBLIC_KEY
```

### Privado

A chave privada deve existir somente como Secret do Worker:

```bash
wrangler secret put VAPID_PRIVATE_KEY
```

Nunca:

- no Git;
- no `.env` commitado;
- em código client;
- em JSON;
- em `wrangler.toml`;
- em logs;
- em respostas HTTP.

## Checkpoint obrigatório

Antes de qualquer commit:

```bash
git diff
git status
```

Pesquisar explicitamente por:

```text
VAPID_PRIVATE_KEY
```

e pelo valor real da chave privada.

### Critério

```text
VAPID PRIVATE KEY NO REPOSITÓRIO = ZERO
```

---

# 7. FASE 2 — PWA

Criar ou adaptar o manifest existente.

Exemplo mínimo:

```json
{
  "name": "Termômetro",
  "short_name": "Termômetro",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0d0d0d",
  "theme_color": "#0d0d0d",
  "id": "/",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    }
  ]
}
```

Não criar um segundo manifest se já existir um.

## Service Worker

Criar/adaptar:

```text
/sw.js
```

Responsabilidades mínimas:

1. receber `push`;
2. interpretar payload;
3. mostrar notificação;
4. tratar `notificationclick`;
5. abrir/focar a aplicação quando apropriado.

Exemplo conceitual:

```javascript
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};

  event.waitUntil(
    self.registration.showNotification(
      data.title || 'Alerta de preço',
      {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: {
          url: data.url || '/'
        }
      }
    )
  );
});
```

Não copiar cegamente esse código para produção. Adaptar ao framework e à arquitetura real do projeto.

---

# 8. SERVICE WORKER — NOTIFICATIONCLICK

O clique da notificação deverá poder retornar ao painel.

Exemplo conceitual:

```javascript
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.openWindow(url)
  );
});
```

A implementação final deve considerar as APIs disponíveis no navegador e evitar assumir que o comportamento é idêntico em todos os sistemas.

---

# 9. FASE 3 — INSCRIÇÃO WEB PUSH

A solicitação de permissão deve acontecer por ação explícita do usuário.

Não executar automaticamente no carregamento.

Fluxo:

```text
usuário toca "Ativar alertas"
        ↓
Notification.requestPermission()
        ↓
serviceWorker.ready
        ↓
pushManager.subscribe()
        ↓
subscription
        ↓
POST /subscribe
        ↓
Worker
        ↓
KV
```

## Exemplo conceitual

```javascript
async function subscribeToPush() {
  const permission = await Notification.requestPermission();

  if (permission !== 'granted') {
    return;
  }

  const registration = await navigator.serviceWorker.ready;

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: VAPID_PUBLIC_KEY
  });

  await fetch(WORKER_URL + '/subscribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(subscription)
  });
}
```

A implementação deve utilizar conversão correta da chave pública VAPID para o formato exigido pelo `applicationServerKey`.

---

# 10. iPHONE / iOS

Web Push em iOS/iPadOS é suportado para Web Apps adicionados à Home Screen a partir do iOS/iPadOS 16.4.

A permissão deve ser solicitada em resposta a interação direta do usuário.

Portanto:

```text
Safari normal
    ↓
não assumir suporte ao fluxo de Push do PWA


Adicionar à Tela de Início
    ↓
abrir o Web App
    ↓
usuário toca "Ativar alertas"
    ↓
pedir permissão
```

A implementação deve usar feature detection, e não somente detecção de navegador.

Não apresentar o Push como garantido em qualquer modo de abertura do iOS.

---

# 11. FASE 4 — CLOUDFLARE WORKER

Criar Worker separado do frontend.

Exemplo:

```bash
wrangler init alerta-worker
```

O Worker terá três responsabilidades:

```text
HTTP API
 ├── /subscribe
 ├── /alerts/sync
 └── /unsubscribe

SCHEDULED
 └── avaliação de alertas

WEB PUSH
 └── envio das notificações
```

---

# 12. CLOUDFLARE KV

Criar namespace:

```bash
wrangler kv namespace create "ALERTAS_KV"
```

O ID retornado deverá ser configurado no Worker.

## Estrutura recomendada

Não guardar tudo em uma única chave gigante.

Usar chaves separadas por responsabilidade.

Exemplo:

```text
subscription:{id}
alert:{id}
alert-state:{id}
```

A estrutura exata pode ser adaptada pela IA, mas deve preservar separação entre:

- inscrição Push;
- configuração do alerta;
- estado do alerta.

## Não gravar a cada tick

O KV não deve receber uma escrita a cada preço observado.

Isso é proibido arquiteturalmente.

Estado deve ser persistido somente quando houver mudança relevante, como:

```text
novo alerta
alteração de configuração
ativação/desativação
disparo
rearme
remoção de subscription inválida
```

---

# 13. FASE 4.1 — ENDPOINT /SUBSCRIBE

O endpoint deverá:

1. validar método;
2. validar JSON;
3. validar estrutura mínima de PushSubscription;
4. gerar identificador;
5. armazenar subscription;
6. retornar sucesso.

Nunca confiar cegamente no body recebido.

Estrutura esperada:

```text
endpoint
keys.p256dh
keys.auth
```

Não armazenar dados pessoais desnecessários.

---

# 14. FASE 4.2 — /UNSUBSCRIBE

Implementar endpoint para remover subscription.

Também remover subscription quando o servidor de Push indicar que ela expirou ou deixou de ser válida.

O Worker não deve continuar tentando indefinidamente uma subscription inválida.

---

# 15. FASE 4.3 — SINCRONIZAÇÃO DOS ALERTAS

Criar mecanismo explícito para o frontend enviar ao Worker as configurações que devem existir em background.

Exemplo conceitual:

```json
{
  "id": "btc-resistance-1",
  "symbol": "BTCUSDT",
  "support": 110000,
  "resistance": 115000,
  "enabled": true,
  "direction": "BOTH"
}
```

A IA deve adaptar esse contrato ao modelo real do `GlobalAlertContext`.

## Regra

O Worker não deve inventar suporte/resistência.

O frontend envia os níveis definidos pelo sistema existente.

---

# 16. IDENTIDADE DO ALERTA

Cada configuração deverá possuir identidade estável.

Exemplo:

```text
alertId
```

Não usar somente:

```text
symbol + preço
```

como identidade.

Isso permite:

- atualizar alerta;
- desativar alerta;
- manter estado;
- impedir duplicação;
- sincronizar alterações.

---

# 17. ESTADO DO ALERTA

Estado mínimo:

```text
alertId
lastPrice
lastEvaluatedAt
lastTrigger
triggered
```

Opcionalmente:

```text
triggeredAt
frozenUntil
```

quando isso for necessário para manter a semântica existente.

O estado do background deve permanecer compatível com a lógica do `GlobalAlertContext`.

---

# 18. FASE 4.4 — PREÇO

O Worker precisa de uma fonte de preço compatível com a infraestrutura atual.

Não duplicar arbitrariamente toda a ingestão Binance existente.

Para background, a IA deve avaliar:

1. endpoint público REST adequado;
2. custo de subrequests;
3. latência;
4. limite de requisições;
5. quantidade de ativos monitorados.

Se a implementação consultar um endpoint por ativo, isso deverá ser considerado contra o limite de subrequests do Worker.

Para poucos ativos, isso é simples.

Para dezenas/centenas, a arquitetura deverá ser revista.

---

# 19. FASE 4.5 — WEB PUSH NO WORKER

Este é o ponto de maior risco técnico.

### PROIBIDO

Instalar:

```bash
npm install web-push
```

e assumir que funcionará no Worker.

A biblioteca tradicional `web-push` é orientada ao ambiente Node.js.

### ORDEM OBRIGATÓRIA

A IA deverá:

1. pesquisar biblioteca compatível com Workers/Edge;
2. verificar manutenção/reputação;
3. confirmar uso de Web Crypto;
4. verificar suporte a VAPID;
5. verificar suporte à criptografia Web Push;
6. testar com `wrangler dev`;
7. somente depois integrar.

O Workers runtime fornece Web Crypto via `crypto.subtle`, portanto a implementação deve preferir uma biblioteca compatível com esse ambiente ou uma implementação baseada diretamente nessas APIs. citeturn0search3

### Último recurso

Implementação manual baseada em:

- RFC 8291 — Web Push Encryption;
- RFC 8292 — VAPID.

Isso só poderá ocorrer se:

```text
biblioteca compatível
=
nenhuma solução confiável encontrada
```

e a implementação for acompanhada por testes criptográficos e testes reais de entrega.

**Não implementar criptografia manual por preferência ou conveniência.**

---

# 20. PAYLOAD DA NOTIFICAÇÃO

Payload mínimo:

```json
{
  "title": "BTC — Resistência rompida",
  "body": "BTCUSDT cruzou US$ 115.000",
  "url": "/",
  "symbol": "BTCUSDT",
  "level": 115000,
  "direction": "RESISTANCE"
}
```

Não colocar segredos no payload.

Não colocar VAPID private key.

Não colocar informações sensíveis.

---

# 21. CRON

Configuração inicial:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

O Cron usa UTC.

A IA deve considerar isso ao interpretar horários de logs e testes.

O intervalo de 5 minutos é um parâmetro inicial, não uma garantia de precisão de cinco minutos.

Cloudflare confirma que Cron Triggers executam um handler `scheduled()` e usam expressões cron em UTC. citeturn0search11

---

# 22. HANDLER SCHEDULED

Fluxo:

```text
scheduled()
   ↓
carregar alert configs
   ↓
filtrar enabled
   ↓
obter preços necessários
   ↓
carregar estados necessários
   ↓
avaliar crossover
   ↓
se NÃO cruzou
    não enviar
   ↓
se cruzou
    verificar estado
   ↓
se já disparado
    não enviar
   ↓
se novo disparo
    enviar Web Push
   ↓
persistir estado
```

Nunca enviar Push simplesmente porque:

```text
currentPrice >= resistance
```

Isso causaria repetição a cada Cron.

É necessário detectar a transição.

---

# 23. CONCORRÊNCIA E DUPLICAÇÃO

O sistema deve considerar que duas execuções não devem produzir duas notificações para o mesmo evento.

A IA deverá avaliar cuidadosamente a consistência do estado em KV.

Não assumir que:

```text
read → evaluate → write
```

é uma transação atômica.

Se houver risco real de concorrência ou execução duplicada, implementar uma estratégia idempotente adequada.

Para o primeiro estágio de uso pessoal, a solução deve ser simples e robusta, não excessivamente complexa.

---

# 24. LIMITES DO FREE TIER

Valores de referência atuais:

### Workers Free

- 100.000 requests/dia;
- 10 ms de CPU por request;
- 10 ms de CPU por Cron Trigger;
- 50 subrequests por request;
- 5 Cron Triggers por conta.

citeturn0search1

### KV Free

- 100.000 leituras/dia;
- 1.000 escritas/dia;
- 1.000 deletes/dia;
- 1.000 list operations/dia;
- 1 GB de armazenamento.

citeturn0search0turn0search4

Um Cron de cinco minutos equivale aproximadamente a:

```text
12 execuções/hora
288 execuções/dia
```

Portanto, para uso pessoal e poucos ativos, o volume básico é pequeno.

A arquitetura não deve, porém, consumir KV de forma desnecessária.

---

# 25. LIMITAÇÃO IMPORTANTE DO WORKER FREE

A IA deve observar o limite de CPU do Cron.

O plano Free possui CPU de 10 ms por execução de Cron. citeturn0search1

Portanto:

**não implementar processamento pesado no Cron.**

Evitar:

- análise histórica;
- cálculo complexo;
- processamento de milhares de eventos;
- reconstrução do mercado;
- ingestão completa da Binance;
- loops desnecessários;
- múltiplas consultas redundantes.

O Worker de Push deve ser pequeno e determinístico.

---

# 26. SEGURANÇA DO ENDPOINT

Os endpoints do Worker não devem ser abertos de forma ingênua.

A IA deverá avaliar proteção contra:

- spam de subscriptions;
- gravação arbitrária no KV;
- payload malformado;
- abuso de `/alerts/sync`;
- criação ilimitada de alertas.

Para uso pessoal, pode ser implementada uma autenticação simples e segura apropriada ao contexto atual do projeto.

**Não expor uma API de administração aberta na internet.**

---

# 27. SEGURANÇA VAPID

Checklist obrigatório antes de cada deploy:

```text
[ ] VAPID_PUBLIC_KEY pode estar no client
[ ] VAPID_PRIVATE_KEY está somente em Secret
[ ] private key não aparece no git diff
[ ] private key não aparece nos logs
[ ] private key não aparece no bundle
[ ] private key não aparece em resposta HTTP
```

---

# 28. FASE 5 — TESTES

Não testar tudo simultaneamente.

## 5.1 Service Worker

```text
[ ] sw.js carregado
[ ] Service Worker registrado
[ ] Service Worker activated
[ ] push handler executável
[ ] notificationclick executável
```

## 5.2 Subscription

```text
[ ] permissão granted
[ ] subscription criada
[ ] POST /subscribe = 200
[ ] subscription presente no KV
```

## 5.3 Push

Antes de conectar o motor de alertas:

```text
[ ] enviar push de teste
[ ] desktop recebe
[ ] Android recebe
[ ] iPhone recebe quando instalado como Home Screen Web App
```

## 5.4 Alerta

Depois:

```text
[ ] criar alerta
[ ] sincronizar alerta
[ ] Worker recebe configuração
[ ] preço é obtido
[ ] crossover é detectado
[ ] Push é enviado
[ ] estado é persistido
[ ] segunda execução não repete o Push
```

---

# 29. TESTE DE NÃO-REPETIÇÃO

Este teste é obrigatório.

Simular:

```text
resistance = 100
previous = 99
current = 101
```

Primeira execução:

```text
DISPARO = SIM
```

Persistir estado.

Segunda execução com:

```text
previous = 101
current = 101.5
```

Resultado:

```text
DISPARO = NÃO
```

Sem esse teste, a implementação não está aprovada.

---

# 30. TESTE DE RESET/REARME

O comportamento deve seguir a política do motor existente.

Não inventar uma regra diferente.

Testar:

```text
abaixo da resistência
      ↓
cruza resistência
      ↓
DISPARA
      ↓
permanece acima
      ↓
NÃO REPETE
      ↓
rearme conforme política existente
      ↓
novo cruzamento
      ↓
novo disparo
```

---

# 31. TESTE DE OFFLINE / BACKGROUND

### Desktop

```text
[ ] site aberto
[ ] Push funcionando
[ ] fechar aba
[ ] disparar Push
[ ] receber notificação
```

### Android

```text
[ ] instalar/abrir PWA
[ ] conceder permissão
[ ] fechar aplicação
[ ] bloquear tela
[ ] disparar Push
[ ] receber notificação
```

### iPhone

```text
[ ] adicionar à Tela de Início
[ ] abrir pela Home Screen
[ ] tocar "Ativar alertas"
[ ] conceder permissão
[ ] fechar app
[ ] bloquear tela
[ ] disparar Push
[ ] receber notificação
```

Web Push para Home Screen Web Apps é suportado no iOS/iPadOS a partir da versão 16.4. citeturn0search2turn0search7

---

# 32. O QUE A IA NÃO DEVE FAZER

## Proibido

- [ ] substituir `GlobalAlertContext`;
- [ ] remover `useLivePrices`;
- [ ] remover alertas em primeiro plano;
- [ ] remover som/vibração existentes;
- [ ] criar um segundo motor com regras diferentes;
- [ ] colocar VAPID private key no código;
- [ ] colocar VAPID private key no Git;
- [ ] assumir que `web-push` tradicional roda no Worker;
- [ ] implementar criptografia manual sem esgotar alternativas compatíveis;
- [ ] pular checkpoints;
- [ ] criar API administrativa aberta;
- [ ] gravar preço a cada tick no KV;
- [ ] enviar Push em todos os ciclos em que o preço permanece acima/abaixo do nível;
- [ ] transformar Cron em falsa promessa de realtime;
- [ ] alterar a lógica atual de S/R sem autorização;
- [ ] alterar a política atual de retriggering sem autorização.

---

# 33. ORDEM OBRIGATÓRIA DE IMPLEMENTAÇÃO

```text
FASE 0
  ↓
CHECKPOINT HUMANO
  ↓
FASE 1 — VAPID
  ↓
CHECKPOINT DE SEGURANÇA
  ↓
FASE 2 — PWA
  ↓
CHECKPOINT SERVICE WORKER
  ↓
FASE 3 — SUBSCRIPTION
  ↓
CHECKPOINT PUSH MANUAL
  ↓
FASE 4 — WORKER/KV
  ↓
CHECKPOINT /subscribe
  ↓
FASE 4.5 — WEB PUSH NO WORKER
  ↓
CHECKPOINT PUSH REAL
  ↓
SINCRONIZAÇÃO DOS ALERTAS
  ↓
CHECKPOINT CONFIGURAÇÃO
  ↓
CRON
  ↓
CHECKPOINT CROSSOVER
  ↓
TESTE DE NÃO-REPETIÇÃO
  ↓
TESTES MOBILE
  ↓
DEPLOY
```

A IA não pode pular diretamente para a fase final.

---

# 34. CHECKPOINTS OBRIGATÓRIOS DA IA

Ao terminar cada fase, a IA deverá informar:

```text
FASE:
ARQUIVOS ALTERADOS:
ARQUIVOS CRIADOS:
DEPENDÊNCIAS ADICIONADAS:
TESTES EXECUTADOS:
RESULTADO DOS TESTES:
RISCOS IDENTIFICADOS:
SEGURANÇA:
PRÓXIMA FASE:
```

E deverá parar.

Não continuar automaticamente para a próxima fase.

---

# 35. CRITÉRIOS DE ACEITAÇÃO FINAL

O sistema somente será considerado concluído quando:

```text
[ ] PWA instalável
[ ] Service Worker ativo
[ ] subscription funcionando
[ ] VAPID configurado
[ ] private key protegida
[ ] KV funcionando
[ ] alert configuration sincronizada
[ ] Worker obtendo preço
[ ] crossover direcional correto
[ ] Push enviado
[ ] estado persistido
[ ] retrigger não duplicado
[ ] desktop testado
[ ] Android testado
[ ] iPhone testado
[ ] alertas foreground preservados
[ ] GlobalAlertContext preservado
[ ] useLivePrices preservado
[ ] nenhum segredo no Git
```

---

# 36. DECISÃO ARQUITETURAL FINAL

A arquitetura aprovada é:

```text
                    ┌───────────────────────────┐
                    │       PAINEL WEB          │
                    │                           │
                    │ GlobalAlertContext        │
                    │ AlertEngine               │
                    │ useLivePrices             │
                    └─────────────┬─────────────┘
                                  │
                         alerta / configuração
                                  │
                  ┌───────────────┴───────────────┐
                  │                               │
                  ▼                               ▼
          MOTOR REALTIME                    SINCRONIZAÇÃO
          WebSocket                         Worker API
                  │                               │
                  ▼                               ▼
          alerta foreground                  Cloudflare KV
          imediato                           configurações
                                                  │
                                                  ▼
                                         Cloudflare Cron
                                           a cada 5 min
                                                  │
                                                  ▼
                                          preço + estado
                                                  │
                                                  ▼
                                             Web Push
                                                  │
                                                  ▼
                                         Service Worker
                                                  │
                                                  ▼
                                           NOTIFICAÇÃO
```

## Regra final

**O navegador continua sendo o sistema realtime.**

**O Worker é o sistema de background.**

**KV é armazenamento de configuração/estado, não banco de ticks.**

**Cron é fallback periódico, não realtime.**

**Web Push é canal de entrega, não motor de decisão.**

**GlobalAlertContext continua sendo a referência funcional da lógica de alertas.**

---

# 37. REFERÊNCIAS TÉCNICAS A VERIFICAR DURANTE A IMPLEMENTAÇÃO

A IA deve consultar a documentação oficial atual antes de tomar decisões sobre limites ou APIs:

- Cloudflare Workers Limits;
- Cloudflare Workers Cron Triggers;
- Cloudflare Workers KV Limits/Pricing;
- Cloudflare Workers Web Crypto;
- Web Push / Push API;
- WebKit Web Push para iOS/iPadOS.

Os limites Cloudflare utilizados nesta especificação foram conferidos em agosto de 2026. Workers Free informa 100.000 requests/dia e 5 Cron Triggers por conta; KV Free informa 100.000 leituras/dia e 1.000 escritas/dia. citeturn0search1turn0search0turn0search4

---

# 38. STATUS

```text
ARQUITETURA: DEFINIDA
FOREGROUND ALERTS: PRESERVADOS
BACKGROUND PUSH: PLANEJADO
PWA: PLANEJADO
WORKER: PLANEJADO
KV: PLANEJADO
VAPID: PLANEJADO
WEB PUSH: REQUER VALIDAÇÃO DE IMPLEMENTAÇÃO EDGE
CRON: PLANEJADO
SEGURANÇA: CHECKPOINT OBRIGATÓRIO
IMPLEMENTAÇÃO: NÃO INICIAR ALÉM DA FASE AUTORIZADA
```

**Primeira autorização operacional:** executar somente Fase 0 e Fase 1. Parar e apresentar o checkpoint antes de continuar.
