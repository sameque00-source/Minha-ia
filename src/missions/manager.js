const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const store = require('./store');
const { paths } = require('../config');

const WORKER = path.join(__dirname, 'worker.js');
const TERMINAL = new Set(['CONCLUIDA', 'FALHA', 'BLOQUEADA', 'CANCELADA', 'TEMPO_ESGOTADO', 'INTERROMPIDA']);
const RESUMABLE = new Set(['CANCELADA', 'TEMPO_ESGOTADO', 'INTERROMPIDA']);
const ACTIVE = new Set(['NA_FILA', 'EXECUTANDO', 'CANCELANDO']);

// O worker (e o código gerado pelo LLM que ele executa) recebe só estas variáveis: nada de
// tokens ou chaves exportados no shell do usuário. Chaves de provedor vêm de .secrets/.env.
const ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'NODE_ENV',
  'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
]);

/** @returns {NodeJS.ProcessEnv} */
function workerEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!(ENV_ALLOW.has(k) || k.startsWith('MINHAIA_'))) continue;
    // proxy com usuário:senha na URL não chega ao worker (nem ao código gerado)
    env[k] = /proxy$/i.test(k) && v ? v.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1') : v;
  }
  return env;
}

/** Vivo = existe e não é zumbi (zumbi já morreu, só não foi recolhido pelo pai). */
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch { return true; } // sem /proc (não-Linux): só o sinal 0 disponível
}

/** Instante de início do processo (campo 22 de /proc/<pid>/stat) — distingue PID reaproveitado. */
function procStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null;
  } catch { return null; }
}

/** Mesmo processo de antes? Sem /proc (não-Linux) só o PID pode ser comparado. */
function sameProcess(pid, start) {
  if (!alive(pid)) return false;
  if (!start) return true;
  return procStart(pid) === start;
}

/** Mata o grupo de processos do worker (worker + tudo que o motor criou: node do LLM, servidores). */
function killGroup(child, signal) {
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* já saiu */ }
  }
}

function engineMissionState(engineMissionId) {
  if (!engineMissionId || !/^missao_[A-Za-z0-9_-]+$/.test(engineMissionId)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.ENGINE_DIR, 'orquestrador', 'missions', engineMissionId, 'MISSION_STATE.json'), 'utf8')).estado;
  } catch { return null; }
}

const err = (status, message) => Object.assign(new Error(message), { status });

class MissionManager {
  constructor({
    maxConcurrent = Number(process.env.MINHAIA_MAX_CONCURRENT || 2),
    maxPending = Number(process.env.MINHAIA_MAX_PENDING || 20),
    timeoutMs = Number(process.env.MINHAIA_MISSION_TIMEOUT_MS || 30 * 60 * 1000),
  } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxPending = maxPending;
    this.timeoutMs = timeoutMs;
    this.ownerId = crypto.randomBytes(6).toString('hex');
    this.running = new Map(); // id -> entry
    this.queue = [];
    this.subscribers = new Set();
    this.seq = new Map();
    this.recoverInterrupted();
  }

  owner() {
    return { pid: process.pid, id: this.ownerId, start: procStart(process.pid) };
  }

  // Jobs ativos de um gerenciador que não existe mais viram INTERROMPIDA e o grupo de processos
  // que sobrou é encerrado. Identidade = PID + instante de início (PID reaproveitado não conta).
  // Jobs de outro gerenciador vivo (ex.: CLI e servidor juntos, ou outro gerenciador neste mesmo
  // processo) são deixados em paz: o dono vivo é o mesmo processo (PID + início) de quando gravou.
  recoverInterrupted() {
    for (const job of store.list()) {
      if (!ACTIVE.has(job.status)) continue;
      const o = job.owner;
      if (o && o.id !== this.ownerId && sameProcess(o.pid, o.start)) continue;
      this.killStaleGroup(job);
      store.update(job.id, { status: 'INTERROMPIDA', finishedAt: new Date().toISOString(), reason: 'o processo que executava a missão terminou (servidor reiniciado ou CLI encerrada)', pid: null });
      this.safeRecord(job.id, 'finished', { status: 'INTERROMPIDA', reason: 'processo dono terminou' });
    }
  }

  /**
   * Encerra o grupo que sobrou de um worker antigo. Se o líder (worker) morreu, nenhum processo
   * novo pode ter PGID igual ao PID dele enquanto restarem membros do grupo; se o PID está vivo,
   * só mata se for o MESMO processo (instante de início igual) — nunca um PID reaproveitado.
   */
  killStaleGroup(job) {
    if (!job.pid || process.platform === 'win32') return;
    if (alive(job.pid) && !(job.workerStart && procStart(job.pid) === job.workerStart)) return;
    try { process.kill(-job.pid, 'SIGKILL'); } catch { /* grupo já não existe */ }
  }

