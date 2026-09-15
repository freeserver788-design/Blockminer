const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const gpu = require('./lib/gpu');
const miner = require('./lib/miner');
const discord = require('./lib/discord');
const { relaunchAsAdmin } = require('./lib/elevate');
const https = require('https');
const { spawn } = require('child_process');

const CURRENT_VERSION = require('./package.json').version;
const UPDATE_URL = 'https://raw.githubusercontent.com/blockem31-cloud/Blockmine/refs/heads/Update/Update.json';

app.setName('blockmine');
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

let win = null;
let pollTimer = null;

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

  miner.setEmitter((d) => safeSend('miner:log', d));
  miner.setStoppedListener(() => {
    safeSend('miner:stopped');
    discord.status({ mining: false, coin: null });
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
  const res = profile && profile.builtin ? miner.startBuiltin(profile) : miner.startExternal(profile || {});
  if (res && res.ok && !(profile && profile.builtin)) {
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
  return res;
});
ipcMain.handle('miner:stop', () => { miner.stop(); return { ok: true }; });
ipcMain.handle('miner:download', async () => downloadXmrig());
ipcMain.handle('miner:downloadLol', async () => downloadLolMiner());

ipcMain.handle('dc:init', (_e, { clientId }) => { discord.init(clientId, win); return { ok: true }; });
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
  try {
    const rel = JSON.parse((await httpsGet('https://api.github.com/repos/Lolliedieb/lolMiner-releases/releases/latest')).toString('utf8'));
    const asset = (rel.assets || []).find((a) => /win64.*\.zip$/i.test(a.name)) || (rel.assets || [])[0];
    if (!asset) return { ok: false, error: 'err.noBuild' };
    const zipPath = path.join(MINER_DIR, 'lolMiner.zip');
    fs.writeFileSync(zipPath, await httpsGet(asset.browser_download_url));
    const outDir = path.join(MINER_DIR, 'lolMiner');
    fs.rmSync(outDir, { recursive: true, force: true });
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`,
    ]);
    await new Promise((r) => ps.on('exit', r));
    if (!fs.existsSync(path.join(outDir, 'lolMiner.exe'))) {
      const found = (function walk(dir) {
        for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, f.name);
          if (f.isDirectory()) { const r = walk(fp); if (r) return r; }
          else if (/^lolMiner\.exe$/i.test(f.name)) return fp;
        }
        return null;
      })(outDir);
      if (!found) return { ok: false, error: 'err.unzip' };
      return { ok: true, path: found };
    }
    return { ok: true, path: path.join(outDir, 'lolMiner.exe') };
  } catch (e) {
    return { ok: false, error: 'err.download' };
  }
}