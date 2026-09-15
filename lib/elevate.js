const { spawn } = require('child_process');
const path = require('path');
const { app } = require('electron');

function relaunchAsAdmin() {
  const proj = path.join(__dirname, '..');
  const script =
    "Start-Process -FilePath '" + process.execPath +
    "' -ArgumentList '" + proj.replace(/'/g, "''") +
    "' -WorkingDirectory '" + proj.replace(/'/g, "''") +
    "' -Verb RunAs";
  spawn('powershell.exe', ['-NoProfile', '-Command', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
  setTimeout(() => app.exit(0), 600);
}

module.exports = { relaunchAsAdmin };