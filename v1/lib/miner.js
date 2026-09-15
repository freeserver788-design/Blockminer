const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

let logFile = null;
try {
  const { app } = require('electron');
  if (app && app.getPath) logFile = path.join(app.getPath('userData'), 'miner.log');
} catch (_) {}

const LOL_ALGO = { FLUX: 'AUTOLYKOS2', KAS: 'KHEAVYHASH', ERG: 'AUTOLYKOS2', ZEPH: 'ZEPHYR', ALPH: 'BLAKE3' };
const SRB_ALGO = { FLUX: 'AUTOLYKOS2', KAS: 'KASPA', ERG: 'AUTOLYKOS2', ZEPH: 'ZEPHYR', ALPH: 'ALEPHIUM' };
const GPU_COINS = ['FLUX', 'KAS', 'ERG', 'ZEPH', 'ALPH'];

function flavorOf(p) {
  const n = path.basename(p || '').toLowerCase();
  if (n.includes('lolminer')) return 'lol';
  if (n.includes('xmrig')) return 'xmrig';
  if (n.includes('srb')) return 'srb';
  return 'generic';
}

function cleanWallet(coin, raw) {
  let w = String(raw || '').trim().replace(/[\u200b-\u200d\ufeff]/g, '');
  w = w.replace(/^(FLUX|tFLUX|KAS|ERG|ERGO|XMR|ZEPH|ALPH|BTC):/i, '');
  return w;
}

function buildArgs(profile) {
  const w = cleanWallet(profile.coin, profile.wallet);
  const worker = (profile.worker || 'rig1').trim().replace(/[^\w\-.]/g, '') || 'rig1';
  const extra = ((profile.extra || '').trim().split(/\s+/)).filter(Boolean);
  const dev = profile.gpuIndex ? ['--devices', String(profile.gpuIndex)] : [];
  const um = profile.coin === 'FLUX' ? 'FLUX:' : '';
  switch (flavorOf(profile.path)) {
    case 'lol':
      return ['--algo', LOL_ALGO[profile.coin] || 'AUTOLYKOS2',
        '--pool', profile.pool, '--user', um + w + '.' + worker, '--pass', 'x', ...dev, ...extra];
    case 'srb':
      return ['--algorithm', SRB_ALGO[profile.coin] || profile.coin,
        '--pool', profile.pool, '--wallet', um + w + '.' + worker, '--password', 'x', ...dev, ...extra];
    case 'xmrig':
      return ['-o', profile.pool, '-u', w, '-p', worker, ...extra];
    default:
      switch (profile.coin) {
        case 'FLUX': return ['--coin', 'AUTOLYKOS2', '--pool', profile.pool, '--user', um + w + '.' + worker, ...dev, ...extra];
        case 'XMR':  return ['-o', profile.pool, '-u', w || '', '-p', worker, ...extra];
        case 'BTC':  return ['-a', 'sha256d', '-o', profile.pool, '-u', w + '.' + worker, '-p', 'c=BTC', ...extra];
        default:     return extra;
      }
  }
}

let child = null;
let emit = () => {};
let onStopped = () => {};

function emitAll(m) {
  if (logFile) {
    try {
      fs.appendFileSync(logFile, '[' + new Date(m.time).toLocaleTimeString('de-DE') + '] ' + m.line + '\n');
    } catch (_) {}
  }
  emit(m);
}

function send(chunk, type) {
  String(chunk).split(/\r?\n/).forEach((l) => {
    const clean = String(l).replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\u001b\][^\u0007]+\u0007/g, '');
    if (clean.trim()) emitAll({ time: Date.now(), type, line: clean });
  });
}

function setEmitter(fn) { emit = fn || (() => {}); }
function setStoppedListener(fn) { onStopped = fn || (() => {}); }

function wire(proc, label) {
  proc.stdout.on('data', (d) => send(d, 'out'));
  proc.stderr.on('data', (d) => send(d, 'err'));
  proc.on('error', (err) => emitAll({ time: Date.now(), type: 'err', line: 'FEHLER: ' + err.message }));
  proc.on('exit', (code) => {
    child = null;
    emitAll({ time: Date.now(), type: 'sys', line: `${label} beendet (Code ${code}).` });
    onStopped();
  });
  child = proc;
}

function launch(profile, label) {
  const isBuiltin = profile.builtin;
  if (isBuiltin) {
    const runPath = path.join(__dirname, '..', 'miner', 'run.js');
    const threads = Math.max(1, Math.min(os.cpus().length, 16));
    const args = [
      runPath,
      '--threads', String(threads),
      '--coin', profile.coin || 'CUSTOM',
      '--pool', profile.pool || 'lokal',
      '--wallet', cleanWallet(profile.coin, profile.wallet) || 'benchmark',
      '--worker', profile.worker || 'rig1',
    ];
    const proc = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    });
    wire(proc, label || 'Built-in Miner');
    emitAll({ time: Date.now(), type: 'sys', line: `Echtes SHA-256-Stratum-Mining gestartet (${threads} Threads).` });
    emitAll({ time: Date.now(), type: 'sys', line: `Pool: ${profile.pool || 'kein Pool gesetzt'}` });
  } else {
    const p = (profile.path || '').trim();
    if (!p || !fs.existsSync(p)) {
      emitAll({ time: Date.now(), type: 'err', line: 'Miner-Datei nicht gefunden: ' + p });
      onStopped();
      return;
    }
    const size = fs.statSync(p).size;
    const args = buildArgs(profile);
    const proc = spawn(p, args, { cwd: path.dirname(p), windowsHide: true });
    wire(proc, label || 'Miner');
    emitAll({ time: Date.now(), type: 'sys', key: 'log.minerChecked', vars: { name: path.basename(p), mb: (size / 1048576).toFixed(1) } });
    emitAll({ time: Date.now(), type: 'sys', key: 'log.starting', vars: { cmd: path.basename(p) + ' ' + args.join(' ') } });
  }
}

/* ---------------- externer Miner ---------------- */
function startExternal(profile) {
  if (child) return { ok: false, error: 'err.running' };
  const p = (profile.path || '').trim();
  if (!p || !fs.existsSync(p)) return { ok: false, error: 'err.noFile' };
  launch(profile, 'Miner');
  return { ok: true };
}

/* ---------------- Built-in Miner (eigenes Engine-Script) ---------------- */
function startBuiltin(profile) {
  if (child) return { ok: false, error: 'err.running' };
  launch(Object.assign({}, profile, { builtin: true }), 'Built-in Miner');
  return { ok: true };
}

function hasMiner() {
  return child !== null;
}

function stop() {
  if (child) { const c = child; child = null; try { c.kill(); } catch (_) {} }
}

module.exports = { startExternal, startBuiltin, stop, hasMiner, setEmitter, setStoppedListener, GPU_COINS, buildArgs };