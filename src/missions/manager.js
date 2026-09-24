const path = require('path');
const { fork } = require('child_process');
const store = require('./store');

const WORKER = path.join(__dirname, 'worker.js');
const TERMINAL = new Set(['CONCLUIDA', 'FALHA', 'BLOQUEADA', 'CANCELADA', 'TEMPO_ESGOTADO', 'INTERROMPIDA']);

class MissionManager {
  constructor({ maxConcurrent = Number(process.env.MINHAIA_MAX_CONCURRENT || 2), timeoutMs = Number(process.env.MINHAIA_MISSION_TIMEOUT_MS || 30 * 60 * 1000) } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.timeoutMs = timeoutMs;
    this.running = new Map(); // id -> { child, timer }
    this.queue = [];
    this.subscribers = new Set(); // fn(jobId, event)
    this.seq = new Map();
    this.recoverInterrupted();
  }

  // Missões marcadas como em execução cujo worker não existe mais (o servidor caiu). Um worker
  // vivo pertence a outro gerenciador (ex.: CLI e servidor ao mesmo tempo) e é deixado em paz.
  recoverInterrupted() {
    const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const job of store.list()) {
      if (['EXECUTANDO', 'NA_FILA', 'CANCELANDO'].includes(job.status) && !alive(job.pid)) {
        store.update(job.id, { status: 'INTERROMPIDA', finishedAt: new Date().toISOString(), reason: 'servidor reiniciado durante a execução', pid: null });
      }
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

  create(objective, { start = true } = {}) {
    const text = String(objective || '').trim();
    if (!text) throw Object.assign(new Error('objetivo vazio'), { status: 400 });
    if (text.length > 4000) throw Object.assign(new Error('objetivo acima de 4000 caracteres'), { status: 400 });
    const job = store.create(text);
    this.record(job.id, 'created', { objective: job.objective });
    if (start) this.start(job.id);
    return store.get(job.id);
  }

  start(id, { resume = false } = {}) {
    const job = store.get(id);
    if (!job) throw Object.assign(new Error('missão não encontrada'), { status: 404 });
    if (this.running.has(id) || this.queue.some((q) => q.id === id)) throw Object.assign(new Error('missão já está em execução ou na fila'), { status: 409 });
    if (resume) {
      if (!job.engineMissionId) throw Object.assign(new Error('missão ainda não tem estado no motor para retomar'), { status: 409 });
      if (!['FALHA', 'CANCELADA', 'TEMPO_ESGOTADO', 'INTERROMPIDA'].includes(job.status)) throw Object.assign(new Error(`não é possível retomar missão em ${job.status}`), { status: 409 });
    } else if (job.status !== 'CRIADA') {
      throw Object.assign(new Error(`missão já iniciada (${job.status}); use retomar`), { status: 409 });
    }
    store.update(id, { status: 'NA_FILA', reason: null });
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
    const child = fork(WORKER, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env });
    let finished = false;
    const finish = (status, patch = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(entry.timer);
      clearTimeout(entry.killTimer);
      this.running.delete(id);
      const finalStatus = entry.finalStatus || status;
      store.update(id, { status: finalStatus, finishedAt: new Date().toISOString(), pid: null, ...patch });
      this.record(id, 'finished', { status: finalStatus, ...patch });
      this.pump();
    };
    const entry = { child, timer: null, killTimer: null };
    this.running.set(id, entry);
    store.update(id, { status: 'EXECUTANDO', startedAt: job.startedAt || new Date().toISOString(), finishedAt: null, pid: child.pid });
    this.record(id, 'started', { resume, pid: child.pid });

    child.on('message', (/** @type {any} */ msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'event' && msg.event) {
        const { seq: _workerSeq, ...rest } = msg.event;
        const e = this.record(id, rest.type, rest);
        if (e.type === 'state' && e.mission) store.update(id, { engineMissionId: e.mission.id, engineState: e.mission.estado });
        if (e.type === 'plan' && e.missionId) store.update(id, { engineMissionId: e.missionId });
      } else if (msg.kind === 'done') {
        const o = msg.outcome || {};
        finish(o.status || 'FALHA', { engineMissionId: o.engineMissionId || store.get(id).engineMissionId, engineState: o.engineState || store.get(id).engineState, reason: o.reason || null });
      }
    });
    const pipeLog = (stream, level) => stream.on('data', (d) => {
      const text = String(d).trim();
      if (text) this.record(id, 'log', { level, text: text.slice(0, 4000) });
    });
    pipeLog(child.stdout, 'stdout');
    pipeLog(child.stderr, 'stderr');
    child.on('exit', (code, signal) => finish(code === 0 ? 'CONCLUIDA' : 'FALHA', { reason: `worker saiu (code=${code}, signal=${signal})` }));
    child.on('error', (e) => finish('FALHA', { reason: e.message }));

    entry.timer = setTimeout(() => {
      store.update(id, { status: 'CANCELANDO' });
      this.record(id, 'timeout', { afterMs: this.timeoutMs });
      this.terminate(id, 'TEMPO_ESGOTADO');
    }, this.timeoutMs);

    child.send({ kind: 'start', objective: job.objective, resumeEngineMissionId: resume ? job.engineMissionId : null });
  }

  terminate(id, finalStatus) {
    const entry = this.running.get(id);
    if (!entry) return;
    entry.finalStatus = finalStatus;
    entry.child.kill('SIGTERM');
    entry.killTimer = setTimeout(() => { if (!entry.child.killed || entry.child.exitCode === null) entry.child.kill('SIGKILL'); }, 5000);
  }

  cancel(id) {
    const job = store.get(id);
    if (!job) throw Object.assign(new Error('missão não encontrada'), { status: 404 });
    const qi = this.queue.findIndex((q) => q.id === id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      store.update(id, { status: 'CANCELADA', finishedAt: new Date().toISOString(), reason: 'cancelada na fila' });
      this.record(id, 'finished', { status: 'CANCELADA' });
      return store.get(id);
    }
    if (!this.running.has(id)) throw Object.assign(new Error(`missão não está em execução (${job.status})`), { status: 409 });
    store.update(id, { status: 'CANCELANDO', reason: 'cancelada pelo usuário' });
    this.record(id, 'cancel_requested', {});
    this.terminate(id, 'CANCELADA');
    return store.get(id);
  }

  shutdown() {
    for (const id of this.running.keys()) this.terminate(id, 'INTERROMPIDA');
  }
}

module.exports = { MissionManager, TERMINAL };
