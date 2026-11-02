import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { computeQuote, exchangeDateKey } from '../cloudflare/bitcoiniciantes-ia/src/index.js';

const TICKER_SRC = fs.readFileSync(new URL('../assets/js/ticker-widget.js', import.meta.url), 'utf8');

const TZ_NY = 'America/New_York';
const TZ_B3 = 'America/Sao_Paulo';
const NOW_A = Date.parse('2026-10-30T23:59:00Z');
const NOW_B = Date.parse('2026-10-31T01:07:00Z');
const WINDOWS = {
  '24h': { windowMs: 24 * 60 * 60 * 1000 },
  '7d': { windowMs: 7 * 24 * 60 * 60 * 1000 },
  '30d': { windowMs: 30 * 24 * 60 * 60 * 1000 },
  '90d': { windowMs: 90 * 24 * 60 * 60 * 1000 },
  '1y': { windowMs: 365 * 24 * 60 * 60 * 1000 },
  '3y': { windowMs: 1096 * 24 * 60 * 60 * 1000 },
};
const EXPECTED = {
  SNDK: { '24h': -13.47, '7d': -7.04, '30d': -33.85, '90d': -5.26, '1y': 487.73 },
  NVDA: { '24h': -4.22, '7d': -3.0, '30d': -10.39, '90d': 1.94, '1y': 0.86 },
};

function ts(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}
function round2(value) {
  return Math.round(value * 100) / 100;
}
function point(iso, close) {
  return { time: ts(iso), close };
}
function replaceLast(points, close) {
  return points.map((item, index) => (index === points.length - 1 ? { ...item, close } : item));
}
function dailyPoints(count, lastIso = '2026-10-31T13:30:00Z') {
  const last = Date.parse(lastIso);
  return Array.from({ length: count }, (_, index) => {
    const time = new Date(last - (count - 1 - index) * 24 * 60 * 60 * 1000).toISOString();
    return point(time, 100 + index);
  });
}
function makeRaw(points, meta = {}) {
  return {
    chart: {
      result: [
        {
          meta: { exchangeTimezoneName: TZ_NY, currency: 'USD', ...meta },
          timestamp: points.map((item) => item.time),
          indicators: {
            quote: [
              {
                close: points.map((item) => item.close),
                volume: points.map(() => 1000),
              },
            ],
          },
        },
      ],
    },
  };
}
function computeAll(raw, symbol, nowMs) {
  const out = {};
  for (const [windowKey, cfg] of Object.entries(WINDOWS)) {
    const quote = computeQuote(raw, symbol, cfg, nowMs);
    out[windowKey] = quote ? { price: quote.price, changePct: quote.changePct, closes: quote.closes } : null;
  }
  return out;
}
function assertWindowValues(actual, expected) {
  for (const [windowKey, value] of Object.entries(expected)) {
    assert.equal(round2(actual[windowKey].changePct), value, `${windowKey} changePct`);
  }
}
function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = original;
  }
}
function legacyComputeQuote(raw, cfg) {
  const result = raw.chart.result[0];
  const timestamps = result.timestamp;
  const closes = result.indicators.quote[0].close;
  const points = timestamps
    .map((time, index) => ({ time, close: closes[index] }))
    .filter((item) => Number.isFinite(item.close));
  const last = points[points.length - 1];
  const baseTime = last.time - cfg.windowMs / 1000;
  let base = points[0];
  for (const item of points) {
    if (item.time <= baseTime) base = item;
    else break;
  }
  if (base.time >= last.time) base = points[Math.max(0, points.length - 2)] || base;
  return {
    price: last.close,
    changePct: base.close ? ((last.close - base.close) / base.close) * 100 : 0,
  };
}

