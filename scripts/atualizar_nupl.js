const fs = require('fs');
const path = require('path');

const SOURCE_URL =
  'https://charts-cdn.checkonchain.com/btconchain/unrealised/nupl/nupl_light.html';
const FALLBACK_URL =
  'https://raw.githubusercontent.com/checkmatey/checkonchain.com/main/' +
  'btconchain/unrealised/nupl/nupl_light.html';
const SOURCE_PAGE =
  'https://charts.checkonchain.com/btconchain/unrealised/nupl/nupl_light.html';

function extractPlotlyTraces(html) {
  const marker = 'Plotly.newPlot(';
  const callStart = html.indexOf(marker);
  if (callStart === -1) throw new Error('Plotly.newPlot não foi encontrado.');

  const arrayStart = html.indexOf('[', callStart + marker.length);
  if (arrayStart === -1) throw new Error('Array de séries não foi encontrado.');

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = arrayStart; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(arrayStart, i + 1));
    }
  }
  throw new Error('O array Plotly está incompleto.');
}

function decodeNumericArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value.bdata !== 'string') return [];

  const buffer = Buffer.from(value.bdata, 'base64');
  const readers = {
    f8: ['readDoubleLE', 8],
    f4: ['readFloatLE', 4],
    i4: ['readInt32LE', 4],
    u4: ['readUInt32LE', 4],
    i2: ['readInt16LE', 2],
    u2: ['readUInt16LE', 2]
  };
  const definition = readers[value.dtype];
  if (!definition) throw new Error(`Formato Plotly não suportado: ${value.dtype}`);

  const [reader, bytes] = definition;
  const output = new Array(Math.floor(buffer.length / bytes));
  for (let i = 0; i < output.length; i += 1) output[i] = buffer[reader](i * bytes);
  return output;
}

function traceToDailyMap(trace, positiveOnly) {
  const values = decodeNumericArray(trace.y);
  const length = Math.min(trace.x.length, values.length);
  const map = new Map();

  for (let i = 0; i < length; i += 1) {
    const date = String(trace.x[i]).slice(0, 10);
    const value = Number(values[i]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const valid = Number.isFinite(value) && (!positiveOnly || value > 0);
    map.set(date, valid ? value : null);
  }
  return map;
}

async function downloadSource() {
  for (const url of [SOURCE_URL, FALLBACK_URL]) {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Bitcoiniciantes-data-updater/1.0' }
    });
    if (response.ok) return response.text();
  }
  throw new Error('Não foi possível baixar a fonte principal nem a contingência.');
}

async function update() {
  const traces = extractPlotlyTraces(await downloadSource());
  const trace = (name) => traces.find((item) => item && item.name === name);
  const expected = {
    price: trace('Price'),
    euphoria: trace('Euphoria-Greed'),
    belief: trace('Belief-Denial'),
    optimism: trace('Optimism'),
    hopeFear: trace('Hope-Fear'),
    capitulation: trace('Capitulation')
  };

  const missing = Object.entries(expected)
    .filter(([, item]) => !item)
    .map(([name]) => name);
  if (missing.length) throw new Error(`Séries ausentes: ${missing.join(', ')}.`);

  const maps = {
    price: traceToDailyMap(expected.price, true),
    euphoria: traceToDailyMap(expected.euphoria, false),
    belief: traceToDailyMap(expected.belief, false),
    optimism: traceToDailyMap(expected.optimism, false),
    hopeFear: traceToDailyMap(expected.hopeFear, false),
    capitulation: traceToDailyMap(expected.capitulation, false)
  };
  const today = new Date().toISOString().slice(0, 10);
  const dates = Array.from(
    new Set(Object.values(maps).flatMap((map) => Array.from(map.keys())))
  ).filter((date) => date <= today).sort();

  const payload = {
    source: 'Checkonchain',
    sourcePage: SOURCE_PAGE,
    updatedAt: new Date().toISOString(),
    latestDataDate: dates.at(-1) || null,
    dates
  };
  for (const [key, map] of Object.entries(maps)) {
    payload[key] = dates.map((date) => map.get(date) ?? null);
  }

  const dataDir = path.join(__dirname, '..', 'dados');
  const json = JSON.stringify(payload);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'nupl.json'), `${json}\n`, 'utf8');
  fs.writeFileSync(
    path.join(dataDir, 'nupl-data.js'),
    `window.BI_NUPL_HISTORY = ${json};\n`,
    'utf8'
  );
  console.log(
    `NUPL atualizado: ${dates.length} datas, última em ${payload.latestDataDate}, ` +
    `${Buffer.byteLength(json)} bytes.`
  );
}

update().catch((error) => {
  console.error('Erro:', error.message);
  process.exit(1);
});
