const fs = require('fs');
const path = require('path');
const { paths, isInside } = require('../config');
const store = require('./store');
const registry = require('../registry');

const EXEC_TYPES = ['sandbox', 'tool', 'llm.start', 'llm.end', 'llm.attempt', 'repair.evaluate', 'repair.fix', 'repair.end'];
const MAX_FILE_BYTES = 256 * 1024;

function missionsRoot() {
  // link criado pelo sync (vendor/.../orquestrador/missions → data/missions); segue o link
  return path.join(paths.ENGINE_DIR, 'orquestrador', 'missions');
}

function engineState(job) {
  if (!job || !job.engineMissionId || !/^missao_[A-Za-z0-9_-]+$/.test(job.engineMissionId)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(missionsRoot(), job.engineMissionId, 'MISSION_STATE.json'), 'utf8')); } catch { return null; }
}

function lastOf(events, type) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === type) return events[i];
  return null;
}

/** Estado consolidado de uma missão: job + snapshot do motor (evento mais recente ou disco). */
function detail(id) {
  const job = store.get(id);
  if (!job) return null;
  const events = store.readEvents(id);
  const stateEv = lastOf(events, 'state');
  const persisted = engineState(job);
  const mission = stateEv ? stateEv.mission : persisted && {
    id: persisted.id, objetivo: persisted.objetivo, estado: persisted.estado, progresso: persisted.progresso,
    historicoEstados: persisted.historicoEstados, subtarefas: persisted.subtarefas, testes: persisted.testes,
    erros: persisted.erros, correcoes: persisted.correcoes, estadoFinal: persisted.estadoFinal,
  };
  const analysis = lastOf(events, 'analysis');
  const plan = lastOf(events, 'plan');
  const blocked = lastOf(events, 'blocked');
  const phase = lastOf(events, 'phase');
  return {
    job,
    mission: mission || null,
    analysis: analysis ? analysis.selection : null,
    plan: plan ? plan.plan : null,
    blocked: blocked ? blocked.reason : null,
    phase: phase ? phase.phase : null,
    lastSeq: events.length ? events[events.length - 1].seq : 0,
    testStub: events.some((e) => e.type === 'warning' && /MODO TESTE/.test(e.message || '')),
  };
}

function tasks(id) {
  const d = detail(id);
  return d && d.mission ? d.mission.subtarefas || [] : [];
}

function agents(id) {
  const d = detail(id);
  if (!d) return null;
  const all = Object.fromEntries(registry.loadAgents().map((a) => [a.id, a]));
  const used = {};
  for (const t of (d.mission && d.mission.subtarefas) || []) {
    if (!t.agente) continue;
    used[t.agente] = used[t.agente] || { id: t.agente, tasks: [], veto: all[t.agente] ? all[t.agente].veto : false, description: all[t.agente] ? all[t.agente].description : null };
    used[t.agente].tasks.push({ id: t.id, status: t.status, tipo: t.tipo });
  }
  return { suggested: d.analysis ? d.analysis.agents : [], used: Object.values(used) };
}

function skills(id) {
  const events = store.readEvents(id, { types: ['skills', 'analysis', 'state'] });
  const lastState = lastOf(events, 'state');
  const statusByTask = Object.fromEntries(((lastState && lastState.mission.subtarefas) || []).map((t) => [t.id, t.status]));
  const perTask = {};
  for (const e of events.filter((x) => x.type === 'skills')) perTask[e.tarefaId] = e; // último registro por tarefa
  const analysis = lastOf(events, 'analysis');
  return {
    suggestedForMission: analysis ? analysis.selection.skills : [],
    perTask: Object.values(perTask).map((e) => ({ tarefaId: e.tarefaId, agente: e.agente, skills: e.skills, descartadas: e.descartadas, resultadoTarefa: statusByTask[e.tarefaId] || null })),
  };
}

function execution(id, afterSeq = 0) {
  return store.readEvents(id, { afterSeq, types: EXEC_TYPES });
}

function logs(id, { afterSeq = 0, types = null } = {}) {
  return store.readEvents(id, { afterSeq, types });
}

function workspaceDir(job) {
  if (!job || !job.engineMissionId || !/^missao_[A-Za-z0-9_-]+$/.test(job.engineMissionId)) return null;
  return path.join(missionsRoot(), job.engineMissionId, 'workspace');
}

