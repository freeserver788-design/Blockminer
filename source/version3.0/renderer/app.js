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
  hrSamples: [],
  elec: 0.40,
  gpuSel: null,
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


const ETH_ADDR_RE = /^(0x)?[0-9a-fA-F]{40}$/;
const BTC_ADDR_RE = /^(bc1[a-z0-9]{25,}|[13][a-km-zA-HJ-NP-Z1-9]{25,})$/;
const TRX_ADDR_RE = /^T[a-zA-Z0-9]{33}$/;

function isUnmineablePayoutAddr(w) {
  w = stripCoinPrefix(w);
  return ETH_ADDR_RE.test(w) || BTC_ADDR_RE.test(w) || TRX_ADDR_RE.test(w) || w.length >= 15; // Generic fallback
}

const WALLET_OK = {
  FLUX:   (w) => { w = stripCoinPrefix(w); return /^(t1|tFLUX|tz|tz1)[0-9A-Za-z]{20,}$/i.test(w) || /^[0-9A-Za-z]{27,34}$/.test(w); },
  XMR:    (w) => /^[48][0-9A-Za-z]{90,106}$/.test(stripCoinPrefix(w)),
  KAS:    (w) => /^(kaspa:)?([a-z0-9]{15,63})$/i.test(stripCoinPrefix(w)),
  ERG:    (w) => { w = stripCoinPrefix(w); return /^9[1-9A-HJ-NP-Za-km-z]{35,}$/.test(w) || /^[0-9A-Za-z]{30,60}$/.test(w); },
  ZEPH:   (w) => { w = stripCoinPrefix(w); return /^(ZEPH|zeph)([0-9A-Za-z]{20,})$/.test(w) || /^[48][0-9A-Za-z]{85,120}$/.test(w); },
  ALPH:   (w) => { w = stripCoinPrefix(w); return /^(alph1|1)[0-9A-Za-z]{25,}$/i.test(w) || /^[1-9A-HJ-NP-Za-km-z]{30,64}$/.test(w); },
  BTC:    (w) => { w = stripCoinPrefix(w); return /^(bc1[a-z0-9]{15,}|[13][a-km-zA-HJ-NP-Z1-9]{25,})$/.test(w) || /^[0-9A-Za-z]{26,50}$/.test(w); },
  CUSTOM: (w) => stripCoinPrefix(w).length >= 15,
};

function stripCoinPrefix(w) {
  return String(w || '').trim().replace(/^[A-Z0-9]{2,10}:/i, '');
}

function normalizeWallet(coin, raw) {
  return String(raw || '').trim().replace(/[\u200b-\u200d\ufeff]/g, '');
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

  const isUnmineableFlux = state.coin === 'FLUX' && (((state.cfg.coins || {}).FLUX || {}).pool || '').includes('unmineable');
  const ok = isUnmineableFlux ? isUnmineablePayoutAddr : (WALLET_OK[state.coin] || WALLET_OK.CUSTOM);

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
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(el._h);
  el._h = setTimeout(() => el.classList.remove('show'), 3400);
}

function fmtHR(hs) {
  if (!hs || isNaN(hs)) return { v: '0.00', unit: 'H/s' };
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s'];
  let i = 0;
  while (hs >= 1000 && i < units.length - 1) { hs /= 1000; i++; }
  return { v: hs.toFixed(2), unit: units[i] };
}

/* ---------------- splash / boot ---------------- */
window.addEventListener('error', (e) => {
  console.error('[blockmine] uncaught error:', e.message, e.filename, e.lineno);
  try { toast('FEHLER: ' + (e.message || 'Unbekannter Fehler') + (e.lineno ? ' (Z. ' + e.lineno + ')' : ''), true); } catch (_) {}
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[blockmine] unhandled rejection:', e.reason);
  try { toast('FEHLER: ' + (String(e.reason || '').slice(0, 120) || 'Unbekannter Fehler'), true); } catch (_) {}
});
const bootMsgs = ['boot.b1', 'boot.b2', 'boot.b3', 'boot.b4'];
let bi = 0;
const bootTimer = setInterval(() => {
  bi = Math.min(bi + 1, bootMsgs.length - 1);
  const el = $('splash-status');
  if (el) el.innerHTML = t(bootMsgs[bi]);
}, 400);