const SNDK_POINTS = [
  point('2025-10-29T13:30:00Z', 204.36),
  point('2025-10-30T13:30:00Z', 195.82),
  point('2026-07-31T13:30:00Z', 1214.83),
  point('2026-09-29T13:30:00Z', 1729.76),
  point('2026-09-30T13:30:00Z', 1739.89),
  point('2026-10-22T13:30:00Z', 1260.93),
  point('2026-10-23T13:30:00Z', 1238.03),
  point('2026-10-28T13:30:00Z', 1404.77),
  point('2026-10-29T13:30:00Z', 1330.05),
  point('2026-10-30T13:30:00Z', 1150.89),
];
const NVDA_POINTS = [
  point('2025-10-29T13:30:00Z', 207.04),
  point('2025-10-30T13:30:00Z', 202.89),
  point('2026-07-31T13:30:00Z', 200.75),
  point('2026-09-29T13:30:00Z', 227.21),
  point('2026-09-30T13:30:00Z', 228.38),
  point('2026-10-22T13:30:00Z', 212.21),
  point('2026-10-23T13:30:00Z', 210.96),
  point('2026-10-28T13:30:00Z', 215.38),
  point('2026-10-29T13:30:00Z', 213.66),
  point('2026-10-30T13:30:00Z', 204.64),
];
const META_SNDK = { symbol: 'SNDK', regularMarketPrice: 1150.89, regularMarketTime: ts('2026-10-30T20:00:00Z') };
const META_NVDA = { symbol: 'NVDA', regularMarketPrice: 204.64, regularMarketTime: ts('2026-10-30T20:00:01Z') };

