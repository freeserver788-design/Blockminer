const { execFile } = require('child_process');

const FIELDS = [
  'index', 'name', 'driver_version', 'pstate',
  'temperature.gpu', 'fan.speed',
  'utilization.gpu', 'utilization.memory',
  'memory.total', 'memory.used',
  'clocks.sm', 'clocks.mem',
  'power.draw', 'power.limit',
];

const powerCache = new Map();
let bin = null;

async function resolveBin() {
  if (bin) return bin;
  const candidates = ['nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Windows\\nvidia-smi.exe'];
  for (const c of candidates) {
    try {
      await new Promise((resolve, reject) => {
        execFile(c, ['--version'], { timeout: 3000 }, (err) => (err ? reject() : resolve()));
      });
      bin = c;
      return bin;
    } catch (_) {}
  }
  return null;
}

function runNvidia(args) {
  return new Promise(async (resolve) => {
    const b = await resolveBin();
    if (!b) return resolve(null);
    execFile(b, args, { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.toString().trim());
    });
  });
}

function parseRows(out) {
  if (!out) return null;
  const lines = out.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(',').map((s) => s.trim().replace(/\s*\[.*?\]\s*/g, '').trim());
  return lines.slice(1).map((line) => {
    const c = line.split(',').map((s) => s.trim());
    const obj = {};
    header.forEach((h, i) => {
      let v = c[i];
      if (v === 'N/A' || v === '') v = '0';
      const num = parseFloat(v);
      obj[h] = Number.isNaN(num) ? v : num;
    });
    return obj;
  });
}

async function gpuStats() {
  const out = await runNvidia([
    '--query-gpu=' + FIELDS.join(','),
    '--format=csv,nounits',
  ]);
  if (!out) return null;
  const rows = parseRows(out);
  if (!rows) return null;
  return rows.map((g) => ({
    index: g.index,
    name: g.name,
    driver: g.driver_version,
    pstate: g.pstate,
    temp: g['temperature.gpu'],
    fan: g['fan.speed'] || 0,
    util: g['utilization.gpu'] || 0,
    memUtil: g['utilization.memory'] || 0,
    memTotal: g['memory.total'],
    memUsed: g['memory.used'],
    clkCore: g['clocks.sm'] || 0,
    clkMem: g['clocks.mem'] || 0,
    power: g['power.draw'] || 0,          // <-- jetzt wirklich die aktuelle Watt
    powerLimit: g['power.limit'] || 0,    // <-- und das Limit separat
  }));
}

async function powerInfo(index = 0) {
  if (powerCache.has(index)) return powerCache.get(index);
  const q = await runNvidia(['-q', '-d', 'POWER', '-i', String(index)]);
  let min = NaN, max = NaN, def = NaN;
  if (q) {
    min = parseFloat((q.match(/Min\s+Power\s+Limit\s*:\s*([\d.]+)/i) || [])[1]);
    max = parseFloat((q.match(/Max\s+Power\s+Limit\s*:\s*([\d.]+)/i) || [])[1]);
    def = parseFloat((q.match(/Default\s+Power\s+Limit\s*:\s*([\d.]+)/i) || [])[1]);
  }
  if (!isFinite(def) || !def) def = 200;
  if (!isFinite(min) || !min) min = Math.round(def * 0.4);
  if (!isFinite(max) || !max) max = Math.round(def * 1.2);
  min = Math.max(50, Math.floor(min));
  max = Math.ceil(max);
  const info = { min, max, def: Math.round(def) };
  powerCache.set(index, info);
  return info;
}

function setPowerLimit(watts, index = 0) {
  return new Promise((resolve) => {
    const args = ['-pl', String(Math.round(watts))];
    if (index != null && index !== 0) args.push('-i', String(index));
    execFile('nvidia-smi', args, (err, _stdout, stderr) => {
      if (err) {
        const msg = (stderr || '').toString() || 'nvidia-smi Fehler';
        const denied = /permission|insufficient|access denied|nicht gen/i.test(msg);
        return resolve({ ok: false, error: msg.trim(), admin: denied });
      }
      resolve({ ok: true, watts: Math.round(watts), index });
    });
  });
}

function isAdmin() {
  return new Promise((resolve) => {
    execFile('net', ['session'], { timeout: 3000 }, (err) => resolve(!err));
  });
}

module.exports = { gpuStats, powerInfo, setPowerLimit, isAdmin };