  /** Encerramento imediato (2º Ctrl+C / morte da CLI): SIGKILL em todos os grupos. */
  killAll() {
    for (const [id, entry] of this.running) {
      entry.killed = true; // o exit que chegar depois não reescreve o status nem duplica 'finished'
      clearTimeout(entry.timer);
      clearTimeout(entry.killTimer);
      killGroup(entry.child, 'SIGKILL');
      this.running.delete(id);
      store.update(id, { status: 'INTERROMPIDA', finishedAt: new Date().toISOString(), reason: 'encerrado à força', pid: null });
      this.safeRecord(id, 'finished', { status: 'INTERROMPIDA', reason: 'encerrado à força' });
    }
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  nextSeq(id) {
    if (!this.seq.has(id)) {
      const last = store.readEvents(id).pop();
      this.seq.set(id, last ? last.seq : 0);
    }
    const n = this.seq.get(id) + 1;
    this.seq.set(id, n);
    return n;
  }

  record(id, type, data = {}) {
    const event = store.appendEvent(id, { ...data, type, seq: this.nextSeq(id), ts: data.ts || new Date().toISOString(), jobId: id });
    for (const fn of this.subscribers) {
      try { fn(id, event); } catch { /* assinante nunca derruba o gerenciador */ }
    }
    return event;
  }

  /** Versão que nunca lança: usada em handlers de eventos de processo filho. */
  safeRecord(id, type, data) {
    try { return this.record(id, type, data); } catch (e) {
      process.stderr.write(`[minhaia] falha ao registrar evento ${type} da missão ${id}: ${e.message}\n`);
      return null;
    }
  }

  pendingCount() {
    return this.queue.length + this.running.size;
  }

  create(objective, { start = true } = {}) {
    const text = String(objective || '').trim();
    if (!text) throw err(400, 'objetivo vazio');
    if (text.length > 4000) throw err(400, 'objetivo acima de 4000 caracteres');
    if (start && this.pendingCount() >= this.maxPending) throw err(429, `limite de ${this.maxPending} missões na fila/em execução atingido`);
    const job = store.create(text);
    this.record(job.id, 'created', { objective: job.objective });
    if (start) this.start(job.id);
    return store.get(job.id);
  }

  start(id, { resume = false } = {}) {
    const job = store.get(id);
    if (!job) throw err(404, 'missão não encontrada');
    if (this.running.has(id) || this.queue.some((q) => q.id === id)) throw err(409, 'missão já está em execução ou na fila');
    if (ACTIVE.has(job.status)) throw err(409, `missão ${job.status} em outro processo (pid ${job.owner ? job.owner.pid : '?'})`);
    if (resume) {
      if (!RESUMABLE.has(job.status)) throw err(409, `não é possível retomar missão em ${job.status}`);
      if (!job.engineMissionId) throw err(409, 'missão parou antes de ter estado no motor (antes do plano): use iniciar');
      const st = engineMissionState(job.engineMissionId);
      if (!st || ['CONCLUIDA', 'FALHA', 'BLOQUEADA'].includes(st)) throw err(409, `estado do motor não permite retomar (${st || 'ausente'})`);
    } else if (!(job.status === 'CRIADA' || (RESUMABLE.has(job.status) && !job.engineMissionId))) {
      throw err(409, `missão já iniciada (${job.status}); use retomar`);
    }
    if (this.pendingCount() >= this.maxPending) throw err(429, `limite de ${this.maxPending} missões na fila/em execução atingido`);
    store.update(id, { status: 'NA_FILA', reason: null, owner: this.owner() });
    this.record(id, 'queued', { resume });
    this.queue.push({ id, resume });
    this.pump();
    return store.get(id);
  }

  pump() {
    while (this.running.size < this.maxConcurrent && this.queue.length) {
      const { id, resume } = this.queue.shift();
      this.launch(id, resume);
    }
  }

  launch(id, resume) {
    const job = store.get(id);
    // processo em grupo próprio: cancelar/timeout encerra também os filhos criados pelo motor
    const child = fork(WORKER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: workerEnv(), detached: process.platform !== 'win32' });
    const entry = { child, timer: null, killTimer: null, finalStatus: null, reason: null, done: false, killed: false };
    this.running.set(id, entry);
    let finished = false;
    const finish = (status, patch = {}, fromDone = false) => {
      if (finished || entry.killed) return;
      finished = true;
      clearTimeout(entry.timer);
      clearTimeout(entry.killTimer);
      killGroup(child, 'SIGKILL'); // nada do grupo sobrevive ao fim da missão
      this.running.delete(id);
      // conclusão real reportada pelo worker prevalece sobre um cancelamento que chegou depois
      const finalStatus = fromDone && status === 'CONCLUIDA' ? status : (entry.finalStatus || status);
      const reason = entry.reason || patch.reason || null;
      store.update(id, { status: finalStatus, finishedAt: new Date().toISOString(), pid: null, ...patch, reason });
      this.safeRecord(id, 'finished', { status: finalStatus, reason });
      this.pump();
    };
    store.update(id, { status: 'EXECUTANDO', startedAt: job.startedAt || new Date().toISOString(), finishedAt: null, pid: child.pid, workerStart: procStart(child.pid), owner: this.owner() });
    this.record(id, 'started', { resume, pid: child.pid });

    child.on('message', (/** @type {any} */ msg) => {
      if (!msg || typeof msg !== 'object') return;
      try {
        if (msg.kind === 'event' && msg.event) {
          const { seq: _workerSeq, ...rest } = msg.event;
          const e = this.record(id, rest.type, rest);
          if (e.type === 'state' && e.mission) store.update(id, { engineMissionId: e.mission.id, engineState: e.mission.estado });
          if (e.type === 'plan' && e.missionId) store.update(id, { engineMissionId: e.missionId });
        } else if (msg.kind === 'done') {
          entry.done = true;
          const o = msg.outcome || {};
          const cur = store.get(id);
          finish(o.status || 'FALHA', { engineMissionId: o.engineMissionId || cur.engineMissionId, engineState: o.engineState || engineMissionState(o.engineMissionId || cur.engineMissionId) || cur.engineState, reason: o.reason || null }, true);
        }
      } catch (e) {
        process.stderr.write(`[minhaia] mensagem do worker descartada (${id}): ${e.message}\n`);
      }
    });
    const pipeLog = (stream, level) => stream.on('data', (d) => {
      const text = String(d).trim();
      if (text && !finished) this.safeRecord(id, 'log', { level, text: text.slice(0, 4000) });
    });
    pipeLog(child.stdout, 'stdout');
    pipeLog(child.stderr, 'stderr');
    // saída sem mensagem "done" nunca é sucesso
    child.on('exit', (code, signal) => finish('FALHA', { reason: `worker saiu sem concluir (code=${code}, signal=${signal})` }));
    child.on('error', (e) => finish('FALHA', { reason: e.message }));

    entry.timer = setTimeout(() => {
      this.safeRecord(id, 'timeout', { afterMs: this.timeoutMs });
      this.terminate(id, 'TEMPO_ESGOTADO', `tempo limite de ${Math.round(this.timeoutMs / 1000)} s esgotado`);
    }, this.timeoutMs);

    child.send({ kind: 'start', objective: job.objective, resumeEngineMissionId: resume ? job.engineMissionId : null });
  }

