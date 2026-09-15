const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const gpu = require('./lib/gpu');
const miner = require('./lib/miner');
const discord = require('./lib/discord');
const { relaunchAsAdmin } = require('./lib/elevate');
const https = require('https');
const net = require('net');
const tls = require('tls');
const os = require('os');
const { spawn } = require('child_process');

const CURRENT_VERSION = require('./package.json').version;
const UPDATE_URL = 'https://raw.githubusercontent.com/freeserver788-design/Blockminer/refs/heads/Update/Update.json';

app.setName('blockmine');
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

let win = null;
let pollTimer = null;

/* ---------------- Watchdog / Failover / Thermal Guard ---------------- */
const DEF_CFG = {
  wd: { enabled: true, maxRestarts: 5, hangSec: 45, rejectPct: 40 },
  guard: { enabled: true, maxTemp: 85, restoreTemp: 75, factor: 0.7 },
};
let lastProfile = null;
let wdRestarts = 0;
let wdLastFail = 0;
let wdQuickFails = 0;
let guardState = new Map();
let _lastAccTot = 0;
let _lastRejTot = 0;
let _lastShareTs = 0;

function sendWebhook(msg) {
  const url = (loadConfig() || {}).webhookUrl || '';
  if (!/^https:\/\/(discord|canary\.discord)\.com\/api\/webhooks\//i.test(url)) return;
  try {
    const body = JSON.stringify({ content: '**Blockmine [' + os.hostname() + ']**: ' + msg.slice(0, 1800) });
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Blockmine' } }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_) {}
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, icon: path.join(__dirname, 'icon.ico') }).show();
    }
  } catch (_) {}
  safeSend('main:toast', { msg: body, title });
}

function cfgGet() {
  const c = loadConfig() || {};
  return {
    wd: Object.assign({}, DEF_CFG.wd, c.wd || {}),
    guard: Object.assign({}, DEF_CFG.guard, c.guard || {}),
  };
}

function logLine(line, type) {
  safeSend('miner:log', { time: Date.now(), type: type || 'sys', line });
}

function safeSend(channel, payload) {
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isDestroyed()) return;
  try { win.webContents.send(channel, payload); } catch (_) {}
}

/* ---------------- config ---------------- */
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return {}; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

app.setName('Blockmine');
try { app.setAppUserModelId('com.blockmine.app'); } catch (_) {}

/* ---------------- window ---------------- */
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'Blockmine',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });

  miner.setEmitter((d) => {
    safeSend('miner:log', d);
    const line = String(d.line || '');
    let m = line.match(/accepted\s*\((\d+)/i);
    if (m) { _lastAccTot = parseInt(m[1], 10) || 0; _lastShareTs = Date.now() / 1000; }
    m = line.match(/rejected\s*\((\d+)/i);
    if (m) { _lastRejTot = parseInt(m[1], 10) || 0; _lastShareTs = Date.now() / 1000; }
  });
  miner.setStoppedListener((info) => {
    if (_donPhase !== 'donate') safeSend('miner:stopped');
    if (_donPhase !== 'donate') discord.status({ mining: false, coin: null });
    handleMinerStopped(info);
  });
  discord.setLogHook((d) => safeSend('miner:log', d));
  discord.init(discord.CLIENT_ID, win);

  pollTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    const stats = await gpu.gpuStats();
    let infos = [];
    if (stats) {
      for (const g of stats) {
        const info = await gpu.powerInfo(g.index);
        infos.push(info);
      }
    }
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('gpu:data', { stats, infos });
    }
    if (stats) thermalGuard(stats, infos);
    watchdogTick();
  }, 1600);

  if (process.env.BM_SMOKE) {
    win.webContents.on('did-finish-load', () => {
      console.log('[bm:smoke] renderer loaded');
      setTimeout(() => app.quit(), 4000);
    });
  }
});

app.on('window-all-closed', () => {
  miner.stop();
  if (pollTimer) clearInterval(pollTimer);
  app.quit();
});

/* ---------------- IPC ---------------- */
ipcMain.handle('gpu:stats', async () => {
  const stats = await gpu.gpuStats();
  const infos = [];
  if (stats) {
    for (const g of stats) infos.push(await gpu.powerInfo(g.index));
  }
  return { stats, infos };
});

