const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeNodeArgs } = require('../src/missions/instrument');
const { workerEnv } = require('../src/missions/manager');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'minhaia-ws-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'minhaia-out-')));
fs.writeFileSync(path.join(ws, 'soma.js'), 'console.log(5)');
fs.writeFileSync(path.join(outside, 'x.js'), 'console.log(1)');
fs.symlinkSync(path.join(outside, 'x.js'), path.join(ws, 'link.js'));
test.after(() => { fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

// Regressão do achado crítico da revisão de segurança: opções do node que escapam da sandbox.
for (const args of [['--run', 'x'], ['--report-directory=/tmp', '--report-uncaught-exception', 'soma.js'], ['--redirect-warnings=/tmp/w', 'soma.js'], ['--cpu-prof-dir=/tmp', 'soma.js'], ['--env-file=.env', 'soma.js'], ['-r', 'x.js'], ['--import', 'x.mjs', 'soma.js'], ['--inspect', 'soma.js'], ['--allow-fs-write=*', 'soma.js'], ['-'], []]) {
  test(`sandbox recusa node ${JSON.stringify(args)}`, () => assert.ok(sanitizeNodeArgs(args, ws).denied));
}

test('sandbox recusa script fora do workspace, inclusive via symlink', () => {
  assert.ok(sanitizeNodeArgs([path.join(outside, 'x.js')], ws).denied);
  assert.ok(sanitizeNodeArgs(['../x.js'], ws).denied);
  assert.ok(sanitizeNodeArgs(['link.js'], ws).denied);
  assert.ok(sanitizeNodeArgs(['nao-existe.js'], ws).denied);
});

test('sandbox aceita script do workspace e -e; argumentos após o script são do script', () => {
  assert.deepStrictEqual(sanitizeNodeArgs(['soma.js', '--run', 'x'], ws).args, [path.join(ws, 'soma.js'), '--run', 'x']);
  assert.deepStrictEqual(sanitizeNodeArgs(['-e', 'console.log(1)'], ws).args, ['-e', 'console.log(1)']);
});

test('worker recebe só variáveis permitidas (nada de tokens do shell)', () => {
  const saved = { ...process.env };
  process.env.GITHUB_TOKEN = 'x'.repeat(20);
  process.env.AWS_SECRET_ACCESS_KEY = 'y'.repeat(20);
  process.env.MINHAIA_X = '1';
  try {
    const env = workerEnv();
    assert.strictEqual(env.GITHUB_TOKEN, undefined);
    assert.strictEqual(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.strictEqual(env.MINHAIA_X, '1');
    assert.ok(env.PATH);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  }
});
