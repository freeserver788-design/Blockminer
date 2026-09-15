'use strict';

/*
 * Echter Stratum-Miner (SHA-256): verbindet sich mit einem
 * echten Pool, baut den Block-Header aus dem Job und sucht
 * Nonces auf mehreren Worker-Threads. Keine Demo.
 */
const { Worker } = require('worker_threads');
const path = require('path');
const crypto = require('crypto');
const { Stratum } = require('./stratum');
const engine = require('./engine');

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i === -1 ? def : argv[i + 1] || def;
}

function sha256d(buf) {
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(buf).digest())
    .digest();
}
function rev(buf) { return Buffer.from(buf).reverse(); }

const THREADS = Math.max(1, parseInt(arg('--threads', '2'), 10) || 2);
const POOL = arg('--pool', '');
const WALLET = arg('--wallet', '');
const WORKER = arg('--worker', 'rig1');

console.log(' * POOL : ' + POOL);
console.log(' * USER : ' + WALLET + '.' + WORKER);
console.log(' * DEVICE: CPU, ' + THREADS + ' Threads');
console.log(' * ALGO : SHA-256d (echtes Stratum-Mining)');
console.log('');

let workers = [];
let totalHs = 0;
let accepted = 0;
let rejected = 0;
let pendingCount = 0;
const start = Date.now();
let last10 = 0;

function buildHeader(job, merkleRootRaw, nonce) {
  const prevLE = rev(Buffer.from(job.prevhash, 'hex'));
  const header = Buffer.alloc(80);
  header.writeUInt32LE(parseInt(job.version, 16), 0);
  prevLE.copy(header, 4);
  rev(merkleRootRaw).copy(header, 36);
  header.writeUInt32LE(parseInt(job.ntime, 16), 68);
  header.writeUInt32LE(parseInt(job.nbits, 16), 72);
  header.writeUInt32LE(nonce >>> 0, 76);
  return header;
}

function buildMerkleRoot(job, stratum) {
  const coinbase = Buffer.from(job.coinb1 + stratum.extranonce1 + stratum.extranonce2 + job.coinb2, 'hex');
  let root = sha256d(coinbase);
  for (const b of job.merkle_branch || []) {
    root = sha256d(Buffer.concat([root, Buffer.from(b, 'hex')]));
  }
  return root;
}

let currentJob = null;

function startWork(jobParams) {
  const job = {
    job_id: jobParams[0],
    prevhash: jobParams[1],
    coinb1: jobParams[2],
    coinb2: jobParams[3],
    merkle_branch: jobParams[4],
    version: jobParams[5],
    nbits: jobParams[6],
    ntime: jobParams[7],
    clean_jobs: jobParams[8],
  };
  currentJob = job;

  const merkleRootRaw = buildMerkleRoot(job, stratum);
  const header = buildHeader(job, merkleRootRaw, 0);
  const target = stratum.target || engine.compactToTarget(parseInt(job.nbits, 16));

  console.log('JOB: ' + job.job_id + ' empfangen, baue Header/Work...');

  stopWork();
  for (let i = 0; i < THREADS; i++) {
    const w = new Worker(path.join(__dirname, 'worker.js'));
    const sab = new SharedArrayBuffer(4);
    w._cancel = sab;
    w.on('message', (m) => {
      if (m.hs) totalHs += m.hs;
      if (m.share) submitShare(job, m.share);
    });
    w.on('error', (e) => console.log('X Worker-Fehler: ' + e.message));
    w.postMessage({ cmd: 'work', headerHex: header.toString('hex'), targetHex: target.toString('hex'), start: i, step: THREADS, cancel: sab });
    workers.push(w);
  }
}

function stopWork() {
  workers.forEach((w) => {
    if (w._cancel) { try { Atomics.store(new Int32Array(w._cancel), 0, 1); } catch (_) {} }
  });
  workers = [];
}

function submitShare(job, nonce) {
  stratum.submit(job.job_id, stratum.extranonce2, job.ntime, nonce.toString(16).padStart(8, '0'));
}

const rateTimer = setInterval(() => {
  const speed10 = Math.round((totalHs - last10) / 5);
  last10 = totalHs;
  if (speed10 > 0) console.log('RATE: ' + speed10 + ' H/s');
}, 5000);
rateTimer.unref();

const stratum = new Stratum({
  wallet: WALLET,
  worker: WORKER,
  onLog: (l) => console.log(l),
  onDiff: (d) => { stratum.target = engine.difficultyToTarget(d); },
  onJob: (params) => startWork(params),
  onResult: (ok, err) => {
    pendingCount++;
    if (ok) {
      accepted++;
      console.log('accepted (' + accepted + '/' + rejected + ') (' + (Date.now() - start) + ' ms) + 0.000 H/s');
    } else {
      rejected++;
      console.log('rejected (' + rejected + ') (' + (err || '') + ')');
    }
  },
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown() {
  stopWork();
  if (stratum) stratum.close();
  process.exit(0);
}

if (!POOL) {
  console.log('FEHLER: Kein Pool angegeben (--pool).');
  shutdown();
} else {
  stratum.connect(POOL);
}

setTimeout(() => {
  if (!currentJob) console.log('WARTE: noch kein Job vom Pool... Prüfe Wallet/Pool-URL.');
}, 5000);
setTimeout(shutdown, 600000);