setTimeout(() => {
  clearInterval(bootTimer);
  const sp = $('splash');
  if (sp) sp.classList.add('fade');
  setTimeout(() => {
    if (sp) sp.style.display = 'none';
    const app = $('app');
    if (app) app.classList.remove('hidden');
    const first = !(state.cfg && state.cfg.tourDone);
    if (first) { state.cfg.tourDone = true; try { api.saveCfg(state.cfg); } catch (_) {} }
  }, 650);
}, 2400);

/* ---------------- navigation ---------------- */
function switchView(view) {
  document.querySelectorAll('.nav-btn').forEach((x) => x.classList.toggle('active', x.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  document.querySelectorAll('.dashboard-addon').forEach((v) => v.classList.toggle('hidden', view !== 'dashboard'));
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

/* ---------------- v3 operations layer ---------------- */
function updateV3Status() {
  const orb = $('v3StatusOrb');
  const label = $('v3Status');
  const detail = $('v3StatusDetail');
  if (!orb || !label || !detail) return;
  const hasGpu = !!(state.gpu && state.all && state.all.length);
  orb.className = 'status-orb ' + (state.running ? 'active' : (hasGpu ? 'ready' : 'warn'));
  label.textContent = state.running ? t('v3.mining') : (hasGpu ? t('v3.ready') : t('v3.noGpu'));
  detail.textContent = state.running
    ? (state.coin + ' · ' + fmtHR(state.hashrate).v + ' ' + fmtHR(state.hashrate).unit)
    : (hasGpu ? state.all.length + ' GPU · ' + t('v3.protected') : t('v3.waiting'));
}

function updateV3Kpis() {
  const g = state.gpu;
  if ($('v3KpiTemp')) $('v3KpiTemp').textContent = g ? g.temp : '--';
  if ($('v3KpiPower')) $('v3KpiPower').textContent = g ? Number(g.power || 0).toFixed(0) : '--';
  const hr = fmtHR(state.hashrate);
  if ($('v3KpiHash')) $('v3KpiHash').textContent = hr.v;
  if ($('v3KpiHashUnit')) $('v3KpiHashUnit').innerHTML = hr.unit + ' <i>' + (state.running ? t('v3.live') : t('v3.idle')) + '</i>';
  const efficiency = state.running ? effTotal() : null;
  if ($('v3KpiEfficiency')) $('v3KpiEfficiency').textContent = efficiency ? efficiency.v : '--';
  if ($('v3KpiEfficiencyUnit')) $('v3KpiEfficiencyUnit').innerHTML = (efficiency ? efficiency.unit : 'H/W') + ' <i>' + t('v3.live') + '</i>';
  if ($('v3KpiTempState')) $('v3KpiTempState').textContent = g ? (g.temp >= 85 ? t('v3.hot') : t('v3.good')) : '—';
  if ($('v3KpiPowerState')) $('v3KpiPowerState').textContent = g && g.powerLimit ? Math.round(g.power / g.powerLimit * 100) + '%' : '—';
  updateV3Status();
}

function renderGpuFleet() {
  const el = $('gpuFleet');
  if (!el) return;
  const gpus = state.all || [];
  if (!gpus.length) {
    el.innerHTML = '<div class="fleet-empty">' + t('v3.fleetEmpty') + '</div>';
    return;
  }
  el.innerHTML = gpus.map((g, i) => {
    const tempClass = g.temp >= 85 ? 'hot' : (g.temp >= 75 ? 'warm' : 'good');
    const pct = g.powerLimit ? Math.round((g.power / g.powerLimit) * 100) : 0;
    return '<button class="fleet-unit ' + (i === state.gpuIdx ? 'selected ' : '') + tempClass + '" data-gpui="' + i + '">' +
      '<span class="fleet-index">GPU ' + g.index + '</span>' +
      '<b title="' + g.name + '">' + g.name + '</b>' +
      '<span class="fleet-reading"><strong>' + g.temp + '°</strong><small>' + g.util + '% LOAD</small></span>' +
      '<span class="fleet-reading"><strong>' + Number(g.power || 0).toFixed(0) + ' W</strong><small>' + pct + '% LIMIT</small></span>' +
      '<span class="fleet-bar"><i style="width:' + Math.min(100, Math.max(0, g.util || 0)) + '%"></i></span>' +
      '</button>';
  }).join('');
}

$('v3QuickMine').addEventListener('click', () => switchView('mining'));
$('v3QuickPower').addEventListener('click', () => {
  if (!state.powerInfo) return toast(t('toast.noGpu'), true);
  const v = Math.round(state.powerInfo.def * 0.8);
  const s = $('plSlider');
  s.value = Math.min(state.powerInfo.max, Math.max(state.powerInfo.min, v));
  $('plValue').textContent = s.value;
  state.sliderDirty = true;
  sliderFill();
  markPreset(+s.value);
  toast(t('toast.sliderSet', { w: s.value }));
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

function renderGpuSelect() {
  const grid = $('gpuSelectGrid');
  const gpus = state.all || [];
  if (!grid || !gpus.length) return;

  grid.innerHTML = gpus.map((g) => {
    const on = state.gpuSel == null || state.gpuSel.indexOf(g.index) >= 0;
    return '<div class="gpu-item" data-gpi="' + g.index + '">' +
      '<div class="gpu-check ' + (on ? 'active' : '') + '" data-gpi="' + g.index + '" title="GPU ' + g.index + ': ' + g.name + ' (' + (g.memTotal / 1024) + ' GB)">' +
      g.index + ' <span class="gpu-item-name">' + g.name + '</span></div></div>';
  }).join('');
}

function renderGpu(d) {
  if (!d || !d.stats || !d.stats.length) {
    state.gpu = null;
    state.all = [];
    renderGpuFleet();
    updateV3Kpis();
    return;
  }
  state.lastGpuData = d;
  state.all = d.stats;
  if (state.gpuIdx >= d.stats.length) state.gpuIdx = 0;
  const g = d.stats[state.gpuIdx];
  state.gpu = g;
  state.infos = d.infos || [];
  state.powerInfo = state.infos[state.gpuIdx] || null;
  renderGpuSwitch(d);
  renderGpuSelect();
  renderGpuFleet();

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

  updateV3Kpis();

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

$('gpuFleet').addEventListener('click', (e) => {
  const card = e.target.closest('.fleet-unit');
  if (!card) return;
  state.gpuIdx = parseInt(card.dataset.gpui, 10) || 0;
  renderGpu(state.lastGpuData);
  renderRecs();
});

$('btnRefreshFleet').addEventListener('click', async () => {
  const d = await api.gpu();
  renderGpu(d);
  renderRecs();
  toast(t('v3.fleetRefreshed'));
});

$('gpuSelectGrid').addEventListener('click', (e) => {
  const item = e.target.closest('.gpu-item');
  if (!item) return;
  const idx = parseInt(item.dataset.gpi, 10);
  if (isNaN(idx)) return;

  if (e.target.classList.contains('gpu-check')) {
    if (state.running) return;
    state.gpuSel = state.gpuSel || [];
    const pos = state.gpuSel.indexOf(idx);
    if (pos >= 0) state.gpuSel.splice(pos, 1);
    else state.gpuSel.push(idx);
    if (!state.gpuSel.length) state.gpuSel = null;
  }

  renderGpuSelect();
  persistCfg();
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
  p.addEventListener('click', async () => {
    if (!state.powerInfo) return;
    const v = Math.round(state.powerInfo.def * parseFloat(p.dataset.frac));
    const s = $('plSlider');
    s.value = Math.min(state.powerInfo.max, Math.max(state.powerInfo.min, v));
    $('plValue').textContent = s.value;
    state.sliderDirty = true;
    sliderFill();
    markPreset(+s.value);
    if (p.dataset.maxall !== undefined) {
      const r = await api.powerAll(v);
      if (r.ok) {
        toast(t('toast.applyAll', { w: v }));
      } else if (r.admin) {
        $('adminBanner').classList.remove('hidden');
        toast(t('toast.adminNeeded'), true);
      } else {
        toast(t('toast.error', { e: r.error || 'nvidia-smi' }), true);
      }
    }
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
  const dlGpu = state.mtype === 'external' ? (gpu || state.coin === 'CUSTOM') : false;
  $('btnDlGpu').classList.toggle('hidden', !dlGpu);
  $('btnDl').classList.toggle('hidden', !!dlGpu);
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
    pools: $('fPools').value.split(/\r?\n/).map((p) => p.trim()).filter(Boolean),
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
    $('fPools').value = Array.isArray(c.pools) ? c.pools.join('\n') : '';
    $('fWallet').value = c.wallet || '';
    $('fWorker').value = c.worker || '';
    $('fExtra').value = c.extra || '';
    $('fMiner').value = c.miner || '';
    if (c.mtype) setMtype(c.mtype);
  } else {
    $('fPool').value = preset || '';
    $('fPools').value = '';
    $('fWallet').value = '';
    $('fWorker').value = '';
    $('fExtra').value = '';
    $('fMiner').value = '';
  }
  updateWalletHint();
  renderGpuSelect();
}

document.querySelectorAll('.coin').forEach((c) => {
  c.addEventListener('click', () => { applyCoin(c.dataset.coin); });
});

$('btnBrowse').addEventListener('click', async () => {
  const r = await api.pickMiner();
  if (r.ok) { $('fMiner').value = r.path; persistCfg(); toast(t('toast.fileSet')); }
});

$('btnTestPool').addEventListener('click', async () => {
  const button = $('btnTestPool');
  const status = $('poolTestStatus');
  const pool = $('fPool').value.trim();
  if (!pool) return toast(t('toast.noPool'), true);
  button.disabled = true;
  status.className = 'testing';
  status.textContent = t('cfg.poolTesting');
  const r = await api.testPool(pool);
  button.disabled = false;
  if (r && r.ok) {
    status.className = 'ok';
    status.textContent = t('cfg.poolOnline', { ms: r.ms, host: r.host });
    toast(t('cfg.poolOnline', { ms: r.ms, host: r.host }));
  } else {
    status.className = 'bad';
    status.textContent = t('cfg.poolOffline');
    toast((r && r.error) || t('cfg.poolOffline'), true);
  }
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
  const eff = state.hashrate > 0 && state.running ? effTotal() : null;
  $('liveEff').textContent = eff ? eff.v + ' ' + eff.unit + '/W' : '-- H/W';
  pushChart();
  updateProfit();
  updateV3Kpis();
}

/* ---------------- hashrate chart ---------------- */
const CHART_MAX = 120;

function pushChart() {
  if (!state.running) return;
  state.hrSamples.push({ t: Date.now(), hr: state.hashrate });
  if (state.hrSamples.length > CHART_MAX) state.hrSamples.shift();
  drawChart();
}

function drawChart() {
  const cv = $('hrChart');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 520;
  const h = cv.clientHeight || 110;
  cv.width = w * dpr;
  cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.06)';
  ctx.lineWidth = 1;
  for (let gi = 0; gi <= 3; gi++) {
    const gy = (h / 4) * gi + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
  }
  const s = state.hrSamples;
  if (s.length < 2) {
    $('hrChartNote').textContent = t('chart.note', { n: 1 });
    return;
  }
  let max = 0;
  for (let i = 0; i < s.length; i++) if (s[i].hr > max) max = s[i].hr;
  if (max <= 0) max = 1;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < s.length; i++) {
    const x = (i / (CHART_MAX - 1)) * (w - 6) + 3;
    const y = h - 4 - (s[i].hr / max) * (h - 10);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  const mins = Math.max(1, Math.ceil(s.length / 60) * (s.length > 60 ? 1 : 1));
  $('hrChartNote').textContent = t('chart.note', { n: mins });
}

/* ---------------- efficiency ---------------- */
function effTotal() {
  if (state.hashrate <= 0) return null;
  const totalW = totalWatts();
  if (totalW <= 0) return null;
  const per = state.hashrate / totalW;
  const f = fmtHR(per);
  return { v: f.v, unit: f.unit.replace('/s', '/W') };
}

/* ---------------- profit estimate ---------------- */
const REWARD_DAY = {
  FLUX: { base: 1e6, rate: 0.055 },
  XMR:  { base: 1, rate: 0.0005 },
  KAS:  { base: 1e9, rate: 0.9 },
  ERG:  { base: 1e6, rate: 0.015 },
  ZEPH: { base: 1e3, rate: 0.012 },
  ALPH: { base: 1e9, rate: 0.55 },
  BTC:  { base: 1e12, rate: 0.6 },
  CUSTOM: { base: 1e6, rate: 0.03 },
};

function getElec() {
  const v = parseFloat($('elecPrice').value);
  const g = parseFloat(state.cfg && state.cfg.elec);
  return (isFinite(v) && v > 0 ? v : (isFinite(g) && g > 0 ? g : state.elec || 0.4));
}

function totalWatts() {
  let w = 0;
  (state.all || []).forEach((g) => { w += g.power || 0; });
  return w;
}

function updateProfit() {
  if (!state.running) {
    $('profitGross').textContent = '--';
    $('profitCost').textContent = t('profit.na');
    $('profitNet').textContent = t('profit.na');
    return;
  }
  const coin = state.coin || 'FLUX';
  const r = REWARD_DAY[coin] || REWARD_DAY.CUSTOM;
  const grossDay = (state.hashrate / r.base) * r.rate;
  const w = totalWatts();
  const costDay = (w / 1000) * 24 * getElec();
  $('profitGross').textContent = fmtEUR(grossDay);
  $('profitCost').textContent = '- ' + fmtEUR(costDay);
  $('profitNet').textContent = fmtEUR(grossDay - costDay);
}

function fmtEUR(v) {
  if (!isFinite(v)) return '--';
  if (v >= 1000) return v.toFixed(0) + ' &euro;';
  if (v >= 1) return v.toFixed(2) + ' &euro;';
  if (v > 0) return v.toFixed(3) + ' &euro;';
  return '0,00 &euro;';
}
setInterval(() => {
  renderMineStats();
  tickMineSession();
}, 1000);

function addLog(d) {
  const con = $('console');
  if (!con) return;
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
    pools: $('fPools').value.split(/\r?\n/).map((p) => p.trim()).filter(Boolean),
    wallet: normalizeWallet(state.coin, $('fWallet').value),
    worker: $('fWorker').value.trim(),
    extra: $('fExtra').value.trim(),
    path: $('fMiner').value.trim(),
    builtin: state.mtype === 'builtin',
    gpuIndex: (state.gpuSel && state.gpuSel.length
      ? state.gpuSel.join(',')
      : (state.all && state.all.length ? state.all.map((g) => g.index).join(',') : '0')),
  };
  profile.pools = [profile.pool, ...profile.pools].filter((p, i, all) => p && all.indexOf(p) === i);
  if (!profile.wallet) return toast(t('toast.noWallet'), true);
  if (!profile.pool) {
    const preset = (COIN_PRESETS[profile.coin] || {}).pool;
    if (preset) {
      profile.pool = preset;
      $('fPool').value = preset;
    } else {
      return toast(t('toast.noPool'), true);
    }
  }
  const isUnmineableFlux = profile.coin === 'FLUX' && profile.pool.includes('unmineable');
  const ok = isUnmineableFlux ? isUnmineablePayoutAddr : (WALLET_OK[profile.coin] || WALLET_OK.CUSTOM);

  if (ok && !ok(profile.wallet)) {
    const isCustomLike = profile.coin === 'CUSTOM';
    if (!isCustomLike) return toast(t('toast.badWallet', { coin: profile.coin }), true);
  }
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
  state.hrSamples = [];
  state.lastPool = profile.pool;
  $('livePool').textContent = state.lastPool || '--';
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
  updateV3Kpis();
});

$('btnStopMine').addEventListener('click', async () => {
  await api.stop();
  setStopped(t('log.stop'));
});

function lockCfg(locked) {
  document.querySelectorAll('.coin').forEach((c) => {
    c.classList.toggle('locked', locked);
    c.style.pointerEvents = locked ? 'none' : 'auto';
  });
  document.querySelectorAll('.mtype').forEach((b) => {
    b.classList.toggle('locked', locked);
    b.style.pointerEvents = locked ? 'none' : 'auto';
  });
  ['fPool', 'fPools', 'fWallet', 'fWorker', 'fExtra', 'fMiner', 'btnBrowse', 'btnDl', 'btnDlGpu'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = locked;
  });
}

function setStarted(d) {
  if (state.running) finalizeMineSession();
  lockCfg(true);
  state.running = true;
  state.startedAt = Date.now();
  state.hashrate = 0; state.accepted = 0; state.rejected = 0;
  state.hrSamples = [];
  state.lastPool = (d && d.pool) || state.lastPool || '--';
  $('livePool').textContent = state.lastPool;
  $('btnMine').innerHTML = '&middot; ' + t('stat.mining') + ' AKTIV &middot;';
  $('btnMine').classList.add('running');
  $('btnStopMine').disabled = false;
  $('btnStopMine').classList.add('running');
  $('statePill').classList.add('mining');
  $('stateText').textContent = t('stat.mining');
  $('mineStatePill').classList.add('mining');
  $('mineStateText').textContent = t('mining.online');
  startMineSession();
  updateDcStatus();
}
api.onStart(setStarted);

function setStopped(msg) {
  finalizeMineSession();
  lockCfg(false);
  state.running = false;
  state.startedAt = null;
  state.lastPool = null;
  $('livePool').textContent = '--';
  state.hrSamples = [];
  drawChart();
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
  updateV3Kpis();
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
  state.cfg.gpuSel = state.gpuSel;
  state.cfg.bal = state.bal;
  state.cfg.hist = state.hist;
  if (state.dc) {
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
  state.dc = Object.assign({ enabled: true, showHr: true }, state.cfg.dc || {});
  const lang = state.cfg.lang === 'en' ? 'en' : 'de';
  window.BM_I18N.setLang(lang);
  applyLang();
  const coin = (cur && (COIN_PRESETS[cur] || cur === 'CUSTOM')) ? cur : 'FLUX';
  applyCoin(coin, { fromLoad: true });
  if (state.cfg.bal) state.bal = state.cfg.bal;
  if (state.cfg.gpuSel) state.gpuSel = state.cfg.gpuSel;
  if (state.cfg.hist && typeof state.cfg.hist === 'object') {
    state.hist = {
      totals: state.cfg.hist.totals || {},
      sessions: Array.isArray(state.cfg.hist.sessions) ? state.cfg.hist.sessions : [],
    };
  }
  persistCfg();
}

['fPool', 'fPools', 'fWallet', 'fWorker', 'fExtra', 'fMiner'].forEach((id) => {
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
  updateV3Kpis();
}

function refreshDcUi() {
  console.log('refreshDcUi called');
  const dc = state.dc || { enabled: false, showHr: false };
  const dcEnabledEl = $('dcEnabled');
  if (dcEnabledEl) dcEnabledEl.checked = !!dc.enabled;
  const dcShowHrEl = $('dcShowHr');
  if (dcShowHrEl) dcShowHrEl.checked = !!dc.showHr;
  const dcRowHrEl = $('dcRowHr');
  if (dcRowHrEl) dcRowHrEl.classList.toggle('off', !dc.enabled);
  const st = $('dcStatus');
  if (!st) { console.log('dcStatus missing in refreshDcUi'); return; }
  if (!dc.enabled) { st.className = 'dc-status'; st.innerHTML = t('dc.off'); }
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
  };
  state.cfg.dc = state.dc;
  api.saveCfg(state.cfg);
  refreshDcUi();
}

function applyDc() {
  if (!state.dc.enabled) { api.dcStop(); return; }
  api.dcInit({});
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

$('dcEnabled').addEventListener('change', () => { saveDc(); applyDc(); });
$('dcShowHr').addEventListener('change', () => { saveDc(); updateDcStatus(); });
setInterval(() => { if (state.running && state.dc && state.dc.enabled && state.dc.showHr) updateDcStatus(); }, 15000);
api.dcReady((d) => { state.dcState = 'ok'; state.dcErr = ''; state.dcTag = (d && d.tag) || ''; refreshDcUi(); });
api.dcError((d) => { state.dcState = 'err'; state.dcErr = ((d.message || '').slice(0, 140)) + (d.code ? ' (Code ' + d.code + ')' : ''); refreshDcUi(); });
api.dcConnecting(() => { state.dcState = 'connecting'; state.dcErr = ''; refreshDcUi(); });

/* ---------------- Schutz & Automatik (wd / guard / elec) ---------------- */
function safDefaults() {
  const cfg = state.cfg || {};
  return {
    wd: Object.assign({ enabled: true, maxRestarts: 5, hangSec: 45, rejectPct: 40 }, (cfg.wd) || {}),
    guard: Object.assign({ enabled: true, maxTemp: 85, restoreTemp: 75, factor: 0.7 }, (cfg.guard) || {}),
    elec: (cfg.elec) || 0.40,
    webhookUrl: (cfg.webhookUrl) || '',
    donate: Object.assign({ enabled: true }, (cfg.donate) || {}),
  };
}

function refreshSafUi() {
  console.log('refreshSafUi called');
  const s = safDefaults();
  const wdEl = $('wdEnabled');
  if (wdEl) wdEl.checked = !!s.wd.enabled;
  const guardEl = $('guardEnabled');
  if (guardEl) guardEl.checked = !!s.guard.enabled;
  const guardMaxEl = $('guardMax');
  if (guardMaxEl) guardMaxEl.value = s.guard.maxTemp;
  const guardRestEl = $('guardRest');
  if (guardRestEl) guardRestEl.value = s.guard.restoreTemp;
  const guardMaxLblEl = $('guardMaxLbl');
  if (guardMaxLblEl) guardMaxLblEl.textContent = s.guard.maxTemp + ' °C';
  const guardRestLblEl = $('guardRestLbl');
  if (guardRestLblEl) guardRestLblEl.textContent = s.guard.restoreTemp + ' °C';
  const elecPriceCfgEl = $('elecPriceCfg');
  if (elecPriceCfgEl) elecPriceCfgEl.value = s.elec;
  const elecPriceEl = $('elecPrice');
  if (elecPriceEl) elecPriceEl.value = s.elec;
  const webhookUrlEl = $('webhookUrl');
  if (webhookUrlEl) webhookUrlEl.value = s.webhookUrl;
  const dEl = $('donEnabled');
  if (dEl) dEl.checked = !!s.donate.enabled;
}

function saveSaf() {
  const s = safDefaults();
  s.wd.enabled = $('wdEnabled').checked;
  s.guard.enabled = $('guardEnabled').checked;
  s.guard.maxTemp = clampInt($('guardMax').value, 60, 95, 85);
  s.guard.restoreTemp = clampInt($('guardRest').value, 55, 90, 75);
  s.elec = clampFloat($('elecPriceCfg').value, 0, 3, 0.40);
  if (s.guard.restoreTemp >= s.guard.maxTemp) s.guard.restoreTemp = s.guard.maxTemp - 5;
  const dEl = $('donEnabled');
  if (dEl) s.donate.enabled = dEl.checked;
  state.cfg.wd = s.wd;
  state.cfg.guard = s.guard;
  state.cfg.elec = s.elec;
  state.cfg.webhookUrl = $('webhookUrl').value.trim();
  state.cfg.donate = s.donate;
  api.saveCfg(state.cfg);
  refreshSafUi();
}

function clampInt(v, lo, hi, d) {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return d;
  return Math.max(lo, Math.min(hi, n));
}
function clampFloat(v, lo, hi, d) {
  const n = parseFloat(v);
  if (!isFinite(n)) return d;
  return Math.max(lo, Math.min(hi, n));
}

$('btnSettings').addEventListener('click', () => {
  console.log('btnSettings clicked');
  refreshDcUi();
  refreshSafUi();
  $('settingsOverlay').classList.remove('hidden');
});
$('btnCloseSettings').addEventListener('click', () => { saveDc(); applyDc(); saveSaf(); $('settingsOverlay').classList.add('hidden'); });
$('settingsOverlay').addEventListener('click', (e) => { if (e.target === $('settingsOverlay')) { saveDc(); applyDc(); saveSaf(); $('settingsOverlay').classList.add('hidden'); } });
$('wdEnabled').addEventListener('change', saveSaf);
$('guardEnabled').addEventListener('change', saveSaf);
$('guardMax').addEventListener('change', saveSaf);
$('guardRest').addEventListener('change', saveSaf);
$('elecPriceCfg').addEventListener('input', () => { saveSaf(); updateProfit(); });
$('donEnabled').addEventListener('change', saveSaf);
$('elecPrice').addEventListener('input', () => {
  const v = clampFloat($('elecPrice').value, 0, 3, 0.40);
  state.cfg.elec = v;
  $('elecPriceCfg').value = v;
  api.saveCfg(state.cfg);
  updateProfit();
});
$('guardProbe').addEventListener('click', async () => {
  const r = await api.guardState();
  if (!r.ok) return toast(t('saf.guardNone'), true);
  const act = (r.state || []).filter((g) => g.active);
  if (!act.length) return toast(t('saf.guardNone'));
  toast(act.map((g) => t('saf.guardSome', { i: g.index, t: g.target })).join(' &middot; '));
});
api.onMainToast((d) => { if (d && d.msg) toast(d.msg.replace(/&[a-z#0-9]+;/g, ''), d.err); });

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
  if (state.dc && state.dc.enabled) { api.dcInit({}); updateDcStatus(); }
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
    updateV3Kpis();
  }
})();
