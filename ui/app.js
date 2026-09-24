'use strict';
// MinhaIA — Web UI. Sem framework; todo dado do motor/LLM entra como texto (nunca HTML).

const $ = (sel) => document.querySelector(sel);

/** Cria elemento: h('div', {class:'x', onclick: fn}, 'texto', outroEl) */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function svg(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const chip = (text, kind = '', title) => h('span', { class: `chip ${kind}`, title }, text);
const fmtMs = (ms) => (ms === null || ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '');

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const STATUS_KIND = {
  CRIADA: 'info', NA_FILA: 'info', EXECUTANDO: 'info', CANCELANDO: 'warn', CONCLUIDA: 'ok',
  FALHA: 'err', BLOQUEADA: 'warn', CANCELADA: 'warn', TEMPO_ESGOTADO: 'err', INTERROMPIDA: 'warn',
};
const RUNNING = new Set(['NA_FILA', 'EXECUTANDO', 'CANCELANDO']);
const RESUMABLE = new Set(['CANCELADA', 'TEMPO_ESGOTADO', 'INTERROMPIDA']);

const state = {
  system: null,
  missions: [],
  currentId: null,
  detail: null,
  events: [],
  es: null,
  tab: 'conversa',
  files: [],
};

// ------------------------------------------------------------------ sistema
async function loadSystem() {
  const el = $('#system');
  try {
    const s = await api('/api/system');
    state.system = s;
    el.replaceChildren(
      chip(s.master.ok ? 'MASTER íntegro' : `Integridade: ${s.master.problems.length} problema(s)`, s.master.ok ? 'ok' : 'err', s.master.ok ? `HEAD ${String(s.master.head).slice(0, 12)} · ${s.master.files} arquivos verificados` : s.master.problems.join(' | ')),
      chip(`${s.agents} agentes`, 'info'),
      chip(`${s.skills} Skills`, 'info'),
      s.providers.configured.length
        ? chip(`LLM: ${s.providers.configured.join(', ')}`, 'ok')
        : chip('Sem provedor de LLM — missões reais bloqueadas', 'err', 'Grave uma chave (GROQ_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY ou NINEROUTER_API_KEY) em .secrets/.env e recarregue'),
    );
  } catch (e) {
    el.replaceChildren(chip(`API indisponível: ${e.message}`, 'err'));
  }
}

// ------------------------------------------------------------------ lista de missões
async function loadMissions() {
  state.missions = await api('/api/missions');
  renderMissionList();
}
const refreshMissions = debounce(() => loadMissions().catch(() => {}), 400);

function renderMissionList() {
  const ul = $('#missions');
  if (!state.missions.length) { ul.replaceChildren(h('li', { class: 'muted' }, 'nenhuma missão ainda')); return; }
  ul.replaceChildren(...state.missions.map((m) => h('li', {},
    h('button', { type: 'button', 'aria-current': m.id === state.currentId ? 'true' : 'false', onclick: () => selectMission(m.id), 'data-id': m.id },
      h('span', { class: 'obj' }, m.objective),
      h('span', {}, chip(m.status, STATUS_KIND[m.status] || ''), ' ', h('span', { class: 'hint' }, fmtTime(m.createdAt)))))));
}

// ------------------------------------------------------------------ nova missão
$('#new-mission').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('#form-error');
  err.hidden = true;
  const objective = $('#objective').value.trim();
  if (!objective) return;
  $('#send').disabled = true;
  try {
    const job = await api('/api/missions', { method: 'POST', body: JSON.stringify({ objective }) });
    $('#objective').value = '';
    await loadMissions();
    selectMission(job.id);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    $('#send').disabled = false;
  }
});