describe('estabilidade de preço e base das cotações', () => {
  it('1. snapshots A e B de SNDK e NVDA em todas as janelas', () => {
    const fixtures = [
      ['SNDK', SNDK_POINTS, META_SNDK],
      ['NVDA', NVDA_POINTS, META_NVDA],
    ];
    for (const [symbol, points, meta] of fixtures) {
      const snapshotA = computeAll(makeRaw(points, meta), symbol, NOW_A);
      const snapshotB = computeAll(makeRaw(replaceLast(points, null), meta), symbol, NOW_B);
      assertWindowValues(snapshotA, EXPECTED[symbol]);
      assertWindowValues(snapshotB, EXPECTED[symbol]);
      assert.equal(snapshotA['1y'].price, meta.regularMarketPrice);
      assert.equal(snapshotB['1y'].price, meta.regularMarketPrice);
    }
  });

  it('2. último candle com fechamento válido mantém a saída atual', () => {
    const raw = makeRaw(SNDK_POINTS, META_SNDK);
    for (const [windowKey, cfg] of Object.entries(WINDOWS)) {
      const current = compileCurrent(raw, cfg);
      const quote = computeQuote(raw, 'SNDK', cfg, NOW_A);
      assert.equal(quote.price, current.price, `${windowKey} price`);
      assert.equal(quote.changePct, current.changePct, `${windowKey} changePct`);
    }
  });

  it('3. último candle nulo, não finito ou <= 0 é preenchido com regularMarketPrice', () => {
    for (const invalidClose of [null, NaN, 0, -1]) {
      const raw = makeRaw(replaceLast(SNDK_POINTS, invalidClose), META_SNDK);
      const quote = computeQuote(raw, 'SNDK', WINDOWS['1y'], NOW_B);
      assert.equal(quote.price, 1150.89);
      assert.equal(round2(quote.changePct), 487.73);
    }
  });

  it('4. regularMarketTime em outra data descarta o candle e sinaliza', () => {
    const meta = { ...META_SNDK, regularMarketTime: ts('2026-10-29T20:00:00Z') };
    const raw = makeRaw(replaceLast(SNDK_POINTS, null), meta);
    const { value: quote, warnings } = captureWarnings(() => computeQuote(raw, 'SNDK', WINDOWS['1y'], NOW_B));
    assert.equal(quote.price, 1330.05);
    assert.equal(round2(quote.changePct), 550.84);
    assert.ok(warnings.some((line) => line.includes('data do candle')), warnings.join('\n'));

    const invalidTime = captureWarnings(() =>
      computeQuote(
        makeRaw(replaceLast(SNDK_POINTS, null), { ...META_SNDK, regularMarketTime: NaN }),
        'SNDK',
        WINDOWS['1y'],
        NOW_B,
      ),
    );
    assert.equal(invalidTime.value.price, 1330.05);
    assert.ok(invalidTime.warnings.some((line) => line.includes('regularMarketTime invalido')), invalidTime.warnings.join('\n'));
  });

  it('5. regularMarketPrice inválido não preenche', () => {
    for (const invalidPrice of [NaN, 0, -1]) {
      const meta = { ...META_SNDK, regularMarketPrice: invalidPrice };
      const raw = makeRaw(replaceLast(SNDK_POINTS, null), meta);
      const { value: quote, warnings } = captureWarnings(() => computeQuote(raw, 'SNDK', WINDOWS['1y'], NOW_B));
      assert.equal(quote.price, 1330.05);
      assert.equal(round2(quote.changePct), 550.84);
      assert.ok(warnings.some((line) => line.includes('regularMarketPrice invalido')), warnings.join('\n'));
    }
  });

  it('6. candle parcial durante o pregão entra normalmente', () => {
    const raw = makeRaw(SNDK_POINTS, META_SNDK);
    const { value: quote, warnings } = captureWarnings(() => computeQuote(raw, 'SNDK', WINDOWS['1y'], Date.parse('2026-10-30T18:00:00Z')));
    assert.equal(quote.price, 1150.89);
    assert.equal(round2(quote.changePct), 487.73);
    assert.equal(warnings.length, 0);
  });

  it('7. sábado, domingo e feriado mantêm a base e o % do último pregão', () => {
    const raw = makeRaw(SNDK_POINTS, META_SNDK);
    const friday = computeQuote(raw, 'SNDK', WINDOWS['1y'], NOW_A);
    const saturday = computeQuote(raw, 'SNDK', WINDOWS['1y'], Date.parse('2026-10-31T15:00:00Z'));
    const sunday = computeQuote(raw, 'SNDK', WINDOWS['1y'], Date.parse('2026-11-01T15:00:00Z'));
    assert.equal(saturday.price, friday.price);
    assert.equal(saturday.changePct, friday.changePct);
    assert.equal(sunday.price, friday.price);
    assert.equal(sunday.changePct, friday.changePct);

    const holidayPoints = [
      point('2025-12-24T14:30:00Z', 100),
      point('2026-12-24T14:30:00Z', 120),
    ];
    const holidayRaw = makeRaw(holidayPoints, {
      symbol: 'HOLIDAY',
      regularMarketPrice: 120,
      regularMarketTime: ts('2026-12-24T18:00:00Z'),
    });
    const beforeHoliday = computeQuote(holidayRaw, 'HOLIDAY', WINDOWS['1y'], Date.parse('2026-12-24T23:59:00Z'));
    const holiday = computeQuote(holidayRaw, 'HOLIDAY', WINDOWS['1y'], Date.parse('2026-12-25T15:00:00Z'));
    assert.equal(holiday.price, beforeHoliday.price);
    assert.equal(holiday.changePct, beforeHoliday.changePct);
  });

  it('8. consulta às 01:07Z em Nova York usa a data de 30/10', () => {
    assert.equal(exchangeDateKey(ts('2026-10-31T01:07:00Z'), TZ_NY), '2026-10-30');
    const raw = makeRaw(replaceLast(SNDK_POINTS, null), META_SNDK);
    const quote = computeQuote(raw, 'SNDK', WINDOWS['1y'], NOW_B);
    assert.equal(quote.price, 1150.89);
    assert.equal(round2(quote.changePct), 487.73);
  });

  it('9. transições de horário de verão em março e novembro', () => {
    assert.equal(exchangeDateKey(ts('2026-03-08T06:59:00Z'), TZ_NY), '2026-03-08');
    assert.equal(exchangeDateKey(ts('2026-03-08T07:00:00Z'), TZ_NY), '2026-03-08');
    assert.equal(exchangeDateKey(ts('2026-11-01T05:59:00Z'), TZ_NY), '2026-11-01');
    assert.equal(exchangeDateKey(ts('2026-11-01T06:00:00Z'), TZ_NY), '2026-11-01');

    const marchRaw = makeRaw(
      [point('2025-03-07T14:30:00Z', 100), point('2026-03-09T13:30:00Z', null)],
      { symbol: 'DST-MAR', regularMarketPrice: 110, regularMarketTime: ts('2026-03-09T20:00:00Z') },
    );
    const novemberRaw = makeRaw(
      [point('2025-10-31T13:30:00Z', 100), point('2026-11-02T14:30:00Z', null)],
      { symbol: 'DST-NOV', regularMarketPrice: 110, regularMarketTime: ts('2026-11-02T21:00:00Z') },
    );
    assert.equal(computeQuote(marchRaw, 'DST-MAR', WINDOWS['1y'], Date.parse('2026-03-09T21:00:00Z')).price, 110);
    assert.equal(computeQuote(novemberRaw, 'DST-NOV', WINDOWS['1y'], Date.parse('2026-11-02T22:00:00Z')).price, 110);
  });

  it('10. B3, futuros e índice', () => {
    const itub = makeRaw(
      [point('2025-10-30T13:00:00Z', 30), point('2026-10-30T13:00:00Z', null)],
      { symbol: 'ITUB4.SA', exchangeTimezoneName: TZ_B3, regularMarketPrice: 38.69, regularMarketTime: ts('2026-10-30T20:00:00Z') },
    );
    const itubQuote = computeQuote(itub, 'ITUB4.SA', WINDOWS['1y'], NOW_B);
    assert.equal(itubQuote.price, 38.69);
    assert.equal(round2(itubQuote.changePct), 28.97);

    const gc = makeRaw(
      [point('2025-10-30T04:00:00Z', 4000), point('2026-10-30T04:00:00Z', null)],
      { symbol: 'GC=F', regularMarketPrice: 3884.9, regularMarketTime: ts('2026-10-30T23:59:59Z') },
    );
    const gcQuote = computeQuote(gc, 'GC=F', WINDOWS['1y'], NOW_B);
    assert.equal(gcQuote.price, 3884.9);
    assert.equal(round2(gcQuote.changePct), -2.88);

    const bz = makeRaw(
      [point('2025-10-30T04:00:00Z', 100), point('2026-10-30T04:00:00Z', null)],
      { symbol: 'BZ=F', regularMarketPrice: 112.33, regularMarketTime: ts('2026-10-30T23:59:57Z') },
    );
    assert.equal(computeQuote(bz, 'BZ=F', WINDOWS['1y'], NOW_B).price, 112.33);

    const spx = makeRaw(
      [point('2025-10-30T13:30:00Z', 7000), point('2026-10-30T13:30:00Z', 7580.07)],
      { symbol: '^GSPC', regularMarketPrice: 7580.07, regularMarketTime: ts('2026-10-30T20:47:43Z') },
    );
    const spxQuote = computeQuote(spx, '^GSPC', WINDOWS['1y'], NOW_B);
    assert.equal(spxQuote.price, 7580.07);
    assert.equal(round2(spxQuote.changePct), 8.29);
  });

  it('11. Intl indisponível ou fuso inválido cai para UTC sem erro', () => {
    const originalIntl = globalThis.Intl;
    try {
      globalThis.Intl = undefined;
      assert.equal(exchangeDateKey(ts('2026-10-30T20:00:00Z'), TZ_NY), '2026-10-30');
    } finally {
      globalThis.Intl = originalIntl;
    }
    assert.equal(exchangeDateKey(ts('2026-10-30T20:00:00Z'), 'Invalid/Zone'), '2026-10-30');

    const raw = makeRaw(replaceLast(SNDK_POINTS, null), { ...META_SNDK, exchangeTimezoneName: 'Invalid/Zone' });
    assert.doesNotThrow(() => computeQuote(raw, 'SNDK', WINDOWS['1y'], NOW_B));
    assert.equal(computeQuote(raw, 'SNDK', WINDOWS['1y'], NOW_B).price, 1150.89);
  });

  it('12. preço do card e changePct usam o mesmo candle', () => {
    const filled = computeQuote(makeRaw(replaceLast(SNDK_POINTS, null), META_SNDK), 'SNDK', WINDOWS['1y'], NOW_B);
    assert.equal(filled.price, 1150.89);
    assert.equal(filled.closes.at(-1), filled.price);
    assert.equal(round2(filled.changePct), round2(((filled.price - 195.82) / 195.82) * 100));

    const { value: discarded } = captureWarnings(() =>
      computeQuote(
        makeRaw(replaceLast(SNDK_POINTS, null), { ...META_SNDK, regularMarketTime: ts('2026-10-29T20:00:00Z') }),
        'SNDK',
        WINDOWS['1y'],
        NOW_B,
      ),
    );
    assert.equal(discarded.price, 1330.05);
    assert.equal(discarded.closes.at(-1), discarded.price);
    assert.equal(round2(discarded.changePct), round2(((discarded.price - 204.36) / 204.36) * 100));
  });

  it('13. assetQuotes captura nowMs uma vez e exporta helpers sem alterar o default', () => {
    const source = fs.readFileSync(new URL('../cloudflare/bitcoiniciantes-ia/src/index.js', import.meta.url), 'utf8');
    assert.ok(source.includes('const nowMs = Date.now();'));
    assert.ok(source.includes('computeQuote(raw, symbol, item, nowMs)'));
    assert.ok(source.includes('export { rlKeyFor, rlTtlSeconds, FUND_RL_LIMIT, computeQuote, exchangeDateKey };'));
    assert.ok(source.includes('export default {'));
  });

  it('14. marca histórico curto somente nas janelas longas e preserva changePct', () => {
    const short = computeQuote(makeRaw(dailyPoints(120)), 'SHORT', WINDOWS['1y'], NOW_B);
    assert.equal(short.shortHistory, true);
    assert.equal(round2(short.changePct), 119);

    const complete = computeQuote(makeRaw(dailyPoints(400)), 'COMPLETE', WINDOWS['1y'], NOW_B);
    assert.equal('shortHistory' in complete, false);

    const exactBase = [
      point('2025-10-31T13:30:00Z', 100),
      point('2026-10-31T13:30:00Z', 200),
    ];
    const exact = computeQuote(makeRaw(exactBase), 'EXACT', WINDOWS['1y'], NOW_B);
    assert.equal('shortHistory' in exact, false);

    const weekendBase = [
      point('2025-10-31T13:30:00Z', 100),
      point('2026-11-02T14:30:00Z', 200),
    ];
    const weekend = computeQuote(makeRaw(weekendBase), 'WEEKEND', WINDOWS['1y'], Date.parse('2026-11-02T21:00:00Z'));
    assert.equal('shortHistory' in weekend, false);

    assert.equal(computeQuote(makeRaw(dailyPoints(60)), 'SHORT90', WINDOWS['90d'], NOW_B).shortHistory, true);
    assert.equal(computeQuote(makeRaw(dailyPoints(15)), 'SHORT30', WINDOWS['30d'], NOW_B).shortHistory, true);
    for (const windowKey of ['24h', '7d']) {
      assert.equal('shortHistory' in computeQuote(makeRaw(dailyPoints(2)), windowKey, WINDOWS[windowKey], NOW_B), false);
    }
  });

  it('15. frontend esconde histórico curto sem convertê-lo em 0,00%', () => {
    assert.ok(TICKER_SRC.includes('quote.shortHistory === true ? null'), 'card usa ausência para histórico curto');
    assert.ok(TICKER_SRC.includes('delete cardChange1y[p]'), 'tabela limpa o 1Y anterior');
    assert.ok(TICKER_SRC.includes('Menos de 1 ano de histórico'), 'tabela informa o histórico curto no title');
  });
});

