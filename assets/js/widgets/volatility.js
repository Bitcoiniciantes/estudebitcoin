(function () {
  'use strict';

  var DAY = 86400000;
  var HORIZONS = [7, 14, 30];
  var THRESHOLDS = [10, 8, 6, 5];
  var EPISODE_THRESHOLD = 6;
  var CACHE_KEY = 'eb_volatility_btc_v1';
  var CACHE_VERSION = 1;
  var HISTORY_START = Date.UTC(2017, 7, 17);
  var MAX_CANDLES = 8000;
  var OVERLAP_DAYS = 8;
  var MAX_INCREMENTAL_PAGES = 3;
  var MAX_GAP_FILLS = 2;
  var MAX_FULL_REFRESH_PER_SESSION = 1;
  var RETRY_COOLDOWN_MS = 10 * 60 * 1000;
  var LOCAL_FALLBACK_SAFETY_MS = 5 * 60 * 1000;
  var REQUEST_TIMEOUT_MS = 15000;
  var TIME_REQUEST_TIMEOUT_MS = 5000;
  var DEFAULT_KLINES_BASE = 'https://data-api.binance.vision/api/v3/klines';
  var DEFAULT_TIME_URL = 'https://data-api.binance.vision/api/v3/time';
  var CHART_AXIS_MAX = 15;
  var CHART_MIN_LABEL_GAP = 32;
  var CHART_VIEWBOX_WIDTH = 760;
  var CHART_MIN_RENDERED_WIDTH = 520;
  var TIME_HOST = 'data-api.binance.vision';

  var MANUAL_EVENTS = [
    { id: 'manual-2026-08-17', label: '17/08/2026', date: '2026-08-17', year: 2026, month: 8, day: 17, value: 4.20, precision: 'day' },
    { id: 'manual-2026-10-27', label: '27/10/2026', date: '2026-10-27', year: 2026, month: 10, day: 27, value: 5.09, precision: 'day' },
    { id: 'manual-janeiro', label: 'Janeiro', date: null, year: null, month: 1, day: null, value: 4.43, precision: 'month' },
    { id: 'manual-junho', label: 'Junho', date: null, year: null, month: 6, day: null, value: 8.45, precision: 'month' }
  ];

  var BANDS = [
    { key: 'max', min: 0, max: 5, label: 'Alerta máximo de acompanhamento', threshold: 5, short: 'Alerta máximo' },
    { key: 'very_compressed', min: 5, max: 6, label: 'Volatilidade muito comprimida', threshold: 6, short: 'Muito comprimida' },
    { key: 'compressed', min: 6, max: 8, label: 'Compressão relevante', threshold: 8, short: 'Compressão relevante' },
    { key: 'watch', min: 8, max: 10, label: 'Acompanhar a evolução', threshold: 10, short: 'Acompanhar' },
    { key: 'outside', min: 10, max: null, label: 'Fora das faixas de compressão definidas', threshold: 10, short: 'Fora das faixas' }
  ];

  var nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var nf0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  var dfUTC = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });
  var dfBR = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  function getRoot() {
    try {
      if (typeof globalThis !== 'undefined') return globalThis;
    } catch (e) {}
    return null;
  }

  function isNum(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function toNum(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function dayOpen(timestamp) {
    return Math.floor(timestamp / DAY) * DAY;
  }

  function expectedLastOpen(referenceNow) {
    return dayOpen(referenceNow) - DAY;
  }

  function fmt2(value) {
    return isNum(value) ? nf2.format(value) : '—';
  }

  function fmtInt(value) {
    return isNum(value) ? nf0.format(value) : '—';
  }

  function fmtSigned(value) {
    if (!isNum(value)) return '—';
    return (value > 0 ? '+' : '') + nf2.format(value);
  }

  function fmtPct(value) {
    return fmt2(value) + '%';
  }

  function fmtPctSigned(value) {
    return fmtSigned(value) + '%';
  }

  function pctHtml(value, signed) {
    var text = signed ? fmtSigned(value) : fmt2(value);
    if (!isNum(value)) return esc(text);
    return '<span class="vol-pct">' +
      '<span class="vol-pct-num">' + esc(text) + '</span>' +
      '<span class="vol-pct-sign" aria-hidden="true">%</span>' +
      '<span class="vol-sr-only"> por cento</span>' +
    '</span>';
  }

  function fmtPoints(value, signed) {
    var text = signed ? fmtSigned(value) : fmt2(value);
    if (!isNum(value)) return text;
    var rounded = Math.round(Math.abs(value) * 100) / 100;
    return text + (rounded === 1 ? ' ponto' : ' pontos');
  }

  function fmtDateUTC(timestamp) {
    if (!isNum(timestamp)) return '—';
    return dfUTC.format(new Date(timestamp));
  }

  function fmtDateTimeBR(timestamp) {
    if (!isNum(timestamp)) return '—';
    return dfBR.format(new Date(timestamp));
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function toCandle(row) {
    if (!row) return null;
    var openTime = null;
    var close = null;
    var closeTime = null;
    if (Array.isArray(row)) {
      openTime = toNum(row[0]);
      if (row.length >= 5) {
        close = toNum(row[4]);
        closeTime = toNum(row[6]);
      } else {
        close = toNum(row[1]);
      }
    } else if (typeof row === 'object') {
      openTime = toNum(row.openTime != null ? row.openTime : row.t);
      close = toNum(row.close != null ? row.close : row.c);
      closeTime = toNum(row.closeTime);
    }
    if (openTime == null || close == null) return null;
    if (openTime % DAY !== 0) return null;
    if (!(close > 0)) return null;
    if (closeTime == null) closeTime = openTime + DAY - 1;
    return { openTime: openTime, close: close, closeTime: closeTime };
  }

  function normalizeCandles(rows, referenceNow, opts) {
    opts = opts || {};
    var map = new Map();
    (rows || []).forEach(function (row) {
      var candle = toCandle(row);
      if (!candle) return;
      if (isNum(referenceNow) && !(candle.closeTime < referenceNow)) return;
      map.set(candle.openTime, candle);
    });
    var out = Array.from(map.values()).sort(function (a, b) { return a.openTime - b.openTime; });
    var limit = opts.limit == null ? MAX_CANDLES : opts.limit;
    if (isNum(limit) && limit > 0 && out.length > limit) out = out.slice(-limit);
    return out;
  }

  function filterClosed(candles, referenceNow) {
    return (candles || []).filter(function (candle) {
      return candle && candle.closeTime < referenceNow;
    });
  }

  function findGaps(candles) {
    var gaps = [];
    for (var i = 1; i < candles.length; i += 1) {
      var diff = candles[i].openTime - candles[i - 1].openTime;
      if (diff === DAY) continue;
      if (diff <= 0) continue;
      gaps.push({
        after: candles[i - 1].openTime,
        before: candles[i].openTime,
        missing: Math.max(1, Math.round(diff / DAY) - 1)
      });
    }
    return gaps;
  }

  function gapsInWindow(gaps, from, to) {
    return gaps.filter(function (gap) {
      return gap.before >= from && gap.after <= to;
    });
  }

  function hasCurrentGap(candles, gaps) {
    if (!candles.length) return false;
    var from = candles[candles.length - 1].openTime - 19 * DAY;
    return gapsInWindow(gaps, from, candles[candles.length - 1].openTime).length > 0;
  }

  function hasRecentGap(gaps, lastOpenTime) {
    if (!isNum(lastOpenTime)) return false;
    return gaps.some(function (gap) {
      return gap.after >= lastOpenTime - 120 * DAY;
    });
  }

  function mergeCandles(existing, fresh) {
    var map = new Map();
    (existing || []).forEach(function (candle) {
      var normalized = toCandle(candle);
      if (normalized) map.set(normalized.openTime, normalized);
    });
    (fresh || []).forEach(function (candle) {
      var normalized = toCandle(candle);
      if (normalized) map.set(normalized.openTime, normalized);
    });
    var out = Array.from(map.values()).sort(function (a, b) { return a.openTime - b.openTime; });
    if (out.length > MAX_CANDLES) out = out.slice(-MAX_CANDLES);
    return out;
  }

  function computeWidths(candles) {
    var out = new Array(candles.length);
    for (var i = 0; i < out.length; i += 1) out[i] = null;
    for (var idx = 19; idx < candles.length; idx += 1) {
      var contiguous = true;
      for (var j = idx - 18; j <= idx; j += 1) {
        if (candles[j].openTime - candles[j - 1].openTime !== DAY) {
          contiguous = false;
          break;
        }
      }
      if (!contiguous) continue;
      var sum = 0;
      for (var k = idx - 19; k <= idx; k += 1) sum += candles[k].close;
      var mean = sum / 20;
      if (!(mean > 0)) continue;
      var variance = 0;
      for (var v = idx - 19; v <= idx; v += 1) {
        var delta = candles[v].close - mean;
        variance += delta * delta;
      }
      var sd = Math.sqrt(variance / 20);
      var width = 4 * sd / mean * 100;
      if (Number.isFinite(width) && width >= 0) out[idx] = width;
    }
    return out;
  }

  function getBand(width) {
    if (!isNum(width) || width < 0) return null;
    for (var i = 0; i < BANDS.length; i += 1) {
      var band = BANDS[i];
      if (band.max == null) {
        if (width >= band.min) return band;
      } else if (width >= band.min && width < band.max) {
        return band;
      }
    }
    return null;
  }

  function getNextTrigger(width) {
    if (!isNum(width) || width < 0) return null;
    var reference;
    var direction;
    var kind;
    if (width < 5) {
      reference = 5;
      direction = 'up';
      kind = 'exit';
    } else if (width >= 10) {
      reference = 10;
      direction = 'down';
      kind = 'trigger';
    } else if (width >= 8) {
      reference = 8;
      direction = 'down';
      kind = 'trigger';
    } else if (width >= 6) {
      reference = 6;
      direction = 'down';
      kind = 'trigger';
    } else {
      reference = 5;
      direction = 'down';
      kind = 'trigger';
    }
    var distance = Math.abs(width - reference);
    return {
      direction: direction,
      reference: reference,
      distance: distance,
      distancePct: width > 0 ? (distance / width) * 100 : null,
      kind: kind
    };
  }

  function findEpisodes(candles, widths, threshold) {
    var episodes = [];
    var excluded = [];
    var active = null;
    var seenFinite = false;

    for (var i = 0; i < candles.length; i += 1) {
      var width = widths[i];
      if (!isNum(width)) {
        if (active) {
          active.active = false;
          active.interrupted = true;
          active = null;
        }
        continue;
      }

      var previousWidth = i > 0 ? widths[i - 1] : null;
      var contiguousPrevious = i > 0 &&
        isNum(previousWidth) &&
        candles[i].openTime - candles[i - 1].openTime === DAY;

      if (!contiguousPrevious) {
        if (active) {
          active.active = false;
          active.interrupted = true;
          active = null;
        }
        if (width < threshold) {
          excluded.push({
            openTime: candles[i].openTime,
            reason: seenFinite ? 'gap_unconfirmed' : 'pre_history'
          });
        }
        seenFinite = true;
        continue;
      }

      if (width < threshold && previousWidth >= threshold) {
        if (active) {
          active.active = false;
          active.interrupted = true;
        }
        active = {
          startIndex: i,
          startTime: candles[i].openTime,
          active: true,
          interrupted: false
        };
        episodes.push(active);
      } else if (width >= threshold && active) {
        active.active = false;
        active = null;
      }

      seenFinite = true;
    }

    if (active) active.active = true;
    return { episodes: episodes, excluded: excluded };
  }

  function summarize(values) {
    var n = values.length;
    if (!n) {
      return {
        n: 0, median: null, min: null, max: null,
        abs10: 0, positive: 0, negative: 0, neutral: 0
      };
    }
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var median = n % 2 === 1
      ? sorted[(n - 1) / 2]
      : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    var positive = 0;
    var negative = 0;
    var neutral = 0;
    var abs10 = 0;
    values.forEach(function (value) {
      if (value > 0) positive += 1;
      else if (value < 0) negative += 1;
      else neutral += 1;
      if (Math.abs(value) >= 10) abs10 += 1;
    });
    return {
      n: n,
      median: median,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      abs10: abs10,
      positive: positive,
      negative: negative,
      neutral: neutral
    };
  }

  function windowsOverlap(startA, startB, horizon) {
    return Math.abs(startA - startB) < horizon * DAY;
  }

  function selectNonOverlapping(items, horizon) {
    var sorted = items.slice().sort(function (a, b) {
      return a.episode.startTime - b.episode.startTime;
    });
    var selected = [];
    var lastSelected = null;
    sorted.forEach(function (item) {
      if (lastSelected == null || !windowsOverlap(item.episode.startTime, lastSelected, horizon)) {
        selected.push(item);
        lastSelected = item.episode.startTime;
      }
    });
    return selected;
  }

  function computeHorizonStats(episodes, candles, horizon) {
    var indexByTime = new Map();
    candles.forEach(function (candle, index) {
      indexByTime.set(candle.openTime, index);
    });
    var lastOpenTime = candles.length ? candles[candles.length - 1].openTime : null;
    var eligible = 0;
    var complete = [];

    episodes.forEach(function (episode) {
      var targetTime = episode.startTime + horizon * DAY;
      if (isNum(lastOpenTime) && targetTime <= lastOpenTime) eligible += 1;
      var startIndex = indexByTime.get(episode.startTime);
      var targetIndex = indexByTime.get(targetTime);
      if (startIndex == null || targetIndex == null) return;
      for (var offset = 0; offset <= horizon; offset += 1) {
        var currentTime = episode.startTime + offset * DAY;
        var currentIndex = indexByTime.get(currentTime);
        if (currentIndex == null) return;
        if (offset > 0 && candles[currentIndex].openTime - candles[currentIndex - 1].openTime !== DAY) return;
      }
      var startClose = candles[startIndex].close;
      var targetClose = candles[targetIndex].close;
      if (!(startClose > 0) || !(targetClose > 0)) return;
      complete.push({
        episode: episode,
        value: (targetClose / startClose - 1) * 100
      });
    });

    var overlap = 0;
    for (var i = 0; i < complete.length; i += 1) {
      for (var j = 0; j < complete.length; j += 1) {
        if (i === j) continue;
        if (windowsOverlap(complete[i].episode.startTime, complete[j].episode.startTime, horizon)) {
          overlap += 1;
          break;
        }
      }
    }

    var selected = selectNonOverlapping(complete, horizon);

    var selectedValues = selected.map(function (item) { return item.value; });
    var completeValues = complete.map(function (item) { return item.value; });
    var selectedSummary = summarize(selectedValues);
    var completeSummary = summarize(completeValues);

    return {
      horizon: horizon,
      identified: episodes.length,
      eligible: eligible,
      complete: complete.length,
      overlap: overlap,
      nonOverlapN: selected.length,
      median: selectedSummary.median,
      min: selectedSummary.min,
      max: selectedSummary.max,
      abs10: selectedSummary.abs10,
      positive: selectedSummary.positive,
      negative: selectedSummary.negative,
      neutral: selectedSummary.neutral,
      frequencyAllowed: selected.length >= 20,
      full: completeSummary,
      selectedReturns: selectedValues,
      completeReturns: completeValues,
      notEligible: episodes.length - eligible,
      eligibleIncomplete: eligible - complete.length,
      incomplete: episodes.length - complete.length
    };
  }

  function buildChartData(candles, widths, limit) {
    var size = limit == null ? 90 : limit;
    var start = Math.max(0, candles.length - size);
    var out = [];
    for (var i = start; i < candles.length; i += 1) {
      out.push({ openTime: candles[i].openTime, width: widths[i] });
    }
    return out;
  }

  function computeModel(candles) {
    var widths = computeWidths(candles);
    var last = candles.length - 1;
    var current = last >= 0 ? widths[last] : null;
    var band = isNum(current) ? getBand(current) : null;
    var threshold = isNum(current) ? EPISODE_THRESHOLD : null;
    var episodeData = threshold == null
      ? { episodes: [], excluded: [] }
      : findEpisodes(candles, widths, threshold);
    var horizons = threshold == null
      ? []
      : HORIZONS.map(function (horizon) {
        return computeHorizonStats(episodeData.episodes, candles, horizon);
      });
    var excludedReasons = { pre_history: 0, gap_unconfirmed: 0 };
    episodeData.excluded.forEach(function (item) {
      if (excludedReasons[item.reason] != null) excludedReasons[item.reason] += 1;
    });
    return {
      candles: candles,
      widths: widths,
      current: current,
      currentTime: last >= 0 ? candles[last].openTime : null,
      band: band,
      threshold: threshold,
      nextTrigger: isNum(current) ? getNextTrigger(current) : null,
      episodes: episodeData.episodes,
      excluded: episodeData.excluded,
      excludedReasons: excludedReasons,
      horizons: horizons,
      chart: buildChartData(candles, widths, 90),
      gaps: findGaps(candles)
    };
  }

  function isUsableServerTime(serverNow, localNow) {
    if (!isNum(serverNow)) return false;
    if (serverNow < HISTORY_START) return false;
    if (serverNow > localNow + DAY) return false;
    if (serverNow < localNow - 7 * DAY) return false;
    return true;
  }

  function resolveReference(localNow, serverNow) {
    if (isUsableServerTime(serverNow, localNow)) {
      return { now: serverNow, source: 'server' };
    }
    return { now: localNow - LOCAL_FALLBACK_SAFETY_MS, source: 'local-fallback' };
  }

  function parseServerDate(value) {
    if (!value) return null;
    var parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function makeCache(candles, reference, savedAt, previousServerNow) {
    return {
      v: CACHE_VERSION,
      savedAt: savedAt,
      lastServerNow: reference && reference.source === 'server'
        ? reference.now
        : (isNum(previousServerNow) ? previousServerNow : null),
      lastClosedOpenTime: candles.length ? candles[candles.length - 1].openTime : null,
      completeFrom: candles.length ? candles[0].openTime : null,
      candles: candles
    };
  }

  function serializeCache(cache) {
    return {
      v: CACHE_VERSION,
      savedAt: cache.savedAt,
      lastServerNow: cache.lastServerNow,
      lastClosedOpenTime: cache.lastClosedOpenTime,
      completeFrom: cache.completeFrom,
      candles: (cache.candles || []).map(function (candle) {
        return [candle.openTime, candle.close];
      })
    };
  }

  function validateCacheRecord(record, referenceNow) {
    if (!record || record.v !== CACHE_VERSION) return { ok: false, reason: 'version' };
    if (!Array.isArray(record.candles)) return { ok: false, reason: 'shape' };
    if (!isNum(record.savedAt)) return { ok: false, reason: 'savedAt' };
    var normalized = normalizeCandles(record.candles, referenceNow, { limit: MAX_CANDLES });
    if (!normalized.length) return { ok: false, reason: 'empty' };
    var first = normalized[0].openTime;
    var last = normalized[normalized.length - 1].openTime;
    var wasTrimmed = record.candles.length > MAX_CANDLES;
    if (!wasTrimmed && record.completeFrom !== first) return { ok: false, reason: 'completeFrom' };
    if (record.lastClosedOpenTime !== last) return { ok: false, reason: 'lastClosed' };
    var cache = makeCache(normalized, { source: 'cache', now: null }, record.savedAt, record.lastServerNow);
    return { ok: true, cache: cache };
  }

  function expectedLastForReference(reference) {
    if (!reference || !isNum(reference.now)) return null;
    return expectedLastOpen(reference.now);
  }

  function planRefresh(cache, expectedLast, force) {
    if (!cache) return { mode: 'full', reason: 'missing' };
    var gaps = findGaps(cache.candles);
    var currentGap = hasCurrentGap(cache.candles, gaps);
    var recentGap = hasRecentGap(gaps, cache.lastClosedOpenTime);
    if (force) return { mode: 'incremental', reason: 'manual' };
    if (!currentGap && !recentGap && isNum(expectedLast) && cache.lastClosedOpenTime >= expectedLast) {
      return { mode: 'none', reason: 'fresh' };
    }
    if (currentGap || recentGap) return { mode: 'incremental', reason: 'gap' };
    if (isNum(expectedLast) && cache.lastClosedOpenTime < expectedLast) {
      return { mode: 'incremental', reason: 'stale' };
    }
    return { mode: 'none', reason: 'fresh' };
  }

  function getStorage() {
    try {
      var storage = getRoot() && getRoot().localStorage;
      if (!storage) return null;
      var probe = '__eb_vol_probe__';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return storage;
    } catch (e) {
      return null;
    }
  }

  function readCache(storage, referenceNow) {
    if (!storage) return { cache: null, persistenceAvailable: false, reason: 'unavailable' };
    var raw;
    try {
      raw = storage.getItem(CACHE_KEY);
    } catch (e) {
      return { cache: null, persistenceAvailable: false, reason: 'read_failed' };
    }
    if (!raw) return { cache: null, persistenceAvailable: true, reason: 'missing' };
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { cache: null, persistenceAvailable: true, reason: 'invalid_json' };
    }
    var validated = validateCacheRecord(parsed, referenceNow);
    if (!validated.ok) {
      return { cache: null, persistenceAvailable: true, reason: validated.reason };
    }
    return { cache: validated.cache, persistenceAvailable: true, reason: 'ok' };
  }

  function writeCache(storage, cache) {
    if (!storage) return false;
    try {
      storage.setItem(CACHE_KEY, JSON.stringify(serializeCache(cache)));
      return true;
    } catch (e) {
      return false;
    }
  }

  function createLoader(options) {
    options = options || {};
    var host = getRoot() || {};
    var config = options.config || host.BI_CONFIG || {};
    var apiConfig = config.api || {};
    var base = options.base || apiConfig.binanceVisionKlinesBase || DEFAULT_KLINES_BASE;
    var timeUrl = options.timeUrl || apiConfig.binanceTimeUrl || DEFAULT_TIME_URL;
    var fetchImpl = options.fetchImpl || (host.fetch ? host.fetch.bind(host) : null);
    var nowFn = options.now || Date.now;
    var requestTimeoutMs = isNum(options.requestTimeoutMs) && options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : REQUEST_TIMEOUT_MS;
    var storage = Object.prototype.hasOwnProperty.call(options, 'storage')
      ? options.storage
      : getStorage();
    var persistenceAvailable = !!storage;
    var memoryCache = options.memoryCache || null;
    var session = options.session || {
      requests: 0,
      gapFills: 0,
      recoveryFullRefreshes: 0,
      lastAttemptAt: 0,
      lastFailedAt: 0
    };
    var lastReference = { now: null, source: 'local-cache', method: 'cache' };
    var clockTried = false;
    var clockValue = null;

    if (!fetchImpl) {
      throw new Error('fetch indisponível');
    }

    function loadStoredCache(localNow) {
      if (memoryCache) {
        return { cache: memoryCache, persistenceAvailable: persistenceAvailable, reason: 'memory' };
      }
      var result = readCache(storage, localNow);
      persistenceAvailable = result.persistenceAvailable;
      if (result.cache) memoryCache = result.cache;
      return result;
    }

    function save(cache) {
      memoryCache = cache;
      if (!storage) {
        persistenceAvailable = false;
        return false;
      }
      var ok = writeCache(storage, cache);
      if (!ok) persistenceAvailable = false;
      return ok;
    }

    function timeoutError(label) {
      var error = new Error((label || 'A requisição') + ' excedeu o tempo limite');
      error.name = 'TimeoutError';
      return error;
    }

    function startAbortTimer(controller, timeoutMs, onTimeout) {
      if (!controller || !(timeoutMs > 0)) return null;
      return setTimeout(function () {
        if (onTimeout) onTimeout();
        controller.abort();
      }, timeoutMs);
    }

    async function fetchServerTime(localNow) {
      if (!timeUrl) return null;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timeoutId = startAbortTimer(controller, Math.min(requestTimeoutMs, TIME_REQUEST_TIMEOUT_MS));
      try {
        session.requests += 1;
        var response = await fetchImpl(timeUrl, {
          cache: 'no-store',
          signal: controller ? controller.signal : undefined
        });
        if (!response || !response.ok) return null;
        var payload = await response.json();
        var serverNow = payload && typeof payload.serverTime === 'number'
          ? payload.serverTime
          : null;
        return isUsableServerTime(serverNow, localNow) ? serverNow : null;
      } catch (error) {
        return null;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    async function ensureReference(localNow, headerTime) {
      if (isUsableServerTime(headerTime, localNow)) {
        return { now: headerTime, source: 'server', method: 'date-header' };
      }
      if (!clockTried) {
        clockTried = true;
        clockValue = await fetchServerTime(localNow);
      }
      var resolved = resolveReference(localNow, clockValue);
      resolved.method = resolved.source === 'server' ? 'server-time' : 'local-clock';
      return resolved;
    }

    async function fetchPage(startTime, limit, endTime) {
      var url = base +
        '?symbol=BTCUSDT&interval=1d&limit=' + encodeURIComponent(limit) +
        '&startTime=' + encodeURIComponent(startTime);
      if (isNum(endTime)) url += '&endTime=' + encodeURIComponent(endTime);
      var lastError = null;
      for (var attempt = 0; attempt < 2; attempt += 1) {
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var timedOut = false;
        var timeoutId = startAbortTimer(controller, requestTimeoutMs, function () {
          timedOut = true;
        });
        try {
          session.requests += 1;
          var response = await fetchImpl(url, {
            cache: 'no-store',
            signal: controller ? controller.signal : undefined
          });
          if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : 'erro'));
          var rows = await response.json();
          if (!Array.isArray(rows)) throw new Error('Resposta inválida da Binance');
          var dateHeader = null;
          try {
            dateHeader = response.headers && response.headers.get
              ? response.headers.get('date')
              : null;
          } catch (e) {}
          return {
            rows: rows,
            serverNow: parseServerDate(dateHeader)
          };
        } catch (error) {
          lastError = error;
          if (timedOut || (error && error.name === 'AbortError')) {
            lastError = timeoutError('A consulta a Binance');
            break;
          }
          if (attempt === 0) await new Promise(function (resolve) { setTimeout(resolve, 600); });
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      }
      throw lastError || new Error('Falha ao buscar candles');
    }

    async function fetchFull(localNow) {
      var rows = [];
      var serverNow = null;
      var start = HISTORY_START;
      var pages = 0;
      while (pages < 10) {
        var page = await fetchPage(start, 1000);
        pages += 1;
        if (page.serverNow != null) serverNow = page.serverNow;
        if (!page.rows.length) break;
        rows = rows.concat(page.rows);
        var lastRow = page.rows[page.rows.length - 1];
        var lastOpen = toNum(lastRow && lastRow[0]);
        if (page.rows.length < 1000 || lastOpen == null) break;
        if (lastOpen + DAY > localNow) break;
        start = lastOpen + DAY;
      }
      var reference = await ensureReference(localNow, serverNow);
      var candles = normalizeCandles(rows, reference.now, { limit: MAX_CANDLES });
      if (!candles.length) throw new Error('Nenhum candle válido recebido');
      return {
        cache: makeCache(candles, reference, localNow),
        reference: reference,
        pages: pages
      };
    }

    async function fetchIncremental(cache, expectedLast, localNow) {
      var gapDays = Math.max(0, Math.ceil((expectedLast - cache.lastClosedOpenTime) / DAY));
      var start = Math.max(cache.completeFrom || HISTORY_START, cache.lastClosedOpenTime - OVERLAP_DAYS * DAY);
      var limit = Math.min(1000, Math.max(30, gapDays + 12));
      var rows = [];
      var serverNow = null;
      var pages = 0;
      while (pages < MAX_INCREMENTAL_PAGES) {
        var page = await fetchPage(start, limit);
        pages += 1;
        if (page.serverNow != null) serverNow = page.serverNow;
        if (!page.rows.length) break;
        rows = rows.concat(page.rows);
        var lastRow = page.rows[page.rows.length - 1];
        var lastOpen = toNum(lastRow && lastRow[0]);
        if (page.rows.length < limit || lastOpen == null) break;
        if (lastOpen >= expectedLast) break;
        start = lastOpen + DAY;
        limit = 1000;
      }
      var reference = await ensureReference(localNow, serverNow);
      var fresh = normalizeCandles(rows, reference.now, { limit: MAX_CANDLES });
      var merged = mergeCandles(cache.candles, fresh);
      return {
        candles: merged,
        fresh: fresh,
        reference: reference,
        pages: pages
      };
    }

    async function repairGaps(candles, reference, expectedLast, localNow) {
      var current = candles;
      var attempts = 0;
      var failure = null;
      while (attempts < MAX_GAP_FILLS && session.gapFills < MAX_GAP_FILLS) {
        var gaps = findGaps(current).filter(function (gap) {
          return gap.after >= expectedLast - 120 * DAY;
        });
        if (!gaps.length) break;
        var gap = gaps[0];
        var start = gap.after + DAY;
        var end = gap.before - DAY;
        if (end < start) break;
        try {
          var page = await fetchPage(start, Math.min(1000, gap.missing + 5), end);
          if (isUsableServerTime(page.serverNow, localNow)) {
            reference = { now: page.serverNow, source: 'server', method: 'date-header' };
          }
          var fresh = normalizeCandles(page.rows, reference.now, { limit: MAX_CANDLES });
          if (!fresh.length) {
            failure = new Error('A Binance não devolveu candles para reparar a lacuna.');
            break;
          }
          current = mergeCandles(current, fresh);
          session.gapFills += 1;
          attempts += 1;
        } catch (error) {
          failure = error;
          break;
        }
      }
      return {
        candles: current,
        reference: reference,
        attempts: attempts,
        failed: !!failure,
        error: failure
      };
    }

    async function load(opts) {
      opts = opts || {};
      var force = !!opts.force;
      var localNow = nowFn();
      clockTried = false;
      clockValue = null;
      var requestsBefore = session.requests;
      var loaded = loadStoredCache(localNow);
      var cache = loaded.cache;
      var gaps = cache ? findGaps(cache.candles) : [];
      var currentGap = cache ? hasCurrentGap(cache.candles, gaps) : false;
      var recentGap = cache ? hasRecentGap(gaps, cache.lastClosedOpenTime) : false;
      var localExpected = expectedLastOpen(localNow);
      var checkedAt = localNow;

      function result(status, extra) {
        var payload = {
          status: status,
          cache: cache,
          gaps: gaps,
          requests: session.requests - requestsBefore,
          checkedAt: checkedAt,
          persistenceAvailable: persistenceAvailable,
          timeSource: lastReference.source,
          timeSourceMethod: lastReference.method || null,
          expectedLastOpenTime: cache ? expectedLastOpen(cache.lastClosedOpenTime) : null
        };
        if (extra) {
          Object.keys(extra).forEach(function (key) { payload[key] = extra[key]; });
        }
        return payload;
      }

      if (!cache) {
        if (session.lastFailedAt && localNow - session.lastFailedAt < RETRY_COOLDOWN_MS && !force) {
          return result('error', { error: 'Aguarde alguns minutos antes de tentar novamente.' });
        }
        try {
          var full = await fetchFull(localNow);
          session.lastAttemptAt = localNow;
          session.lastFailedAt = 0;
          var fullExpected = expectedLastForReference(full.reference) || localExpected;
          var repairedFull = await repairGaps(full.cache.candles, full.reference, fullExpected, localNow);
          if (repairedFull.failed) {
            throw repairedFull.error || new Error('Não foi possível reparar a lacuna do histórico inicial.');
          }
          lastReference = repairedFull.reference;
          cache = repairedFull.candles === full.cache.candles
            ? full.cache
            : makeCache(repairedFull.candles, repairedFull.reference, localNow, full.cache.lastServerNow);
          gaps = findGaps(cache.candles);
          save(cache);
          var fullStale = cache.lastClosedOpenTime < expectedLastForReference(repairedFull.reference);
          var fullIncomplete = gaps.length > 0;
          return result(fullStale || fullIncomplete ? 'stale' : 'updated', {
            cache: cache,
            gaps: gaps,
            timeSource: repairedFull.reference.source,
            error: fullStale
              ? 'A Binance ainda não publicou o candle fechado mais recente.'
              : (fullIncomplete ? 'Há lacuna no histórico que não pôde ser reparada; janelas afetadas foram excluídas.' : null)
          });
        } catch (error) {
          session.lastAttemptAt = localNow;
          session.lastFailedAt = localNow;
          return result('error', { error: error.message || 'Falha ao carregar o histórico.' });
        }
      }

      if (!force && cache.lastClosedOpenTime >= localExpected && !currentGap && !recentGap) {
        lastReference = { now: localNow, source: 'local-cache', method: 'cache' };
        return result('fresh', { timeSource: 'local-cache', timeSourceMethod: 'cache' });
      }

      if (!force && session.lastFailedAt && localNow - session.lastFailedAt < RETRY_COOLDOWN_MS) {
        return result('stale', {
          cache: cache,
          gaps: gaps,
          cooldown: true,
          error: 'Tentativa recente. Exibindo o último histórico válido.'
        });
      }

      var gapDays = Math.max(0, (localExpected - cache.lastClosedOpenTime) / DAY);
      if (gapDays > 2900 && session.recoveryFullRefreshes < MAX_FULL_REFRESH_PER_SESSION) {
        try {
          var recovery = await fetchFull(localNow);
          session.recoveryFullRefreshes += 1;
          session.lastAttemptAt = localNow;
          session.lastFailedAt = 0;
          var recoveryExpected = expectedLastForReference(recovery.reference) || localExpected;
          var repairedRecovery = await repairGaps(recovery.cache.candles, recovery.reference, recoveryExpected, localNow);
          if (repairedRecovery.failed) {
            throw repairedRecovery.error || new Error('Falha ao reparar lacuna na recuperação completa.');
          }
          lastReference = repairedRecovery.reference;
          cache = repairedRecovery.candles === recovery.cache.candles
            ? recovery.cache
            : makeCache(repairedRecovery.candles, repairedRecovery.reference, localNow, recovery.cache.lastServerNow);
          gaps = findGaps(cache.candles);
          save(cache);
          var recoveryPartial = cache.lastClosedOpenTime < recoveryExpected;
          var recoveryIncomplete = gaps.length > 0;
          return result(recoveryPartial || recoveryIncomplete ? 'stale' : 'updated', {
            cache: cache,
            gaps: gaps,
            timeSource: repairedRecovery.reference.source,
            error: recoveryPartial
              ? 'A Binance ainda não publicou o candle fechado mais recente.'
              : (recoveryIncomplete ? 'Há lacuna no histórico; janelas afetadas foram excluídas.' : null)
          });
        } catch (error) {
          session.lastAttemptAt = localNow;
          session.lastFailedAt = localNow;
          return result('stale', {
            cache: cache,
            gaps: gaps,
            error: error.message || 'Falha na recuperação completa.'
          });
        }
      }

      try {
        var incremental = await fetchIncremental(cache, localExpected, localNow);
        session.lastAttemptAt = localNow;
        session.lastFailedAt = 0;
        var merged = incremental.candles;
        var mergedGaps = findGaps(merged);
        var repaired = await repairGaps(merged, incremental.reference, localExpected, localNow);
        if (repaired.failed) {
          throw repaired.error || new Error('Não foi possível reparar a lacuna recente.');
        }
        merged = repaired.candles;
        mergedGaps = findGaps(merged);
        var reference = repaired.reference || incremental.reference;
        lastReference = reference;

        var mergedCurrentGap = hasCurrentGap(merged, mergedGaps);
        if (mergedCurrentGap && session.recoveryFullRefreshes < MAX_FULL_REFRESH_PER_SESSION) {
          try {
            var recoveryGap = await fetchFull(localNow);
            session.recoveryFullRefreshes += 1;
            var recoveryGapExpected = expectedLastForReference(recoveryGap.reference) || localExpected;
            var repairedGap = await repairGaps(recoveryGap.cache.candles, recoveryGap.reference, recoveryGapExpected, localNow);
            if (repairedGap.failed) {
              throw repairedGap.error || new Error('Falha ao reparar lacuna na recuperação completa.');
            }
            lastReference = repairedGap.reference;
            cache = repairedGap.candles === recoveryGap.cache.candles
              ? recoveryGap.cache
              : makeCache(repairedGap.candles, repairedGap.reference, localNow, recoveryGap.cache.lastServerNow);
            gaps = findGaps(cache.candles);
            save(cache);
            var recoveryGapPartial = cache.lastClosedOpenTime < recoveryGapExpected;
            var recoveryGapIncomplete = gaps.length > 0;
            return result(recoveryGapPartial || recoveryGapIncomplete ? 'stale' : 'updated', {
              cache: cache,
              gaps: gaps,
              timeSource: repairedGap.reference.source,
              error: recoveryGapPartial
                ? 'A Binance ainda não publicou o candle fechado mais recente.'
                : (recoveryGapIncomplete ? 'Há lacuna no histórico; janelas afetadas foram excluídas.' : null)
            });
          } catch (error) {
            session.lastAttemptAt = localNow;
            session.lastFailedAt = localNow;
            throw error;
          }
        }

        var nextCache = makeCache(merged, reference, localNow, cache.lastServerNow);
        cache = nextCache;
        gaps = mergedGaps;
        save(cache);
        var expectedByReference = expectedLastForReference(reference) || localExpected;
        var partial = cache.lastClosedOpenTime < expectedByReference;
        var mergedIncomplete = mergedGaps.length > 0;
        return result(partial || mergedIncomplete ? 'stale' : 'updated', {
          cache: cache,
          gaps: gaps,
          timeSource: reference.source,
          error: partial
            ? 'A Binance ainda não publicou o candle fechado mais recente.'
            : (mergedIncomplete ? 'Há lacuna no histórico; janelas afetadas foram excluídas.' : null)
        });
      } catch (error) {
        session.lastAttemptAt = localNow;
        session.lastFailedAt = localNow;
        return result('stale', {
          cache: cache,
          gaps: gaps,
          error: error.message || 'Falha na atualização incremental.'
        });
      }
    }

    return {
      load: load,
      session: session,
      getPersistenceAvailable: function () { return persistenceAvailable; }
    };
  }

  function gaugeHtml(width, band) {
    var pct = clamp(width / 15 * 100, 0, 100);
    return '' +
      '<div class="vol-gauge" role="img" aria-label="Largura atual ' + esc(fmt2(width)) + ' por cento. Faixa: ' + esc(band.label) + '.">' +
        '<div class="vol-gauge-track">' +
          '<span class="vol-gauge-zone vol-zone-max" style="width:33.333%"></span>' +
          '<span class="vol-gauge-zone vol-zone-very" style="width:6.667%"></span>' +
          '<span class="vol-gauge-zone vol-zone-compressed" style="width:13.333%"></span>' +
          '<span class="vol-gauge-zone vol-zone-watch" style="width:13.333%"></span>' +
          '<span class="vol-gauge-zone vol-zone-outside" style="width:33.334%"></span>' +
          '<span class="vol-gauge-marker" style="left:' + pct.toFixed(2) + '%"></span>' +
        '</div>' +
        '<div class="vol-gauge-ticks" aria-hidden="true">' +
          '<span style="left:33.333%">5</span>' +
          '<span style="left:40%">6</span>' +
          '<span style="left:53.333%">8</span>' +
          '<span style="left:66.667%">10</span>' +
          '<span style="left:100%">15+</span>' +
        '</div>' +
      '</div>';
  }

  function manualTimestamp(event) {
    if (!event || event.precision !== 'day') return null;
    return Date.UTC(event.year, event.month - 1, event.day);
  }

  function chartSvg(model) {
    var points = model.chart || [];
    var finite = points.filter(function (point) { return isNum(point.width); });
    if (!finite.length) {
      return '<div class="vol-chart-empty">Sem candles suficientes para desenhar o gráfico de 90 dias.</div>';
    }
    var W = 760;
    var H = 250;
    var left = 46;
    var right = 18;
    var top = 16;
    var bottom = 34;
    var plotW = W - left - right;
    var plotH = H - top - bottom;
    var first = points[0].openTime;
    var last = points[points.length - 1].openTime;
    var clippedPoints = finite.filter(function (point) { return point.width > CHART_AXIS_MAX; });
    var clipped = clippedPoints.length > 0;
    var peak = clippedPoints.reduce(function (best, point) {
      return !best || point.width > best.width ? point : best;
    }, null);

    function x(t) {
      if (last === first) return left + plotW / 2;
      return left + ((t - first) / (last - first)) * plotW;
    }
    function y(value) {
      return top + (1 - clamp(value, 0, CHART_AXIS_MAX) / CHART_AXIS_MAX) * plotH;
    }

    var zones = [
      { from: 0, to: 5, cls: 'max' },
      { from: 5, to: 6, cls: 'very' },
      { from: 6, to: 8, cls: 'compressed' },
      { from: 8, to: 10, cls: 'watch' },
      { from: 10, to: CHART_AXIS_MAX, cls: 'outside' }
    ];
    var zoneRects = zones.map(function (zone) {
      var yTop = y(zone.to);
      var yBottom = y(zone.from);
      return '<rect class="vol-zone-bg vol-zone-bg-' + zone.cls + '" x="' + left + '" y="' + yTop.toFixed(1) +
        '" width="' + plotW + '" height="' + (yBottom - yTop).toFixed(1) + '"></rect>';
    }).join('');

    var thresholdLayout = [5, 6, 8, 10].map(function (value) {
      return { value: value, lineY: y(value), labelY: y(value) + 3.5, x: left - 9 };
    }).sort(function (a, b) {
      return a.labelY - b.labelY;
    });
    var needsSpread = thresholdLayout.some(function (label, index) {
      return index > 0 && label.labelY - thresholdLayout[index - 1].labelY < CHART_MIN_LABEL_GAP;
    });
    if (needsSpread) {
      var center = (thresholdLayout[0].labelY + thresholdLayout[thresholdLayout.length - 1].labelY) / 2;
      var firstLabelY = center - (CHART_MIN_LABEL_GAP * (thresholdLayout.length - 1)) / 2;
      thresholdLayout.forEach(function (label, index) {
        label.labelY = firstLabelY + index * CHART_MIN_LABEL_GAP;
      });
    }
    var thresholdLines = thresholdLayout.map(function (label) {
      var leader = Math.abs(label.labelY - (label.lineY + 3.5)) > 0.5
        ? '<line class="vol-axis-leader" x1="' + (left - 2) + '" x2="' + (left - 6) + '" y1="' + label.lineY.toFixed(1) + '" y2="' + (label.labelY - 3.5).toFixed(1) + '"></line>'
        : '';
      return '<line class="vol-threshold" x1="' + left + '" x2="' + (left + plotW) + '" y1="' + label.lineY.toFixed(1) +
        '" y2="' + label.lineY.toFixed(1) + '"></line>' + leader +
        '<text class="vol-axis" data-threshold="' + label.value + '" x="' + label.x + '" y="' + label.labelY.toFixed(1) + '" text-anchor="end">' + label.value + '</text>';
    }).join('');

    var path = '';
    var drawing = false;
    points.forEach(function (point) {
      if (!isNum(point.width)) {
        drawing = false;
        return;
      }
      path += (drawing ? 'L' : 'M') + x(point.openTime).toFixed(1) + ',' + y(point.width).toFixed(1) + ' ';
      drawing = true;
    });

    var current = isNum(model.current) && points.length ? points[points.length - 1] : null;
    var currentX = current ? x(current.openTime) : null;
    var currentDot = current
      ? '<circle class="vol-current-dot" cx="' + currentX.toFixed(1) + '" cy="' + y(current.width).toFixed(1) + '" r="4.5"></circle>'
      : '';

    var manualDots = MANUAL_EVENTS.map(function (event) {
      var t = manualTimestamp(event);
      if (t == null || t < first || t > last) return '';
      var actualX = x(t);
      var markerX = actualX;
      if (isNum(currentX) && Math.abs(actualX - currentX) < 20) markerX = actualX - 20;
      var cy = y(event.value);
      var stem = markerX !== actualX
        ? '<line class="vol-manual-stem" x1="' + actualX.toFixed(1) + '" x2="' + markerX.toFixed(1) + '" y1="' + cy.toFixed(1) + '" y2="' + cy.toFixed(1) + '"></line>'
        : '';
      return '<g class="vol-manual-marker" data-manual-label="' + esc(event.label) + '" data-manual-x="' + markerX.toFixed(1) + '">' +
        '<title>Registro manual ' + esc(event.label) + ': ' + esc(fmt2(event.value)) + ' por cento</title>' +
        stem +
        '<path class="vol-manual-dot" d="M ' + markerX.toFixed(1) + ' ' + (cy - 5).toFixed(1) +
        ' L ' + (markerX + 5).toFixed(1) + ' ' + cy.toFixed(1) +
        ' L ' + markerX.toFixed(1) + ' ' + (cy + 5).toFixed(1) +
        ' L ' + (markerX - 5).toFixed(1) + ' ' + cy.toFixed(1) + ' Z"></path>' +
        '</g>';
    }).join('');

    var clipBoundary = clipped
      ? '<line class="vol-axis-clip" x1="' + left + '" x2="' + (left + plotW) + '" y1="' + top + '" y2="' + top + '"></line>'
      : '';
    var clipMark = clipped && peak
      ? '<g class="vol-clip-marker" data-clip-value="' + peak.width.toFixed(2) + '">' +
        '<title>Pico de ' + esc(fmt2(peak.width)) + ' por cento cortado no topo; escala até ' + fmt2(CHART_AXIS_MAX) + ' por cento.</title>' +
        '<path class="vol-clip-mark" d="M ' + x(peak.openTime).toFixed(1) + ' ' + top +
        ' l -4 7 l 8 0 Z"></path>' +
        '</g>'
      : '';

    var firstLabel = fmtDateUTC(first);
    var lastLabel = fmtDateUTC(last);
    var aria = 'Gráfico dos últimos 90 candles fechados. Largura atual ' + fmt2(model.current) +
      ' por cento. Linhas de referência em 5, 6, 8 e 10. Escala vertical até ' + fmt2(CHART_AXIS_MAX) + ' por cento.' +
      (clipped ? ' Pico acima do limite cortado no topo.' : '');

    return '' +
      '<div class="vol-chart-scroll" tabindex="0" role="region" aria-label="Gráfico rolável da largura de Bollinger dos últimos 90 candles fechados">' +
        '<svg class="vol-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" data-axis-max="' + CHART_AXIS_MAX + '" data-clipped="' + clipped + '" role="img" aria-label="' + esc(aria) + '">' +
          '<title>Termômetro de volatilidade do Bitcoin</title>' +
          '<desc>' + esc(aria) + '</desc>' +
          zoneRects +
          thresholdLines +
          clipBoundary +
          clipMark +
          '<line class="vol-axis-line" x1="' + left + '" x2="' + left + '" y1="' + top + '" y2="' + (top + plotH) + '"></line>' +
          '<line class="vol-axis-line" x1="' + left + '" x2="' + (left + plotW) + '" y1="' + (top + plotH) + '" y2="' + (top + plotH) + '"></line>' +
          (path ? '<path class="vol-line" d="' + path.trim() + '"></path>' : '') +
          currentDot +
          manualDots +
          '<text class="vol-x-label" x="' + left + '" y="' + (H - 10) + '">' + esc(firstLabel) + '</text>' +
          '<text class="vol-x-label" x="' + (left + plotW) + '" y="' + (H - 10) + '" text-anchor="end">' + esc(lastLabel) + '</text>' +
        '</svg>' +
      '</div>' +
      '<div class="vol-chart-legend" aria-hidden="true">' +
        '<span><i class="vol-legend-line"></i> Largura BB(20,2)</span>' +
        '<span><i class="vol-legend-diamond"></i> Registro manual com data completa</span>' +
        '<span><i class="vol-legend-current"></i> Último candle fechado</span>' +
        (clipped ? '<span><i class="vol-legend-clip"></i> Pico acima de 15% (cortado no topo)</span>' : '') +
      '</div>';
  }

  function horizonCard(item) {
    var incomplete = item.incomplete != null ? item.incomplete : item.identified - item.complete;
    var excludedOverlap = item.complete - item.nonOverlapN;
    var incompleteLabel = fmtInt(incomplete) + (incomplete > 0
      ? (incomplete === 1 ? ' (episódio ativo)' : ' (inclui episódio ativo)')
      : '');
    var freq;
    if (item.frequencyAllowed) {
      var posPct = item.nonOverlapN ? item.positive / item.nonOverlapN * 100 : null;
      var negPct = item.nonOverlapN ? item.negative / item.nonOverlapN * 100 : null;
      var neutral = item.neutral
        ? '<span class="vol-freq-neutral">Neutros: ' + fmtInt(item.neutral) + ' de ' + fmtInt(item.nonOverlapN) + '</span>'
        : '';
      freq = '<div class="vol-freq">' +
        '<div><span>Frequência positiva</span><strong>' + fmtInt(item.positive) + ' de ' + fmtInt(item.nonOverlapN) +
          ' <small>(' + pctHtml(posPct) + ')</small></strong></div>' +
        '<div><span>Frequência negativa</span><strong>' + fmtInt(item.negative) + ' de ' + fmtInt(item.nonOverlapN) +
          ' <small>(' + pctHtml(negPct) + ')</small></strong></div>' +
        neutral +
        '<p>Frequência descritiva da subamostra sem sobreposição. Não representa previsão futura.</p>' +
      '</div>';
    } else {
      freq = '<div class="vol-insufficient" role="status">Amostra insuficiente para frequência</div>';
    }
    return '' +
      '<article class="vol-horizon">' +
        '<header class="vol-horizon-head">' +
          '<h4>' + item.horizon + ' dias</h4>' +
          '<span>n sem sobreposição: ' + fmtInt(item.nonOverlapN) + '</span>' +
        '</header>' +
        '<div class="vol-horizon-main">' +
          '<div><span>Mediana</span><strong>' + pctHtml(item.median, true) + '</strong></div>' +
          '<div><span>Amplitude</span><strong>' + pctHtml(item.min, true) + ' a ' + pctHtml(item.max, true) + '</strong></div>' +
          '<div><span>Movimentos ≥ 10%</span><strong>' + fmtInt(item.abs10) + ' de ' + fmtInt(item.nonOverlapN) + '</strong></div>' +
        '</div>' +
        freq +
        '<p class="vol-horizon-meta">' + fmtInt(item.identified) + ' identificados · Sem janela completa: ' +
          incompleteLabel + ' · ' + fmtInt(item.complete) + ' completas · ' +
          fmtInt(item.overlap) + ' com sobreposição · ' + fmtInt(item.nonOverlapN) +
          ' na subamostra (' + fmtInt(excludedOverlap) + ' excluídas na seleção por sobreposição)</p>' +
      '</article>';
  }

  function manualSectionHtml(model) {
    var rows = MANUAL_EVENTS.map(function (event) {
      var detail = event.precision === 'month'
        ? '<span class="vol-muted"> · ano não informado</span>'
        : '';
      return '<tr>' +
        '<th scope="row">' + esc(event.label) + detail + '</th>' +
        '<td class="vol-num">' + pctHtml(event.value) + '</td>' +
        '<td><span class="vol-tag">Registro manual — não usado no cálculo</span></td>' +
      '</tr>';
    }).join('');

    var comparison = '';
    if (model && isNum(model.current)) {
      var dated = MANUAL_EVENTS.filter(function (event) {
        return event.precision === 'day';
      }).sort(function (a, b) {
        return manualTimestamp(b) - manualTimestamp(a);
      });
      if (dated.length) {
        var latest = dated[0];
        var diff = latest.value - model.current;
        var officialDate = fmtDateUTC(model.currentTime);
        var sameDate = latest.label === officialDate;
        comparison = '<div class="vol-compare">' +
          '<div><span>Oficial BB(20,2)</span><strong>' + pctHtml(model.current) + '</strong><small>' + esc(officialDate) + ' UTC</small></div>' +
          '<div><span>Manual mais recente</span><strong>' + pctHtml(latest.value) + '</strong><small>' + esc(latest.label) + '</small></div>' +
          '<div><span>Diferença</span><strong>' + fmtPoints(diff, true) + '</strong><small>métricas distintas' + (sameDate ? '' : '; a data pode coincidir') + '</small></div>' +
        '</div>';
      }
    }

    return '<section class="vol-manual" aria-labelledby="vol-manual-title">' +
      '<div class="vol-section-head">' +
        '<h3 id="vol-manual-title">Registros manuais</h3>' +
        '<span>Preservados como referência; não entram no cálculo</span>' +
      '</div>' +
      comparison +
      '<div class="vol-table-wrap" tabindex="0" role="region" aria-label="Tabela de registros manuais">' +
        '<table class="vol-table">' +
          '<caption>Registros manuais informados, incluindo datas incompletas</caption>' +
          '<thead><tr><th scope="col">Registro</th><th scope="col">Valor</th><th scope="col">Origem</th></tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
    '</section>';
  }

  function fullSampleHtml(model) {
    if (!model.horizons.length) {
      return '<details class="vol-details"><summary>Amostra completa e sobreposição</summary>' +
        '<p>Não há episódio ativo para calcular a amostra histórica.</p></details>';
    }
    var showFullFrequency = model.horizons.some(function (item) { return item.frequencyAllowed; });
    var rows = model.horizons.map(function (item) {
      var freq = showFullFrequency
        ? '<td>' + (item.frequencyAllowed
          ? fmtInt(item.full.positive) + ' / ' + fmtInt(item.full.negative)
          : '—') + '</td>'
        : '';
      var incomplete = item.incomplete != null ? item.incomplete : item.identified - item.complete;
      return '<tr>' +
        '<th scope="row">' + item.horizon + 'd</th>' +
        '<td>' + fmtInt(item.identified) + '</td>' +
        '<td>' + fmtInt(incomplete) + '</td>' +
        '<td>' + fmtInt(item.complete) + '</td>' +
        '<td>' + fmtInt(item.overlap) + '</td>' +
        '<td>' + fmtInt(item.nonOverlapN) + '</td>' +
        '<td>' + fmtInt(item.complete - item.nonOverlapN) + '</td>' +
        '<td>' + pctHtml(item.full.median, true) + '</td>' +
        '<td>' + pctHtml(item.full.min, true) + '</td>' +
        '<td>' + pctHtml(item.full.max, true) + '</td>' +
        '<td>' + fmtInt(item.full.abs10) + '</td>' +
        freq +
      '</tr>';
    }).join('');

    var excluded = model.excludedReasons || { pre_history: 0, gap_unconfirmed: 0 };
    return '<details class="vol-details">' +
      '<summary>Amostra completa e sobreposição</summary>' +
      '<p class="vol-note">A amostra completa é descritiva e inclui janelas que podem se sobrepor. A tabela principal usa a subamostra sem sobreposição. As medianas das duas amostras podem divergir porque representam conjuntos diferentes de episódios; isso é descritivo, não é erro nem evidência de capacidade preditiva.</p>' +
      '<div class="vol-table-wrap" tabindex="0" role="region" aria-label="Tabela da amostra completa">' +
        '<table class="vol-table vol-table-wide">' +
          '<caption>Comparação entre amostra completa e subamostra sem sobreposição</caption>' +
          '<thead><tr>' +
            '<th scope="col">Horizonte</th><th scope="col">Identificados</th><th scope="col">Sem janela completa</th>' +
            '<th scope="col">Completas</th><th scope="col">Completas com sobreposição</th><th scope="col">Na subamostra</th>' +
            '<th scope="col">Excluídas na seleção</th><th scope="col">Mediana completa</th><th scope="col">Mín.</th><th scope="col">Máx.</th>' +
            '<th scope="col">|≥10%|</th>' +
            (showFullFrequency ? '<th scope="col">Pos./neg. completas</th>' : '') +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<p class="vol-note">Episódios não confirmados por dados insuficientes: ' + fmtInt(model.excluded.length) +
        ' (iniciados antes do histórico: ' + fmtInt(excluded.pre_history) +
        '; lacuna sem transição confirmada: ' + fmtInt(excluded.gap_unconfirmed) +
        '). Essa contagem não inclui episódios sem janela futura completa nem exclusões por sobreposição.</p>' +
      '<p class="vol-note">Uma janela é envolvida em sobreposição quando compartilha dias de retorno com outra janela completa. Cada episódio é contado uma vez. A subamostra aceita um sinal somente quando está a pelo menos h dias do último aceito; janelas que apenas se tocam no fechamento D+h não compartilham dias de retorno. As colunas “Completas com sobreposição” e “Excluídas na seleção” medem coisas diferentes: a primeira conta janelas que compartilham dias; a segunda conta quantas foram retiradas pela seleção sem sobreposição.</p>' +
      '<p class="vol-note">A seleção reduz a sobreposição, mas não elimina a dependência entre episódios do mesmo regime de mercado. Não há cálculo de intervalo de confiança nem inferência de previsão.</p>' +
    '</details>';
  }

  function methodologyHtml(meta) {
    var timeSource = timeSourceDetail(meta);
    return '<details class="vol-details">' +
      '<summary>Metodologia, fonte e limitações</summary>' +
      '<div class="vol-method-grid">' +
        '<section><h4>Indicador</h4><p>Largura percentual das Bandas de Bollinger (20,2): <code>4 × DP20 / SMA20 × 100</code>, com desvio-padrão populacional e candles diários fechados em UTC. É uma métrica alternativa; não reproduz necessariamente a fórmula original da planilha.</p></section>' +
        '<section><h4>Faixas</h4><p>Faixas: abaixo de 5,00; de 5,00 até abaixo de 6,00; de 6,00 até abaixo de 8,00; de 8,00 até abaixo de 10,00; 10,00 ou mais. A classificação usa a largura não arredondada; a exibição pode ser arredondada. São referências da planilha aplicadas à métrica alternativa, não níveis de previsão.</p></section>' +
        '<section><h4>Episódios e retornos</h4><p>O sinal é o primeiro candle fechado abaixo do limiar após um fechamento igual ou superior. O retorno é close-to-close: <code>(close[D+h] / close[D] − 1) × 100</code>. Só entram janelas com todos os candles diários entre D e D+h.</p></section>' +
        '<section><h4>Sobreposição</h4><p>Para cada horizonte, os sinais são ordenados por data e uma subamostra aceita um novo sinal apenas quando ele está a pelo menos h dias do último aceito. A seleção reduz a sobreposição dos retornos, mas não elimina a dependência de regime.</p></section>' +
        '<section><h4>Frequências</h4><p>Frequências positivas e negativas só aparecem quando a subamostra sem sobreposição tem n ≥ 20. São descritivas e não representam previsão futura.</p></section>' +
        '<section><h4>Tempo e cache</h4><p>O candle só é considerado fechado quando seu closeTime é anterior ao horário de referência. Fonte efetiva nesta renderização: ' + esc(timeSource) + '. O cabeçalho HTTP Date só é usado se o navegador conseguir lê-lo; quando não estiver exposto, o widget consulta <code>' + TIME_HOST + '/api/v3/time</code> (HTTP 200 e <code>serverTime</code> numérico). Se essa consulta falhar, usa o relógio local com margem de 5 minutos; esse fallback não tem host remoto e depende do relógio do dispositivo. O cache local é versionado e a atualização diária busca apenas candles novos, com sobreposição de 8 dias. Requisições têm timeout de 15 s com cancelamento via AbortController.</p></section>' +
        '<section><h4>Limitações</h4><p>Os registros manuais não são comparáveis diretamente à métrica calculada. A amostra é pequena e dependente; não há previsão de direção ou preço. O cache é local ao navegador. Falhas de rede preservam o último histórico válido.</p></section>' +
        '<section><h4>Fonte</h4><p><a href="https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&amp;interval=1d&amp;limit=1000" target="_blank" rel="noopener noreferrer">Binance Vision — BTCUSDT, candles diários</a>. Histórico desde 17/08/2017.</p></section>' +
      '</div>' +
    '</details>';
  }

  function userFacingError(message) {
    var text = String(message || '').trim();
    if (/tempo limite/i.test(text)) {
      return 'A Binance não respondeu dentro do tempo limite. Tente novamente em alguns instantes.';
    }
    if (/failed to fetch|networkerror|load failed/i.test(text)) {
      return 'Não foi possível acessar a Binance. Verifique a conexão e tente novamente.';
    }
    if (/^HTTP 5\d\d$/.test(text)) {
      return 'A Binance está instável no momento. Tente novamente em alguns instantes.';
    }
    if (/^HTTP 4\d\d$/.test(text)) {
      return 'A Binance recusou a consulta (' + text + '). Tente novamente mais tarde.';
    }
    return text || 'Tente novamente em alguns instantes.';
  }

  function statusText(meta) {
    if (meta.status === 'fresh') return 'Atualizado';
    if (meta.status === 'updated') return 'Atualizado agora';
    if (meta.status === 'stale') return meta.cooldown ? 'Aguardando nova tentativa' : 'Desatualizado';
    return 'Erro';
  }

  function statusClass(meta) {
    if (meta.status === 'fresh' || meta.status === 'updated') return 'vol-status-ok';
    if (meta.status === 'stale') return 'vol-status-warn';
    return 'vol-status-error';
  }

  function timeSourceShort(meta) {
    if (!meta || !meta.timeSource) return 'não determinada';
    if (meta.timeSource === 'server') {
      if (meta.timeSourceMethod === 'date-header') return 'servidor Binance (cabeçalho Date)';
      if (meta.timeSourceMethod === 'server-time') return 'servidor Binance (/api/v3/time)';
      return 'servidor Binance';
    }
    if (meta && meta.timeSource === 'local-cache') return 'cache local já validado';
    return 'relógio local com margem (sem horário válido de ' + TIME_HOST + ')';
  }

  function timeSourceDetail(meta) {
    if (!meta || !meta.timeSource) return 'não determinada (sem referência temporal válida nesta tentativa)';
    if (meta.timeSource === 'server') {
      if (meta.timeSourceMethod === 'date-header') return 'cabeçalho HTTP Date do servidor Binance';
      if (meta.timeSourceMethod === 'server-time') return 'servidor Binance via ' + TIME_HOST + '/api/v3/time';
      return 'servidor Binance';
    }
    if (meta && meta.timeSource === 'local-cache') return 'cache local já validado';
    return 'relógio local com margem conservadora de 5 minutos (fallback após falha ou horário inválido em ' + TIME_HOST + '/api/v3/time; depende do relógio do dispositivo)';
  }

  function topHtml(model, meta) {
    if (!model || !isNum(model.current)) {
      return '<div class="vol-unavailable" role="status">' +
        '<strong>Indicador indisponível com segurança.</strong>' +
        '<span>O histórico não tem candles fechados suficientes ou a janela BB20 contém lacuna.</span>' +
      '</div>';
    }
    var trigger = model.nextTrigger;
    var triggerLabel = trigger && trigger.kind === 'exit' ? 'Referência de saída' : 'Próximo gatilho';
    var direction = trigger && trigger.direction === 'up' ? 'para cima' : 'para baixo';
    var distance = trigger
      ? fmtPoints(trigger.distance) + (trigger.distancePct != null ? ' (' + pctHtml(trigger.distancePct) + ' da largura atual)' : '')
      : '—';
    var shortDistance = trigger
      ? 'Distância até ' + fmt2(trigger.reference) + ': <b>' + distance + '</b>. Não é previsão nem preço-alvo.'
      : 'Sem gatilho calculado.';
    return '<div class="vol-top">' +
      '<div class="vol-current-block">' +
        '<span class="vol-eyebrow">Largura BB(20,2)</span>' +
        '<div class="vol-current-value">' + pctHtml(model.current) + '</div>' +
        '<div class="vol-band vol-band-' + model.band.key + '">' + esc(model.band.label) + '</div>' +
        '<p class="vol-current-date">Candle fechado: <b>' + esc(fmtDateUTC(model.currentTime)) + ' UTC</b></p>' +
      '</div>' +
      '<div class="vol-gauge-block">' +
        '<span class="vol-eyebrow">Faixas de referência</span>' +
        gaugeHtml(model.current, model.band) +
        '<p class="vol-gauge-note">Quanto menor a largura, maior o alerta de compressão. A faixa não indica direção do preço.</p>' +
      '</div>' +
      '<div class="vol-next-block">' +
        '<span class="vol-eyebrow">' + triggerLabel + '</span>' +
        '<div class="vol-next-value">' + (trigger ? fmt2(trigger.reference) : '—') + '</div>' +
        '<div class="vol-next-dir">' + (trigger ? direction : '—') + '</div>' +
        '<p class="vol-next-short">' + shortDistance + '</p>' +
      '</div>' +
    '</div>' +
    '<div class="vol-meta-row">' +
      '<span>Última verificação: <b>' + esc(fmtDateTimeBR(meta.checkedAt)) + '</b> (Brasília)</span>' +
      '<span data-time-source="' + esc(meta.timeSourceMethod || meta.timeSource || '') + '" data-time-host="' + TIME_HOST + '">Referência temporal: <b>' + esc(timeSourceShort(meta)) + '</b></span>' +
      '<span>' + (meta.persistenceAvailable ? 'Cache local ativo' : 'Persistência local indisponível — dados apenas nesta sessão') + '</span>' +
    '</div>';
  }

  function historyHtml(model) {
    if (!model.horizons.length) {
      return '<section class="vol-history" aria-labelledby="vol-history-title">' +
        '<div class="vol-section-head"><h3 id="vol-history-title">Resultados históricos</h3></div>' +
        '<p class="vol-note">Não há episódio ativo para calcular a amostra histórica.</p>' +
      '</section>';
    }
    var excluded = model.excludedReasons || { pre_history: 0, gap_unconfirmed: 0 };
    return '<section class="vol-history" aria-labelledby="vol-history-title">' +
      '<div class="vol-section-head">' +
        '<div><h3 id="vol-history-title">O que aconteceu após episódios semelhantes</h3>' +
        '<p>Episódios identificados abaixo de ' + fmt2(model.threshold) + '. A tabela usa a subamostra sem sobreposição; a amostra completa, em detalhes, pode ter medianas diferentes por reunir outro conjunto de episódios.</p></div>' +
        '<span class="vol-tag">' + fmtInt(model.episodes.length) + ' episódios identificados</span>' +
      '</div>' +
      '<p class="vol-note">Episódios não confirmados por dados insuficientes: ' + fmtInt(model.excluded.length) +
        ' (início antes do histórico: ' + fmtInt(excluded.pre_history) +
        '; lacuna sem transição confirmada: ' + fmtInt(excluded.gap_unconfirmed) +
        '). Essa contagem não inclui episódios sem janela futura completa nem exclusões por sobreposição.</p>' +
      '<div class="vol-horizons">' + model.horizons.map(horizonCard).join('') + '</div>' +
      fullSampleHtml(model) +
    '</section>';
  }

  function detailsToggleContent(expanded) {
    return (expanded ? 'Ocultar detalhes' : 'Ver detalhes') +
      ' <span class="vol-expand-icon" aria-hidden="true">' + (expanded ? '−' : '+') + '</span>';
  }

  function detailsToggleHtml(expanded) {
    return '<button type="button" class="vol-expand-toggle" id="vol-expand-toggle" aria-expanded="' +
      (expanded ? 'true' : 'false') + '" aria-controls="vol-expand-region">' +
      detailsToggleContent(expanded) + '</button>';
  }

  function cardHtml(model, meta) {
    var gaps = meta.gaps || model.gaps || [];
    var chartClipped = (model.chart || []).some(function (point) {
      return isNum(point.width) && point.width > CHART_AXIS_MAX;
    });
    var cacheNote = meta.persistenceAvailable
      ? 'Cache local ativo.'
      : 'Persistência local indisponível; os dados ficam apenas nesta sessão.';
    var errorNote = meta.error
      ? '<div class="vol-alert" role="status">' + esc(userFacingError(meta.error)) + '</div>'
      : '';
    var gapNote = gaps.length
      ? '<div class="vol-alert vol-alert-warn">Histórico com ' + fmtInt(gaps.length) +
        ' lacuna(s). Janelas que cruzam lacunas não entram nos retornos; a janela atual só é calculada se estiver contínua.</div>'
      : '';
    return '<section class="vol-card" aria-labelledby="vol-title">' +
      '<header class="vol-head">' +
        '<div class="vol-head-copy">' +
          '<span class="vol-eyebrow">INDICADOR DIÁRIO · BTCUSDT</span>' +
          '<h2 id="vol-title">Volatilidade do Bitcoin</h2>' +
          '<p>Compressão das Bandas de Bollinger (20,2) e comportamento observado após sinais semelhantes.</p>' +
        '</div>' +
        '<div class="vol-head-actions">' +
          '<span class="vol-status ' + statusClass(meta) + '" role="status" aria-live="polite">' + esc(statusText(meta)) + '</span>' +
          '<button type="button" class="vol-refresh" id="vol-refresh">Atualizar</button>' +
        '</div>' +
      '</header>' +
      errorNote +
      topHtml(model, meta) +
      detailsToggleHtml(false) +
      '<div class="vol-expand-region" id="vol-expand-region" hidden>' +
        gapNote +
        '<p class="vol-expand-intro">O percentual é relativo à largura atual. A direção indica o lado do limiar; não é variação esperada, preço-alvo ou previsão.</p>' +
        '<section class="vol-chart-section" aria-labelledby="vol-chart-title">' +
          '<div class="vol-section-head">' +
            '<div><h3 id="vol-chart-title">Últimos 90 candles fechados</h3>' +
            '<p>Linha da largura percentual e referências de 5, 6, 8 e 10. Escala vertical até 15%' +
              (chartClipped ? '; picos acima aparecem cortados no topo.' : '.') + '</p></div>' +
          '</div>' +
          '<div class="vol-chart-host" data-vol-chart-host></div>' +
        '</section>' +
        historyHtml(model) +
        manualSectionHtml(model) +
        methodologyHtml(meta) +
        '<footer class="vol-footer">' +
          '<span>Fonte: Binance Vision · BTCUSDT 1D · último candle fechado em ' + esc(fmtDateUTC(model.currentTime)) + ' UTC.</span>' +
          '<span>' + esc(cacheNote) + ' Próxima verificação automática após 00:00 UTC.</span>' +
        '</footer>' +
      '</div>' +
    '</section>';
  }

  function cleanupDetails(root) {
    if (root && typeof root.__volDetailsCleanup === 'function') {
      root.__volDetailsCleanup();
      root.__volDetailsCleanup = null;
    }
  }

  function bindDetails(root, model) {
    var button = root.querySelector('#vol-expand-toggle');
    var region = root.querySelector('#vol-expand-region');
    var host = root.querySelector('[data-vol-chart-host]');
    if (!button || !region || !host) return;
    var resizeTimer = null;
    function drawChart() {
      if (region.hidden) return;
      host.innerHTML = chartSvg(model);
    }
    function onResize() {
      if (region.hidden) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(drawChart, 120);
    }
    function setExpanded(expanded) {
      button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      button.innerHTML = detailsToggleContent(expanded);
      region.hidden = !expanded;
      if (expanded) {
        drawChart();
      } else {
        host.innerHTML = '';
      }
    }
    button.addEventListener('click', function () {
      setExpanded(button.getAttribute('aria-expanded') !== 'true');
    });
    window.addEventListener('resize', onResize);
    root.__volDetailsCleanup = function () {
      window.removeEventListener('resize', onResize);
      clearTimeout(resizeTimer);
    };
  }

  function renderCard(root, model, meta) {
    cleanupDetails(root);
    root.innerHTML = cardHtml(model, meta);
    bindRefresh(root);
    bindDetails(root, model);
  }

  function renderLoading(root) {
    cleanupDetails(root);
    root.innerHTML = '<section class="vol-card" aria-labelledby="vol-title">' +
      '<header class="vol-head">' +
        '<div class="vol-head-copy">' +
          '<span class="vol-eyebrow">INDICADOR DIÁRIO · BTCUSDT</span>' +
          '<h2 id="vol-title">Volatilidade do Bitcoin</h2>' +
          '<p>Carregando candles diários fechados e calculando a compressão.</p>' +
        '</div>' +
        '<span class="vol-status vol-status-loading" role="status" aria-live="polite">Carregando</span>' +
      '</header>' +
      '<div class="vol-loading" role="status"><span class="vol-spinner" aria-hidden="true"></span> Consultando a Binance e validando o histórico local…</div>' +
    '</section>';
    bindRefresh(root);
  }

  function renderError(root, meta, message) {
    cleanupDetails(root);
    root.innerHTML = '<section class="vol-card" aria-labelledby="vol-title">' +
      '<header class="vol-head">' +
        '<div class="vol-head-copy">' +
          '<span class="vol-eyebrow">INDICADOR DIÁRIO · BTCUSDT</span>' +
          '<h2 id="vol-title">Volatilidade do Bitcoin</h2>' +
          '<p>O histórico oficial não está disponível no momento.</p>' +
        '</div>' +
        '<span class="vol-status vol-status-error" role="status" aria-live="polite">Erro sem histórico válido</span>' +
      '</header>' +
      '<div class="vol-error" role="alert">' +
        '<strong>Não foi possível carregar os candles da Binance.</strong>' +
        '<span>' + esc(userFacingError(message)) + '</span>' +
      '</div>' +
      '<div class="vol-head-actions"><button type="button" class="vol-refresh" id="vol-refresh">Tentar novamente</button></div>' +
    '</section>';
    bindRefresh(root);
  }

  function bindRefresh(root) {
    var button = root.querySelector('#vol-refresh');
    if (!button) return;
    button.addEventListener('click', function () {
      if (root.__volRefresh) root.__volRefresh(true);
    });
  }

  async function init() {
    var root = typeof document !== 'undefined' ? document.getElementById('volatility-root') : null;
    if (!root || root.getAttribute('data-vol-init') === '1') return;
    root.setAttribute('data-vol-init', '1');
    var host = getRoot() || {};
    var config = host.BI_CONFIG || {};
    var storage = getStorage();
    var loader;
    try {
      loader = createLoader({
        config: config,
        storage: storage,
        fetchImpl: host.fetch ? host.fetch.bind(host) : null
      });
    } catch (error) {
      renderError(root, {}, error.message || 'Não foi possível iniciar o widget.');
      return;
    }
    var refreshing = false;
    var lastModel = null;
    var lastMeta = null;

    async function refresh(force, silent) {
      if (refreshing) return;
      refreshing = true;
      if (!silent || !lastModel) renderLoading(root);
      try {
        var result = await loader.load({ force: !!force });
        lastMeta = result;
        if (!result.cache) {
          renderError(root, result, result.error);
        } else {
          var model = computeModel(result.cache.candles);
          lastModel = model;
          renderCard(root, model, result);
        }
      } catch (error) {
        if (lastModel && lastMeta) {
          lastMeta = Object.assign({}, lastMeta, { status: 'stale', error: error.message });
          renderCard(root, lastModel, lastMeta);
        } else {
          renderError(root, lastMeta || {}, error.message || 'Falha inesperada.');
        }
      } finally {
        refreshing = false;
      }
    }

    root.__volRefresh = refresh;
    bindRefresh(root);

    function schedule() {
      var now = Date.now();
      var next = dayOpen(now) + DAY + LOCAL_FALLBACK_SAFETY_MS + 60 * 1000;
      if (next <= now) next += DAY;
      var delay = Math.max(1000, next - now);
      setTimeout(function () {
        refresh(false, true).finally(schedule);
      }, delay);
    }

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refresh(false, true);
    });

    await refresh(false, false);
    schedule();
  }

  var testApi = {
    DAY: DAY,
    HORIZONS: HORIZONS,
    THRESHOLDS: THRESHOLDS,
    EPISODE_THRESHOLD: EPISODE_THRESHOLD,
    MANUAL_EVENTS: MANUAL_EVENTS,
    BANDS: BANDS,
    CACHE_KEY: CACHE_KEY,
    CACHE_VERSION: CACHE_VERSION,
    HISTORY_START: HISTORY_START,
    MAX_CANDLES: MAX_CANDLES,
    OVERLAP_DAYS: OVERLAP_DAYS,
    MAX_INCREMENTAL_PAGES: MAX_INCREMENTAL_PAGES,
    MAX_GAP_FILLS: MAX_GAP_FILLS,
    MAX_FULL_REFRESH_PER_SESSION: MAX_FULL_REFRESH_PER_SESSION,
    RETRY_COOLDOWN_MS: RETRY_COOLDOWN_MS,
    LOCAL_FALLBACK_SAFETY_MS: LOCAL_FALLBACK_SAFETY_MS,
    DEFAULT_KLINES_BASE: DEFAULT_KLINES_BASE,
    DEFAULT_TIME_URL: DEFAULT_TIME_URL,
    CHART_AXIS_MAX: CHART_AXIS_MAX,
    CHART_MIN_LABEL_GAP: CHART_MIN_LABEL_GAP,
    CHART_VIEWBOX_WIDTH: CHART_VIEWBOX_WIDTH,
    CHART_MIN_RENDERED_WIDTH: CHART_MIN_RENDERED_WIDTH,
    TIME_HOST: TIME_HOST,
    toCandle: toCandle,
    normalizeCandles: normalizeCandles,
    filterClosed: filterClosed,
    findGaps: findGaps,
    gapsInWindow: gapsInWindow,
    hasCurrentGap: hasCurrentGap,
    hasRecentGap: hasRecentGap,
    mergeCandles: mergeCandles,
    computeWidths: computeWidths,
    getBand: getBand,
    getNextTrigger: getNextTrigger,
    findEpisodes: findEpisodes,
    summarize: summarize,
    windowsOverlap: windowsOverlap,
    selectNonOverlapping: selectNonOverlapping,
    computeHorizonStats: computeHorizonStats,
    buildChartData: buildChartData,
    computeModel: computeModel,
    expectedLastOpen: expectedLastOpen,
    resolveReference: resolveReference,
    parseServerDate: parseServerDate,
    makeCache: makeCache,
    serializeCache: serializeCache,
    validateCacheRecord: validateCacheRecord,
    planRefresh: planRefresh,
    readCache: readCache,
    writeCache: writeCache,
    createLoader: createLoader,
    fmt2: fmt2,
    fmtSigned: fmtSigned,
    fmtPct: fmtPct,
    fmtPctSigned: fmtPctSigned,
    pctHtml: pctHtml,
    fmtPoints: fmtPoints,
    chartSvg: chartSvg,
    cardHtml: cardHtml,
    detailsToggleContent: detailsToggleContent,
    detailsToggleHtml: detailsToggleHtml,
    topHtml: topHtml,
    horizonCard: horizonCard,
    manualSectionHtml: manualSectionHtml,
    methodologyHtml: methodologyHtml,
    timeSourceShort: timeSourceShort,
    timeSourceDetail: timeSourceDetail,
    fmtDateUTC: fmtDateUTC,
    fmtDateTimeBR: fmtDateTimeBR,
    manualTimestamp: manualTimestamp,
    userFacingError: userFacingError
  };

  var host = getRoot();
  if (host) {
    host.BIWidgets = host.BIWidgets || {};
    host.BIWidgets.volatility = init;
  }
  if (typeof module === 'object' && module.exports) {
    module.exports = { _test: testApi };
  }
})();