// ------------------------------------------------------------------ missão selecionada
async function selectMission(id) {
  if (state.es) state.es.close();
  state.currentId = id;
  state.events = [];
  state.files = [];
  $('#file-view').textContent = 'selecione um arquivo';
  renderMissionList();
  $('#empty').hidden = true;
  $('#mission').hidden = false;
  await refreshDetail();
  const es = new EventSource(`/api/missions/${encodeURIComponent(id)}/events`);
  state.es = es;
  es.addEventListener('mission', (msg) => {
    if (state.currentId !== id) return;
    const e = JSON.parse(msg.data);
    if (state.events.length && e.seq <= state.events[state.events.length - 1].seq) return;
    state.events.push(e);
    onMissionEvent(e);
  });
}

function onMissionEvent(e) {
  if (['state', 'plan', 'analysis', 'blocked', 'finished', 'started', 'queued', 'cancel_requested', 'result', 'phase'].includes(e.type)) refreshDetailSoon();
  if (e.type === 'tool' || e.type === 'finished') refreshFilesSoon();
  if (['created', 'finished', 'started'].includes(e.type)) refreshMissions();
  renderEventViewsSoon();
}

async function refreshDetail() {
  if (!state.currentId) return;
  try {
    state.detail = await api(`/api/missions/${encodeURIComponent(state.currentId)}`);
    renderDetail();
  } catch (e) {
    $('#m-banner').className = 'banner err';
    $('#m-banner').textContent = e.message;
    $('#m-banner').hidden = false;
  }
}
const refreshDetailSoon = debounce(refreshDetail, 300);
const renderEventViewsSoon = debounce(() => renderTab(state.tab), 150);

function renderDetail() {
  const d = state.detail;
  const { job, mission } = d;
  $('#m-objective').textContent = job.objective;
  $('#m-meta').replaceChildren(
    chip(job.status, STATUS_KIND[job.status] || ''),
    mission ? chip(`motor: ${mission.estado}`, 'info', 'estado da máquina de estados do Orquestrador do MASTER') : null,
    d.analysis ? chip(`nível ${d.analysis.classification.level} · esforço ${d.analysis.classification.effort}`, '') : null,
    d.testStub ? chip('TEST-STUB (não é LLM real)', 'warn') : null,
    chip(`criada ${fmtTime(job.createdAt)}`, ''),
    job.engineMissionId ? chip(job.engineMissionId, '', 'id da missão no motor') : null,
  );
  $('#m-progress').style.width = `${Math.round(((mission && mission.progresso) || (job.status === 'CONCLUIDA' ? 1 : 0)) * 100)}%`;

  const cancel = $('#btn-cancel');
  cancel.disabled = !RUNNING.has(job.status) || job.status === 'CANCELANDO';
  const resume = $('#btn-resume');
  resume.disabled = !(RESUMABLE.has(job.status) && job.engineMissionId);

  const banner = $('#m-banner');
  banner.hidden = true;
  if (d.blocked) {
    banner.className = 'banner warn';
    banner.textContent = `Missão bloqueada: ${d.blocked}. Grave uma chave de provedor em .secrets/.env (fora do navegador) e crie a missão de novo.`;
    banner.hidden = false;
  } else if (['FALHA', 'TEMPO_ESGOTADO', 'INTERROMPIDA'].includes(job.status) && job.reason) {
    banner.className = 'banner err';
    banner.textContent = job.reason;
    banner.hidden = false;
  } else if (d.testStub) {
    banner.className = 'banner info';
    banner.textContent = 'Esta missão rodou com o dublê de teste de LLM (TEST-STUB). O pipeline é real; as respostas do modelo não são.';
    banner.hidden = false;
  }
  renderTab(state.tab);
}

$('#btn-cancel').addEventListener('click', async () => {
  $('#btn-cancel').disabled = true;
  try { await api(`/api/missions/${encodeURIComponent(state.currentId)}/cancel`, { method: 'POST', body: '{}' }); } catch (e) { alert(e.message); }
  refreshDetail();
});
$('#btn-resume').addEventListener('click', async () => {
  $('#btn-resume').disabled = true;
  try { await api(`/api/missions/${encodeURIComponent(state.currentId)}/resume`, { method: 'POST', body: '{}' }); } catch (e) { alert(e.message); }
  refreshDetail();
});