ipcMain.handle('sys:admin', async () => {
  const ok = await gpu.isAdmin();
  return { admin: ok, win32: process.platform === 'win32' };
});

ipcMain.handle('sys:elevate', async () => {
  relaunchAsAdmin();
  return { ok: true };
});

ipcMain.handle('power:set', async (_e, watts, index) => {
  const gi = Number.isInteger(index) ? index : 0;
  const info = await gpu.powerInfo(gi);
  const clamped = Math.min(info.max, Math.max(info.min, Math.round(watts)));
  return gpu.setPowerLimit(clamped, gi);
});

ipcMain.handle('power:setAll', async (_e, watts) => {
  const stats = await gpu.gpuStats();
  if (!stats || !stats.length) return { ok: false, error: 'no gpus' };
  const results = [];
  for (let i = 0; i < stats.length; i++) {
    const info = await gpu.powerInfo(i);
    const clamped = Math.min(info.max, Math.max(info.min, Math.round(watts)));
    results.push(await gpu.setPowerLimit(clamped, i));
  }
  const anyOk = results.some((r) => r.ok);
  const anyAdmin = results.some((r) => r.admin);
  if (anyAdmin) return { ok: false, admin: true };
  return { ok: anyOk };
});

ipcMain.handle('power:reset', async (_e, index) => {
  const gi = Number.isInteger(index) ? index : 0;
  const info = await gpu.powerInfo(gi);
  return gpu.setPowerLimit(info.def, gi);
});

