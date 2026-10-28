import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const V = require('../assets/js/widgets/volatility.js')._test;
const D = V.DAY;
const START = Date.UTC(2020, 0, 1);
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const LAST = V.expectedLastOpen(NOW);

function approx(actual, expected, eps = 1e-9) {
  return Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(actual), Math.abs(expected));
}

function candle(openTime, close) {
  return { openTime, close, closeTime: openTime + D - 1 };
}

function candlesFromCloses(closes, start = START) {
  return closes.map((close, index) => candle(start + index * D, close));
}

function rowsFromCandles(candles) {
  return candles.map((item) => [item.openTime, 0, 0, 0, item.close, 0, item.closeTime]);
}

function buildRows(lastOpen, missing) {
  const missingSet = new Set(Array.isArray(missing) ? missing : missing == null ? [] : [missing]);
  const rows = [];
  let index = 0;
  for (let openTime = V.HISTORY_START; openTime <= lastOpen; openTime += D) {
    if (!missingSet.has(openTime)) {
      rows.push([openTime, 0, 0, 0, 100 + (index % 50), 0, openTime + D - 1]);
    }
    index += 1;
  }
  return rows;
}

function createStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(String(key), String(value)); },
    removeItem(key) { data.delete(key); },
    data
  };
}

function createWorld(extra = {}) {
  return {
    now: NOW,
    serverNow: NOW,
    rows: buildRows(LAST),
    fail: 0,
    failOnEnded: false,
    hang: false,
    aborted: false,
    missing: null,
    omitMissingInOpenEnded: false,
    dateHeader: true,
    timeFail: false,
    timeInvalid: false,
    requests: 0,
    timeRequests: 0,
    ...extra
  };
}

