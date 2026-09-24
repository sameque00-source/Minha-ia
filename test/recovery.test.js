const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { SKIP_NO_MASTER, isolateRuntime, STUB } = require('./helpers');

const LINUX = process.platform === 'linux';
// zumbi (morto, ainda não recolhido pelo PID 1 do container) conta como morto — mesmo critério do produto
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2, s.lastIndexOf(')') + 3) !== 'Z'; } catch { return true; }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function withJobsDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minhaia-rec-'));
  const saved = process.env.MINHAIA_JOBS_DIR;
  process.env.MINHAIA_JOBS_DIR = dir;
  t.after(() => { if (saved === undefined) delete process.env.MINHAIA_JOBS_DIR; else process.env.MINHAIA_JOBS_DIR = saved; fs.rmSync(dir, { recursive: true, force: true }); });
  return require('../src/missions/store');
}

/** Líder de grupo detached com um filho no mesmo grupo (simula worker + código gerado). */
function spawnGroup() {
  const leader = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000);console.log(process.pid)'],{stdio:['ignore','inherit','ignore']});setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve) => leader.stdout.once('data', (d) => resolve({ leader, childPid: Number(String(d).trim()) })));
}

test('recuperação: dono morto → INTERROMPIDA com evento finished', { skip: SKIP_NO_MASTER }, (t) => {
  const store = withJobsDir(t);
  const job = store.create('x');
  store.update(job.id, { status: 'EXECUTANDO', owner: { pid: 999999, id: 'morto', start: '1' }, pid: null });
  const { MissionManager } = require('../src/missions/manager');
  new MissionManager();
  assert.strictEqual(store.get(job.id).status, 'INTERROMPIDA');
  assert.ok(store.readEvents(job.id).some((e) => e.type === 'finished' && e.status === 'INTERROMPIDA'));
});

test('recuperação: dono vivo (mesmo processo) → missão intocada', { skip: SKIP_NO_MASTER || (!LINUX && 'usa /proc') }, async (t) => {
  const store = withJobsDir(t);
  const { MissionManager, procStart } = require('../src/missions/manager');
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  await wait(200);
  const job = store.create('x');
  store.update(job.id, { status: 'EXECUTANDO', owner: { pid: other.pid, id: 'outro', start: procStart(other.pid) } });
  new MissionManager();
  assert.strictEqual(store.get(job.id).status, 'EXECUTANDO');
});

test('recuperação: PID do dono reaproveitado (início diferente) → INTERROMPIDA', { skip: SKIP_NO_MASTER || (!LINUX && 'usa /proc') }, async (t) => {
  const store = withJobsDir(t);
  const { MissionManager } = require('../src/missions/manager');
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  await wait(200);
  const job = store.create('x');
  store.update(job.id, { status: 'EXECUTANDO', owner: { pid: other.pid, id: 'antigo', start: 'outro-instante' } });
  new MissionManager();
  assert.strictEqual(store.get(job.id).status, 'INTERROMPIDA');
  assert.ok(alive(other.pid), 'processo alheio com PID reaproveitado não pode ser morto');
});

test('recuperação: grupo órfão de worker morto é encerrado', { skip: SKIP_NO_MASTER || (!LINUX && 'grupos POSIX') }, async (t) => {
  const store = withJobsDir(t);
  const { MissionManager } = require('../src/missions/manager');
  const { leader, childPid } = await spawnGroup();
  t.after(() => { try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* já morto */ } });
  process.kill(leader.pid, 'SIGKILL'); // worker morreu; o filho (código gerado) ficou órfão
  await wait(200);
  assert.ok(alive(childPid));
  const job = store.create('x');
  store.update(job.id, { status: 'EXECUTANDO', owner: { pid: 999999, id: 'morto' }, pid: leader.pid, workerStart: 'qualquer' });
  new MissionManager();
  await wait(200);
  assert.ok(!alive(childPid), 'filho órfão do worker morto precisa ser encerrado');
});

test('recuperação: nunca mata grupo de PID reaproveitado (vivo, início diferente)', { skip: SKIP_NO_MASTER || (!LINUX && 'grupos POSIX') }, async (t) => {
  const store = withJobsDir(t);
  const { MissionManager } = require('../src/missions/manager');
  const { leader, childPid } = await spawnGroup();
  t.after(() => { try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* já morto */ } });
  const job = store.create('x');
  store.update(job.id, { status: 'EXECUTANDO', owner: { pid: 999999, id: 'morto' }, pid: leader.pid, workerStart: 'instante-antigo' });
  new MissionManager();
  await wait(200);
  assert.ok(alive(leader.pid) && alive(childPid), 'grupo alheio precisa continuar vivo');
});

test('processo dono morto abruptamente (SIGKILL) não deixa o código gerado órfão', { skip: SKIP_NO_MASTER || (!LINUX && 'usa /proc') }, async (t) => {
  const rt = isolateRuntime();
  const jobs = fs.mkdtempSync(path.join(os.tmpdir(), 'minhaia-owner-'));
  t.after(() => { rt.restore(); fs.rmSync(jobs, { recursive: true, force: true }); });
  const owner = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'run-manager.js')], {
    env: { ...process.env, NODE_ENV: 'test', MINHAIA_TEST_ADAPTERS: STUB, MINHAIA_TEST_STUB_SCENARIO: 'hang', MINHAIA_JOBS_DIR: jobs },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const ws = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('código gerado não começou')), 60000);
    let buf = '';
    owner.stdout.on('data', (d) => { buf += d; const m = buf.match(/SANDBOX (.+)\n/); if (m) { clearTimeout(to); resolve(m[1]); } });
  });
  await wait(700);
  const procs = () => fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(`${ws}/soma.js`); } catch { return false; } });
  assert.ok(procs().length >= 1, 'o código gerado deveria estar rodando');
  owner.kill('SIGKILL');
  await wait(1000);
  assert.deepStrictEqual(procs(), [], 'nada do grupo pode sobreviver à morte do processo dono');
});
