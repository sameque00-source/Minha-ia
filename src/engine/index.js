const fs = require('fs');
const path = require('path');
const { paths, secretNames, PROVIDER_KEYS } = require('../config');
const { select } = require('../selection/selector');

function engine(rel) {
  const f = path.join(paths.ENGINE_DIR, rel);
  if (!fs.existsSync(f)) throw new Error(`motor do MASTER não sincronizado (${rel}) — rode \`minhaia sync\``);
  return require(f);
}

/** Nomes das chaves de provedor configuradas em .secrets/.env (nunca os valores). */
function providerStatus() {
  const names = secretNames();
  const configured = PROVIDER_KEYS.filter((k) => names.has(k));
  return { secretsFile: fs.existsSync(paths.SECRETS_ENV), configured, missing: PROVIDER_KEYS.filter((k) => !names.has(k)), gatewayKey: names.has('GATEWAY_API_KEY') };
}

function blockedWithoutProvider() {
  const providers = providerStatus();
  if (providers.configured.length > 0) return null;
  return `nenhuma chave de provedor em ${path.relative(paths.ROOT, paths.SECRETS_ENV)} (${PROVIDER_KEYS.join(', ')}) — o Planejador precisa de LLM real`;
}

/**
 * Executa uma missão real ponta a ponta com o motor do MASTER:
 * seleção → Planejador (LLM) → grafo de tarefas → Executor com especialistas
 * (QA/Security com veto, autocorreção) → TESTANDO → REVISANDO → estado terminal.
 * Sem chave de provedor, não finge execução: retorna BLOQUEADO.
 */
async function runMission(objective, { log = () => {} } = {}) {
  const selection = select(objective);
  const blocked = blockedWithoutProvider();
  if (blocked) return { status: 'BLOQUEADO', reason: blocked, selection };
  const { Executor } = engine('executor/executor.js');
  log(`[engine] nível ${selection.classification.level}; agentes sugeridos: ${selection.agents.map((a) => a.id).join(', ') || '(nenhum)'}`);
  const r = await new Executor().executarMissaoCompleta(objective);
  return {
    status: r.ok ? 'CONCLUIDA' : 'FALHA',
    missionId: r.missao ? r.missao.id : null,
    state: r.missao ? r.missao.estado : null,
    events: r.eventos,
    selection,
  };
}

/** Só retoma missão existente: o Executor trataria um texto qualquer como objetivo novo. */
async function resumeMission(missionId) {
  if (!/^missao_[A-Za-z0-9_-]+$/.test(String(missionId))) return { status: 'INVALIDO', reason: `id de missão inválido: "${missionId}" (esperado missao_...)` };
  if (!listMissions().some((m) => m.id === missionId)) return { status: 'INVALIDO', reason: `missão ${missionId} não encontrada em data/missions` };
  const blocked = blockedWithoutProvider();
  if (blocked) return { status: 'BLOQUEADO', reason: blocked, missionId };
  const { Executor } = engine('executor/executor.js');
  const r = await new Executor().executarMissaoCompleta(missionId);
  return { status: r.ok ? 'CONCLUIDA' : 'FALHA', missionId, state: r.missao ? r.missao.estado : null, events: r.eventos };
}

function listMissions() {
  const dir = path.join(paths.DATA_DIR, 'missions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((d) => d.startsWith('missao_')).map((id) => {
    const f = path.join(dir, id, 'MISSION_STATE.json');
    let estado = null;
    let objetivo = null;
    try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); estado = j.estado; objetivo = j.objetivo; } catch { /* sem estado persistido */ }
    return { id, estado, objetivo };
  });
}

module.exports = {
  runMission,
  resumeMission,
  listMissions,
  providerStatus,
  memory: () => engine('memoria/memoria.js'),
  autoRepair: () => engine('autocorrecao/autocorrecao.js'),
  research: () => engine('pesquisa/pesquisa.js'),
  llm: () => engine('planejador/core/chamar-llm.js'),
  router: () => engine('router/router.js'),
  specialists: () => engine('agentes/core/registro-especialistas.js'),
};