function createFetch(world) {
  const calls = [];
  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.pathname === '/time') {
      world.timeRequests += 1;
      if (world.timeFail) {
        return {
          ok: false,
          status: 503,
          headers: { get() { return null; } },
          json: async () => ({})
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        json: async () => ({ serverTime: world.timeInvalid ? 'inválido' : world.serverNow })
      };
    }
    calls.push(url);
    world.requests += 1;
    if (world.hang) {
      return new Promise((resolve, reject) => {
        const signal = options.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => {
          world.aborted = true;
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    }
    if (world.fail > 0) {
      world.fail -= 1;
      return {
        ok: false,
        status: 500,
        headers: { get() { return null; } },
        json: async () => []
      };
    }
    const endParam = parsed.searchParams.get('endTime');
    if (world.failOnEnded && endParam != null) {
      return {
        ok: false,
        status: 500,
        headers: { get() { return null; } },
        json: async () => []
      };
    }
    const start = Number(parsed.searchParams.get('startTime'));
    const limit = Number(parsed.searchParams.get('limit'));
    const end = endParam == null ? null : Number(endParam);
    let rows = world.rows.filter((row) => row[0] >= start && (end == null || row[0] <= end));
    if (world.omitMissingInOpenEnded && end == null && world.missing != null) {
      const missingSet = new Set(Array.isArray(world.missing) ? world.missing : [world.missing]);
      rows = rows.filter((row) => !missingSet.has(row[0]));
    }
    rows = rows.slice(0, limit);
    return {
      ok: true,
      status: 200,
      headers: {
        get(name) {
          return world.dateHeader && String(name).toLowerCase() === 'date'
            ? new Date(world.serverNow).toUTCString()
            : null;
        }
      },
      json: async () => rows
    };
  }
  return { fetchImpl, calls };
}

function makeLoader(world, storage, extra = {}) {
  const fake = createFetch(world);
  const loader = V.createLoader({
    config: {
      api: {
        binanceVisionKlinesBase: 'https://fake.local/klines',
        binanceTimeUrl: 'https://fake.local/time'
      }
    },
    storage,
    fetchImpl: fake.fetchImpl,
    now: () => world.now,
    ...extra
  });
  return { loader, calls: fake.calls };
}

describe('computeWidths', () => {
  it('exige 20 candles e não calcula antes da janela completa', () => {
    const candles = candlesFromCloses(Array.from({ length: 19 }, () => 100));
    const widths = V.computeWidths(candles);
    assert.equal(widths.length, 19);
    assert.ok(widths.every((value) => value === null));
  });

  it('série constante produz largura zero', () => {
    const candles = candlesFromCloses(Array.from({ length: 20 }, () => 100));
    assert.equal(V.computeWidths(candles)[19], 0);
  });

  it('usa desvio-padrão populacional e a fórmula 4*DP/SMA', () => {
    const closes = Array.from({ length: 20 }, (_, index) => index + 1);
    const candles = candlesFromCloses(closes);
    const mean = 10.5;
    const variance = closes.reduce((sum, close) => sum + (close - mean) ** 2, 0) / 20;
    const expected = 4 * Math.sqrt(variance) / mean * 100;
    assert.ok(approx(V.computeWidths(candles)[19], expected));
  });

  it('não calcula janela que contém lacuna de dias', () => {
    const candles = candlesFromCloses(Array.from({ length: 21 }, (_, index) => index + 1));
    for (let index = 11; index < candles.length; index += 1) {
      candles[index] = candle(candles[index].openTime + D, candles[index].close);
    }
    const widths = V.computeWidths(candles);
    assert.equal(widths[19], null);
    assert.equal(widths[20], null);
  });
});

describe('faixas e próximos gatilhos', () => {
  it('aplica limites inferiores inclusivos e rótulos exatos', () => {
    assert.equal(V.getBand(4.999).key, 'max');
    assert.equal(V.getBand(5).key, 'very_compressed');
    assert.equal(V.getBand(5.995).key, 'very_compressed');
    assert.equal(V.getBand(5.999).key, 'very_compressed');
    assert.equal(V.getBand(6).key, 'compressed');
    assert.equal(V.getBand(7.999).key, 'compressed');
    assert.equal(V.getBand(8).key, 'watch');
    assert.equal(V.getBand(9.999).key, 'watch');
    assert.equal(V.getBand(10).key, 'outside');
    assert.equal(V.getBand(15).key, 'outside');
    assert.equal(V.getBand(-0.01), null);
    assert.equal(V.getBand(NaN), null);
    assert.equal(V.getBand(4.999).label, 'Alerta máximo de acompanhamento');
    assert.equal(V.getBand(5).label, 'Volatilidade muito comprimida');
    assert.equal(V.getBand(6).label, 'Compressão relevante');
    assert.equal(V.getBand(8).label, 'Acompanhar a evolução');
    assert.equal(V.getBand(10).label, 'Fora das faixas de compressão definidas');
  });

  it('mapeia gatilho de saída abaixo de 5 e gatilhos para baixo nas demais faixas', () => {
    assert.deepEqual(
      { ...V.getNextTrigger(4.999), distance: undefined, distancePct: undefined },
      { reference: 5, direction: 'up', kind: 'exit', distance: undefined, distancePct: undefined }
    );
    for (const [width, reference] of [[5, 5], [5.999, 5], [6, 6], [7.999, 6], [8, 8], [9.999, 8], [10, 10], [12, 10]]) {
      const trigger = V.getNextTrigger(width);
      assert.equal(trigger.reference, reference);
      assert.equal(trigger.direction, 'down');
      assert.equal(trigger.kind, 'trigger');
    }
  });

  it('calcula distância em pontos e percentual da largura', () => {
    const trigger = V.getNextTrigger(5.191650499135427);
    assert.ok(approx(trigger.distance, 0.191650499135427));
    assert.ok(approx(trigger.distancePct, 0.191650499135427 / 5.191650499135427 * 100));
    assert.equal(V.getNextTrigger(0).distancePct, null);
    assert.equal(V.getNextTrigger(-1), null);
  });
});

describe('episódios', () => {
  function widthsFor(values) {
    return values;
  }

  it('identifica início após fechamento no limiar e mantém episódio ativo', () => {
    const candles = candlesFromCloses([7, 5, 7, 5, 5].map((value) => 100 + value));
    const result = V.findEpisodes(candles, widthsFor([7, 5, 7, 5, 5]), 6);
    assert.equal(result.episodes.length, 2);
    assert.equal(result.episodes[0].startIndex, 1);
    assert.equal(result.episodes[0].active, false);
    assert.equal(result.episodes[1].startIndex, 3);
    assert.equal(result.episodes[1].active, true);
    assert.equal(result.excluded.length, 0);
  });

  it('exclui primeiro valor abaixo como pré-histórico e depois aceita sinal', () => {
    const candles = candlesFromCloses([100, 100, 100, 100, 100]);
    const result = V.findEpisodes(candles, [5, 7, 7, 7, 5], 6);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].reason, 'pre_history');
    assert.equal(result.excluded[0].openTime, candles[0].openTime);
    assert.equal(result.episodes.length, 1);
    assert.equal(result.episodes[0].startIndex, 4);
  });

  it('interrompe episódio em lacuna e não confirma transição após lacuna', () => {
    const candles = [
      candle(START, 100),
      candle(START + D, 100),
      candle(START + 2 * D, 100),
      candle(START + 4 * D, 100),
      candle(START + 5 * D, 100)
    ];
    const result = V.findEpisodes(candles, [7, 5, 5, 5, 5], 6);
    assert.equal(result.episodes.length, 1);
    assert.equal(result.episodes[0].active, false);
    assert.equal(result.episodes[0].interrupted, true);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].reason, 'gap_unconfirmed');
    assert.equal(result.excluded[0].openTime, candles[3].openTime);
  });

  it('trata primeiro valor finito após lacuna como não confirmado', () => {
    const candles = [
      candle(START, 100),
      candle(START + D, 100),
      candle(START + 2 * D, 100)
    ];
    const result = V.findEpisodes(candles, [7, null, 5], 6);
    assert.equal(result.episodes.length, 0);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].reason, 'gap_unconfirmed');
  });
});