// ------------------------------------------------------------------ abas
for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('.tabs button'))) {
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    for (const x of document.querySelectorAll('.tabs button')) x.setAttribute('aria-selected', String(x === b));
    for (const t of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.tab'))) t.hidden = t.id !== `tab-${state.tab}`;
    renderTab(state.tab);
  });
}

function renderTab(tab) {
  if (!state.detail) return;
  const fn = { conversa: renderConversation, plano: renderPlan, grafo: renderGraph, agentes: renderAgents, execucao: renderExecution, arquivos: renderFiles, testes: renderTests, logs: renderLogs }[tab];
  if (fn) fn();
}

// ---- Conversa: narrativa gerada a partir dos eventos reais
function renderConversation() {
  const items = [];
  const taskStatus = {};
  const say = (who, text, ts, kind = '') => items.push(h('div', { class: `msg ${kind}` }, h('div', { class: 'who' }, h('span', {}, who), h('span', {}, fmtTime(ts))), h('p', {}, text)));
  for (const e of state.events) {
    switch (e.type) {
      case 'created': say('Você', e.objective, e.ts, 'user'); break;
      case 'analysis': {
        const s = e.selection;
        say('Orquestrador · análise', `Nível ${s.classification.level} (${s.classification.effort}). Agentes sugeridos: ${s.agents.map((a) => a.id).join(', ') || 'nenhum'}. Skills candidatas: ${s.skills.map((x) => x.id).join(', ') || 'nenhuma'}. Governança: reviewer=${s.governance.reviewerRequired}, security=${s.governance.securityRequired}.`, e.ts);
        break;
      }
      case 'blocked': say('Orquestrador', `Bloqueada: ${e.reason}`, e.ts); break;
      case 'phase': say('Orquestrador', e.message || e.phase, e.ts); break;
      case 'plan': {
        const n = ((state.detail.mission && state.detail.mission.subtarefas) || []).length;
        if (e.plan) say('Planejador', `${e.plan.interpretacao || ''}${n ? `\n${n} tarefa(s) no grafo` : ''}`, e.ts);
        break;
      }
      case 'state':
        for (const t of e.mission.subtarefas || []) {
          if (taskStatus[t.id] !== t.status && ['em_progresso', 'concluida', 'erro', 'cancelada'].includes(t.status)) {
            say(`Agente ${t.agente || '—'}`, `${t.status === 'em_progresso' ? 'Iniciou' : t.status === 'concluida' ? 'Concluiu' : 'Falhou em'}: ${t.descricao}${t.skills && t.skills.length ? `\nSkills: ${t.skills.join(', ')}` : ''}${t.resultado && t.resultado.erros && t.resultado.erros.length ? `\nErro: ${t.resultado.erros[0]}` : ''}`, e.ts);
          }
          taskStatus[t.id] = t.status;
        }
        break;
      case 'repair.fix': say('Auto-Repair', `Tentativa ${e.tentativa} falhou (${e.categoria}). Estratégia: ${e.estrategia} — ${e.motivo || ''}`, e.ts); break;
      case 'finished': say('MinhaIA', `Missão finalizada: ${e.status}${e.reason ? ` — ${e.reason}` : ''}`, e.ts); break;
      default:
    }
  }
  $('#tab-conversa').replaceChildren(h('div', { class: 'timeline' }, items.length ? items : h('p', { class: 'muted' }, 'aguardando eventos…')));
}

