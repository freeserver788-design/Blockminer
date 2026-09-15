'use strict';
const { parentPort } = require('worker_threads');
const engine = require('./engine');

let cancel = null;

parentPort.on('message', (m) => {
  if (m.cmd === 'work') {
    cancel = m.cancel || null;
    const target = Buffer.from(m.targetHex, 'hex');
    engine.mine(Buffer.from(m.headerHex, 'hex'), target, m.start, m.step, {
      onHs: (hs) => parentPort.postMessage({ hs }),
      onShare: (nonce) => parentPort.postMessage({ share: nonce }),
    }, cancel);
    parentPort.postMessage({ done: true });
  }
  if (m.cmd === 'stop') {
    process.exit(0);
  }
});