describe('resumo e horizontes', () => {
  it('calcula mediana, extremos, neutros e movimentos absolutos >= 10', () => {
    assert.deepEqual(V.summarize([]), {
      n: 0, median: null, min: null, max: null,
      abs10: 0, positive: 0, negative: 0, neutral: 0
    });
    assert.deepEqual(V.summarize([1, 2, 3]), {
      n: 3, median: 2, min: 1, max: 3,
      abs10: 0, positive: 3, negative: 0, neutral: 0
    });
    assert.equal(V.summarize([1, 2, 3, 4]).median, 2.5);
    const result = V.summarize([-10, 0, 10, 9.999]);
    assert.equal(result.abs10, 2);
    assert.equal(result.positive, 2);
    assert.equal(result.negative, 1);
    assert.equal(result.neutral, 1);
  });

  it('detecta sobreposição com fronteira exata de h dias', () => {
    assert.equal(V.windowsOverlap(0, 7 * D - 1, 7), true);
    assert.equal(V.windowsOverlap(0, 7 * D, 7), false);
    assert.equal(V.windowsOverlap(0, 8 * D, 7), false);
  });

  it('seleciona amostra sem sobreposição aceitando exatamente h dias', () => {
    const items = [0, 7, 14].map((days) => ({ episode: { startTime: days * D }, value: days }));
    assert.deepEqual(V.selectNonOverlapping(items, 7).map((item) => item.episode.startTime), [0, 7 * D, 14 * D]);
    const closeItems = [0, 6, 13].map((days) => ({ episode: { startTime: days * D }, value: days }));
    assert.deepEqual(V.selectNonOverlapping(closeItems, 7).map((item) => item.episode.startTime), [0, 13 * D]);
  });

  it('calcula retornos close-to-close e contabiliza janelas completas', () => {
    const closes = [100, 101, 102, 103, 104, 105, 106, 110, 108, 107, 100, 99, 98, 97, 120];
    const candles = candlesFromCloses(closes);
    const episodes = [
      { startTime: candles[0].openTime },
      { startTime: candles[7].openTime }
    ];
    const stats = V.computeHorizonStats(episodes, candles, 7);
    assert.equal(stats.identified, 2);
    assert.equal(stats.eligible, 2);
    assert.equal(stats.complete, 2);
    assert.equal(stats.overlap, 0);
    assert.equal(stats.nonOverlapN, 2);
    assert.ok(approx(stats.completeReturns[0], 10));
    assert.ok(approx(stats.completeReturns[1], 120 / 110 * 100 - 100));
  });

  it('conta sobreposição e reduz a subamostra', () => {
    const closes = [100, 101, 102, 103, 104, 105, 100, 110, 108, 107, 100, 99, 98, 120];
    const candles = candlesFromCloses(closes);
    const episodes = [
      { startTime: candles[0].openTime },
      { startTime: candles[6].openTime }
    ];
    const stats = V.computeHorizonStats(episodes, candles, 7);
    assert.equal(stats.complete, 2);
    assert.equal(stats.overlap, 2);
    assert.equal(stats.nonOverlapN, 1);
    assert.equal(stats.incomplete, 0);
    assert.equal(stats.complete - stats.nonOverlapN, 1);
    assert.equal(stats.frequencyAllowed, false);
  });

  it('não usa janela com lacuna interna', () => {
    const candles = [
      candle(0, 100), candle(D, 101), candle(2 * D, 102),
      candle(4 * D, 103), candle(5 * D, 104), candle(6 * D, 105),
      candle(7 * D, 110), candle(8 * D, 111)
    ];
    const stats = V.computeHorizonStats([{ startTime: 0 }], candles, 7);
    assert.equal(stats.eligible, 1);
    assert.equal(stats.complete, 0);
    assert.equal(stats.eligibleIncomplete, 1);
    assert.equal(stats.incomplete, 1);
  });

  it('marca frequência indisponível com n < 20 e disponível com n >= 20', () => {
    const candles = candlesFromCloses(Array.from({ length: 160 }, (_, index) => 100 + index % 7));
    const episodes = [];
    for (let day = 0; day < 140; day += 7) episodes.push({ startTime: candles[day].openTime });
    const stats = V.computeHorizonStats(episodes, candles, 7);
    assert.equal(stats.nonOverlapN, 20);
    assert.equal(stats.frequencyAllowed, true);
    assert.equal(stats.positive + stats.negative + stats.neutral, stats.nonOverlapN);
  });
});

describe('horizontes', () => {
  it('usa horizontes fixos de 7, 14 e 30 dias no calculo e na interface', () => {
    assert.deepEqual(V.HORIZONS, [7, 14, 30]);
    const candles = candlesFromCloses(Array.from({ length: 120 }, () => 100));
    const model = V.computeModel(candles);
    assert.deepEqual(model.horizons.map((item) => item.horizon), [7, 14, 30]);
  });
});

