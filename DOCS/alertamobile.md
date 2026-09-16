# Correção de Alertas no Mobile

## 🎯 Objetivo
Corrigir 3 problemas que impedem os alertas de funcionar no mobile:

1. Áudio nunca é desbloqueado (falta gesto do usuário)
2. Sininho (`.tq-bell`) fica invisível (depende de `:hover`, que não existe em touch)
3. Falta feedback tátil (vibração) como reforço

---

## ⚠️ Regras gerais (seguir à risca)

- **NÃO reescrever arquivos inteiros.** Fazer apenas edições pontuais (find & replace cirúrgico).
- **NÃO remover** nenhuma chamada existente a `unlockAudio()` — apenas **adicionar** uma nova forma de chamá-la.
- Testar cada etapa isoladamente antes de passar para a próxima.
- Se algum trecho de código citado abaixo não bater 100% com o que existe no arquivo real, **parar e mostrar o trecho real encontrado**, em vez de adivinhar onde colar.

---

## Passo 1 — Desbloquear áudio no primeiro toque

**Arquivo:** o mesmo que contém a função `unlockAudio()` (provavelmente `dynamicSR.js`, verificar).

**Ação:** adicionar, próximo ao topo do arquivo (fora de qualquer função), um listener global que roda **uma única vez**:

```javascript
// Desbloqueia o AudioContext no primeiro toque/clique do usuário (necessário no mobile)
function unlockAudioOnFirstInteraction() {
  unlockAudio();
  document.removeEventListener('touchstart', unlockAudioOnFirstInteraction);
  document.removeEventListener('click', unlockAudioOnFirstInteraction);
}
document.addEventListener('touchstart', unlockAudioOnFirstInteraction, { once: true });
document.addEventListener('click', unlockAudioOnFirstInteraction, { once: true });
```

**Checklist de validação:**
- [ ] A função `unlockAudio()` já existe no arquivo (confirmar nome exato antes de colar).
- [ ] O código foi colado **fora** de qualquer outra função (nível raiz do arquivo).
- [ ] `{ once: true }` está presente (evita repetir o unlock a cada toque).
- [ ] Testar no celular: tocar em qualquer lugar da tela → depois verificar no console (`ctx.state`) se mudou de `"suspended"` para `"running"`.

---

## Passo 2 — Tornar o sininho visível no mobile

**Arquivo:** o CSS onde está definida a classe `.tq-bell` (provavelmente `.css` ou `<style>` dentro do HTML).

**Encontrar este bloco:**
```css
.tq-bell {
    opacity: 0;
    pointer-events: none;
}
.tq:hover .tq-bell {
    opacity: 1;
}
```

**Substituir por:**
```css
.tq-bell {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
}
.tq:hover .tq-bell {
    opacity: 1;
}

/* Mobile: sininho sempre visível quando há alerta ativo, sem depender de hover */
.tq.has-alert .tq-bell {
    opacity: 1;
    pointer-events: auto;
}

@media (hover: none) {
    .tq .tq-bell {
        opacity: 0.5;
        pointer-events: auto;
    }
}
```

**Explicação:**
- `.has-alert` é uma classe que precisa ser adicionada **via JavaScript** ao elemento `.tq` sempre que um alerta estiver ativo naquele card. Isso deve ser feito no mesmo ponto do código onde hoje o `alertFlash` já é disparado (buscar por `alertFlash` no JS).
- `@media (hover: none)` é a forma correta e moderna de detectar "dispositivo sem hover" (mais confiável que checar largura de tela).

**Checklist:**
- [ ] Localizar no JS onde `alertFlash` (ou equivalente) é ativado.
- [ ] Adicionar `elemento.classList.add('has-alert')` junto com o disparo do alerta.
- [ ] Adicionar `elemento.classList.remove('has-alert')` quando o alerta for desativado/resetado.
- [ ] Testar no celular: sininho deve aparecer com opacidade baixa sempre, e ficar 100% visível quando houver alerta.

---

## Passo 3 (opcional, mas recomendado) — Vibração como reforço tátil

**Arquivo:** onde o beep sonoro é disparado (buscar por `play()` ou nome da função de beep).

**Ação:** logo após a linha que toca o som, adicionar:

```javascript
// Feedback tátil no mobile (silencioso em desktop, que ignora navigator.vibrate)
if (navigator.vibrate) {
    navigator.vibrate(200);
}
```

**Checklist:**
- [ ] Confirmar que existe suporte condicional (`if (navigator.vibrate)`) para não quebrar em navegadores sem suporte.
- [ ] Não usar vibração muito longa (200ms é suficiente, evitar >500ms).

---

## 🧪 Teste final (fazer nesta ordem, no celular real — não emulador)

1. Abrir a página no celular.
2. Tocar em qualquer lugar da tela (isso deve silenciosamente desbloquear o áudio).
3. Forçar/aguardar um alerta disparar.
4. Confirmar, na ordem:
   - [ ] Som toca
   - [ ] Sininho aparece visível no card
   - [ ] Celular vibra (se Passo 3 implementado)
   - [ ] Card ainda pisca (`alertFlash`) normalmente

---

## 🚫 O que NÃO fazer

- Não criar um `AudioContext` novo separado do existente — apenas chamar o `unlockAudio()` já existente.
- Não trocar `:hover` por `:active` (isso resolveria só parcialmente e traria comportamento errado no desktop).
- Não remover o `pointer-events: none` da regra base `.tq-bell` — ele deve continuar lá para o estado "sem alerta".