// ---- Plano
function list(title, arr) {
  return h('div', { class: 'section' }, h('h3', {}, title), arr && arr.length ? h('ul', {}, arr.map((x) => h('li', {}, typeof x === 'string' ? x : JSON.stringify(x)))) : h('p', { class: 'muted' }, '—'));
}
function renderPlan() {
  const { analysis, plan } = state.detail;
  const parts = [];
  if (analysis) {
    parts.push(h('div', { class: 'section' }, h('h3', {}, 'Análise (determinística, antes do LLM)'),
      h('p', {}, `Nível ${analysis.classification.level} · esforço ${analysis.classification.effort} · modalidade ${analysis.classification.modality.join(', ')}`),
      h('p', {}, `Modelo previsto: ${analysis.model.chosen || '—'} (${analysis.model.tipoTarefa}); chaves configuradas na cadeia: ${analysis.model.fallback.filter((m) => m.keyConfigured).length}/${analysis.model.fallback.length}`)));
  }
  if (plan) {
    parts.push(h('div', { class: 'section' }, h('h3', {}, 'Interpretação do Planejador'), h('p', {}, plan.interpretacao || '—')));
    parts.push(h('div', { class: 'grid2' }, list('Requisitos', plan.requisitos), list('Entregáveis', plan.entregaveis), list('Restrições', plan.restricoes), list('Riscos', plan.riscos), list('Critérios de sucesso', plan.criteriosSucessoGeral)));
  } else {
    parts.push(h('p', { class: 'muted' }, state.detail.blocked ? 'Sem plano: missão bloqueada antes do Planejador.' : 'O plano aparece quando o Planejador terminar.'));
  }
  $('#tab-plano').replaceChildren(...parts);
}

