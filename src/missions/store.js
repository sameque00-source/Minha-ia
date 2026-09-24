const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths } = require('../config');
const { redact, redactDeep } = require('../security/redact');

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

/** Evento redigido valor a valor ANTES de serializar: nada de segredo em disco nem no stream. */
function appendEvent(id, event) {
  const safe = redactDeep(event);
  const file = jobPath(id, 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(safe)}\n`);
  return safe;
}

// Cache incremental por missão: relê só os bytes acrescentados desde a última leitura.
const eventCache = new Map(); // id -> { size, events, partial: Buffer }

function allEvents(id) {
  const file = jobPath(id, 'events.jsonl');
  let st;
  try { st = fs.statSync(file); } catch { eventCache.delete(id); return []; }
  let c = eventCache.get(id);
  if (!c || st.size < c.size) c = { size: 0, events: [], partial: Buffer.alloc(0) };
  if (st.size > c.size) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.size);
      fs.readSync(fd, buf, 0, buf.length, c.size);
      // só decodifica até o último \n: nunca parte um caractere UTF-8 multibyte ao meio
      const all = Buffer.concat([c.partial, buf]);
      const cut = all.lastIndexOf(0x0a) + 1;
      c.partial = all.subarray(cut);
      for (const l of all.subarray(0, cut).toString('utf8').split('\n')) {
        if (!l) continue;
        try { c.events.push(JSON.parse(l)); } catch { /* linha corrompida é ignorada */ }
      }
      c.size = st.size;
    } finally {
      fs.closeSync(fd);
    }
  }
  eventCache.set(id, c);
  return c.events;
}

function readEvents(id, { afterSeq = 0, types = null, limit = Infinity } = {}) {
  const out = allEvents(id).filter((e) => e.seq > afterSeq && (!types || types.includes(e.type)));
  return Number.isFinite(limit) ? out.slice(-limit) : out;
}

module.exports = { create, get, save, update, list, appendEvent, readEvents, validId, jobsDir };