function files(id) {
  const dir = workspaceDir(store.get(id));
  if (!dir || !fs.existsSync(dir)) return [];
  const real = fs.realpathSync(dir);
  const out = [];
  (function walk(abs, rel) {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      if (out.length >= 500) return;
      if (ent.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(abs, ent.name), r);
      else if (ent.isFile()) { const st = fs.statSync(path.join(abs, ent.name)); out.push({ path: r, bytes: st.size, modifiedAt: st.mtime.toISOString() }); }
    }
  })(real, '');
  return out;
}

function fileContent(id, relPath) {
  const dir = workspaceDir(store.get(id));
  if (!dir || !fs.existsSync(dir) || typeof relPath !== 'string' || !relPath || relPath.includes('\0')) return { status: 404, error: 'arquivo não encontrado' };
  const root = fs.realpathSync(dir);
  const target = path.resolve(root, relPath);
  if (!isInside(target, root) || !fs.existsSync(target)) return { status: 404, error: 'arquivo não encontrado' };
  const real = fs.realpathSync(target);
  if (!isInside(real, root) || !fs.statSync(real).isFile()) return { status: 404, error: 'arquivo não encontrado' };
  const size = fs.statSync(real).size;
  if (size > MAX_FILE_BYTES) return { status: 413, error: `arquivo com ${size} bytes (limite ${MAX_FILE_BYTES})` };
  const buf = fs.readFileSync(real);
  const binary = buf.includes(0);
  return { status: 200, path: relPath, bytes: size, binary, content: binary ? null : buf.toString('utf8') };
}

function result(id) {
  const d = detail(id);
  if (!d) return null;
  const events = store.readEvents(id, { types: ['result', 'finished', 'blocked'] });
  return {
    status: d.job.status,
    reason: d.job.reason,
    blocked: d.blocked,
    engineState: d.mission ? d.mission.estado : null,
    estadoFinal: d.mission ? d.mission.estadoFinal : null,
    result: lastOf(events, 'result'),
    tests: d.mission ? d.mission.testes : [],
    errors: d.mission ? d.mission.erros : [],
    corrections: d.mission ? d.mission.correcoes : [],
    files: files(id),
  };
}

// ---------------------------------------------------------------- observabilidade
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function observability({ running = [] } = {}) {
  const jobs = store.list().slice(0, 15);
  const calls = [];
  const attempts = [];
  const repairs = [];
  const tools = [];
  const errors = [];
  for (const j of jobs) {
    for (const e of store.readEvents(j.id, { types: ['llm.end', 'llm.attempt', 'repair.fix', 'repair.end', 'tool', 'error', 'blocked'] })) {
      const row = { ...e, objective: j.objective.slice(0, 80) };
      if (e.type === 'llm.end') calls.push(row);
      else if (e.type === 'llm.attempt') attempts.push(row);
      else if (e.type.startsWith('repair')) repairs.push(row);
      else if (e.type === 'tool') tools.push(row);
      else errors.push(row);
    }
  }
  const byProvider = {};
  for (const a of attempts) {
    const p = byProvider[a.provider || '?'] = byProvider[a.provider || '?'] || { provider: a.provider || '?', attempts: 0, ok: 0, fallbacks: 0, totalMs: 0 };
    p.attempts += 1; if (a.ok) p.ok += 1; if (a.fallback) p.fallbacks += 1; p.totalMs += a.ms || 0;
  }
  const health = readJSON(path.join(paths.AIORCH_DIR, 'logs', 'health-state.json')) || {};
  const now = Date.now();
  const cooldowns = Object.entries(health).filter(([, h]) => h.cooldownAte > now).map(([model, h]) => ({ model, erro: h.ultimoErro, falhasSeguidas: h.falhasSeguidas, restanteMs: h.cooldownAte - now }));
  const tail = (arr, n) => arr.sort((a, b) => a.ts.localeCompare(b.ts)).slice(-n);
  return {
    generatedAt: new Date().toISOString(),
    running,
    missions: jobs.map((j) => ({ id: j.id, status: j.status, objective: j.objective.slice(0, 120), createdAt: j.createdAt, engineState: j.engineState })),
    providers: Object.values(byProvider).map((p) => ({ ...p, avgMs: p.attempts ? Math.round(p.totalMs / p.attempts) : null })),
    cooldowns,
    llmCalls: tail(calls, 40),
    repairs: tail(repairs, 40),
    tools: tail(tools, 40),
    errors: tail(errors, 40),
  };
}

module.exports = { detail, tasks, agents, skills, execution, logs, files, fileContent, result, observability, EXEC_TYPES };
