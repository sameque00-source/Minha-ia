const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveMasterDir } = require('../src/config');
const { createRuntimeLinks } = require('../src/master/sync');

const MASTER = resolveMasterDir();
const SKIP_NO_MASTER = MASTER ? false : 'MASTER ausente (defina MINHAIA_MASTER_DIR) — NÃO VALIDADO';

function masterStatus() {
  return execFileSync('git', ['-C', MASTER, 'status', '--porcelain'], { encoding: 'utf8' });
}

/** Aponta os links de runtime (data/) para um diretório temporário; devolve função de restauração. */
function isolateRuntime() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minhaia-test-'));
  const restore = () => {
    for (const sig of ['SIGINT', 'SIGTERM']) process.removeListener(sig, onSignal);
    createRuntimeLinks();
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  function onSignal(sig) { restore(); process.kill(process.pid, sig); }
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, onSignal);
  createRuntimeLinks(undefined, { dataRoot: tmp });
  return { dir: tmp, restore };
}

/** Porta TCP livre em loopback. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

module.exports = { MASTER, SKIP_NO_MASTER, masterStatus, isolateRuntime, freePort };
