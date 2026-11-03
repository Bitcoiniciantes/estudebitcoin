import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const ticker = fs.readFileSync(new URL('../assets/js/ticker-widget.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('B3 permite um extra temporário e exige login para o próximo', () => {
  assert.match(ticker, /var B3_FIXED_ASSETS = B3_ASSETS\.slice\(\);/);
  assert.match(ticker, /var b3AdditionalAssets = \[\];/);
  assert.match(ticker, /b3AdditionalAssets\.length \+ Object\.keys\(b3ValidationPending\)\.length >= 8/);
  assert.match(ticker, /function getB3Assets\(\)/);
  assert.match(ticker, /if \(!user && b3AdditionalAssets\.length >= 1\)/);
  assert.match(ticker, /EstudeAuth\.openModal\("login"\)/);
  assert.match(ticker, /var b3VisitorExtra = \[\];/);
  assert.match(ticker, /b3PreferencesLoading = true/);
});

test('regex B3 aceita ações, units, ETFs, FIIs e B3SA3', () => {
  const re = /^[A-Z][A-Z0-9]{3}[0-9]{1,2}$/;
  for (const value of ['B3SA3', 'PETR4', 'BPAC11', 'BOVA11', 'HGLG11']) assert.match(value, re);
  assert.match(ticker, /var B3_TICKER_RE = \/\^\[A-Z\]\[A-Z0-9\]\{3\}\[0-9\]\{1,2\}\$\//);
});

test('B3 usa a lista dinâmica em cotações, refresh e RSI', () => {
  assert.match(ticker, /function fetchB3\(assets\)/);
  assert.match(ticker, /fetchB3\(assets\)/);
  assert.match(ticker, /var rsiAssets = tab === "b3" \? assets : STOCKS/);
  assert.match(ticker, /var key = tab \+ "\\|" \+ win \+ \(tab === "b3" \? "\\|" \+ signature : ""\)/);
});

test('validação de cotação é isolada do cache, RSI e ticker-price', () => {
  assert.match(ticker, /window=24h/);
  assert.match(ticker, /typeof quote\.price === "number" && Number\.isFinite\(quote\.price\) && quote\.price > 0/);
  const validation = ticker.slice(ticker.indexOf('function validateAndAddB3'), ticker.indexOf('function card'));
  assert.doesNotMatch(validation, /broadcastQuotes|rsiMemo|cache\[/);
});

test('UI B3 tem contador, inclusão, remoção somente de extras e acessibilidade', () => {
  assert.match(html, /id="b3-custom-controls"/);
  assert.match(html, /id="b3-count">8\/16</);
  assert.match(html, /id="b3-add-input"/);
  assert.match(html, /id="b3-add-button"/);
  assert.match(html, /id="b3-login-link"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(ticker, /function removeB3Extra\(symbol\)/);
  assert.match(ticker, /isFixedB3\(symbol\)/);
  assert.match(ticker, /setAttribute\("aria-label", "Remover /);
});

test('visitante recebe um extra temporário e a sessão limpa ao recarregar/logout', () => {
  assert.match(ticker, /var canEdit = !b3PreferencesLoading && \(user \? b3AdditionalAssets\.length < 8 : true\)/);
  assert.match(ticker, /b3AdditionalAssets = mergeB3Extras\(snapshot && snapshot\.val\(\), b3VisitorExtra\)/);
  assert.match(ticker, /b3VisitorExtra = \[\];/);
  assert.match(ticker, /b3AdditionalAssets = \[\];/);
});

test('persistência B3 usa UID, fila serializada e não usa storage local', () => {
  assert.match(ticker, /users\/" \+ uid \+ "\/preferences\/b3AdditionalSymbols/);
  assert.match(ticker, /var b3WriteQueues = \{\};/);
  assert.match(ticker, /b3WriteQueues\[uid\] = queue\.then/);
  assert.doesNotMatch(ticker, /localStorage|sessionStorage|document\.cookie/);
  assert.match(ticker, /estudebitcoin:auth-change/);
});

test('Auth reutiliza a inicialização existente para fornecer o Database', () => {
  const auth = fs.readFileSync(new URL('../assets/js/auth.js', import.meta.url), 'utf8');
  assert.match(auth, /getDatabase: function \(\)/);
  assert.match(auth, /return ensureFirebase\(\)\.then/);
  assert.match(auth, /return fb \? fb\.database\(\) : null/);
});