ipcMain.handle('miner:pick', async () => {
  const isEn = loadConfig().lang === 'en';
  const r = await dialog.showOpenDialog(win, {
    title: isEn ? 'Select miner (.exe)' : 'Miner auswählen (.exe)',
    filters: [{ name: 'Executables', extensions: ['exe'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false };
  return { ok: true, path: r.filePaths[0] };
});

ipcMain.handle('miner:start', async (_e, profile) => {
  miner.stop();
  donateStop();
  lastProfile = profile || null;
  wdRestarts = 0;
  wdQuickFails = 0;
  _lastAccTot = 0; _lastRejTot = 0;
  const p = profile || {};
  let res = { ok: true };
  if (p.builtin) {
    res = miner.startBuiltin(p);
  } else {
    res = miner.startExternal(p);
  }
  if (res && res.ok && !p.builtin) {
    try {
      const stats = await gpu.gpuStats();
      if (stats && stats[0] && win && !win.isDestroyed()) {
        const lim = stats[0].powerLimit || 0;
        const isEn = loadConfig().lang === 'en';
        safeSend('miner:log', { time: Date.now(), type: 'sys', line: isEn
          ? 'GPU LOAD: Card mines at full load at ' + lim + ' W &mdash; nothing overclocked, your watt setting stays unchanged.'
          : 'GPU-LAST: Karte minet mit maximaler Auslastung bei ' + lim + ' W &mdash; nichts &uuml;bertaktet, deine Watt-Einstellung bleibt unver&auml;ndert.' });
      }
    } catch (_) {}
  }
  if (res && res.ok) donateStart(p);
  return res;
});
ipcMain.handle('miner:stop', () => { miner.stop(); donateStop(); return { ok: true }; });
ipcMain.handle('miner:download', async () => downloadXmrig());
ipcMain.handle('miner:downloadLol', async () => downloadLolMiner());

/* ---------------- Pool connectivity ---------------- */
ipcMain.handle('pool:test', async (_e, rawPool) => {
  const raw = String(rawPool || '').trim();
  if (!raw) return { ok: false, error: 'Kein Pool angegeben.' };
  try {
    let value = raw.replace(/^stratum\+/, '').replace(/^tcp:\/\//i, '').replace(/^ssl:\/\//i, '');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'tcp://' + value;
    const u = new URL(value);
    const port = Number(u.port || 3333);
    if (!u.hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ungültiger Host oder Port.');
    const started = Date.now();
    const secure = /^stratum\+ssl|^ssl/i.test(raw);
    const socket = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: false })
      : net.createConnection({ host: u.hostname, port });
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(6500);
      socket.once('connect', () => finish({ ok: true, host: u.hostname, port, ms: Date.now() - started }));
      socket.once('secureConnect', () => finish({ ok: true, host: u.hostname, port, ms: Date.now() - started, secure: true }));
      socket.once('timeout', () => finish({ ok: false, error: 'Zeitüberschreitung beim Pool-Test.' }));
      socket.once('error', (err) => finish({ ok: false, error: err && err.message ? err.message : 'Verbindung fehlgeschlagen.' }));
    });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Ungültige Pool-Adresse.' };
  }
});

/* ---------------- Donation (Dev-Fee 5%) ---------------- */
const DONATE_WALLETS = {
  FLUX: 't1YPNZZRbzziM7dj1gz3oHuyP5VNHiZUaan',
  XMR: '48yscdXa2oGaqY4nAzBRnF8fTK59FgCqhBEPpwCqXUdK4AfBo8SvkZ6PUcbqER38neYYno3cxBakbDY88zeBVD5bGG2FBWW',
};
const DONATE_CYCLE_MS = 20 * 60 * 1000;
const DONATE_PCT = 5;
let _donTimer = null;
let _donPhase = null;
let _donOrigProfile = null;

function donateStart(profile) {
  donateStop();
  const c = loadConfig() || {};
  const d = c.donate || {};
  if (d.enabled === false) return;
  const coin = profile.coin;
  if (!DONATE_WALLETS[coin]) return;
  _donOrigProfile = Object.assign({}, profile);
  _donPhase = 'user';
  const userMs = Math.round(DONATE_CYCLE_MS * (1 - DONATE_PCT / 100));
  _donTimer = setTimeout(() => donateFlip(), userMs);
}

function donateFlip() {
  if (!_donOrigProfile) return;
  const coin = _donOrigProfile.coin;
  const donateWallet = DONATE_WALLETS[coin];
  if (!donateWallet) return;
  if (_donPhase === 'user') {
    _donPhase = 'donate';
    const donateMs = Math.round(DONATE_CYCLE_MS * (DONATE_PCT / 100));
    const donateProfile = Object.assign({}, _donOrigProfile, { wallet: donateWallet, _donating: true });
    miner.stop();
    wdRestarts = 0; wdQuickFails = 0;
    setTimeout(() => {
      if (!lastProfile) return;
      const res = _donOrigProfile.builtin
        ? miner.startBuiltin(donateProfile)
        : miner.startExternal(donateProfile);
      if (res && res.ok) logLine('Donate-Phase (' + DONATE_PCT + '% an Admin)...', 'sys');
      _donTimer = setTimeout(() => donateFlip(), donateMs);
    }, 1200);
  } else {
    _donPhase = 'user';
    const userMs = Math.round(DONATE_CYCLE_MS * (1 - DONATE_PCT / 100));
    miner.stop();
    wdRestarts = 0; wdQuickFails = 0;
    setTimeout(() => {
      if (!lastProfile) return;
      const res = startProfileAgain();
      if (res && res.ok) logLine('Donate-Phase beendet, normal weiter.', 'sys');
      _donTimer = setTimeout(() => donateFlip(), userMs);
    }, 1200);
  }
}

function donateStop() {
  if (_donTimer) { clearTimeout(_donTimer); _donTimer = null; }
  _donPhase = null;
  _donOrigProfile = null;
}

ipcMain.handle('donate:status', () => {
  const c = loadConfig() || {};
  const d = c.donate || {};
  return { enabled: d.enabled !== false, phase: _donPhase };
});

/* ---------------- Watchdog / Failover / Thermal Guard ---------------- */
function startProfileAgain() {
  if (!lastProfile) return null;
  if (miner.hasMiner()) return { ok: false, error: 'err.running' };
  const lp = lastProfile;
  const res = lp.builtin ? miner.startBuiltin(lp) : miner.startExternal(lp);
  if (res && res.ok) {
    safeSend('miner:started', { coin: lp.coin, pool: lp.pool });
    discord.status({ mining: true, coin: lp.coin });
  }
  return res;
}

function restartMiner(reason) {
  if (!lastProfile) return;
  const { wd } = cfgGet();
  if (!wd.enabled) return;
  if (wdRestarts >= wd.maxRestarts) {
    const isEn = loadConfig().lang === 'en';
    const msg = isEn ? 'Watchdog: too many restarts (' + wdRestarts + '). Stopped.' : 'Watchdog: zu viele Neustarts (' + wdRestarts + '). Gestoppt.';
    logLine(msg, 'err');
    notify('Blockmine Watchdog', msg);
    sendWebhook(msg);
    miner.stop();
    return;
  }
  const elapsed = Date.now() - wdLastFail;
  if (elapsed < 4500) wdQuickFails++; else wdQuickFails = 0;
  if (wdQuickFails >= 3) {
    const isEn = loadConfig().lang === 'en';
    const msg = isEn ? 'Watchdog: crash loop detected, giving up.' : 'Watchdog: Crash-Schleife erkannt, abgebrochen.';
    logLine(msg, 'err');
    notify('Blockmine Watchdog', msg);
    sendWebhook(msg);
    miner.stop();
    return;
  }
  wdLastFail = Date.now();
  wdRestarts++;
  setTimeout(() => {
    if (!lastProfile) return;
    const res = startProfileAgain();
    if (res && res.ok) {
      const isEn = loadConfig().lang === 'en';
      logLine(isEn ? 'Watchdog: miner restarted (' + reason + ').' : 'Watchdog: Miner neu gestartet (' + reason + ').', 'sys');
    }
  }, 1800);
}

function handleMinerStopped(info) {
  if (!lastProfile) return;
  if (info && info.intentional) return;
  if (_donPhase === 'donate') return;
  const { wd } = cfgGet();
  if (!wd.enabled) return;
  const isEn = loadConfig().lang === 'en';
  const code = info && typeof info.code === 'number' ? info.code : '?';
  const msg = isEn ? 'Miner stopped unexpectedly (code ' + code + ') &mdash; restarting&hellip;' : 'Miner wurde unerwartet beendet (Code ' + code + ') &mdash; Neustart&hellip;';
  logLine(msg, 'err');
  notify('Blockmine Watchdog', msg.replace(/&mdash;/g, '-'));
  sendWebhook('Miner crash detected, restarting...');
  restartMiner('crash');
}

function watchdogTick() {
  if (!lastProfile || !miner.hasMiner()) { _lastAccTot = 0; _lastRejTot = 0; _lastShareTs = 0; return; }
  const { wd } = cfgGet();

  /* kein neuer Share seit wd.hangSec -> Pool wechseln oder neu starten */
  if (_lastShareTs && (Date.now() / 1000) - _lastShareTs > wd.hangSec) {
    _lastShareTs = Date.now() / 1000;
    const isEn = loadConfig().lang === 'en';
    logLine(isEn ? 'No shares for ' + wd.hangSec + 's &mdash; switching.' : 'Keine Shares seit ' + wd.hangSec + 's &mdash; Wechsel.', 'warn');
    switchPool();
  }
}

function switchPool() {
  if (!lastProfile || !(lastProfile.pools || []).length) {
    restartMiner('pool switch');
    return;
  }
  const cur = lastProfile.pool;
  const pools = lastProfile.pools.slice();
  const i = pools.indexOf(cur);
  const next = pools[(i + 1) % pools.length];
  if (!next) return;
  lastProfile.pool = next;
  const isEn = loadConfig().lang === 'en';
  const msg = isEn ? 'Failover &rarr; now using ' + next : 'Failover &rarr; neuer Pool: ' + next;
  logLine(msg, 'sys');
  notify('Blockmine Failover', msg.replace(/&rarr;/g, '>'));
  miner.stop();
  setTimeout(() => {
    if (!lastProfile) return;
    const res = startProfileAgain();
    if (res && res.ok) logLine(isEn ? 'Restarted with ' + next : 'Neu gestartet mit ' + next, 'sys');
  }, 1600);
}

function thermalGuard(stats, infos) {
  const { guard } = cfgGet();
  if (!guard.enabled) return;
  stats.forEach((g, i) => {
    const info = infos[i] || {};
    const def = info.def || 200;
    const st = guardState.get(i) || { target: 0, active: false, saved: 0, cooldown: 0 };
    const now = Date.now();
    if (g.temp >= guard.maxTemp && !st.active && now > st.cooldown && st.target === 0) {
      const target = Math.max(info.min || 50, Math.round(def * guard.factor));
      st.target = target;
      st.active = true;
      st.saved = g.powerLimit || def;
      gpu.setPowerLimit(target, g.index).then((r) => {
        if (r && r.ok) {
          const isEn = loadConfig().lang === 'en';
          const msg = isEn ? 'Thermal Guard: ' + g.temp + '°C &mdash; limit lowered to ' + target + ' W.' : 'Thermal Guard: ' + g.temp + '°C &mdash; Limit gesenkt auf ' + target + ' W.';
          logLine(msg, 'warn');
          notify('Blockmine Thermal Guard', msg.replace(/&mdash;/g, '-').replace(/°C/g, 'C'));
        }
      });
    } else if (st.active && g.temp <= guard.restoreTemp && st.target > 0) {
      const back = st.saved || def;
      gpu.setPowerLimit(back, g.index).then((r) => {
        if (r && r.ok) {
          st.target = 0;
          st.active = false;
          st.saved = 0;
          st.cooldown = now + 30000;
          const isEn = loadConfig().lang === 'en';
          const msg = isEn ? 'Thermal Guard: ' + g.temp + '°C &mdash; limit restored to ' + back + ' W.' : 'Thermal Guard: ' + g.temp + '°C &mdash; Limit wiederhergestellt auf ' + back + ' W.';
          logLine(msg, 'sys');
        }
      });
    }
    guardState.set(i, st);
  });
}

ipcMain.handle('wd:reset', () => {
  wdRestarts = 0; wdQuickFails = 0; wdLastFail = 0; _lastAccTot = 0; _lastRejTot = 0; _lastShareTs = 0;
  return { ok: true };
});

ipcMain.handle('guard:state', () => {
  const arr = [];
  guardState.forEach((v, i) => arr.push({ index: i, active: v.active, target: v.target }));
  return { ok: true, state: arr };
});

ipcMain.handle('dc:init', () => { discord.init(discord.CLIENT_ID, win); return { ok: true }; });
ipcMain.handle('dc:status', (_e, s) => { discord.status(s); return { ok: true }; });
ipcMain.handle('dc:stop', () => { discord.stop(); return { ok: true }; });
ipcMain.handle('open:external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) { shell.openExternal(url); return { ok: true }; }
  return { ok: false };
});

ipcMain.handle('config:load', () => loadConfig());
ipcMain.handle('config:save', (_e, cfg) => { saveConfig(cfg || {}); return { ok: true }; });

/* ---------------- Auto-Updater ---------------- */
function parseVersion(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return [0, 0, 0];
  const parts = s.split('.').map((n) => parseInt(n, 10));
  while (parts.length < 3) parts.push(0);
  return parts.map((n) => (isNaN(n) ? 0 : n));
}

function versionGt(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (A[i] > B[i]) return true;
    if (A[i] < B[i]) return false;
  }
  return false;
}

