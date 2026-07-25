const fs = require('fs');
const path = require('path');

const SOURCE_URL =
  'https://charts-cdn.checkonchain.com/btconchain/pricing/' +
  'pricing_costbasisoriginals/pricing_costbasisoriginals_light.html';
const FALLBACK_URL =
  'https://raw.githubusercontent.com/checkmatey/checkonchain.com/main/btconchain/pricing/' +
  'pricing_costbasisoriginals/pricing_costbasisoriginals_light.html';

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

function traceToDailyMap(trace) {
  const values = decodeNumericArray(trace.y);
  const length = Math.min(trace.x.length, values.length);
  const map = new Map();

  for (let i = 0; i < length; i += 1) {
    const date = String(trace.x[i]).slice(0, 10);
    const value = Number(values[i]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      map.set(date, Number.isFinite(value) && value > 0 ? value : null);
    }
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
  const priceTrace = trace('Price');
  const realisedTrace = trace('Realised Price');
  const lthTrace = trace('LTH Cost Basis');

  if (!priceTrace || !realisedTrace || !lthTrace) {
    throw new Error('Uma ou mais séries esperadas não foram encontradas.');
  }

  const priceMap = traceToDailyMap(priceTrace);
  const realisedMap = traceToDailyMap(realisedTrace);
  const lthMap = traceToDailyMap(lthTrace);
  const dates = Array.from(new Set([...realisedMap.keys(), ...lthMap.keys(), ...priceMap.keys()]))
    .sort();

  const payload = {
    source: 'Checkonchain',
    sourcePage: 'https://charts.checkonchain.com/btconchain/pricing/pricing_costbasisoriginals/pricing_costbasisoriginals_light.html',
    updatedAt: new Date().toISOString(),
    dates,
    price: dates.map((date) => priceMap.get(date) ?? null),
    realised: dates.map((date) => realisedMap.get(date) ?? null),
    lth: dates.map((date) => lthMap.get(date) ?? null)
  };

  const dataDir = path.join(__dirname, '..', 'dados');
  const json = JSON.stringify(payload);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'costbasis.json'), `${json}\n`, 'utf8');
  fs.writeFileSync(
    path.join(dataDir, 'costbasis-data.js'),
    `window.BI_COSTBASIS_HISTORY = ${json};\n`,
    'utf8'
  );
  console.log(`Cost basis atualizado: ${dates.length} datas, ${Buffer.byteLength(json)} bytes.`);
}

update().catch((error) => {
  console.error('Erro:', error.message);
  process.exit(1);
});
