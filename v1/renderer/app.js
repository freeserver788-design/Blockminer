'use strict';

const $ = (id) => document.getElementById(id);
const api = window.bm;
const t = (...a) => window.BM_I18N.t(...a);

/* ---------------- state ---------------- */
const state = {
  gpu: null,
  all: [],
  gpuIdx: 0,
  powerInfo: null,
  sliderDirty: false,
  plApplied: false,
  coin: 'FLUX',
  mtype: 'builtin',
  running: false,
  startedAt: null,
  hashrate: 0,
  accepted: 0,
  rejected: 0,
  cfg: {},
  bal: {},
  hist: { totals: {}, sessions: [] },
  sess: null,
  prices: null,
  pricesTs: 0,
};

const COIN_PRESETS = {
  FLUX:   { pool: 'stratum+tcp://autolykos.unmineable.com:3333' },
  XMR:    { pool: 'pool.supportxmr.com:3333' },
  KAS:    { pool: 'stratum+tcp://kp.2miners.com:2020' },
  ERG:    { pool: 'stratum+tcp://erg.herominers.com:1111' },
  ZEPH:   { pool: 'stratum+tcp://zeph.herominers.com:7777' },
  ALPH:   { pool: 'stratum+tcp://a.viabtc.com:8800' },
  BTC:    { pool: 'stratum+tcp://btc.2miners.com:4040' },
  CUSTOM: { pool: '' },
};

const DC_CLIENT_ID = '1548357421674659840';

const WALLET_OK = {
  FLUX:   (w) => /^t1[0-9A-Za-z]{30,}$/.test(w),
  XMR:    (w) => /^[48][0-9A-Za-z]{94}$/.test(w),
  KAS:    (w) => /^kaspa:[a-z0-9]{20,}$/i.test(w),
  ERG:    (w) => /^9[1-9A-HJ-NP-Za-km-z]{40,}$/.test(w),
  ZEPH:   (w) => /^(ZEPH|zeph)[0-9A-Za-z]{20,}$/.test(w) || /^[48][0-9A-Za-z]{90,}$/.test(w),
  ALPH:   (w) => /^(alph1|1)[0-9A-Za-z]{20,}$/i.test(w) || /^[1-9A-HJ-NP-Za-km-z]{30,}$/.test(w),
  BTC:    (w) => /^(bc1[a-z0-9]{25,}|[13][a-km-zA-HJ-NP-Z1-9]{24,})$/.test(w),
  CUSTOM: (w) => w.length >= 20,
};

function normalizeWallet(coin, raw) {
  let w = String(raw || '').trim().replace(/[\u200b-\u200d\ufeff]/g, '');
  w = w.replace(/^(FLUX|tFLUX|KAS|ERG|ERGO|XMR|ZEPH|ALPH|BTC):/i, '');
  return w;
}

function updateWalletHint() {
  const $el = $('fWallet');
  $el.placeholder = t('wh.' + state.coin + '.ph');
  const el = $('walletHint');
  if (!el) return;
  const w = normalizeWallet(state.coin, $el.value);
  if (!w) {
    el.className = 'wallet-hint';
    el.innerHTML = t('wh.' + state.coin + '.hint');
    return;
  }
  const ok = WALLET_OK[state.coin] || WALLET_OK.CUSTOM;
  if (ok(w)) {
    el.className = 'wallet-hint';
    el.innerHTML = t('wh.good');
  } else {
    el.className = 'wallet-hint warn';
    el.innerHTML = t('wh.bad', { coin: state.coin, hint: t('wh.' + state.coin + '.hint') });
  }
}

const BALANCE_COINS = ['FLUX', 'XMR', 'KAS', 'ERG', 'ZEPH', 'ALPH', 'BTC'];
const COIN_NAMES = { FLUX: 'FLUX', XMR: 'MONERO', KAS: 'KASPA', ERG: 'ERGO', ZEPH: 'ZEPHYR', ALPH: 'ALEPHIUM', BTC: 'BITCOIN' };
const GPU_COINS = ['FLUX', 'KAS', 'ERG', 'ZEPH', 'ALPH'];

/* ---------------- helpers ---------------- */
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3400);
}

function fmtHR(hs) {
  if (!hs || isNaN(hs)) return { v: '0.00', unit: 'H/s' };
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s'];
  let i = 0;
  while (hs >= 1000 && i < units.length - 1) { hs /= 1000; i++; }
  return { v: hs.toFixed(2), unit: units[i] };
}

/* ---------------- splash / boot ---------------- */
const bootMsgs = ['boot.b1', 'boot.b2', 'boot.b3', 'boot.b4'];
let bi = 0;
const bootTimer = setInterval(() => {
  bi = Math.min(bi + 1, bootMsgs.length - 1);
  $('splash-status').innerHTML = t(bootMsgs[bi]);
}, 400);

setTimeout(() => {
  clearInterval(bootTimer);
  $('splash').classList.add('fade');
  setTimeout(() => {
    $('splash').style.display = 'none';
    $('app').classList.remove('hidden');
    if (!state.cfg.tourDone) { state.cfg.tourDone = true; api.saveCfg(state.cfg); openTour(0); }
  }, 650);
}, 2400);