ipcMain.handle('update:check', async () => {
  try {
    const body = await httpsGet(UPDATE_URL);
    const j = JSON.parse(body.toString('utf8'));
    const latest = String(j.latest_version == null ? '' : j.latest_version);
    const downloadUrl = String(j.download_url || '');
    return {
      ok: true,
      current: CURRENT_VERSION,
      latest,
      update: !!downloadUrl && versionGt(latest, CURRENT_VERSION),
      changelog: String(j.changelog || ''),
      downloadUrl,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('update:download', async (_e, url) => {
  try {
    const target = path.join(app.getPath('temp'), 'Blockmine-Setup-Latest.exe');
    fs.writeFileSync(target, await httpsGet(url || ''));
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('update:install', async (_e, installerPath) => {
  try {
    spawn(installerPath, [], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.exit(0), 1200);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('update:open', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) { shell.openExternal(url); return { ok: true }; }
  return { ok: false };
});

/* ---------------- Coin-Kurse (CoinGecko) ---------------- */
const PRICE_COINS = [
  ['FLUX', 'flux'], ['XMR', 'monero'], ['KAS', 'kaspa'],
  ['ERG', 'ergo'], ['ZEPH', 'zephyr'], ['ALPH', 'alephium'], ['BTC', 'bitcoin'],
];

ipcMain.handle('prices:fetch', async () => {
  const ids = PRICE_COINS.map((c) => c[1]).join(',');
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=eur';
  try {
    const body = await httpsGet(url);
    const j = JSON.parse(body.toString('utf8'));
    const prices = {};
    for (const [ticker, id] of PRICE_COINS) {
      prices[ticker] = j[id] && typeof j[id].eur === 'number' ? j[id].eur : null;
    }
    return { ok: true, prices, ts: Date.now() };
  } catch (e) {
    return { ok: false, prices: null, error: e.message, ts: Date.now() };
  }
});

/* ---------------- optional: XMRig-Download (extern) ---------------- */
const XMRIG_VERSIONS = ['v6.22.2', 'v6.21.0', 'v6.20.0'];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'blockmine' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('Timeout')));
  });
}

async function downloadXmrig() {
  const MINER_DIR = path.join(app.getPath('userData'), 'miners');
  fs.mkdirSync(MINER_DIR, { recursive: true });
  const zipPath = path.join(MINER_DIR, 'xmrig.zip');
  let lastErr = null;
  for (const v of XMRIG_VERSIONS) {
    try {
      const url = `https://github.com/xmrig/xmrig/releases/download/${v}/xmrig-${v.slice(1)}-msvc-win64.zip`;
      fs.writeFileSync(zipPath, await httpsGet(url));
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${MINER_DIR}\\xmrig' -Force`,
      ]);
      await new Promise((r) => ps.on('exit', r));
      const exe = fs.readdirSync(path.join(MINER_DIR, 'xmrig'), { withFileTypes: true })
        .flatMap((d) => d.isDirectory()
          ? fs.readdirSync(path.join(MINER_DIR, 'xmrig', d.name)).map((f) => path.join(MINER_DIR, 'xmrig', d.name, f))
          : [path.join(MINER_DIR, 'xmrig', d.name)])
        .find((f) => /xmrig\.exe$/i.test(f));
      if (exe) return { ok: true, path: exe };
      return { ok: false, error: 'err.unzip' };
    } catch (e) { lastErr = e; }
  }
  return { ok: false, error: 'err.download' };
}

/*
 * lolMiner (GPU: FLUX/KAS/ERG/ZEPH/ALPH). Lädt das aktuellste
 * Release über die GitHub-Releases-API (keine feste Version).
 */
async function downloadLolMiner() {
  const MINER_DIR = path.join(app.getPath('userData'), 'miners');
  fs.mkdirSync(MINER_DIR, { recursive: true });
  const isWin = process.platform === 'win32';
  try {
    const rel = JSON.parse((await httpsGet('https://api.github.com/repos/Lolliedieb/lolMiner-releases/releases/latest')).toString('utf8'));
    const pattern = isWin ? /win64.*\.zip$/i : /lin64.*\.tar\.gz$/i;
    const asset = (rel.assets || []).find((a) => pattern.test(a.name)) || (rel.assets || [])[0];
    if (!asset) return { ok: false, error: 'err.noBuild' };
    
    const ext = isWin ? '.zip' : '.tar.gz';
    const filePath = path.join(MINER_DIR, 'lolMiner' + ext);
    fs.writeFileSync(filePath, await httpsGet(asset.browser_download_url));
    const outDir = path.join(MINER_DIR, 'lolMiner');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    if (isWin) {
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${filePath}' -DestinationPath '${outDir}' -Force`]);
      await new Promise((r) => ps.on('exit', r));
    } else {
      const tar = spawn('tar', ['-xzf', filePath, '-C', outDir, '--strip-components=1']);
      await new Promise((r) => tar.on('exit', r));
    }

    const exeName = isWin ? 'lolMiner.exe' : 'lolMiner';
    const found = (function walk(dir) {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name);
        if (f.isDirectory()) { const r = walk(fp); if (r) return r; }
        else if (new RegExp('^' + exeName + '$', 'i').test(f.name)) return fp;
      }
      return null;
    })(outDir);
    
    if (!found) return { ok: false, error: 'err.unzip' };
    if (!isWin) fs.chmodSync(found, 0o755);
    return { ok: true, path: found };
  } catch (e) {
    return { ok: false, error: 'err.download' };
  }
}