describe('janela 3y e caminho do shortHistory no front', () => {
  const Y3_LAST = '2026-10-30T13:30:00Z';
  const Y3_LAST_TS = ts(Y3_LAST);

  it('16. 3y ancora a base no último candle (last.time - 1096d), não em "agora"', () => {
    const points = [
      point('2023-09-01T13:30:00Z', 50),
      point('2023-10-27T13:30:00Z', 90),
      point('2023-10-31T13:30:00Z', 95),
      point(Y3_LAST, 180),
    ];
    const raw = makeRaw(points);
    const quote = computeQuote(raw, 'Y3', WINDOWS['3y'], Date.parse('2026-11-02T20:00:00Z'));
    assert.equal(quote.price, 180);
    // baseTime = 2023-10-30T13:30Z => base = candle de 27/10 (90). Se a base
    // fosse "agora - 1096d" (31/10 20:00Z) o candle de 31/10 (95) seria a base.
    assert.equal(quote.changePct, 100);
    assert.notEqual(quote.changePct, ((180 - 95) / 95) * 100);
    assert.equal(quote.shortHistory, undefined);
  });

  it('17. 3y em sábado, domingo e feriado mantém preço e % do último pregão', () => {
    const raw = makeRaw([point('2023-10-27T13:30:00Z', 100), point(Y3_LAST, 150)]);
    const friday = computeQuote(raw, 'Y3W', WINDOWS['3y'], Date.parse('2026-10-30T23:59:00Z'));
    const saturday = computeQuote(raw, 'Y3W', WINDOWS['3y'], Date.parse('2026-10-31T15:00:00Z'));
    const sunday = computeQuote(raw, 'Y3W', WINDOWS['3y'], Date.parse('2026-11-01T15:00:00Z'));
    assert.equal(friday.changePct, 50);
    assert.equal(saturday.price, friday.price);
    assert.equal(saturday.changePct, friday.changePct);
    assert.equal(sunday.price, friday.price);
    assert.equal(sunday.changePct, friday.changePct);

    const holidayRaw = makeRaw([point('2023-12-22T14:30:00Z', 80), point('2026-12-24T14:30:00Z', 120)]);
    const beforeHoliday = computeQuote(holidayRaw, 'Y3H', WINDOWS['3y'], Date.parse('2026-12-24T23:59:00Z'));
    const holiday = computeQuote(holidayRaw, 'Y3H', WINDOWS['3y'], Date.parse('2026-12-25T15:00:00Z'));
    assert.equal(beforeHoliday.changePct, 50);
    assert.equal(holiday.price, beforeHoliday.price);
    assert.equal(holiday.changePct, beforeHoliday.changePct);
  });

  it('18. 3y marca shortHistory só quando falta histórico (300 curto, longo e base exata sem flag)', () => {
    const short = computeQuote(makeRaw(dailyPoints(300)), 'SHORT3Y', WINDOWS['3y'], NOW_B);
    assert.equal(short.shortHistory, true);
    assert.equal(short.price, 399);

    const complete = computeQuote(makeRaw(dailyPoints(1200)), 'COMPLETE3Y', WINDOWS['3y'], NOW_B);
    assert.equal('shortHistory' in complete, false);

    const exactBase = [
      point('2023-10-30T13:30:00Z', 100),
      point(Y3_LAST, 200),
    ];
    const exact = computeQuote(makeRaw(exactBase), 'EXACT3Y', WINDOWS['3y'], NOW_B);
    assert.equal('shortHistory' in exact, false);
    assert.equal(exact.changePct, 100);
  });

  it('19. Worker -> fetchStocks -> card: 3y curto mostra preço e "—" com o title da janela', async () => {
    const { grid, cards, requests, clickTab, clickWindow } = mountTickerWidget();
    await settle();
    assert.ok(requests.some((u) => u.includes('window=24h')), 'boot busca 24h');

    clickTab('stocks');
    await settle();
    const after24h = cards.filter((c) => c.symbol === 'NVDA').at(-1);
    assert.equal('shortHistory' in after24h, false, '24h não cria shortHistory:false');

    clickWindow('3y');
    await settle();
    assert.ok(requests.some((u) => u.includes('window=3y')), 'pediu a janela 3y');
    const after3y = cards.filter((c) => c.symbol === 'NVDA').at(-1);
    assert.equal(after3y.shortHistory, true, 'shortHistory preservado no objeto do card');
    assert.equal(after3y.price, 204.64, 'preço continua disponível');
    assert.ok(grid.innerHTML.includes('>204,64<'), 'preço renderizado');
    assert.ok(grid.innerHTML.includes('title="Menos de 3 anos de histórico"'), 'title de 3 anos');
    assert.ok(grid.innerHTML.includes('>—</span>'), 'percentual vira —');
    assert.ok(grid.innerHTML.includes('class="tq flat"'), '— em cinza (flat)');

    clickWindow('1y');
    await settle();
    assert.ok(grid.innerHTML.includes('title="Menos de 1 ano de histórico"'), '1y mantém o texto anterior');
    assert.equal(cards.filter((c) => c.symbol === 'NVDA').at(-1).shortHistory, true);

    for (const win of ['7d', '30d', '90d']) {
      clickWindow(win);
      await settle();
      assert.equal('shortHistory' in cards.filter((c) => c.symbol === 'NVDA').at(-1), false, `${win} sem a propriedade`);
      assert.ok(!grid.innerHTML.includes('de histórico"'), `${win} sem title de histórico curto`);
    }
    assert.ok(grid.innerHTML.includes('>204,64<'), 'preço segue visível fora das janelas curtas');
  });

  it('20. 3Y só em STOCKS e sem estado residual ao voltar', async () => {
    const { buttons, requests, clickTab, clickWindow } = mountTickerWidget();
    await settle();
    assert.equal(buttons['3y'].hidden, true, '3Y oculto em CRIPTO');
    assert.equal(buttons['1y'].hidden, true, '1Y oculto em CRIPTO');

    clickTab('stocks');
    await settle();
    assert.equal(buttons['3y'].hidden, false, '3Y visível em STOCKS');
    assert.equal(buttons['1y'].hidden, false, '1Y visível em STOCKS');

    clickWindow('3y');
    await settle();
    assert.equal(buttons['3y'].classList.contains('active'), true, '3Y ativo');
    const before = requests.length;

    clickTab('crypto');
    await settle();
    assert.equal(buttons['3y'].hidden, true, 'CRIPTO oculta 3Y');
    assert.equal(buttons['24h'].classList.contains('active'), true, 'volta para 24h');
    const cryptoRequests = requests.slice(before);
    assert.ok(cryptoRequests.length > 0, 'CRIPTO buscou preços');
    assert.ok(!cryptoRequests.some((u) => u.includes('window=3y')), 'nenhuma request 3y em CRIPTO');
    assert.ok(!cryptoRequests.some((u) => u.includes('/api/quotes')), 'CRIPTO não usa /api/quotes');

    const beforeBack = requests.length;
    clickTab('stocks');
    await settle();
    assert.equal(buttons['3y'].hidden, false, 'STOCKS volta a mostrar 3Y');
    const back = requests.slice(beforeBack).filter((u) => u.includes('/api/quotes'));
    assert.ok(back.length > 0, 'STOCKS voltou a buscar');
    assert.ok(back.every((u) => u.includes('window=24h')), 'sem resíduo de 3y: volta em 24h');
  });
});

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function widgetButton(attrs) {
  const set = new Set();
  return {
    attrs,
    hidden: false,
    listeners: {},
    classList: {
      toggle(cls, on) { if (on) set.add(cls); else set.delete(cls); },
      contains(cls) { return set.has(cls); },
      add(cls) { set.add(cls); },
      remove(cls) { set.delete(cls); },
    },
    getAttribute(name) { return name in attrs ? attrs[name] : null; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    click() { (this.listeners.click || []).forEach((fn) => fn({ target: this })); },
  };
}

// Monta o ticker-widget REAL num contexto vm com DOM mínimo. O payload do
// Worker é criado DENTRO do contexto (mesmo Array.prototype) para observar o
// objeto do card que fetchStocks monta.
function mountTickerWidget() {
  const requests = [];
  const cards = [];
  const intervals = [];
  const buttons = {
    '1h': widgetButton({ 'data-window': '1h' }),
    '24h': widgetButton({ 'data-window': '24h' }),
    '7d': widgetButton({ 'data-window': '7d' }),
    '30d': widgetButton({ 'data-window': '30d' }),
    '90d': widgetButton({ 'data-window': '90d', 'data-only-tab': 'stocks' }),
    '1y': widgetButton({ 'data-window': '1y', 'data-only-tab': 'stocks' }),
    '3y': widgetButton({ 'data-window': '3y', 'data-only-tab': 'stocks' }),
  };
  const windowButtons = Object.values(buttons);
  const tabs = {
    crypto: widgetButton({ 'data-tab': 'crypto' }),
    stocks: widgetButton({ 'data-tab': 'stocks' }),
  };
  const tabButtons = Object.values(tabs);
  tabs.crypto.classList.add('active');
  buttons['24h'].classList.add('active');

  const grid = {
    innerHTML: '',
    style: {},
    parentNode: { insertBefore() {} },
    nextSibling: null,
    addEventListener() {},
    querySelector() { return null; },
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0 }; },
  };
  const status = { textContent: '' };
  const generic = () => ({
    value: '', textContent: '', title: '', style: {}, hidden: false,
    addEventListener() {}, querySelectorAll: () => [], setAttribute() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  });
  const els = { 'ticker-grid': grid, 'ticker-status': status };

  const sandbox = {
    console,
    navigator: {},
    CustomEvent: class {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    WebSocket: class { constructor() {} close() {} },
    fetch: (url) => {
      const target = String(url);
      requests.push(target);
      if (target.includes('/api/quotes')) {
        const win = /[?&]window=([^&]+)/.exec(target);
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sandbox.__payload(win ? win[1] : '24h')) });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
    },
    document: {
      readyState: 'complete',
      body: { appendChild() {}, removeChild() {} },
      getElementById: (id) => els[id] || (els[id] = generic()),
      querySelector: (sel) => {
        const m = /data-window="([^"]+)"/.exec(sel);
        return m ? buttons[m[1]] || null : null;
      },
      querySelectorAll: (sel) => {
        if (sel === '.ticker-window button') return windowButtons;
        if (sel === '.ticker-tabs button') return tabButtons;
        return [];
      },
      addEventListener() {},
      createElement: () => generic(),
    },
    window: {
      innerHeight: 800,
      addEventListener() {},
      dispatchEvent() {},
      setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
      setTimeout: () => 0,
      clearTimeout: () => {},
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Payload do Worker (mesmo formato de /api/quotes) criado no contexto.
  vm.runInContext(`globalThis.__payload = function (win) {
    var quotes = [
      { symbol: "NVDA", name: "NVIDIA", price: 204.64, changePct: 55.3, volume: 1000, closes: [1, 2, 3], currency: "USD" },
      { symbol: "GC=F", name: "OURO", price: 3884.9, changePct: 12.5, volume: 2000, closes: [1, 2, 3], currency: "USD" }
    ];
    if (win === "3y" || win === "1y") quotes[0].shortHistory = true;
    return { window: win, updatedAt: "2026-11-02T20:00:00.000Z", quotes: quotes };
  };`, sandbox);

  // Observa o objeto do card devolvido por fetchStocks (mesmo caminho real).
  const ctxArray = vm.runInContext('Array', sandbox);
  const originalMap = ctxArray.prototype.map;
  ctxArray.prototype.map = function (fn, thisArg) {
    return originalMap.call(this, function (value, index, arr) {
      const result = fn.call(thisArg, value, index, arr);
      if (result && typeof result === 'object' && !Array.isArray(result) && typeof result.symbol === 'string' && 'currency' in result) {
        cards.push(result);
      }
      return result;
    });
  };

  const source = fs.readFileSync(new URL('../assets/js/ticker-widget.js', import.meta.url), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'ticker-widget.js' });

  const clickTab = (name) => tabs[name].click();
  const clickWindow = (name) => buttons[name].click();
  return { grid, cards, requests, buttons, intervals, clickTab, clickWindow };
}

function compileCurrent(raw, cfg) {
  return legacyComputeQuote(raw, cfg);
}