/* ---------------- navigation ---------------- */
function switchView(view) {
  document.querySelectorAll('.nav-btn').forEach((x) => x.classList.toggle('active', x.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $('view-' + view).classList.remove('hidden');
  if (view === 'geld') {
    renderGeld();
    renderHist();
    if (!state.prices || Date.now() - state.pricesTs > 5 * 60 * 1000) refreshPrices();
  }
}
document.querySelectorAll('.nav-btn').forEach((b) => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});

/* ---------------- GPU data ---------------- */
const CIRC = Math.PI * 2 * 52;

function renderGpuSwitch(d) {
  const sw = $('gpuSwitch');
  if (!sw) return;
  const gpus = d && d.stats ? d.stats : [];
  if (!gpus.length) { sw.innerHTML = ''; return; }
  if (gpus.length < 2) { sw.innerHTML = ''; return; }
  sw.innerHTML = gpus.map((g, i) =>
    '<button class="gpu-tab ' + (i === state.gpuIdx ? 'active' : '') + '" data-gpui="' + i + '">' + t('gpu.tab', { i: g.index }) + '</button>'
  ).join('');
}

function renderGpu(d) {
  if (!d || !d.stats || !d.stats.length) return;
  state.lastGpuData = d;
  state.all = d.stats;
  if (state.gpuIdx >= d.stats.length) state.gpuIdx = 0;
  const g = d.stats[state.gpuIdx];
  state.gpu = g;
  state.infos = d.infos || [];
  state.powerInfo = state.infos[state.gpuIdx] || null;
  renderGpuSwitch(d);

  $('gpuName').textContent = g.name;
  $('gpuMeta').innerHTML = t('dash.gpuMeta', { d: g.driver, s: g.pstate });
  $('pstate').textContent = g.pstate;
  $('sideGpuName').textContent = g.name;
  $('sideGpuCount').textContent = d.stats.length;
  $('sideUtil').textContent = g.util;
  $('sideTemp').textContent = g.temp;
  $('sidePower').textContent = g.power.toFixed(0);

  const frac = Math.min(1, g.temp / 100);
  $('gTemp').style.strokeDashoffset = (CIRC * (1 - frac)).toFixed(1);
  $('gTempVal').textContent = g.temp;

  $('mPower').innerHTML = g.power.toFixed(1) + '<span> W</span>';
  $('powerBar').style.width = Math.min(100, (g.power / (g.powerLimit || 1)) * 100) + '%';
  $('mUtil').innerHTML = g.util + '<span> %</span>';
  $('utilBar').style.width = g.util + '%';
  $('mFan').innerHTML = g.fan + '<span> %</span>';
  $('fanBar').style.width = g.fan + '%';
  $('mMem').innerHTML = (g.memUsed / 1024).toFixed(1) + '<span> / ' + (g.memTotal / 1024).toFixed(0) + ' GB</span>';
  $('memBar').style.width = Math.min(100, (g.memUsed / g.memTotal) * 100) + '%';

  $('clkCore').textContent = g.clkCore;
  $('clkMem').textContent = g.clkMem;

  if (state.running) {
    $('livePower').textContent = g.power.toFixed(1) + ' W';
    $('liveTemp').textContent = g.temp + ' &deg;C';
    $('liveUtil').textContent = g.util + ' %';
  }

  if (state.powerInfo && !state.sliderDirty && !state.plApplied) {
    initSlider(state.powerInfo);
  }
}

$('gpuSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('.gpu-tab');
  if (!b) return;
  state.gpuIdx = parseInt(b.dataset.gpui, 10);
  renderGpu(state.lastGpuData);
  renderRecs();
});

/* ---------------- power slider ---------------- */
function sliderFill() {
  const s = $('plSlider');
  const pct = ((s.value - s.min) / (s.max - s.min)) * 100;
  s.style.background = 'linear-gradient(to right, #fff 0%, #fff ' + pct + '%, rgba(255,255,255,.15) ' + pct + '%, rgba(255,255,255,.15) 100%)';
}

function initSlider(info) {
  const s = $('plSlider');
  s.min = info.min;
  s.max = info.max;
  s.step = 1;
  s.value = state.gpu ? state.gpu.powerLimit : info.def;
  s.disabled = false;
  $('plMin').textContent = info.min + ' W';
  $('plMax').textContent = info.max + ' W';
  $('plValue').textContent = state.gpu ? state.gpu.powerLimit : info.def;
  state.sliderDirty = false;
  sliderFill();
  markPreset(s.value);
}

function markPreset(v) {
  document.querySelectorAll('.preset').forEach((p) => {
    const frac = parseFloat(p.dataset.frac);
    p.classList.toggle('active', Math.abs(v - state.powerInfo.def * frac) < 2);
  });
}

$('plSlider').addEventListener('input', (e) => {
  $('plValue').textContent = e.target.value;
  state.sliderDirty = true;
  sliderFill();
  if (state.powerInfo) markPreset(parseInt(e.target.value, 10));
});

document.querySelectorAll('.preset').forEach((p) => {
  p.addEventListener('click', () => {
    if (!state.powerInfo) return;
    const v = Math.round(state.powerInfo.def * parseFloat(p.dataset.frac));
    const s = $('plSlider');
    s.value = Math.min(state.powerInfo.max, Math.max(state.powerInfo.min, v));
    $('plValue').textContent = s.value;
    state.sliderDirty = true;
    sliderFill();
    markPreset(+s.value);
  });
});

$('btnApply').addEventListener('click', async () => {
  const info = state.powerInfo;
  if (!info) return toast(t('toast.noGpu'), true);
  let v = parseInt($('plSlider').value, 10);
  if (v > info.max) v = info.max;
  if (v < info.min) v = info.min;
  $('btnApply').disabled = true;
  const r = await api.power(v, state.gpuIdx);
  $('btnApply').disabled = false;
  if (r.ok) {
    state.plApplied = true;
    state.sliderDirty = false;
    $('plValue').textContent = r.watts;
    $('adminBanner').classList.add('hidden');
    toast(t('toast.applySet', { w: r.watts }));
  } else if (r.admin) {
    $('adminBanner').classList.remove('hidden');
    toast(t('toast.adminNeeded'), true);
  } else {
    toast(t('toast.error', { e: r.error || 'nvidia-smi' }), true);
  }
});

$('btnReset').addEventListener('click', async () => {
  const r = await api.powerReset(state.gpuIdx);
  if (r.ok) { $('adminBanner').classList.add('hidden'); toast(t('toast.resetOk')); }
  else if (r.admin) { $('adminBanner').classList.remove('hidden'); toast(t('toast.adminMissing'), true); }
  else toast(t('toast.error', { e: r.error || t('rec.unknown') }), true);
});