describe('modelo e eventos manuais', () => {
  it('mantém o valor atual no último candle e não usa candle anterior', () => {
    const closes = Array.from({ length: 30 }, (_, index) => 100 + index);
    const candles = candlesFromCloses(closes);
    const widths = V.computeWidths(candles);
    const model = V.computeModel(candles);
    assert.equal(model.current, widths[29]);
    assert.equal(model.currentTime, candles[29].openTime);
    assert.equal(model.chart.at(-1).width, widths[29]);
  });

  it('usa limiar fixo de 6% mesmo quando a faixa atual é outra', () => {
    const closes = Array.from({ length: 20 }, (_, index) => index < 10 ? 98.375 : 101.625);
    const model = V.computeModel(candlesFromCloses(closes));
    assert.ok(approx(model.current, 6.5));
    assert.equal(model.band.key, 'compressed');
    assert.equal(model.threshold, 6);
    assert.equal(model.episodes.length, 0);
    assert.equal(model.excluded.length, 0);
  });

  it('não calcula indicador quando a janela atual tem lacuna', () => {
    const candles = candlesFromCloses(Array.from({ length: 30 }, () => 100));
    candles[25] = candle(candles[25].openTime + D, candles[25].close);
    const model = V.computeModel(candles);
    assert.equal(model.current, null);
    assert.equal(model.band, null);
    assert.equal(model.horizons.length, 0);
  });

  it('preserva os quatro registros manuais e não inventa ano em mês', () => {
    assert.equal(V.MANUAL_EVENTS.length, 4);
    assert.deepEqual(V.MANUAL_EVENTS.map((event) => [event.label, event.value]), [
      ['17/08/2026', 4.2],
      ['27/10/2026', 5.09],
      ['Janeiro', 4.43],
      ['Junho', 8.45]
    ]);
    const month = V.MANUAL_EVENTS.find((event) => event.label === 'Janeiro');
    assert.equal(month.year, null);
    assert.equal(month.date, null);
    assert.equal(V.manualTimestamp(month), null);
    assert.equal(V.manualTimestamp(V.MANUAL_EVENTS[0]), Date.UTC(2026, 7, 17));
  });
});

