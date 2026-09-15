'use strict';

/*
 * Blockmine SHA-256d PoW-Engine (ECHTER Stratum-Mining).
 * Bekommt einen 80-Byte-Header + 32-Byte-Target und sucht
 * Nonces gegen das echte Pool-Target. Kein Overclocking.
 */
const crypto = require('crypto');

function sha256d(buf) {
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(buf).digest())
    .digest();
}

/* Compact-Bits (nbits) -> 32-Byte-Hash-Target (Big-Endian) */
function compactToTarget(bits) {
  const exponent = bits >> 24;
  const mantissa = bits & 0x7fffff;
  let big = BigInt(mantissa) << BigInt((exponent - 3) * 8);
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0 && big > 0n; i--) {
    out[i] = Number(big & 0xffn);
    big >>= 8n;
  }
  return out;
}

/* Ziel-Target aus einer Difficulty (BTC-Konvention) */
function difficultyToTarget(diff) {
  const max = 0x00000000ffff0000000000000000000000000000000000000000000000000000n;
  const d = BigInt(diff);
  let t = (max / d) * 0x10000n;
  let out = Buffer.alloc(32);
  for (let i = 31; i >= 0 && t > 0n; i--) {
    out[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  return out;
}

/*
 * Sucht Nonces: startet bei `nonceStart`, Schritt `step`.
 * cb.onHs(hs)  - Hashes zaehlen (throttle).
 * cb.onShare(nonce, hashHex) - Target getroffen.
 */
function mine(header, target, nonceStart, step, cb, cancel) {
  const h = Buffer.from(header); // 80 Bytes, nonce = 0
  let nonce = nonceStart >>> 0;
  let hs = 0;
  let n = 0;
  let t0 = Date.now();
  const cancelInt = cancel ? new Int32Array(cancel) : null;

  for (;;) {
    h.writeUInt32LE(nonce, 76);
    const d = sha256d(h);
    hs++;
    if (Buffer.compare(d, target) <= 0) {
      if (cb && cb.onShare) cb.onShare(nonce >>> 0, d.toString('hex'));
    }
    nonce = (nonce + step) >>> 0;
    if (++n >= 200000) {
      n = 0;
      if (cancelInt && Atomics.load(cancelInt, 0) === 1) break;
    }
    const now = Date.now();
    if (cb && cb.onHs && now - t0 >= 1000) {
      t0 = now;
      cb.onHs(hs);
      hs = 0;
    }
  }
}

module.exports = { sha256d, compactToTarget, difficultyToTarget, mine };