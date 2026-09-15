'use strict';

const net = require('net');
const crypto = require('crypto');

const CLIENT_ID = '1548357421674659840';

const KEYS = {
  FLUX: 'flux', XMR: 'xmr', KAS: 'kaspa', ERG: 'ergo',
  ZEPH: 'zephyr', ALPH: 'alephium', BTC: 'bitcoin', CUSTOM: 'custom',
};

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

let sock = null;
let buf = Buffer.alloc(0);
let enabled = false;
let ready = false;
let connecting = false;
let mainWindow = null;
let logHook = () => {};
let pending = { mining: false, coin: 'FLUX', showHr: true };
let reconnectTimer = null;
let pulseTimer = null;
let sessionStart = Date.now();
let skipAssets = false;
let lastNonce = null;
let lastOkAt = 0;

function setLogHook(fn) { logHook = fn || (() => {}); }
function log(line) { logHook({ time: Date.now(), type: 'sys', line }); }
function sendIpc(channel, payload) {
  if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function pack(op, obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = Buffer.alloc(8 + json.length);
  out.writeUInt32LE(op, 0);
  out.writeUInt32LE(json.length, 4);
  json.copy(out, 8);
  return out;
}

function write(op, obj) {
  if (!sock || sock.destroyed) return;
  try { sock.write(pack(op, obj)); } catch (_) {}
}

function nonce() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function fmtHR(h) {
  if (!h) return null;
  const units = [['T', 1e12], ['G', 1e9], ['M', 1e6], ['k', 1e3]];
  for (const [u, m] of units) if (h >= m) return (h / m).toFixed(2) + ' ' + u + 'H/s';
  return Number(h).toFixed(0) + ' H/s';
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  if (s.length < 2) s = 'Blockmine';
  return s.slice(0, n || 128);
}

function buildActivity(withAssets) {
  const coin = String((pending && pending.coin) || 'FLUX').toUpperCase();
  const mining = !!(pending && pending.mining);
  const details = mining ? ('Mining ' + coin) : 'Idle monitor';
  let state = 'GPU dashboard';
  if (mining && pending.showHr) state = fmtHR(pending.hr) ? ('Hashrate ' + fmtHR(pending.hr)) : 'Waiting for shares';
  else if (mining) state = 'Power-limit mining';

  if (mining && pending.start) {
    const t = Number(pending.start);
    if (t && Math.abs(t - sessionStart) > 2000) sessionStart = t;
  }

  const activity = {
    name: 'Blockmine',
    type: 0,
    details: clip(details, 128),
    state: clip(state, 128),
    timestamps: { start: sessionStart },
    instance: false,
  };

  if (withAssets) {
    activity.assets = {
      large_image: KEYS[coin] || 'custom',
      large_text: clip(coin, 32),
    };
  }
  return activity;
}

function setActivity(withAssets, note) {
  if (!ready || !sock) return;
  lastNonce = nonce();
  write(OP.FRAME, {
    cmd: 'SET_ACTIVITY',
    nonce: lastNonce,
    args: {
      pid: process.pid,
      activity: buildActivity(withAssets),
    },
  });
  if (note) log('DISCORD: ' + note);
}

function startPulse() {
  if (pulseTimer) clearInterval(pulseTimer);
  pulseTimer = setInterval(() => {
    if (ready) setActivity(!skipAssets, null);
  }, 30000);
}

function scheduleReconnect() {
  if (reconnectTimer || !enabled) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (enabled && !ready && !connecting) connect();
  }, 6000);
}

function onFrame(msg) {
  if (!msg) return;

  if (msg.evt === 'READY') {
    ready = true;
    connecting = false;
    lastOkAt = Date.now();
    const u = msg.data && msg.data.user;
    const tag = u ? (u.username || u.id) : 'ok';
    log('DISCORD: verbunden als ' + tag + ' — setze Aktivitaet.');
    sendIpc('dc:ready', { tag });
    skipAssets = false;
    setActivity(true, 'Status: ' + buildActivity(true).details);
    setTimeout(() => { if (ready) setActivity(!skipAssets, null); }, 1200);
    startPulse();
    return;
  }

  if (msg.evt === 'ERROR') {
    const err = (msg.data && (msg.data.message || msg.data.code)) || 'RPC error';
    if (!skipAssets && /image|asset|activity/i.test(String(err))) {
      skipAssets = true;
      log('DISCORD: Bilder ungueltig, sende ohne Art Assets.');
      setActivity(false, 'Status ohne Bilder');
      return;
    }
    log('DISCORD: ' + err);
    sendIpc('dc:error', { message: String(err), code: (msg.data && msg.data.code) || null });
    return;
  }

  if (msg.cmd === 'SET_ACTIVITY') {
    lastOkAt = Date.now();
    if (msg.data && msg.data.name) {
      log('DISCORD: Profil zeigt "' + msg.data.name + '" / ' + (msg.data.details || ''));
    }
  }
}

