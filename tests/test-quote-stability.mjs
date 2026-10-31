import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeQuote, exchangeDateKey } from '../cloudflare/bitcoiniciantes-ia/src/index.js';

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
});

function compileCurrent(raw, cfg) {
  return legacyComputeQuote(raw, cfg);
}
