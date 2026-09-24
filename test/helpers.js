const fs = require('fs');
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
  createRuntimeLinks(undefined, { dataRoot: tmp });
  return {
    dir: tmp,
    restore() {
      createRuntimeLinks();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

module.exports = { MASTER, SKIP_NO_MASTER, masterStatus, isolateRuntime };