$('btnElevate').addEventListener('click', async () => {
  $('btnElevate').textContent = 'NEUSTART...';
  await api.elevate();
});

/* ---------------- mining config ---------------- */
function updateMtHint() {
  const gpu = GPU_COINS.indexOf(state.coin) >= 0;
  $('mtHint').innerHTML = state.mtype === 'builtin'
    ? t('mth.builtin') + (gpu ? t('mth.builtinGpu', { coin: state.coin }) : '')
    : t('mth.external', { hint: t('ch.' + state.coin) });
  const showGpu = state.mtype === 'external' ? gpu : false;
  $('btnDlGpu').classList.toggle('hidden', !showGpu);
  $('btnDl').classList.toggle('hidden', !!showGpu);
}

function setMtype(mt) {
  state.mtype = mt;
  document.querySelectorAll('.mtype').forEach((b) => b.classList.toggle('active', b.dataset.mt === mt));
  $('extRow').classList.toggle('hidden', mt === 'builtin');
  $('dlRow').classList.toggle('hidden', mt === 'builtin');
  updateMtHint();
}

document.querySelectorAll('.mtype').forEach((b) => {
  b.addEventListener('click', () => { setMtype(b.dataset.mt); persistCfg(); });
});

function applyCoin(coin, opts) {
  const fromLoad = !!(opts && opts.fromLoad);
  if (!fromLoad) saveActiveCoin();
  state.coin = coin;
  document.querySelectorAll('.coin').forEach((c) => c.classList.toggle('active', c.dataset.coin === coin));
  loadCoinCfg(coin);
  $('fExtra').placeholder = coin === 'XMR' ? t('cfg.extraPhXmr') : t('cfg.extraPh');
  $('fMiner').placeholder = t('cfg.minerPh');
  if (GPU_COINS.indexOf(coin) >= 0 && state.mtype === 'builtin') {
    setMtype('external');
    if (!fromLoad) toast(t('toast.coinToGpu', { coin: coin }));
  }
  updateMtHint();
  updateWalletHint();
  if (!fromLoad) persistCfg();
}

/* ---------------- per-Coin-Profile ---------------- */
function saveActiveCoin() {
  if (!state.coin) return;
  if (!$('fWallet')) return;
  state.cfg.coins = state.cfg.coins || {};
  state.cfg.coins[state.coin] = {
    pool: $('fPool').value.trim(),
    wallet: normalizeWallet(state.coin, $('fWallet').value),
    worker: $('fWorker').value.trim(),
    extra: $('fExtra').value.trim(),
    miner: $('fMiner').value.trim(),
    mtype: state.mtype,
  };
}

function loadCoinCfg(coin) {
  const c = (state.cfg.coins || {})[coin];
  const preset = COIN_PRESETS[coin] && COIN_PRESETS[coin].pool;
  if (c) {
    $('fPool').value = c.pool || preset || '';
    $('fWallet').value = c.wallet || '';
    $('fWorker').value = c.worker || '';
    $('fExtra').value = c.extra || '';
    $('fMiner').value = c.miner || '';
    if (c.mtype) setMtype(c.mtype);
  } else {
    $('fPool').value = preset || '';
    $('fWallet').value = '';
    $('fWorker').value = '';
    $('fExtra').value = '';
    $('fMiner').value = '';
  }
  updateWalletHint();
}

document.querySelectorAll('.coin').forEach((c) => {
  c.addEventListener('click', () => { applyCoin(c.dataset.coin); });
});

$('btnBrowse').addEventListener('click', async () => {
  const r = await api.pickMiner();
  if (r.ok) { $('fMiner').value = r.path; persistCfg(); toast(t('toast.fileSet')); }
});

function errText(e) {
  if (typeof e === 'string' && e.indexOf('err.') === 0 && window.BM_I18N.has(e)) return t(e);
  return e || '';
}

$('btnDl').addEventListener('click', async () => {
  const b = $('btnDl');
  b.disabled = true;
  b.innerHTML = t('toast.dlBusy');
  const r = await api.downloadMiner();
  b.disabled = false;
  if (r.ok) {
    b.innerHTML = t('toast.xmrigOk');
    $('fMiner').value = r.path;
    persistCfg();
    toast(t('toast.xmrigOkLong', { p: r.path }));
  } else {
    b.innerHTML = t('cfg.dlxmr');
    toast(t('toast.dlFail', { e: errText(r.error) }), true);
  }
});

$('btnDlGpu').addEventListener('click', async () => {
  const b = $('btnDlGpu');
  b.disabled = true;
  b.innerHTML = t('toast.dlBusyLol');
  const r = await api.downloadGpuMiner();
  b.disabled = false;
  if (r.ok) {
    b.innerHTML = t('toast.lolOk');
    $('fMiner').value = r.path;
    persistCfg();
    toast(t('toast.lolOkLong', { p: r.path }));
  } else {
    b.innerHTML = t('cfg.dllol');
    toast(t('toast.dlFail', { e: errText(r.error) }), true);
  }
});

/* ---------------- hashrate / log ---------------- */
function pushHR(sample) {
  state._hrbuf = state._hrbuf || [];
  state._hrbuf.push(sample);
  if (state._hrbuf.length > 7) state._hrbuf.shift();
  if (state._hrbuf.length < 3) { state.hashrate = sample; return; }
  const s = state._hrbuf.slice().sort((a, b) => a - b);
  state.hashrate = s[Math.floor(s.length / 2)];
}