  terminate(id, finalStatus, reason) {
    const entry = this.running.get(id);
    if (!entry || entry.finalStatus) return;
    entry.finalStatus = finalStatus;
    entry.reason = reason;
    store.update(id, { status: 'CANCELANDO', reason });
    try { entry.child.send({ kind: 'stop', reason }); } catch { /* canal fechado */ }
    // primeiro só o worker: o motor para sem "ver" a morte dos comandos (estado fica retomável);
    // o grupo inteiro morre no fim da missão (finish) ou pelo prazo abaixo
    try { entry.child.kill('SIGTERM'); } catch { /* já saiu */ }
    entry.killTimer = setTimeout(() => killGroup(entry.child, 'SIGKILL'), 5000);
  }

  cancel(id) {
    const job = store.get(id);
    if (!job) throw err(404, 'missão não encontrada');
    const qi = this.queue.findIndex((q) => q.id === id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      store.update(id, { status: 'CANCELADA', finishedAt: new Date().toISOString(), reason: 'cancelada na fila' });
      this.record(id, 'finished', { status: 'CANCELADA', reason: 'cancelada na fila' });
      return store.get(id);
    }
    if (!this.running.has(id)) {
      if (ACTIVE.has(job.status)) throw err(409, `missão em execução por outro processo (pid ${job.owner ? job.owner.pid : '?'}): cancele por lá`);
      throw err(409, `missão não está em execução (${job.status})`);
    }
    this.record(id, 'cancel_requested', {});
    this.terminate(id, 'CANCELADA', 'cancelada pelo usuário');
    return store.get(id);
  }

  shutdown() {
    for (const q of this.queue.splice(0)) {
      store.update(q.id, { status: 'INTERROMPIDA', finishedAt: new Date().toISOString(), reason: 'servidor encerrado com a missão na fila' });
      this.safeRecord(q.id, 'finished', { status: 'INTERROMPIDA', reason: 'servidor encerrado com a missão na fila' });
    }
    for (const id of [...this.running.keys()]) this.terminate(id, 'INTERROMPIDA', 'servidor encerrado durante a execução');
  }
}

module.exports = { MissionManager, TERMINAL, RESUMABLE, workerEnv, procStart };