describe('formatação visual', () => {
  it('renderiza o percentual com sinal visual e leitura acessível', () => {
    const html = V.pctHtml(5.143161);
    assert.match(html, /5,14/);
    assert.match(html, /class="vol-pct-sign" aria-hidden="true">%</);
    assert.match(html, /class="vol-sr-only"> por cento/);
    assert.match(V.pctHtml(-2.5, true), /-2,50/);
    assert.match(V.pctHtml(2.5, true), /\+2,50/);
  });

  it('flexiona ponto e pontos no singular e no plural', () => {
    assert.equal(V.fmtPoints(1), '1,00 ponto');
    assert.equal(V.fmtPoints(2.5), '2,50 pontos');
    assert.equal(V.fmtPoints(0), '0,00 pontos');
    assert.equal(V.fmtPoints(-1, true), '-1,00 ponto');
  });

  it('informa distância sem prefixo positivo e com a largura atual', () => {
    const model = {
      current: 5.191650499135427,
      currentTime: NOW,
      band: V.getBand(5.191650499135427),
      nextTrigger: V.getNextTrigger(5.191650499135427)
    };
    const html = V.topHtml(model, {
      checkedAt: NOW,
      timeSource: 'server',
      timeSourceMethod: 'server-time',
      persistenceAvailable: true
    });
    assert.match(html, /0,19 ponto/);
    assert.match(html, /3,69/);
    assert.match(html, /da largura atual/);
    assert.match(html, /Não é previsão nem preço-alvo/);
    assert.ok(!/\(\+/.test(html));
    assert.ok(!html.includes('O percentual é relativo à largura atual'));
  });
});

describe('card recolhido', () => {
  const model = V.computeModel(candlesFromCloses(Array.from({ length: 120 }, () => 100)));
  const meta = {
    status: 'fresh',
    checkedAt: NOW,
    timeSource: 'server',
    timeSourceMethod: 'server-time',
    persistenceAvailable: true,
    gaps: []
  };

  it('inicia recolhido, com botão real e atributos aria corretos', () => {
    const html = V.cardHtml(model, meta);
    assert.match(html, /<button type="button" class="vol-expand-toggle" id="vol-expand-toggle" aria-expanded="false" aria-controls="vol-expand-region">Ver detalhes <span class="vol-expand-icon" aria-hidden="true">\+<\/span><\/button>/);
    assert.match(html, /<div class="vol-expand-region" id="vol-expand-region" hidden>/);
    assert.match(html, /data-vol-chart-host/);
    assert.ok(!html.includes('vol-chart-svg'));
    assert.match(html, /O que aconteceu após episódios semelhantes/);
    assert.match(html, /O percentual é relativo à largura atual/);
  });

  it('alterna o texto do botão e o aria-expanded ao abrir', () => {
    const html = V.detailsToggleHtml(true);
    assert.match(html, /aria-expanded="true"/);
    assert.match(html, /aria-controls="vol-expand-region"/);
    assert.match(html, /Ocultar detalhes <span class="vol-expand-icon" aria-hidden="true">−<\/span>/);
    assert.equal(V.detailsToggleContent(false), 'Ver detalhes <span class="vol-expand-icon" aria-hidden="true">+</span>');
  });
});

describe('gráfico e textos do card', () => {
  function chartModel(endTime, maxWidth, lastWidth) {
    const start = endTime - 89 * D;
    const chart = Array.from({ length: 90 }, (_, index) => ({
      openTime: start + index * D,
      width: 5 + (index % 5)
    }));
    chart[45].width = maxWidth;
    chart[89].width = lastWidth;
    return { chart, current: lastWidth, currentTime: chart[89].openTime };
  }

  function axisLabelYs(svg) {
    return [...svg.matchAll(/data-threshold="[^"]+"[^>]*y="([^"]+)"/g)]
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b);
  }

  it('limita o eixo em 15 e sinaliza o pico cortado', () => {
    const html = V.chartSvg(chartModel(Date.UTC(2026, 7, 29), 25, 7));
    assert.equal(V.CHART_AXIS_MAX, 15);
    assert.match(html, /data-axis-max="15"/);
    assert.match(html, /data-clipped="true"/);
    assert.match(html, /vol-clip-marker/);
    assert.match(html, /Pico acima de 15% \(cortado no topo\)/);
  });

  it('não sinaliza corte quando todos os pontos cabem no eixo', () => {
    const html = V.chartSvg(chartModel(Date.UTC(2026, 7, 29), 12, 7));
    assert.match(html, /data-clipped="false"/);
    assert.ok(!html.includes('vol-clip-marker'));
  });

  it('mantém pelo menos 12 px livres entre rótulos do eixo na largura mínima', () => {
    const html = V.chartSvg(chartModel(Date.UTC(2026, 7, 29), 12, 7));
    const ys = axisLabelYs(html);
    assert.equal(ys.length, 4);
    const renderedCenterGap = (ys[1] - ys[0]) * V.CHART_MIN_RENDERED_WIDTH / V.CHART_VIEWBOX_WIDTH;
    assert.ok(ys[1] - ys[0] >= V.CHART_MIN_LABEL_GAP - 0.05);
    assert.ok(renderedCenterGap - 9 >= 12);
  });

  it('separa o losango manual do último candle com linha-guia', () => {
    const end = Date.UTC(2026, 9, 27);
    const html = V.chartSvg(chartModel(end, 12, 5.09));
    const circle = html.match(/class="vol-current-dot" cx="([^"]+)"/);
    const manual = html.match(/data-manual-label="27\/10\/2026" data-manual-x="([^"]+)"/);
    assert.ok(circle && manual);
    assert.ok(Number(circle[1]) - Number(manual[1]) >= 18);
    assert.match(html, /vol-manual-stem/);
  });

  it('usa "Sem janela completa" por horizonte e singulariza o episódio ativo', () => {
    const base = {
      horizon: 7,
      identified: 22,
      incomplete: 1,
      complete: 21,
      overlap: 4,
      nonOverlapN: 19,
      median: 0.8,
      min: -13.83,
      max: 23.01,
      abs10: 2,
      positive: 10,
      negative: 9,
      neutral: 0,
      frequencyAllowed: true
    };
    const html = V.horizonCard(base);
    assert.match(html, /Sem janela completa: 1 \(episódio ativo\)/);
    assert.ok(!html.includes('janelas completas'));
    assert.match(html, /0,80/);
    assert.match(V.horizonCard({ ...base, incomplete: 2 }), /2 \(inclui episódio ativo\)/);
    assert.match(V.horizonCard({ ...base, incomplete: 0 }), /Sem janela completa: 0 ·/);
  });

  it('usa "métricas distintas" quando a data manual coincide com o candle', () => {
    const html = V.manualSectionHtml({ current: 5.14, currentTime: Date.UTC(2026, 9, 27) });
    assert.match(html, /Diferença<\/span><strong>-0,05 pontos<\/strong><small>métricas distintas<\/small>/);
    assert.match(html, /5,09/);
    assert.match(html, /por cento/);
  });

  it('descreve as faixas em texto e informa o host do horário no fallback', () => {
    const html = V.methodologyHtml({ timeSource: 'server', timeSourceMethod: 'server-time' });
    assert.match(html, /de 5,00 até abaixo de 6,00/);
    assert.match(html, /de 6,00 até abaixo de 8,00/);
    assert.match(html, /de 8,00 até abaixo de 10,00/);
    assert.match(html, /data-api\.binance\.vision\/api\/v3\/time/);
    assert.ok(!html.includes('x &lt; 5'));
    assert.match(V.timeSourceShort({ timeSource: 'local' }), /sem horário válido de data-api\.binance\.vision/);
    assert.match(V.timeSourceDetail({ timeSource: 'local' }), /fallback após falha ou horário inválido em data-api\.binance\.vision/);
  });
});

describe('mensagens de erro', () => {
  it('traduz falhas de rede e HTTP sem expor mensagem técnica crua', () => {
    assert.equal(
      V.userFacingError('Failed to fetch'),
      'Não foi possível acessar a Binance. Verifique a conexão e tente novamente.'
    );
    assert.equal(
      V.userFacingError('HTTP 503'),
      'A Binance está instável no momento. Tente novamente em alguns instantes.'
    );
    assert.match(V.userFacingError('HTTP 451'), /^A Binance recusou a consulta/);
    assert.equal(
      V.userFacingError('A Binance ainda não publicou o candle fechado mais recente.'),
      'A Binance ainda não publicou o candle fechado mais recente.'
    );
    assert.equal(
      V.userFacingError('A consulta a Binance excedeu o tempo limite'),
      'A Binance não respondeu dentro do tempo limite. Tente novamente em alguns instantes.'
    );
  });
});

