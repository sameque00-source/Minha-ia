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

const STUB = path.join(__dirname, 'fixtures', 'stub-adapters.js');

/**
 * Sobe a API em processo, com estado (jobs + runtime do motor) isolado em tmp.
 * `stub: true` liga o dublê de LLM de teste (NODE_ENV=test) nos workers.
 */
async function startApi({ stub = false, env = {} } = {}) {
  const rt = isolateRuntime();
  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('MINHAIA_JOBS_DIR', path.join(rt.dir, 'jobs'));
  if (stub) { set('NODE_ENV', 'test'); set('MINHAIA_TEST_ADAPTERS', STUB); set('MINHAIA_TEST_PROMPT_LOG', path.join(rt.dir, 'prompts.jsonl')); }
  for (const [k, v] of Object.entries(env)) set(k, v);
  const { createServer } = require('../src/server');
  const { MissionManager } = require('../src/missions/manager');
  const manager = new MissionManager();
  const { server } = createServer({ manager });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, manager, dir: rt.dir, promptLog: path.join(rt.dir, 'prompts.jsonl'),
    async close() {
      manager.shutdown();
      await new Promise((r) => server.close(r));
      server.closeAllConnections && server.closeAllConnections();
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rt.restore();
    },
  };
}

async function req(base, method, p, { body, headers = {} } = {}) {
  const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* não-JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}

/** Espera o evento `finished` da missão (via assinatura do gerenciador). */
function waitFinished(manager, id, timeoutMs = 60000) {
  const { TERMINAL } = require('../src/missions/manager');
  const job = require('../src/missions/store').get(id);
  if (job && TERMINAL.has(job.status) && !manager.running.has(id)) return Promise.resolve({ type: 'finished', status: job.status });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { off(); reject(new Error(`missão ${id} não terminou em ${timeoutMs} ms`)); }, timeoutMs);
    const off = manager.subscribe((jobId, e) => { if (jobId === id && e.type === 'finished') { clearTimeout(t); off(); resolve(e); } });
  });
}

/** Espera um evento do tipo; `after` = só eventos com seq maior (considera os já gravados). */
function waitEvent(manager, id, type, timeoutMs = 30000, after = 0) {
  const past = require('../src/missions/store').readEvents(id, { afterSeq: after, types: [type] });
  if (past.length) return Promise.resolve(past[0]);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { off(); reject(new Error(`evento ${type} não chegou`)); }, timeoutMs);
    const off = manager.subscribe((jobId, e) => { if (jobId === id && e.type === type && e.seq > after) { clearTimeout(t); off(); resolve(e); } });
  });
}

module.exports = { MASTER, SKIP_NO_MASTER, masterStatus, isolateRuntime, freePort, startApi, req, waitFinished, waitEvent, STUB };
