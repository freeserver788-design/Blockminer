const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

let logFile = null;
try {
  const { app } = require('electron');
  if (app && app.getPath) logFile = path.join(app.getPath('userData'), 'miner.log');
} catch (_) {}

const LOL_ALGO = { FLUX: 'AUTOLYKOS2', KAS: 'KASPA', ERG: 'AUTOLYKOS2', ZEPH: 'ZEPHYR', ALPH: 'ALEPH' };
const SRB_ALGO = { FLUX: 'AUTOLYKOS2', KAS: 'KASPA', ERG: 'AUTOLYKOS2', ZEPH: 'ZEPHYR', ALPH: 'ALEPHIUM' };
const GPU_COINS = ['FLUX', 'KAS', 'ERG', 'ZEPH', 'ALPH'];

const UNMINEABLE_SUB = { BTC: 'btc', FLUX: 'autolykos', KAS: 'kaspa', ERG: 'ergo', ZEPH: 'zephyr', ALPH: 'alph', XMR: 'randomx' };

function normalizePool(coin, pool) {
  let p = String(pool || '').trim();
  if (!p) return p;
  const hadScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p);
  let host = p.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '').replace(/^[/:]+/, '');
  host = host.replace(/\/+/g, '/');
  if (host.includes('unmineable.com')) {
    const sub = UNMINEABLE_SUB[coin] || String(coin).toLowerCase();
    host = host.replace(/^www\./i, '');
    const portM = host.match(/:(\d+)$/);
    const port = portM ? portM[1] : '3333';
    const subM = host.match(/^([a-z0-9-]+)\.unmineable\.com(?::\d+)?$/i);
    const existing = subM ? subM[1].toLowerCase() : null;
    if (existing === sub) {
      host = host.replace(/\.unmineable\.com(:\d+)?$/i, '.unmineable.com:' + port);
    } else {
      host = sub + '.unmineable.com:' + port;
    }
    return 'stratum+tcp://' + host;
  }
  if (hadScheme) {
    return 'stratum+tcp://' + host.replace(/^\/+/, '');
  }
  return host;
}

function flavorOf(p) {
  const n = path.basename(p || '').toLowerCase();
  if (n.includes('lolminer')) return 'lol';
  if (n.includes('xmrig')) return 'xmrig';
  if (n.includes('srb')) return 'srb';
  return 'generic';
}

function cleanWallet(coin, raw) {
  return String(raw || '').trim().replace(/[\u200b-\u200d\ufeff]/g, '');
}

function coinPrefix(coin, pool) {
  if (coin === 'BTC' && pool !== 'lokal') return 'BTC:';
  if (coin === 'FLUX' && /unmineable/i.test(pool || '')) return 'FLUX:';
  if (coin === 'ALPH' && /viabtc/i.test(pool || '')) return '';
  return '';
}

function buildUser(coin, w, worker, pool) {
  let u = cleanWallet(coin, w);
  const pre = coinPrefix(coin, pool);
  if (pre && u.indexOf(':') < 0) u = pre + u;
  if (!u) u = 'benchmark';
  return u.includes('.') ? u : u + '.' + worker;
}

function buildArgs(profile) {
  const w = cleanWallet(profile.coin, profile.wallet);
  const worker = (profile.worker || 'rig1').trim().replace(/[^\w\-.]/g, '') || 'rig1';
  const extra = ((profile.extra || '').trim().split(/\s+/)).filter(Boolean);
  const dev = profile.gpuIndex ? ['--devices', String(profile.gpuIndex)] : [];
  const pool = normalizePool(profile.coin, profile.pool);
  const user = buildUser(profile.coin, w, worker, pool);
  let args = [];
  switch (flavorOf(profile.path)) {
    case 'lol':
      args = ['--algo', LOL_ALGO[profile.coin] || 'AUTOLYKOS2',
        '--pool', pool, '--user', user, '--pass', 'x', ...dev, ...extra];
      break;
    case 'srb':
      args = ['--algorithm', SRB_ALGO[profile.coin] || profile.coin,
        '--pool', pool, '--wallet', user, '--password', 'x', ...dev, ...extra];
      break;
    case 'xmrig':
      args = ['-o', pool, '-u', w, '-p', worker, ...extra];
      break;
    default:
      if (profile.coin === 'CUSTOM') {
        args = ['--pool', pool, '--wallet', user, '--pass', 'x', ...extra];
      } else {
        switch (profile.coin) {
          case 'FLUX': args = ['--coin', 'AUTOLYKOS2', '--pool', pool, '--user', user, ...dev, ...extra]; break;
          case 'XMR':  args = ['-o', pool, '-u', w || '', '-p', worker, ...extra]; break;
          case 'BTC':  args = ['-a', 'sha256d', '-o', pool, '-u', user, '-p', 'c=BTC', ...extra]; break;
          default:     args = extra; break;
        }
      }
  }
  return args;
}

let children = [];
let emit = () => {};
let onStopped = () => {};
let stopping = false;

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
    const i = children.indexOf(proc);
    if (i >= 0) children.splice(i, 1);
    emitAll({ time: Date.now(), type: 'sys', line: `${label} beendet (Code ${code}).` });
    if (children.length === 0) onStopped({ code, intentional: stopping, label });
  });
  children.push(proc);
}

function launch(profile, label) {
  stopping = false;
  const isBuiltin = profile.builtin;
  if (isBuiltin) {
    const runPath = path.join(__dirname, '..', 'miner', 'run.js');
    const threads = Math.max(1, Math.min(os.cpus().length, 16));
    const pool = normalizePool(profile.coin, profile.pool || 'lokal');
    const wallet = buildUser(profile.coin, cleanWallet(profile.coin, profile.wallet), profile.worker || 'rig1', pool);
    const args = [
      runPath,
      '--threads', String(threads),
      '--coin', profile.coin || 'CUSTOM',
      '--pool', pool,
      '--wallet', wallet,
      '--worker', profile.worker || 'rig1',
    ];
    const proc = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
    });
    wire(proc, label || 'Built-in Miner');
    emitAll({ time: Date.now(), type: 'sys', line: `Echtes SHA-256-Stratum-Mining gestartet (${threads} Threads).` });
    emitAll({ time: Date.now(), type: 'sys', line: `Pool: ${pool || 'kein Pool gesetzt'}` });
  } else {
    const p = (profile.path || '').trim();
    if (!p || !fs.existsSync(p)) {
      emitAll({ time: Date.now(), type: 'err', line: 'Miner-Datei nicht gefunden: ' + p });
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
  const p = (profile.path || '').trim();
  if (!p || !fs.existsSync(p)) return { ok: false, error: 'err.noFile' };
  launch(profile, 'GPU Miner');
  return { ok: true };
}

/* ---------------- Built-in Miner (eigenes Engine-Script) ---------------- */
function startBuiltin(profile) {
  launch(Object.assign({}, profile, { builtin: true }), 'CPU Miner');
  return { ok: true };
}

function hasMiner() {
  return children.length > 0;
}

function stop() {
  stopping = true;
  children.forEach((c) => { try { c.kill(); } catch (_) {} });
  children = [];
}

module.exports = { startExternal, startBuiltin, stop, hasMiner, setEmitter, setStoppedListener, GPU_COINS, buildArgs, normalizePool };
