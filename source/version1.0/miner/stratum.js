'use strict';

const net = require('net');

class Stratum {
  constructor(opts) {
    this.wallet = opts.wallet || '';
    this.worker = opts.worker || 'rig1';
    this.onLog = opts.onLog || (() => {});
    this.onJob = opts.onJob || (() => {});
    this.onDiff = opts.onDiff || (() => {});
    this.onAuth = opts.onAuth || (() => {});
    this.onResult = opts.onResult || (() => {});

    this.sock = null;
    this.buf = '';
    this.idc = 0;
    this.extranonce1 = null;
    this.extranonce2 = Buffer.alloc(2, 0).toString('hex');
    this.subDone = false;
    this.authDone = false;
  }

  connect(url) {
    const m = String(url).match(/^stratum(?:\+tcp)?:\/\/([^:/]+)(?::(\d+))?/i)
      || String(url).match(/^([^:/]+)(?::(\d+))?$/);
    if (!m) { this.onLog('FEHLER: Ungültige Pool-URL: ' + url); return; }
    const host = m[1];
    const port = parseInt(m[2] || '3333', 10);

    this.sock = net.connect(port, host, () => {
      this.onLog('POOL: verbunden mit ' + host + ':' + port);
      this.send('mining.subscribe', ['blockmine/1.0'], ++this.idc);
    });
    this.sock.on('data', (d) => this._data(d));
    this.sock.on('error', (e) => this.onLog('POOL-FEHLER: ' + e.message));
    this.sock.on('close', () => this.onLog('POOL: Verbindung geschlossen.'));
  }

  _data(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this._line(line);
    }
  }

  _line(line) {
    let o;
    try { o = JSON.parse(line); } catch (_) { return; }

    if (o.id === 1 && o.result) {
      this.extranonce1 = o.result[1];
      this.subDone = true;
      this.send('mining.authorize', [this.wallet, this.worker], ++this.idc);
    }
    if (o.id === 2) {
      this.authDone = true;
      if (o.error) this.onLog('AUTH: abgelehnt (' + JSON.stringify(o.error) + ')');
      else { this.onLog('AUTH: verbunden als ' + this.wallet); this.onAuth(); }
    }
    if (o.method === 'mining.set_difficulty') {
      const d = parseFloat(o.params[0]);
      this.onLog('DIFF: Pool-Schwierigkeit ' + d);
      if (this.onDiff) this.onDiff(d);
    }
    if (o.method === 'mining.notify') {
      if (this.onJob) this.onJob(o.params);
    }
    if (o.id != null && o.id > 2 && 'result' in o) {
      this.onResult(o.result === true, o.error ? JSON.stringify(o.error) : null);
    }
  }

  send(method, params, id) {
    const frame = { id: id != null ? id : null, method, params };
    this.sock.write(JSON.stringify(frame) + '\n');
  }

  submit(jobId, extranonce2, ntime, nonce) {
    this.send('mining.submit', [this.wallet, jobId, extranonce2, ntime, nonce], ++this.idc);
  }

  close() {
    if (this.sock) { try { this.sock.destroy(); } catch (_) {} }
  }
}

module.exports = { Stratum };