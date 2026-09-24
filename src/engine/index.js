const fs = require('fs');
const path = require('path');
const { paths } = require('../config');
const { select } = require('../selection/selector');

const PROVIDER_KEYS = ['GROQ_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'NINEROUTER_API_KEY'];

function engine(rel) {
  const f = path.join(paths.ENGINE_DIR, rel);
  if (!fs.existsSync(f)) throw new Error(`motor do MASTER não sincronizado (${rel}) — rode \`minhaia sync\``);
  return require(f);
}

/** Nomes das chaves de provedor configuradas em .secrets/.env (nunca os valores). */
function providerStatus() {
  const configured = new Set();
  if (fs.existsSync(paths.SECRETS_ENV)) {
    for (const line of fs.readFileSync(paths.SECRETS_ENV, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
      if (m && PROVIDER_KEYS.includes(m[1])) configured.add(m[1]);
    }
  }
  return { secretsFile: fs.existsSync(paths.SECRETS_ENV), configured: [...configured], missing: PROVIDER_KEYS.filter((k) => !configured.has(k)) };
}

/**
 * Executa uma missão real ponta a ponta com o motor do MASTER:
 * seleção → Planejador (LLM) → grafo de tarefas → Executor com especialistas
 * (QA/Security com veto, autocorreção) → TESTANDO → REVISANDO → estado terminal.
 * Sem chave de provedor, não finge execução: retorna BLOQUEADO.
 */
async function runMission(objective, { log = () => {} } = {}) {
  const selection = select(objective);
  const providers = providerStatus();
  if (providers.configured.length === 0) {
    return {
      status: 'BLOQUEADO',
      reason: `nenhuma chave de provedor em ${path.relative(paths.ROOT, paths.SECRETS_ENV)} (${PROVIDER_KEYS.join(', ')}) — o Planejador precisa de LLM real`,
      selection,
    };
  }
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

async function resumeMission(missionId) {
  const { Executor } = engine('executor/executor.js');
  return new Executor().executarMissaoCompleta(missionId);
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