describe('tempo e cache', () => {
  it('usa exclusivamente o host data-api.binance.vision por padrão', () => {
    assert.equal(V.DEFAULT_KLINES_BASE, 'https://data-api.binance.vision/api/v3/klines');
    assert.equal(V.DEFAULT_TIME_URL, 'https://data-api.binance.vision/api/v3/time');
  });

  it('calcula o último candle fechado em UTC', () => {
    assert.equal(V.expectedLastOpen(NOW), LAST);
    assert.equal(V.expectedLastOpen(Date.UTC(2026, 9, 27, 0, 1)), Date.UTC(2026, 9, 26));
  });

  it('aceita Date do servidor e usa fallback conservador quando inválido', () => {
    assert.deepEqual(V.resolveReference(NOW, NOW - 1000), { now: NOW - 1000, source: 'server' });
    const fallback = V.resolveReference(NOW, NOW - 8 * D);
    assert.deepEqual(fallback, { now: NOW - V.LOCAL_FALLBACK_SAFETY_MS, source: 'local-fallback' });
    assert.equal(V.resolveReference(NOW, null).source, 'local-fallback');
    assert.equal(V.resolveReference(NOW, NOW + 2 * D).source, 'local-fallback');
  });

  it('normaliza, ordena, deduplica, descarta parcial e limita candles', () => {
    const rows = [
      [2 * D, 0, 0, 0, 102, 0, 3 * D - 1],
      [D, 0, 0, 0, 101, 0, 2 * D - 1],
      [D, 0, 0, 0, 201, 0, 2 * D - 1],
      [3 * D, 0, 0, 0, 103, 0, 4 * D - 1],
      [4 * D, 0, 0, 0, 104, 0, 5 * D - 1]
    ];
    const normalized = V.normalizeCandles(rows, 4 * D, { limit: 2 });
    assert.deepEqual(normalized.map((item) => item.openTime), [2 * D, 3 * D]);
    assert.deepEqual(normalized.map((item) => item.close), [102, 103]);
  });

  it('prioriza a ocorrência mais recente em duplicatas de candle', () => {
    const rows = [
      [START, 0, 0, 0, 100, 0, START + D - 1],
      [START, 0, 0, 0, 200, 0, START + D - 1]
    ];
    const normalized = V.normalizeCandles(rows, START + D);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].close, 200);
    const merged = V.mergeCandles([candle(START, 100)], [candle(START, 200)]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].close, 200);
  });

  it('valida e serializa cache sem perder a identidade dos candles', () => {
    const candles = candlesFromCloses([100, 101, 102], START);
    const cache = V.makeCache(candles, { now: NOW, source: 'server' }, NOW - 1000);
    const record = V.serializeCache(cache);
    assert.equal(record.v, V.CACHE_VERSION);
    assert.equal(record.candles.length, 3);
    assert.equal(record.candles[0].length, 2);
    const validated = V.validateCacheRecord(record, NOW);
    assert.equal(validated.ok, true);
    assert.deepEqual(validated.cache.candles, candles);
  });

  it('rejeita cache com versão, formato ou último candle inválido', () => {
    const candles = candlesFromCloses([100, 101], START);
    const record = V.serializeCache(V.makeCache(candles, { now: NOW, source: 'server' }, NOW));
    assert.equal(V.validateCacheRecord({ ...record, v: 99 }, NOW).ok, false);
    assert.equal(V.validateCacheRecord({ ...record, candles: null }, NOW).ok, false);
    assert.equal(V.validateCacheRecord({ ...record, lastClosedOpenTime: START }, NOW).ok, false);
    assert.equal(V.validateCacheRecord({ ...record, candles: [] }, NOW).ok, false);
  });

  it('lê, grava e informa indisponibilidade de armazenamento', () => {
    const storage = createStorage();
    const candles = candlesFromCloses([100, 101], START);
    const cache = V.makeCache(candles, { now: NOW, source: 'server' }, NOW);
    assert.equal(V.writeCache(storage, cache), true);
    assert.equal(V.readCache(storage, NOW).reason, 'ok');
    assert.equal(V.readCache(storage, NOW).cache.candles.length, 2);
    assert.equal(V.readCache(null, NOW).persistenceAvailable, false);
    storage.setItem(V.CACHE_KEY, '{');
    assert.equal(V.readCache(storage, NOW).reason, 'invalid_json');
  });

  it('planeja carga completa, incremental, fresca e manual', () => {
    const candles = candlesFromCloses([100, 101], LAST);
    const cache = V.makeCache(candles, { now: NOW, source: 'server' }, NOW);
    assert.equal(V.planRefresh(null, LAST, false).mode, 'full');
    assert.equal(V.planRefresh(cache, LAST, false).mode, 'none');
    assert.equal(V.planRefresh(cache, LAST, true).reason, 'manual');
    const stale = V.makeCache(candlesFromCloses([100], LAST - D), { now: NOW, source: 'server' }, NOW);
    assert.equal(V.planRefresh(stale, LAST, false).reason, 'stale');
    const gapCandles = candlesFromCloses([100, 101, 102], LAST - 3 * D);
    gapCandles.splice(1, 1);
    const withGap = V.makeCache(gapCandles, { now: NOW, source: 'server' }, NOW);
    assert.equal(V.planRefresh(withGap, LAST, false).reason, 'gap');
  });
});