// ---- Task Graph (camadas por dependência)
function renderGraph() {
  const tasks = (state.detail.mission && state.detail.mission.subtarefas) || [];
  const root = $('#tab-grafo');
  if (!tasks.length) { root.replaceChildren(h('p', { class: 'muted' }, 'O grafo aparece depois do planejamento.')); return; }
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const layer = {};
  const depth = (t, seen = new Set()) => {
    if (layer[t.id] !== undefined) return layer[t.id];
    if (seen.has(t.id)) return 0;
    seen.add(t.id);
    const deps = (t.dependeDe || []).filter((d) => byId[d]);
    layer[t.id] = deps.length ? 1 + Math.max(...deps.map((d) => depth(byId[d], seen))) : 0;
    return layer[t.id];
  };
  tasks.forEach((t) => depth(t));
  const cols = {};
  for (const t of tasks) (cols[layer[t.id]] = cols[layer[t.id]] || []).push(t);
  const W = 230, H = 74, GX = 60, GY = 18, PAD = 16;
  const pos = {};
  let maxRows = 0;
  for (const [c, ts] of Object.entries(cols)) {
    ts.forEach((t, r) => { pos[t.id] = { x: PAD + Number(c) * (W + GX), y: PAD + r * (H + GY) }; });
    maxRows = Math.max(maxRows, ts.length);
  }
  const width = PAD * 2 + Object.keys(cols).length * (W + GX) - GX;
  const height = PAD * 2 + maxRows * (H + GY) - GY;
  const g = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Grafo de tarefas' });
  g.append(svg('defs', {}, svg('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'currentColor' }))));
  for (const t of tasks) for (const d of t.dependeDe || []) {
    if (!pos[d]) continue;
    const a = pos[d], b = pos[t.id];
    g.append(svg('path', { class: 'edge', d: `M${a.x + W},${a.y + H / 2} C${a.x + W + GX / 2},${a.y + H / 2} ${b.x - GX / 2},${b.y + H / 2} ${b.x},${b.y + H / 2}`, 'marker-end': 'url(#arrow)' }));
  }
  for (const t of tasks) {
    const p = pos[t.id];
    const desc = t.descricao.length > 34 ? `${t.descricao.slice(0, 33)}…` : t.descricao;
    const node = svg('g', { class: `node st-${t.status}`, transform: `translate(${p.x},${p.y})` },
      svg('title', {}, `${t.descricao}\nstatus: ${t.status}\nagente: ${t.agente || '—'}\nSkills: ${(t.skills || []).join(', ') || '—'}`),
      svg('rect', { width: W, height: H, rx: 8 }),
      svg('text', { x: 10, y: 20 }, `${t.tipo} · ${t.status}`),
      svg('text', { x: 10, y: 40 }, desc),
      svg('text', { x: 10, y: 60, class: 'sub' }, `${t.agente || '—'}${t.skills && t.skills.length ? ` · ${t.skills.length} Skill(s)` : ''}${t.tentativas ? ` · ${t.tentativas} tent.` : ''}`));
    g.append(node);
  }
  root.replaceChildren(
    h('div', { class: 'legend' }, chip('pendente'), chip('em_progresso', 'info'), chip('concluida', 'ok'), chip('bloqueada', 'warn'), chip('erro/cancelada', 'err')),
    h('div', { class: 'graph-wrap' }, g));
}

// ---- Agentes & Skills
async function renderAgents() {
  const id = state.currentId;
  const root = $('#tab-agentes');
  const [agents, skills] = await Promise.all([api(`/api/missions/${encodeURIComponent(id)}/agents`), api(`/api/missions/${encodeURIComponent(id)}/skills`)]).catch(() => [null, null]);
  if (state.currentId !== id || state.tab !== 'agentes') return;
  if (!agents) { root.replaceChildren(h('p', { class: 'muted' }, 'indisponível')); return; }
  root.replaceChildren(
    h('div', { class: 'section' }, h('h3', {}, 'Agentes sugeridos na análise'),
      agents.suggested.length ? h('table', {}, h('tr', {}, h('th', {}, 'Agente'), h('th', {}, 'Por quê'), h('th', {}, 'Veto')),
        agents.suggested.map((a) => h('tr', {}, h('td', {}, a.id), h('td', {}, a.reasons.join('; ')), h('td', {}, a.veto ? 'sim' : '—')))) : h('p', { class: 'muted' }, 'nenhum (nível 0 ou bloqueada)')),
    h('div', { class: 'section' }, h('h3', {}, 'Agentes que executaram tarefas'),
      agents.used.length ? h('table', {}, h('tr', {}, h('th', {}, 'Agente'), h('th', {}, 'Tarefas'), h('th', {}, 'Veto')),
        agents.used.map((a) => h('tr', {}, h('td', {}, a.id), h('td', {}, a.tasks.map((t) => `${t.tipo}:${t.status}`).join(', ')), h('td', {}, a.veto ? 'sim' : '—')))) : h('p', { class: 'muted' }, 'nenhum ainda')),
    h('div', { class: 'section' }, h('h3', {}, 'Skills carregadas por tarefa (injetadas no contexto do agente)'),
      skills.perTask.length ? h('table', {}, h('tr', {}, h('th', {}, 'Tarefa'), h('th', {}, 'Agente'), h('th', {}, 'Skill · motivo'), h('th', {}, 'Tools / dependências'), h('th', {}, 'Resultado')),
        skills.perTask.map((p) => h('tr', {},
          h('td', {}, p.tarefaId),
          h('td', {}, p.agente || '—'),
          h('td', {}, p.skills.length ? p.skills.map((s) => h('div', {}, h('b', {}, s.id), ` — ${s.motivo}${s.linhasRemovidas ? ` (${s.linhasRemovidas} linha(s) de serviço indisponível removidas)` : ''}`)) : 'nenhuma relevante',
            p.descartadas.length ? h('div', { class: 'hint' }, `descartadas: ${p.descartadas.map((x) => `${x.id} (${x.motivo})`).join('; ')}`) : null),
          h('td', {}, p.skills.map((s) => h('div', {}, `${s.tools}${s.requires.length ? ` · menciona: ${s.requires.join(', ')}` : ''}`))),
          h('td', {}, p.resultadoTarefa || '—')))) : h('p', { class: 'muted' }, 'nenhuma Skill carregada ainda')),
    h('div', { class: 'section' }, h('h3', {}, 'Skills candidatas para a missão (análise)'),
      skills.suggestedForMission.length ? h('ul', {}, skills.suggestedForMission.map((s) => h('li', {}, `${s.id} — ${s.matched.join(', ')}`))) : h('p', { class: 'muted' }, '—')));
}

// ---- Execução: modelo/provider, ferramentas (terminal), auto-repair
function renderExecution() {
  const ev = state.events.filter((e) => ['sandbox', 'llm.end', 'llm.attempt', 'tool', 'repair.evaluate', 'repair.fix', 'repair.end'].includes(e.type));
  const items = ev.map((e) => {
    if (e.type === 'llm.end') return h('div', { class: 'exec-item' }, h('div', { class: 'row' }, chip('LLM', e.ok ? 'ok' : 'err'), h('b', {}, e.model || '—'), chip(e.provider || '—'), chip(fmtMs(e.ms)), e.error ? h('span', { class: 'hint' }, e.error) : null, h('span', { class: 'hint' }, fmtTime(e.ts))));
    if (e.type === 'sandbox') return h('div', { class: 'exec-item' }, h('div', { class: 'row' }, chip(e.allowed ? (e.sandboxed ? 'sandbox: node confinado ao workspace' : 'SEM sandbox (opt-in)') : 'sandbox: bloqueado', e.allowed ? (e.sandboxed ? 'ok' : 'err') : 'warn'), h('code', {}, e.comando)), e.motivo ? h('p', { class: 'hint' }, e.motivo) : null);
    if (e.type === 'llm.attempt') return h('div', { class: 'exec-item' }, h('div', { class: 'row' }, chip('tentativa', e.ok ? 'ok' : 'err'), `${e.model} · ${e.provider}`, e.fallback ? chip('fallback', 'warn') : null, chip(fmtMs(e.ms)), e.agente ? chip(`agente ${e.agente}`) : null));
    if (e.type === 'tool') {
      const cmd = e.arg && (e.arg.comando || e.arg.caminho);
      return h('div', { class: 'exec-item' }, h('div', { class: 'row' }, chip(e.tool, e.ok ? 'ok' : 'err'), h('code', {}, cmd || ''), e.exitCode !== undefined && e.exitCode !== null ? chip(`exit ${e.exitCode}`) : null, chip(fmtMs(e.ms))),
        e.stdout || e.stderr || e.error ? h('pre', { class: 'terminal' }, [e.stdout, e.stderr, e.error].filter(Boolean).join('\n')) : null);
    }
    if (e.type === 'repair.evaluate') return h('div', { class: 'exec-item' }, h('div', { class: 'row' }, chip('auto-repair: avaliação', e.sucesso ? 'ok' : 'err'), `tentativa ${e.tentativa}`), e.erro ? h('pre', { class: 'terminal' }, e.erro) : null);
    if (e.type === 'repair.fix') return h('div', { class: 'exec-item' }, h('div', { class: 'row' }, chip('auto-repair: correção', 'warn'), `${e.categoria} → ${e.estrategia}`), h('p', { class: 'hint' }, e.motivo || ''));
    return h('div', { class: 'exec-item' }, h('div', { class: 'row' }, chip('auto-repair: fim', e.status === 'SUCESSO_VALIDADO' ? 'ok' : 'err'), `${e.status} em ${e.tentativas} tentativa(s)`, e.motivo ? h('span', { class: 'hint' }, e.motivo) : null));
  });
  $('#tab-execucao').replaceChildren(h('div', { class: 'exec' }, items.length ? items : h('p', { class: 'muted' }, 'nenhuma chamada de modelo ou ferramenta ainda')));
}

// ---- Arquivos do workspace da missão
async function loadFiles() {
  if (!state.currentId) return;
  state.files = await api(`/api/missions/${encodeURIComponent(state.currentId)}/files`).catch(() => []);
  if (state.tab === 'arquivos') renderFiles();
}
const refreshFilesSoon = debounce(loadFiles, 500);
function renderFiles() {
  const ul = $('#file-list');
  if (!state.files.length) { ul.replaceChildren(h('li', { class: 'muted' }, 'nenhum arquivo no workspace')); loadFilesOnce(); return; }
  ul.replaceChildren(...state.files.map((f) => h('li', {}, h('button', { type: 'button', onclick: () => openFile(f.path), title: `${f.bytes} bytes · ${f.modifiedAt}` }, f.path))));
}
let filesLoadedFor = null;
function loadFilesOnce() {
  if (filesLoadedFor === state.currentId) return;
  filesLoadedFor = state.currentId;
  loadFiles();
}
async function openFile(p) {
  const view = $('#file-view');
  view.textContent = 'carregando…';
  try {
    const f = await api(`/api/missions/${encodeURIComponent(state.currentId)}/files?path=${encodeURIComponent(p)}`);
    view.textContent = f.binary ? `(arquivo binário, ${f.bytes} bytes)` : f.content;
  } catch (e) {
    view.textContent = e.message;
  }
}

// ---- Testes & Revisão
function renderTests() {
  const m = state.detail.mission;
  const root = $('#tab-testes');
  if (!m) { root.replaceChildren(h('p', { class: 'muted' }, 'sem estado do motor ainda')); return; }
  const reviews = (m.subtarefas || []).filter((t) => ['revisao', 'qa', 'security', 'teste'].includes(t.tipo));
  const result = [...state.events].reverse().find((e) => e.type === 'result');
  root.replaceChildren(
    h('div', { class: 'section' }, h('h3', {}, 'Testes'), (m.testes || []).length ? h('table', {}, h('tr', {}, h('th', {}, 'O quê'), h('th', {}, 'Resultado'), h('th', {}, 'Evidência')), m.testes.map((t) => h('tr', {}, h('td', {}, t.oQue || ''), h('td', {}, t.resultado || ''), h('td', {}, t.evidencia || '')))) : h('p', { class: 'muted' }, 'nenhum teste registrado')),
    h('div', { class: 'section' }, h('h3', {}, 'Revisão / QA / Security (agentes com veto)'), reviews.length ? h('table', {}, h('tr', {}, h('th', {}, 'Tipo'), h('th', {}, 'Agente'), h('th', {}, 'Status'), h('th', {}, 'Resultado')), reviews.map((t) => h('tr', {}, h('td', {}, t.tipo), h('td', {}, t.agente || '—'), h('td', {}, t.status), h('td', {}, t.resultado ? (t.resultado.resultado || (t.resultado.erros || []).join('; ')) : '—')))) : h('p', { class: 'muted' }, 'nenhuma tarefa de revisão no plano')),
    h('div', { class: 'section' }, h('h3', {}, 'Erros'), (m.erros || []).length ? h('ul', {}, m.erros.map((e) => h('li', {}, `${e.subtarefaId || ''} ${e.tipo || ''}: ${e.erro}`))) : h('p', { class: 'muted' }, 'nenhum')),
    h('div', { class: 'section' }, h('h3', {}, 'Correções'), (m.correcoes || []).length ? h('ul', {}, m.correcoes.map((c) => h('li', {}, `${c.diagnostico || ''} → ${c.correcao || ''} (${c.resultado || ''})`))) : h('p', { class: 'muted' }, 'nenhuma')),
    h('div', { class: 'section' }, h('h3', {}, 'Resultado final'), m.estadoFinal ? h('p', {}, `${m.estadoFinal.sucesso ? 'Sucesso' : 'Falha'}: ${m.estadoFinal.motivo || ''}`) : h('p', { class: 'muted' }, 'ainda não finalizada'), result ? h('p', { class: 'hint' }, `estado do motor: ${result.estado}`) : null));
}

// ---- Logs
function renderLogs() {
  const sel = $('#log-type');
  const types = [...new Set(state.events.map((e) => e.type))].sort();
  const current = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'todos'), ...types.map((t) => h('option', { value: t }, t)));
  sel.value = types.includes(current) ? current : '';
  const rows = state.events.filter((e) => !sel.value || e.type === sel.value).slice(-500);
  $('#log-list').replaceChildren(...rows.map((e) => {
    const { seq, ts, type, jobId: _jobId, ...rest } = e;
    return h('div', { class: 'log-line' }, h('span', { class: 't' }, `#${seq} ${fmtTime(ts)} ${type} `), JSON.stringify(rest).slice(0, 1200));
  }));
}
$('#log-type').addEventListener('change', renderLogs);

// ------------------------------------------------------------------ observabilidade
async function loadObservability() {
  let o;
  try { o = await api('/api/observability'); } catch { return; }
  const block = (title, children) => h('div', { class: 'obs-block' }, h('h4', {}, title), children && children.length ? children : h('div', { class: 'muted' }, '—'));
  const row = (k, v, title) => h('div', { class: 'obs-row', title }, h('span', { class: 'k' }, k), h('span', {}, v));
  $('#obs').replaceChildren(
    block('Em execução', o.running.map((r) => row(r.task ? `${r.task.agente || '—'} · ${r.task.descricao}` : r.id, r.phase || '—', r.task && r.task.skills ? `Skills: ${r.task.skills.join(', ')}` : ''))),
    block('Provedores (tentativas registradas)', o.providers.map((p) => row(p.provider, `${p.ok}/${p.attempts} ok · ${fmtMs(p.avgMs)} · ${p.fallbacks} fallback`))),
    block('Cooldown (circuit breaker)', o.cooldowns.map((c) => row(c.model, `${c.erro} · ${Math.ceil(c.restanteMs / 1000)} s`))),
    block('Últimas chamadas de LLM', o.llmCalls.slice(-8).reverse().map((c) => row(`${c.model || '—'} (${c.provider || '—'})`, `${c.ok ? 'ok' : 'erro'} · ${fmtMs(c.ms)}`, c.error || ''))),
    block('Ferramentas', o.tools.slice(-8).reverse().map((t) => row(`${t.tool} ${(t.arg && (t.arg.comando || t.arg.caminho)) || ''}`, `${t.ok ? 'ok' : 'erro'} · ${fmtMs(t.ms)}`))),
    block('Auto-Repair', o.repairs.slice(-6).reverse().map((r) => row(r.type.replace('repair.', ''), r.status || r.estrategia || (r.sucesso ? 'sucesso' : 'falha')))),
    block('Erros / bloqueios', o.errors.slice(-6).reverse().map((e) => row(e.type, (e.message || e.reason || '').slice(0, 60), e.message || e.reason))),
  );
}
const refreshObsSoon = debounce(loadObservability, 800);

function openGlobalStream() {
  const live = $('#live');
  const es = new EventSource('/api/stream');
  es.onopen = () => { live.className = 'live'; live.textContent = '● ao vivo'; };
  es.onerror = () => { live.className = 'live off'; live.textContent = '○ reconectando'; };
  es.addEventListener('mission', (msg) => {
    const e = JSON.parse(msg.data);
    refreshObsSoon();
    if (e.jobId !== state.currentId && ['created', 'finished', 'started', 'blocked'].includes(e.type)) refreshMissions();
  });
}

// ------------------------------------------------------------------ início
(async function init() {
  await loadSystem();
  await loadMissions().catch(() => {});
  await loadObservability();
  openGlobalStream();
  setInterval(loadObservability, 15000); // só para a contagem de cooldown; o resto é por evento
  if (state.missions[0]) selectMission(state.missions[0].id);
})();
