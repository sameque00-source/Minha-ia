const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths } = require('../config');
const { redact } = require('../security/redact');

// Missão da MinhaIA ("job"): o pedido do usuário + o ciclo de vida do worker que roda o motor.
// O estado detalhado (plano, tarefas, resultados) é o do motor, persistido por ele em
// data/missions/<engineMissionId>/MISSION_STATE.json.

function jobsDir() {
  return process.env.MINHAIA_JOBS_DIR ? path.resolve(process.env.MINHAIA_JOBS_DIR) : path.join(paths.DATA_DIR, 'jobs');
}

const ID_RE = /^mia_[a-z0-9]{8,40}$/;

function validId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function jobPath(id, file = 'job.json') {
  if (!validId(id)) throw new Error(`id de missão inválido: ${id}`);
  return path.join(jobsDir(), id, file);
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function create(objective) {
  const id = `mia_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  const job = {
    id,
    objective: redact(objective),
    status: 'CRIADA',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    engineMissionId: null,
    engineState: null,
    reason: null,
    pid: null,
  };
  save(job);
  return job;
}

function save(job) {
  writeAtomic(jobPath(job.id), JSON.stringify(job, null, 2));
  return job;
}

function get(id) {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')); } catch { return null; }
}

function update(id, patch) {
  const job = get(id);
  if (!job) return null;
  return save({ ...job, ...patch });
}

function list() {
  const dir = jobsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(validId).map(get).filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Evento sempre redigido antes de gravar: nada de segredo em disco nem no stream. */
function appendEvent(id, event) {
  const line = redact(JSON.stringify(event));
  fs.mkdirSync(path.dirname(jobPath(id, 'events.jsonl')), { recursive: true });
  fs.appendFileSync(jobPath(id, 'events.jsonl'), `${line}\n`);
  return JSON.parse(line);
}

function readEvents(id, { afterSeq = 0, types = null, limit = 5000 } = {}) {
  let raw;
  try { raw = fs.readFileSync(jobPath(id, 'events.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of raw.split('\n')) {
    if (!l) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e.seq <= afterSeq) continue;
    if (types && !types.includes(e.type)) continue;
    out.push(e);
  }
  return out.slice(-limit);
}

module.exports = { create, get, save, update, list, appendEvent, readEvents, validId, jobsDir };