function parseMetrics(line) {
  const hr = line.match(/([\d.]+)\s*(k|m|g|t)?(?:h|sol)\/s/i);
  if (hr) {
    let mult = 1;
    const u = (hr[2] || '').toLowerCase();
    if (u === 'k') mult = 1e3; else if (u === 'm') mult = 1e6;
    else if (u === 'g') mult = 1e9; else if (u === 't') mult = 1e12;
    pushHR(parseFloat(hr[1]) * mult);
  }
  let m = line.match(/accepted\s*\((\d+)/i);
  if (m) state.accepted = parseInt(m[1], 10);
  m = line.match(/rejected\s*\((\d+)/i);
  if (m) state.rejected = parseInt(m[1], 10);
  m = line.match(/(\d+)\s*acc(?:\s*\((\d+)\))?/i);
  if (m && m[2]) state.accepted = parseInt(m[2], 10);
}

function renderMineStats() {
  const f = fmtHR(state.hashrate);
  $('hashRate').textContent = f.v;
  $('hashUnit').textContent = f.unit;
  const maxH = 2e9;
  $('hashBar').style.width = Math.min(100, (state.hashrate / maxH) * 100) + '%';
  $('accepted').textContent = state.accepted;
  $('rejected').textContent = state.rejected;
  if (state.startedAt) {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    $('liveUptime').textContent = hh + ':' + mm + ':' + ss;
  }
}
setInterval(() => {
  renderMineStats();
  tickMineSession();
}, 1000);

function addLog(d) {
  const con = $('console');
  const line = (d.key ? t(d.key, d.vars) : d.line) || '';
  const isMetric = /^(speed|accepted)/i.test(line);
  const lastEl = con.lastElementChild;
  if (lastEl && lastEl.dataset.metric === '1' && isMetric) {
    const prev = lastEl.querySelector('.' + d.type);
    if (prev) {
      prev.textContent = line;
      parseMetrics(line);
      renderMineStats();
      return;
    }
  }
  const div = document.createElement('div');
  const t = new Date(d.time);
  div.dataset.metric = isMetric ? '1' : '0';
  div.innerHTML = '<span class="t">' + t.toLocaleTimeString(uiLocale()) + '</span><span class="' + d.type + '"></span>';
  div.querySelector('.' + d.type).textContent = line;
  con.appendChild(div);
  while (con.children.length > 160) con.removeChild(con.firstChild);
  con.scrollTop = con.scrollHeight;
  parseMetrics(line);
  renderMineStats();
}

$('btnClearConsole').addEventListener('click', () => { $('console').innerHTML = ''; });

/* ---------------- start / stop ---------------- */
$('btnMine').addEventListener('click', async () => {
  if (state.running) return;
  const profile = {
    coin: state.coin,
    pool: $('fPool').value.trim(),
    wallet: normalizeWallet(state.coin, $('fWallet').value),
    worker: $('fWorker').value.trim(),
    extra: $('fExtra').value.trim(),
    path: $('fMiner').value.trim(),
    builtin: state.mtype === 'builtin',
    gpuIndex: state.all && state.all.length ? state.all.map((g) => g.index).join(',') : '0',
  };
  if (!profile.wallet) return toast(t('toast.noWallet'), true);
  const ok = WALLET_OK[profile.coin];
  if (ok && !ok(profile.wallet)) {
    return toast(t('toast.badWallet', { coin: profile.coin }), true);
  }
  if (!profile.pool) return toast(t('toast.noPool'), true);
  if (profile.builtin && GPU_COINS.indexOf(profile.coin) >= 0) {
    return toast(t('toast.coinGpu', { coin: profile.coin }), true);
  }
  if (!profile.builtin && !profile.path) {
    return toast(t('toast.noMiner'), true);
  }
  const r = await api.start(profile);
  if (!r.ok) return toast(r.error || t('toast.startFail'), true);
  state.running = true;
  state.startedAt = Date.now();
  state.hashrate = 0; state.accepted = 0; state.rejected = 0;
  $('btnMine').innerHTML = '&middot; ' + t('stat.mining') + ' AKTIV &middot;';
  $('btnMine').classList.add('running');
  $('btnStopMine').disabled = false;
  $('btnStopMine').classList.add('running');
  $('statePill').classList.add('mining');
  $('stateText').textContent = t('stat.mining');
  $('mineStatePill').classList.add('mining');
  $('mineStateText').textContent = t('mining.online');
  addLog({ time: Date.now(), type: 'sys', line: t('log.sessionStart') });
  if (!profile.builtin) {
    addLog({ time: Date.now(), type: 'sys', line: t('log.gpuActive', { idx: profile.gpuIndex, name: state.gpu ? ' &middot; ' + state.gpu.name : '', coin: COIN_NAMES[profile.coin] }) });
    if (state.gpu && state.powerInfo && profile.coin === 'FLUX' && state.gpu.powerLimit < state.powerInfo.def) {
      addLog({ time: Date.now(), type: 'sys', line: t('log.tipStock') });
    }
  } else {
    addLog({ time: Date.now(), type: 'sys', line: t('log.cpuActive', { pool: profile.pool }) });
  }
  persistCfg();
  updateDcStatus();
  startMineSession();
});

$('btnStopMine').addEventListener('click', async () => {
  await api.stop();
  setStopped(t('log.stop'));
});

function setStopped(msg) {
  finalizeMineSession();
  state.running = false;
  state.startedAt = null;
  $('btnMine').innerHTML = t('cfg.start');
  $('btnMine').classList.remove('running');
  $('btnStopMine').disabled = true;
  $('btnStopMine').classList.remove('running');
  $('statePill').classList.remove('mining');
  $('stateText').textContent = t('dash.standby');
  $('mineStatePill').classList.remove('mining');
  $('mineStateText').textContent = t('mining.offline');
  if (msg) addLog({ time: Date.now(), type: 'sys', line: msg });
  updateDcStatus();
}
api.onStop(() => setStopped());
api.onLog(addLog);

/* ---------------- recommendations ---------------- */
function renderRecs() {
  const g = state.gpu;
  const info = state.powerInfo;
  const chips = [];
  const items = [];

  if (!g) {
    $('recChips').innerHTML = '<span class="rec-chip warn">' + t('rec.gpuNotFound') + '</span>';
    $('recList').innerHTML = '<div class="rec-item warn"><span class="rec-icon">!</span><div class="rec-txt">' + t('rec.noGpu') + '</div></div>';
    return;
  }

  /* chips: TEMP / WATT / VRAM */
  const tempOk = g.temp < 75;
  chips.push('<span class="rec-chip ' + (tempOk ? 'ok' : 'warn') + '"><span class="rc-dot"></span>TEMP <b>' + g.temp + '</b>&deg;C</span>');
  const pct = g.powerLimit ? Math.round(g.power / g.powerLimit * 100) : 0;
  chips.push('<span class="rec-chip ' + (pct < 90 ? 'ok' : 'warn') + '"><span class="rc-dot"></span>WATT <b>' + g.power.toFixed(0) + '</b> W (' + pct + '%)</span>');
  const vramPct = g.memTotal ? Math.round(g.memUsed / g.memTotal * 100) : 0;
  chips.push('<span class="rec-chip ' + (vramPct < 90 ? 'ok' : 'warn') + '"><span class="rc-dot"></span>VRAM <b>' + vramPct + '</b>%</span>');
  chips.push('<span class="rec-chip ' + (state.running ? 'ok' : '') + '"><span class="rc-dot"></span>' + (state.running ? t('rec.miningActive') : t('rec.minerStop')) + '</span>');
  $('recChips').innerHTML = chips.join('');

  /* power recommendation */
  if (info) {
    const def = info.def || 200;
    const cur = g.powerLimit || def;
    const bal = Math.max(info.min, Math.min(info.max, Math.round(def * 0.8)));
    if (state.running) {
      items.push({
        level: 'info',
        icon: 'P',
        txt: t('rec.powerMax', { cur, bal, def }),
        apply: cur < def - 1 ? bal : null,
      });
    } else if (cur > bal + 1) {
      items.push({
        level: 'info',
        icon: 'P',
        txt: t('rec.powerAbove', { cur, bal }),
        apply: bal,
      });
    } else {
      items.push({
        level: 'ok',
        icon: '&check;',
        txt: t('rec.powerOk', { cur }),
      });
    }
  }

  /* temperature */
  if (g.temp >= 85) items.push({ level: 'warn', icon: '!', txt: t('rec.tempHot', { t: g.temp }) });
  else if (g.temp >= 70) items.push({ level: 'info', icon: '!', txt: t('rec.tempNorm', { t: g.temp }) });
  else if (state.running) items.push({ level: 'ok', icon: '&check;', txt: t('rec.tempGood', { t: g.temp }) });

  /* mining related */
  if (!state.running) {
    items.push({ level: 'info', icon: '&rsaquo;', txt: t('rec.minerIdle') });
  } else {
    const f = fmtHR(state.hashrate);
    items.push({ level: 'ok', icon: '&check;', txt: t('rec.minerActive', { v: f.v, unit: f.unit, acc: state.accepted }) });
    if (g.util < 10) {
      items.push({ level: 'info', icon: '&rsaquo;', txt: t('rec.gpuLow', { u: g.util }) });
    }
  }

  if (!state.running && state.coin !== 'CUSTOM' && !$('fWallet').value.trim()) {
    items.push({ level: 'info', icon: '&rsaquo;', txt: t('rec.walletEmpty') });
  }

  $('recList').innerHTML = items.map((it, i) =>
    '<div class="rec-item ' + it.level + '"><span class="rec-icon">' + it.icon + '</span>' +
    '<div class="rec-txt">' + it.txt + '</div>' +
    (it.apply ? '<button class="rec-apply" data-watts="' + it.apply + '">' + t('rec.set') + '</button>' : '') +
    '</div>'
  ).join('');
}

$('recList').addEventListener('click', (e) => {
  const b = e.target.closest('.rec-apply');
  if (!b || !state.powerInfo) return;
  const w = Math.min(state.powerInfo.max, Math.max(state.powerInfo.min, parseInt(b.dataset.watts, 10)));
  const s = $('plSlider');
  s.value = w;
  $('plValue').textContent = w;
  state.sliderDirty = true;
  sliderFill();
  markPreset(w);
  toast(t('toast.sliderSet', { w }));
});
setInterval(renderRecs, 2000);

/* ---------------- geld / portfolio ---------------- */
function fmtEur(v) {
  if (v == null || isNaN(v)) return '--';
  return v.toLocaleString(uiLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderGeld() {
  const list = $('balList');
  if (!list) return;
  list.innerHTML = BALANCE_COINS.map((coin) => {
    const qty = parseFloat((state.bal[coin] || '0').replace(',', '.'));
    const pr = state.prices && state.prices[coin];
    const val = (pr != null && !isNaN(qty) && qty > 0) ? qty * pr : null;
    return '<div class="bal-row">' +
      '<div class="bal-coin"><b>' + coin + '</b><small>' + COIN_NAMES[coin] + '</small></div>' +
      '<input class="bal-qty" data-coin="' + coin + '" type="text" inputmode="decimal" value="' + (state.bal[coin] || '0') + '" spellcheck="false"/>' +
      '<div class="bal-price ' + (pr == null ? 'offline' : '') + '">' + (pr == null ? '&mdash;' : '&euro; ' + fmtEur(pr)) + '</div>' +
      '<div class="bal-value ' + (val == null ? 'offline' : '') + '">' + (val == null ? '&mdash;' : '&euro; ' + fmtEur(val)) + '</div>' +
      '</div>';
  }).join('');
  refreshTotal();
  updatePriceUi();
}

function refreshTotal() {
  let sum = 0, any = false;
  BALANCE_COINS.forEach((coin) => {
    const qty = parseFloat((state.bal[coin] || '0').replace(',', '.'));
    const pr = state.prices && state.prices[coin];
    if (pr != null && !isNaN(qty) && qty > 0) { sum += qty * pr; any = true; }
  });
  $('geldTotal').textContent = fmtEur(sum);
  $('geldNote').innerHTML = !any ? t('geld.noteEmpty') : t('geld.noteOk');
}

function updatePriceUi() {
  const ok = state.prices && Object.keys(state.prices).length > 0;
  $('priceStatus').textContent = ok ? t('gld.live') : t('gld.off');
  $('priceStatus').classList.toggle('safe', !!ok);
  const upd = $('priceUpdate');
  if (state.pricesTs) {
    upd.textContent = t('gld.update') + new Date(state.pricesTs).toLocaleTimeString(uiLocale());
    upd.classList.add('fresh');
  } else {
    upd.innerHTML = t('gld.update') + '&mdash;';
    upd.classList.remove('fresh');
  }
}

function uiLocale() {
  return window.BM_I18N.lang === 'en' ? 'en-GB' : 'de-DE';
}

async function refreshPrices() {
  const r = await api.prices();
  if (r && r.ok && r.prices) {
    state.prices = r.prices;
    state.pricesTs = r.ts;
  }
  renderGeld();
  renderHist();
}

$('balList').addEventListener('input', (e) => {
  const inp = e.target.closest('.bal-qty');
  if (!inp) return;
  const coin = inp.dataset.coin;
  const raw = inp.value.trim();
  const n = parseFloat(raw.replace(',', '.'));
  if (raw !== '' && !isNaN(n)) state.bal[coin] = String(n);
  else if (raw === '') state.bal[coin] = '0';
  persistCfg();
  refreshTotal();
});

$('btnRefreshPrices').addEventListener('click', () => refreshPrices());

setInterval(() => {
  if (Date.now() - state.pricesTs > 30 * 1000) refreshPrices();
}, 60 * 1000);

/* ---------------- mining history ---------------- */
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh) return hh + 'h ' + String(mm).padStart(2, '0') + 'm';
  if (mm) return mm + 'm ' + String(ss).padStart(2, '0') + 's';
  return ss + 's';
}

function fmtHashes(h) {
  if (!h || h <= 0) return '—';
  const units = [['TH', 1e12], ['GH', 1e9], ['MH', 1e6], ['kH', 1e3]];
  for (const [u, m] of units) if (h >= m) return (h / m).toFixed(2) + ' ' + u;
  return h.toFixed(0) + ' H';
}

function startMineSession() {
  state.sess = {
    coin: state.coin,
    start: state.startedAt || Date.now(),
    hrSum: 0,
    hrN: 0,
  };
  renderHist();
}

function tickMineSession() {
  if (!state.running || !state.sess) return;
  if (state.hashrate > 0) {
    state.sess.hrSum += state.hashrate;
    state.sess.hrN += 1;
  }
  renderHistLive();
}

function finalizeMineSession() {
  if (!state.sess) return;
  const end = Date.now();
  const dur = end - state.sess.start;
  const avgHr = state.sess.hrN ? (state.sess.hrSum / state.sess.hrN) : (state.hashrate || 0);
  const work = avgHr * (dur / 1000);
  if (dur >= 8000) {
    state.hist.sessions = state.hist.sessions || [];
    state.hist.sessions.unshift({
      id: end,
      coin: state.sess.coin,
      start: state.sess.start,
      end,
      dur,
      accepted: state.accepted || 0,
      rejected: state.rejected || 0,
      avgHr,
      work,
    });
    if (state.hist.sessions.length > 80) state.hist.sessions.length = 80;
    const t = state.hist.totals[state.sess.coin] || { ms: 0, shares: 0, work: 0, runs: 0 };
    t.ms += dur;
    t.shares += state.accepted || 0;
    t.work += work;
    t.runs += 1;
    state.hist.totals[state.sess.coin] = t;
    persistCfg();
  }
  state.sess = null;
  renderHist();
}

function renderHistLive() {
  const el = $('histLive');
  if (!el) return;
  if (!state.running || !state.sess) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const dur = Date.now() - state.sess.start;
  const avgHr = state.sess.hrN ? (state.sess.hrSum / state.sess.hrN) : (state.hashrate || 0);
  const work = avgHr * (dur / 1000);
  const hr = fmtHR(state.hashrate);
  el.classList.remove('hidden');
  el.innerHTML = t('hist.live', { coin: state.sess.coin, dur: fmtDur(dur), v: hr.v, unit: hr.unit, sh: (state.accepted || 0), work: fmtHashes(work) });
}

function renderHist() {
  renderHistLive();
  const totals = $('histTotals');
  const list = $('histList');
  if (!totals || !list) return;
  const coins = Object.keys(state.hist.totals || {});
  if (!coins.length && !(state.hist.sessions || []).length) {
    totals.innerHTML = '';
    list.innerHTML = '<div class="hist-empty">' + t('hist.empty') + '</div>';
    return;
  }
  totals.innerHTML = coins.map((coin) => {
    const s = state.hist.totals[coin];
    return '<div class="hist-tot"><b>' + coin + '</b><small>' +
      t('hist.tot', { runs: s.runs, plural: (s.runs === 1 ? '' : 'en'), dur: fmtDur(s.ms), shares: s.shares, work: fmtHashes(s.work) }) +
      '</small></div>';
  }).join('');
  const rows = (state.hist.sessions || []).slice(0, 40).map((session) => {
    const when = new Date(session.start).toLocaleString(uiLocale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const hr = fmtHR(session.avgHr);
    return '<div class="hist-row"><span>' + when + '</span><span>' + session.coin + '</span><span>' +
      fmtDur(session.dur) + '</span><span>' + (session.accepted || 0) + '</span><span>' +
      fmtHashes(session.work) + ' <small>(' + hr.v + ' ' + hr.unit + ')</small></span></div>';
  }).join('');
  list.innerHTML = rows || '<div class="hist-empty">' + t('hist.noSessions') + '</div>';
}

/* ---------------- persistence ---------------- */
function persistCfg() {
  saveActiveCoin();
  state.cfg.coin = state.coin;
  state.cfg.mtype = state.mtype;
  state.cfg.bal = state.bal;
  state.cfg.hist = state.hist;
  if (state.dc) {
    state.dc.clientId = DC_CLIENT_ID;
    state.cfg.dc = state.dc;
  }
  api.saveCfg(state.cfg);
}

async function loadCfg() {
  state.cfg = (await api.loadCfg()) || {};
  state.cfg.coins = state.cfg.coins || {};
  const cur = state.cfg.coin;
  if (cur && !state.cfg.coins[cur]) {
    state.cfg.coins[cur] = {
      pool: state.cfg.pool || (COIN_PRESETS[cur] ? COIN_PRESETS[cur].pool : ''),
      wallet: state.cfg.wallet || '',
      worker: state.cfg.worker || '',
      extra: state.cfg.extra || '',
      miner: state.cfg.miner || '',
      mtype: state.cfg.mtype || 'builtin',
    };
  }
  Object.keys(state.cfg.coins).forEach((coin) => {
    const c = state.cfg.coins[coin];
    if (c && c.wallet) c.wallet = normalizeWallet(coin, c.wallet);
  });
  state.dc = Object.assign({ enabled: true, showHr: true, clientId: DC_CLIENT_ID }, state.cfg.dc || {});
  state.dc.clientId = DC_CLIENT_ID;
  const lang = state.cfg.lang === 'en' ? 'en' : 'de';
  window.BM_I18N.setLang(lang);
  applyLang();
  const coin = (cur && (COIN_PRESETS[cur] || cur === 'CUSTOM')) ? cur : 'FLUX';
  applyCoin(coin, { fromLoad: true });
  if (state.cfg.bal) state.bal = state.cfg.bal;
  if (state.cfg.hist && typeof state.cfg.hist === 'object') {
    state.hist = {
      totals: state.cfg.hist.totals || {},
      sessions: Array.isArray(state.cfg.hist.sessions) ? state.cfg.hist.sessions : [],
    };
  }
  persistCfg();
}

['fPool', 'fWallet', 'fWorker', 'fExtra', 'fMiner'].forEach((id) => {
  $(id).addEventListener('input', () => {
    if (id === 'fWallet') {
      const n = normalizeWallet(state.coin, $(id).value);
      if (n !== $(id).value) $(id).value = n;
      updateWalletHint();
    }
    persistCfg();
  });
});

/* ---------------- tutorial / onboarding ---------------- */
const TOUR_STEPS = [
  { t: 'tour.1t', x: 'tour.1x' },
  { target: 'gpuCard', view: 'dashboard', t: 'tour.2t', x: 'tour.2x' },
  { target: 'powerCard', view: 'dashboard', t: 'tour.3t', x: 'tour.3x' },
  { target: 'navMining', view: 'mining', t: 'tour.4t', x: 'tour.4x' },
  { target: 'cfgCard', view: 'mining', t: 'tour.5t', x: 'tour.5x' },
  { t: 'tour.6t', x: 'tour.6x' },
];

let tourIdx = 0;

function tourPosition() {
  const hl = $('tourHighlight');
  const step = TOUR_STEPS[tourIdx];
  if (!step.target) { hl.classList.add('hide-vis'); return; }
  const el = $(step.target);
  if (!el) { hl.classList.add('hide-vis'); return; }
  const r = el.getBoundingClientRect();
  hl.classList.remove('hide-vis');
  hl.style.left = (r.left - 6) + 'px';
  hl.style.top = (r.top - 6) + 'px';
  hl.style.width = (r.width + 12) + 'px';
  hl.style.height = (r.height + 12) + 'px';
}

function openTour(idx) {
  tourIdx = idx;
  const overlay = $('tour');
  overlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const step = TOUR_STEPS[tourIdx];
  $('tourTitle').innerHTML = t(step.t);
  $('tourText').innerHTML = t(step.x);
  $('tourStep').textContent = (tourIdx + 1) + ' / ' + TOUR_STEPS.length;
  $('tourProgress').style.width = ((tourIdx + 1) / TOUR_STEPS.length * 100) + '%';
  $('tourBack').style.visibility = tourIdx === 0 ? 'hidden' : 'visible';
  $('tourNext').textContent = tourIdx === TOUR_STEPS.length - 1 ? t('tour.start') : t('tour.next');

  if (step.view) switchView(step.view);
  setTimeout(tourPosition, 60);
}

function closeTour() {
  $('tour').classList.add('hidden');
  $('tourHighlight').classList.add('hide-vis');
  document.body.style.overflow = '';
}

$('tourNext').addEventListener('click', () => {
  if (tourIdx >= TOUR_STEPS.length - 1) { closeTour(); return; }
  openTour(tourIdx + 1);
});
$('tourBack').addEventListener('click', () => {
  if (tourIdx > 0) openTour(tourIdx - 1);
});
$('tourSkip').addEventListener('click', closeTour);
$('btnHelp').addEventListener('click', () => {
  switchView('dashboard');
  openTour(0);
});
window.addEventListener('resize', tourPosition);

/* ---------------- Einstellungen / Sprache / Discord Rich Presence ---------------- */
function applyLang() {
  window.BM_I18N.applyStatic();
  document.documentElement.lang = window.BM_I18N.lang;
  document.querySelectorAll('.lang-btn').forEach((b) => b.classList.toggle('active', b.dataset.lang === window.BM_I18N.lang));
  const f = $('fWallet');
  if (f) f.placeholder = t('wh.' + state.coin + '.ph');
  const m = $('fExtra');
  if (m && state.coin === 'XMR') m.placeholder = t('cfg.extraPhXmr');
  const mn = $('fMiner');
  if (mn) mn.placeholder = t('cfg.minerPh');
  if (!$('btnMine').classList.contains('running')) $('btnMine').innerHTML = t('cfg.start');
  updateMtHint();
  updateWalletHint();
  renderGeld();
  renderHist();
  updatePriceUi();
  renderRecs();
  refreshDcUi();
  renderGpuSwitch(state.lastGpuData);
}

function refreshDcUi() {
  if (!$('dcEnabled')) return;
  $('dcEnabled').checked = !!state.dc.enabled;
  $('dcShowHr').checked = !!state.dc.showHr;
  $('dcRowHr').classList.toggle('off', !state.dc.enabled);
  const st = $('dcStatus');
  if (!state.dc.enabled) { st.className = 'dc-status'; st.innerHTML = t('dc.off'); }
  else if (state.dcState === 'err') { st.className = 'dc-status err'; st.innerHTML = t('dc.err') + (state.dcErr ? ' <small>' + state.dcErr + '</small>' : ''); }
  else if (state.dcState === 'ok') { st.className = 'dc-status ok'; st.innerHTML = t('dc.actOn') + (state.dcTag ? ' <small>(' + state.dcTag + ')</small>' : ''); }
  else { st.className = 'dc-status'; st.innerHTML = t('dc.connecting'); }
}

document.querySelectorAll('.lang-btn').forEach((b) => {
  b.addEventListener('click', () => {
    state.cfg.lang = b.dataset.lang;
    window.BM_I18N.setLang(state.cfg.lang);
    applyLang();
    persistCfg();
  });
});

function saveDc() {
  state.dc = {
    enabled: $('dcEnabled').checked,
    showHr: $('dcShowHr').checked,
    clientId: DC_CLIENT_ID,
  };
  state.cfg.dc = state.dc;
  api.saveCfg(state.cfg);
  refreshDcUi();
}

function applyDc() {
  if (!state.dc.enabled) { api.dcStop(); return; }
  api.dcInit({ clientId: DC_CLIENT_ID });
  updateDcStatus();
}

function updateDcStatus() {
  if (!state.dc || !state.dc.enabled) return;
  api.dcStatus({
    mining: state.running,
    coin: state.coin,
    hr: state.hashrate,
    showHr: state.dc.showHr,
    start: state.startedAt || Date.now(),
  });
  refreshDcUi();
}

$('btnSettings').addEventListener('click', () => { refreshDcUi(); $('settingsOverlay').classList.remove('hidden'); });
$('btnCloseSettings').addEventListener('click', () => { saveDc(); applyDc(); $('settingsOverlay').classList.add('hidden'); });
$('settingsOverlay').addEventListener('click', (e) => { if (e.target === $('settingsOverlay')) { saveDc(); applyDc(); $('settingsOverlay').classList.add('hidden'); } });
$('dcEnabled').addEventListener('change', () => { saveDc(); applyDc(); });
$('dcShowHr').addEventListener('change', () => { saveDc(); updateDcStatus(); });
setInterval(() => { if (state.running && state.dc && state.dc.enabled && state.dc.showHr) updateDcStatus(); }, 15000);
api.dcReady((d) => { state.dcState = 'ok'; state.dcErr = ''; state.dcTag = (d && d.tag) || ''; refreshDcUi(); });
api.dcError((d) => { state.dcState = 'err'; state.dcErr = ((d.message || '').slice(0, 140)) + (d.code ? ' (Code ' + d.code + ')' : ''); refreshDcUi(); });
api.dcConnecting(() => { state.dcState = 'connecting'; state.dcErr = ''; refreshDcUi(); });

/* ---------------- Auto-Update ---------------- */
let _upd = null;
let _updInstalling = false;

function showUpdate(info) {
  _upd = info;
  $('updateVer').innerHTML = t('upd.ver', { v: info.latest, cur: info.current });
  $('updateChangelog').textContent = info.changelog || '';
  $('update').classList.remove('hidden');
}

async function checkForUpdate() {
  try {
    const r = await api.updateCheck();
    if (r.ok && r.update) showUpdate(r);
  } catch (_) {}
}

$('updateClose').addEventListener('click', () => $('update').classList.add('hidden'));
$('updateLater').addEventListener('click', () => $('update').classList.add('hidden'));
$('updateGo').addEventListener('click', async () => {
  if (!_upd || _updInstalling) return;
  _updInstalling = true;
  $('updateVer').innerHTML = t('upd.installing');
  const dl = await api.updateDownload(_upd.downloadUrl);
  if (!dl.ok) {
    _updInstalling = false;
    $('updateVer').innerHTML = t('upd.fail', { e: errText(dl.error) });
    return;
  }
  $('updateVer').innerHTML = t('upd.done');
  setTimeout(() => {
    api.updateInstall(dl.path);
    _updInstalling = false;
  }, 900);
});

/* ---------------- boot ---------------- */
(async function boot() {
  await loadCfg();
  state.dcState = 'idle'; state.dcErr = '';
  refreshDcUi();
  if (state.dc && state.dc.enabled) { api.dcInit({ clientId: DC_CLIENT_ID }); updateDcStatus(); }
  else api.dcStop();
  api.onData(renderGpu);
  renderGeld();
  renderHist();
  refreshPrices();
  checkForUpdate();

  try {
    const d = await api.gpu();
    renderGpu(d);
    if (d && d.stats && d.stats.length) $('headSub').innerHTML = d.stats[0].name + ' &middot; ' + t('dash.telemetry');
    const adm = await api.isAdmin();
    if (d && d.stats && !adm.admin) {
      $('adminBanner').classList.remove('hidden');
    }
    renderRecs();
  } catch (_) {
    $('gpuName').textContent = t('no.gpu');
    $('headSub').textContent = t('no.gpuSub');
    toast(t('no.gpuToast'), true);
  }
})();