import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { computePreMarketEstimates } from '../cloudflare/bitcoiniciantes-ia/src/index.js';

const ts = (value) => Math.floor(Date.parse(value) / 1000);

function chart(symbol, { preStart, regularStart, regularEnd, previousStart, previousEnd, points }) {
  return {
    meta: {
      symbol,
      exchangeTimezoneName: 'America/New_York',
      currentTradingPeriod: {
        pre: { start: preStart, end: regularStart },
        regular: { start: regularStart, end: regularEnd },
      },
      tradingPeriods: previousStart && previousEnd ? [[{ start: previousStart, end: previousEnd }]] : [],
    },
    timestamp: points.map((point) => point[0]),
    indicators: { quote: [{ close: points.map((point) => point[1]) }] },
  };
}

function sparkFixture({
  now = ts('2026-11-13T13:00:00Z'),
  preStart = ts('2026-11-13T09:00:00Z'),
  regularStart = ts('2026-11-13T14:30:00Z'),
  regularEnd = ts('2026-11-13T21:00:00Z'),
  previousStart = ts('2026-11-12T14:30:00Z'),
  previousEnd = ts('2026-11-12T21:00:00Z'),
  officialClose = 6000,
  futureReference = 6100,
  futureCurrent = 6161,
  futureCurrentTime = now - 300,
  omitReference = false,
} = {}) {
  const common = { preStart, regularStart, regularEnd, previousStart, previousEnd };
  const index = chart('^GSPC', {
    ...common,
    points: [[previousEnd, officialClose]],
  });
  const futurePoints = [];
  if (!omitReference) futurePoints.push([previousEnd, futureReference]);
  futurePoints.push([futureCurrentTime, futureCurrent]);
  const future = chart('ES=F', { ...common, points: futurePoints });
  return {
    now,
    raw: {
      spark: {
        result: [
          { symbol: '^GSPC', response: [index] },
          { symbol: 'ES=F', response: [future] },
        ],
      },
    },
  };
}

test('pré-mercado calcula índice estimado pela variação do futuro', () => {
  const fixture = sparkFixture();
  const estimate = computePreMarketEstimates(fixture.raw, fixture.now * 1000)['^GSPC'];
  assert.ok(estimate);
  assert.equal(estimate.future, 'ES=F');
  assert.equal(estimate.changePct, 1);
  assert.equal(estimate.price, 6060);
});

test('pregão regular e pós-mercado não produzem estimativa', () => {
  const regular = sparkFixture({ now: ts('2026-11-13T15:00:00Z'), futureCurrentTime: ts('2026-11-13T14:59:00Z') });
  const post = sparkFixture({ now: ts('2026-11-13T22:00:00Z'), futureCurrentTime: ts('2026-11-13T21:59:00Z') });
  assert.deepEqual(Object.keys(computePreMarketEstimates(regular.raw, regular.now * 1000)), []);
  assert.deepEqual(Object.keys(computePreMarketEstimates(post.raw, post.now * 1000)), []);
});

test('fim de semana e feriado não são confundidos com pré-mercado', () => {
  const mondayPre = ts('2026-11-16T09:00:00Z');
  const mondayOpen = ts('2026-11-16T14:30:00Z');
  const weekend = sparkFixture({
    now: ts('2026-11-15T15:00:00Z'), preStart: mondayPre, regularStart: mondayOpen,
    regularEnd: ts('2026-11-16T21:00:00Z'), futureCurrentTime: ts('2026-11-15T14:59:00Z'),
  });
  const holiday = sparkFixture({
    now: ts('2026-12-25T15:00:00Z'), preStart: ts('2026-12-28T09:00:00Z'),
    regularStart: ts('2026-12-28T14:30:00Z'), regularEnd: ts('2026-12-28T21:00:00Z'),
    futureCurrentTime: ts('2026-12-25T14:59:00Z'),
  });
  assert.deepEqual(Object.keys(computePreMarketEstimates(weekend.raw, weekend.now * 1000)), []);
  assert.deepEqual(Object.keys(computePreMarketEstimates(holiday.raw, holiday.now * 1000)), []);
});

test('timestamps do Yahoo cobrem horário de verão sem horário UTC fixo', () => {
  const fixture = sparkFixture({
    now: ts('2026-03-09T12:00:00Z'),
    preStart: ts('2026-03-09T08:00:00Z'),
    regularStart: ts('2026-03-09T13:30:00Z'),
    regularEnd: ts('2026-03-09T20:00:00Z'),
    previousStart: ts('2026-03-06T14:30:00Z'),
    previousEnd: ts('2026-03-06T21:00:00Z'),
    futureCurrentTime: ts('2026-03-09T11:55:00Z'),
  });
  assert.ok(computePreMarketEstimates(fixture.raw, fixture.now * 1000)['^GSPC']);
});

test('fechamento antecipado usa o fim de sessão informado pelo Yahoo', () => {
  const fixture = sparkFixture({
    now: ts('2026-11-30T13:00:00Z'),
    preStart: ts('2026-11-30T09:00:00Z'),
    regularStart: ts('2026-11-30T14:30:00Z'),
    regularEnd: ts('2026-11-30T21:00:00Z'),
    previousStart: ts('2026-11-27T14:30:00Z'),
    previousEnd: ts('2026-11-27T18:00:00Z'),
    futureCurrentTime: ts('2026-11-30T12:55:00Z'),
  });
  assert.ok(computePreMarketEstimates(fixture.raw, fixture.now * 1000)['^GSPC']);
});

test('futuro desatualizado ou referência ausente mantém cotação oficial', () => {
  const stale = sparkFixture({ futureCurrentTime: ts('2026-11-13T12:49:59Z') });
  const missing = sparkFixture({ omitReference: true });
  assert.deepEqual(Object.keys(computePreMarketEstimates(stale.raw, stale.now * 1000)), []);
  assert.deepEqual(Object.keys(computePreMarketEstimates(missing.raw, missing.now * 1000)), []);
});

test('front-end mantém estimativa separada e restrita a card(), STOCKS e 24H', () => {
  const source = fs.readFileSync(new URL('../assets/js/ticker-widget.js', import.meta.url), 'utf8');
  const cardStart = source.indexOf('function card(quote)');
  const cardEnd = source.indexOf('function fetchCrypto()', cardStart);
  const cardSource = source.slice(cardStart, cardEnd);
  const broadcastStart = source.indexOf('function broadcastQuotes(quotes)');
  const broadcastEnd = source.indexOf('function refresh(force)', broadcastStart);
  assert.match(source, /var preMarketEstimates = \{\}/);
  assert.match(cardSource, /activeTab === "stocks" && activeWindow === "24h"/);
  assert.match(cardSource, /quote\.symbol === "\^GSPC" \|\| quote\.symbol === "\^NDX"/);
  assert.match(cardSource, /PRÉ · FUT/);
  assert.doesNotMatch(source.slice(broadcastStart, broadcastEnd), /preMarketEstimates/);
});

test('Worker usa um único endpoint em lote e somente na janela 24H', () => {
  const source = fs.readFileSync(new URL('../cloudflare/bitcoiniciantes-ia/src/index.js', import.meta.url), 'utf8');
  assert.match(source, /windowKey === "24h" && PRE_MARKET_FUTURES\[symbol\]/);
  assert.match(source, /v7\/finance\/spark\?symbols=/);
  assert.match(source, /sparkSymbols\.join\(","\)/);
});
