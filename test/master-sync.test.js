const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { paths } = require('../src/config');
const { SKIP_NO_MASTER, masterStatus } = require('./helpers');

test('sync materializa o MASTER sem alterar nada nele', { skip: SKIP_NO_MASTER }, () => {
  const before = masterStatus();
  const lock = require('../src/master/sync').sync();
  const after = masterStatus();
  assert.strictEqual(after, before, 'git status do MASTER mudou durante o sync');
  assert.strictEqual(after, '', 'MASTER deveria estar limpo');
  assert.ok(lock.fileCount > 300, `poucos arquivos no lock: ${lock.fileCount}`);
  assert.match(lock.masterGitHead || '', /^[0-9a-f]{40}$/);
});

test('verify confirma MASTER intacto e cópias íntegras', { skip: SKIP_NO_MASTER }, () => {
  const r = require('../src/master/verify').verify();
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.masterDrift.length, 0);
  assert.strictEqual(r.vendorTampered.length, 0);
  assert.strictEqual(r.masterGit.clean, true);
});

test('todos os patches declarados foram aplicados e nenhum caminho Windows sobrou', { skip: SKIP_NO_MASTER }, () => {
  const lock = JSON.parse(fs.readFileSync(paths.LOCK_PATH, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(paths.MANIFEST_PATH, 'utf8'));
  assert.deepStrictEqual(lock.patches.map((p) => p.id).sort(), manifest.patches.map((p) => p.id).sort());
  const offenders = Object.keys(lock.files)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /C:\/Users\/Administrator|'C:', 'Users'/.test(fs.readFileSync(path.join(paths.ROOT, f), 'utf8')));
  assert.deepStrictEqual(offenders, []);
});

test('verify detecta cópia adulterada fora do sync', { skip: SKIP_NO_MASTER }, () => {
  const target = path.join(paths.CLAUDE_AGENTS_DIR, 'reviewer.md');
  const original = fs.readFileSync(target);
  try {
    fs.appendFileSync(target, '\n<!-- adulterado -->\n');
    const r = require('../src/master/verify').verify();
    assert.ok(r.vendorTampered.includes('.claude/agents/reviewer.md'));
    assert.strictEqual(r.ok, false);
  } finally {
    fs.writeFileSync(target, original);
  }
});

test('verify detecta arquivo intruso nos destinos gerados', { skip: SKIP_NO_MASTER }, () => {
  const intruder = path.join(paths.CLAUDE_AGENTS_DIR, 'intruso-teste.md');
  try {
    fs.writeFileSync(intruder, 'x');
    const r = require('../src/master/verify').verify();
    assert.ok(r.unexpectedLocal.includes('.claude/agents/intruso-teste.md'));
    assert.strictEqual(r.ok, false);
  } finally {
    fs.rmSync(intruder, { force: true });
  }
});

test('verify detecta link de runtime desviado', { skip: SKIP_NO_MASTER }, () => {
  const { isolateRuntime } = require('./helpers');
  const rt = isolateRuntime();
  try {
    const r = require('../src/master/verify').verify();
    assert.ok(r.badLinks.length > 0);
    assert.strictEqual(r.ok, false);
  } finally {
    rt.restore();
  }
  assert.strictEqual(require('../src/master/verify').verify().ok, true);
});

test('sync com patch inconsistente aborta sem tocar a instalação atual', { skip: SKIP_NO_MASTER }, () => {
  const original = fs.readFileSync(paths.MANIFEST_PATH, 'utf8');
  const lockBefore = fs.readFileSync(paths.LOCK_PATH, 'utf8');
  try {
    const m = JSON.parse(original);
    m.patches[0].expectCount = 999;
    fs.writeFileSync(paths.MANIFEST_PATH, JSON.stringify(m));
    assert.throws(() => require('../src/master/sync').sync(), /esperado 999/);
  } finally {
    fs.writeFileSync(paths.MANIFEST_PATH, original);
  }
  assert.strictEqual(fs.readFileSync(paths.LOCK_PATH, 'utf8'), lockBefore);
  assert.strictEqual(require('../src/master/verify').verify().ok, true);
  assert.ok(!fs.existsSync(path.join(paths.ROOT, '.sync-staging')));
});

test('estado de runtime é link para data/, nunca diretório dentro de vendor/', { skip: SKIP_NO_MASTER }, () => {
  const memDir = path.join(paths.ENGINE_DIR, 'memoria', 'dados');
  assert.ok(fs.lstatSync(memDir).isSymbolicLink());
  assert.strictEqual(fs.realpathSync(memDir), fs.realpathSync(path.join(paths.DATA_DIR, 'memoria')));
});