function feed(chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 8) {
    const op = buf.readUInt32LE(0);
    const len = buf.readUInt32LE(4);
    if (buf.length < 8 + len) break;
    const raw = buf.subarray(8, 8 + len).toString('utf8');
    buf = buf.subarray(8 + len);
    let msg = null;
    try { msg = JSON.parse(raw); } catch (_) { continue; }
    if (op === OP.PING) write(OP.PONG, msg);
    else if (op === OP.CLOSE) {
      log('DISCORD: Discord hat die Pipe geschlossen.');
      teardown(false);
      scheduleReconnect();
    } else if (op === OP.FRAME) onFrame(msg);
  }
}

function tryPipe(id) {
  return new Promise((resolve) => {
    const paths = [
      '\\\\.\\pipe\\discord-ipc-' + id,
      '\\\\?\\pipe\\discord-ipc-' + id,
    ];
    let i = 0;
    const next = () => {
      if (i >= paths.length) return resolve(null);
      const p = paths[i++];
      const s = net.createConnection(p);
      const fail = () => { try { s.destroy(); } catch (_) {} next(); };
      s.once('connect', () => {
        s.removeListener('error', fail);
        resolve(s);
      });
      s.once('error', fail);
    };
    next();
  });
}

async function connect() {
  if (!enabled || connecting || ready) return;
  sendIpc('dc:connecting');
  connecting = true;
  buf = Buffer.alloc(0);

  let s = null;
  for (let id = 0; id < 10; id++) {
    s = await tryPipe(id);
    if (s) break;
  }
  if (!s) {
    connecting = false;
    log('DISCORD: Discord Desktop nicht gefunden (IPC). Client muss laufen, nicht nur im Browser.');
    sendIpc('dc:error', { message: 'Discord Desktop nicht gefunden' });
    scheduleReconnect();
    return;
  }

  sock = s;
  sock.on('data', feed);
  sock.on('error', () => {
    if (!enabled) return;
    ready = false;
    connecting = false;
    sock = null;
    sendIpc('dc:error', { message: 'RPC Pipe-Fehler' });
    scheduleReconnect();
  });
  sock.on('close', () => {
    const wasReady = ready;
    ready = false;
    connecting = false;
    sock = null;
    if (!enabled) return;
    if (wasReady) {
      log('DISCORD: getrennt.');
      sendIpc('dc:error', { message: 'RPC getrennt' });
    }
    scheduleReconnect();
  });

  write(OP.HANDSHAKE, { v: 1, client_id: String(CLIENT_ID) });

  setTimeout(() => {
    if (connecting && !ready) {
      connecting = false;
      try { sock && sock.destroy(); } catch (_) {}
      sock = null;
      log('DISCORD: Handshake Timeout — Client-ID oder Discord-Version pruefen.');
      sendIpc('dc:error', { message: 'Handshake Timeout' });
      scheduleReconnect();
    }
  }, 8000);
}

function init(_id, win) {
  if (win) mainWindow = win;
  enabled = true;
  if (ready || connecting) {
    if (ready) setActivity(!skipAssets, null);
    return;
  }
  teardown(false);
  connect();
}

function status(s) {
  const mining = !!(s && s.mining);
  const wasMining = !!(pending && pending.mining);
  pending = s || pending;
  if (mining && !wasMining) sessionStart = Number(s.start) || Date.now();
  if (!mining && wasMining) sessionStart = Date.now();
  if (ready) setActivity(!skipAssets, null);
}

function teardown(clearEnabled) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = null; }
  if (clearEnabled) enabled = false;
  ready = false;
  connecting = false;
  const dying = sock;
  sock = null;
  if (dying) {
    try {
      dying.write(pack(OP.FRAME, {
        cmd: 'SET_ACTIVITY',
        nonce: nonce(),
        args: { pid: process.pid, activity: null },
      }));
    } catch (_) {}
    try { dying.destroy(); } catch (_) {}
  }
}

function stop() {
  teardown(true);
}

module.exports = { CLIENT_ID, init, status, stop, setLogHook };