describe('loader e persistência', () => {
  it('carrega histórico completo em 4 requisições e não repete no mesmo dia', async () => {
    const world = createWorld();
    const storage = createStorage();
    const { loader, calls } = makeLoader(world, storage);
    const first = await loader.load();
    assert.equal(first.status, 'updated');
    assert.equal(first.requests, 4);
    assert.equal(calls.length, 4);
    assert.equal(first.cache.candles.length, 3358);
    assert.equal(first.cache.candles.at(-1).openTime, LAST);
    assert.equal(first.timeSource, 'server');
    assert.equal(first.timeSourceMethod, 'date-header');
    assert.equal(first.persistenceAvailable, true);
    assert.ok(storage.getItem(V.CACHE_KEY));

    const second = await loader.load();
    assert.equal(second.status, 'fresh');
    assert.equal(second.timeSourceMethod, 'cache');
    assert.equal(second.requests, 0);
    assert.equal(calls.length, 4);
  });

  it('atualiza incrementalmente no dia seguinte com uma requisição', async () => {
    const world = createWorld();
    const storage = createStorage();
    const { loader, calls } = makeLoader(world, storage);
    await loader.load();
    world.now = NOW + D;
    world.serverNow = NOW + D;
    world.rows.push([LAST + D, 0, 0, 0, 123, 0, LAST + 2 * D - 1]);

    const result = await loader.load();
    assert.equal(result.status, 'updated');
    assert.equal(result.requests, 1);
    assert.equal(result.cache.candles.at(-1).openTime, LAST + D);
    assert.equal(calls.length, 5);

    const fresh = await loader.load();
    assert.equal(fresh.status, 'fresh');
    assert.equal(fresh.requests, 0);
  });

  it('força atualização manual mesmo com cache fresco', async () => {
    const world = createWorld();
    const storage = createStorage();
    const { loader, calls } = makeLoader(world, storage);
    await loader.load();
    const result = await loader.load({ force: true });
    assert.equal(result.status, 'updated');
    assert.equal(result.requests, 1);
    assert.equal(calls.length, 5);
  });

  it('mantém cache em memória quando localStorage não existe', async () => {
    const world = createWorld();
    const { loader, calls } = makeLoader(world, null);
    const first = await loader.load();
    assert.equal(first.status, 'updated');
    assert.equal(first.persistenceAvailable, false);
    const second = await loader.load();
    assert.equal(second.status, 'fresh');
    assert.equal(second.requests, 0);
    assert.equal(calls.length, 4);
  });

  it('marca histórico incompleto como desatualizado', async () => {
    const world = createWorld({ rows: buildRows(LAST - D) });
    const storage = createStorage();
    const { loader } = makeLoader(world, storage);
    const result = await loader.load();
    assert.equal(result.status, 'stale');
    assert.match(result.error, /ainda não publicou/);
    assert.equal(result.cache.candles.at(-1).openTime, LAST - D);
  });

  it('aplica cooldown após falha e permite nova tentativa manual', async () => {
    const world = createWorld({ fail: 2 });
    const storage = createStorage();
    const { loader, calls } = makeLoader(world, storage);
    const first = await loader.load();
    assert.equal(first.status, 'error');
    assert.equal(first.requests, 2);
    assert.equal(calls.length, 2);

    const blocked = await loader.load();
    assert.equal(blocked.status, 'error');
    assert.equal(blocked.requests, 0);
    assert.match(blocked.error, /Aguarde/);

    const forced = await loader.load({ force: true });
    assert.equal(forced.status, 'updated');
    assert.equal(forced.requests, 4);
    assert.equal(calls.length, 6);
  });

  it('preserva o último histórico válido quando a atualização falha', async () => {
    const world = createWorld();
    const storage = createStorage();
    const { loader } = makeLoader(world, storage);
    const first = await loader.load();
    world.now = NOW + D;
    world.serverNow = NOW + D;
    world.fail = 2;

    const result = await loader.load();
    assert.equal(result.status, 'stale');
    assert.equal(result.cache.candles, first.cache.candles);
    assert.equal(result.requests, 2);
    assert.match(result.error, /HTTP 500/);
  });

  it('repara lacuna recente de forma direcionada ja na carga inicial', async () => {
    const missing = LAST - 3 * D;
    const world = createWorld({ missing, omitMissingInOpenEnded: true });
    const storage = createStorage();
    const { loader } = makeLoader(world, storage);
    const first = await loader.load();
    assert.equal(first.status, 'updated');
    assert.equal(first.requests, 5);
    assert.equal(first.gaps.length, 0);
    assert.equal(loader.session.gapFills, 1);
    assert.equal(V.findGaps(first.cache.candles).length, 0);

    const second = await loader.load();
    assert.equal(second.status, 'fresh');
    assert.equal(second.requests, 0);
  });

  it('nao persiste o historico inicial quando o reparo direcionado falha', async () => {
    const missing = LAST - 3 * D;
    const world = createWorld({ missing, omitMissingInOpenEnded: true, failOnEnded: true });
    const storage = createStorage();
    const { loader } = makeLoader(world, storage);
    const result = await loader.load();
    assert.equal(result.status, 'error');
    assert.equal(result.cache, null);
    assert.match(result.error, /HTTP 500/);
    assert.equal(storage.data.size, 0);
  });

  it('limita o numero de reparos e informa a lacuna restante', async () => {
    const missing = [LAST - 10 * D, LAST - 6 * D, LAST - 2 * D];
    const world = createWorld({ missing, omitMissingInOpenEnded: true });
    const storage = createStorage();
    const { loader } = makeLoader(world, storage);
    const result = await loader.load();
    assert.equal(result.status, 'stale');
    assert.equal(result.requests, 6);
    assert.equal(loader.session.gapFills, 2);
    assert.ok(result.gaps.length >= 1);
    assert.match(result.error, /lacuna/i);
  });

  it('descarta cache inválido e recarrega o histórico completo', async () => {
    const world = createWorld();
    const storage = createStorage({
      [V.CACHE_KEY]: JSON.stringify({ v: 0, candles: [] })
    });
    const { loader } = makeLoader(world, storage);
    const result = await loader.load();
    assert.equal(result.status, 'updated');
    assert.equal(result.requests, 4);
    assert.equal(result.cache.candles.length, 3358);
  });
});


describe('timeout e referencia temporal', () => {
  it('cancela a requisicao no timeout e nao persiste resposta incompleta', async () => {
    const world = createWorld({ hang: true });
    const storage = createStorage();
    const { loader } = makeLoader(world, storage, { requestTimeoutMs: 25 });
    const result = await loader.load();
    assert.equal(result.status, 'error');
    assert.equal(result.cache, null);
    assert.match(result.error, /tempo limite/i);
    assert.equal(result.requests, 1);
    assert.equal(world.aborted, true);
    assert.equal(storage.data.size, 0);
  });

  it('preserva o cache valido quando a atualizacao sofre timeout', async () => {
    const world = createWorld();
    const storage = createStorage();
    const { loader } = makeLoader(world, storage, { requestTimeoutMs: 25 });
    const first = await loader.load();
    const stored = storage.getItem(V.CACHE_KEY);
    world.now = NOW + D;
    world.serverNow = NOW + D;
    world.hang = true;

    const result = await loader.load();
    assert.equal(result.status, 'stale');
    assert.equal(result.cache.candles, first.cache.candles);
    assert.equal(result.requests, 1);
    assert.equal(world.aborted, true);
    assert.equal(storage.getItem(V.CACHE_KEY), stored);
    assert.match(result.error, /tempo limite/i);
  });

  it('consulta /api/v3/time quando o cabecalho Date nao esta exposto', async () => {
    const world = createWorld({ dateHeader: false });
    const storage = createStorage();
    const { loader, calls } = makeLoader(world, storage);
    const result = await loader.load();
    assert.equal(result.status, 'updated');
    assert.equal(result.timeSource, 'server');
    assert.equal(result.timeSourceMethod, 'server-time');
    assert.equal(world.timeRequests, 1);
    assert.equal(result.requests, 5);
    assert.equal(calls.length, 4);
    assert.equal(result.cache.lastServerNow, world.serverNow);
  });

  it('usa fallback local se /api/v3/time vier em formato invalido', async () => {
    const world = createWorld({ dateHeader: false, timeInvalid: true });
    const storage = createStorage();
    const { loader } = makeLoader(world, storage);
    const result = await loader.load();
    assert.equal(result.timeSource, 'local-fallback');
    assert.equal(result.timeSourceMethod, 'local-clock');
    assert.equal(world.timeRequests, 1);
    assert.equal(result.cache.lastServerNow, null);
    assert.equal(result.status, 'updated');
  });

  it('usa fallback local se /api/v3/time retornar HTTP de erro', async () => {
    const world = createWorld({ dateHeader: false, timeFail: true });
    const storage = createStorage();
    const { loader } = makeLoader(world, storage);
    const result = await loader.load();
    assert.equal(result.timeSource, 'local-fallback');
    assert.equal(result.timeSourceMethod, 'local-clock');
    assert.equal(world.timeRequests, 1);
    assert.equal(result.cache.lastServerNow, null);
  });

  it('nao considera candle parcial como fechado', () => {
    const openTime = LAST;
    const row = [openTime, 0, 0, 0, 100, 0, openTime + D - 1];
    assert.equal(V.normalizeCandles([row], openTime + D - 1).length, 0);
    assert.equal(V.normalizeCandles([row], openTime + D).length, 1);
  });
});
