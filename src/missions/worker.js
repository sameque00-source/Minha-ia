// Processo filho que executa UMA missão no motor do MASTER (vendorizado). Isolar em processo
// (em grupo próprio) dá cancelamento real, timeout e falha contida.
const bus = require('../runtime/bus');
const { instrument } = require('./instrument');
const { select } = require('../selection/selector');
const { providerStatus } = require('../engine');

function testAdaptersFromEnv() {
  const mod = process.env.MINHAIA_TEST_ADAPTERS;
  if (!mod) return null;
  if (process.env.NODE_ENV !== 'test') throw new Error('MINHAIA_TEST_ADAPTERS só é aceito com NODE_ENV=test');
  return require(mod);
}

let engineMissionId = null;
let stopReason = 'interrompida';

/**
 * Retomada: o motor só executa tarefas "pendente". Tarefas que estavam "em_progresso" quando o
 * processo anterior foi encerrado voltam a "pendente" (pela persistência do próprio motor).
 */
function prepareResume(persistencia, missionId) {
  const m = persistencia.carregar(missionId);
  if (!m) throw new Error(`estado da missão ${missionId} não encontrado no motor`);
  const reset = [];
  for (const t of m.subtarefas || []) {
    if (t.status === 'em_progresso') { t.status = 'pendente'; reset.push(t.id); }
  }
  if (reset.length) persistencia.salvar(m);
  bus.emit('resume', { engineMissionId: missionId, estado: m.estado, tarefasReabertas: reset });
}

async function run({ objective, resumeEngineMissionId }) {
  const testAdapters = testAdaptersFromEnv();
  if (!resumeEngineMissionId) bus.emit('analysis', { selection: select(objective) });
  if (!testAdapters && providerStatus().configured.length === 0) {
    bus.emit('blocked', { reason: 'nenhuma chave de provedor em .secrets/.env (GROQ_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY, NINEROUTER_API_KEY) — o Planejador precisa de LLM real' });
    return { status: 'BLOQUEADA' };
  }

  bus.on((e) => {
    if (e.type === 'state' && e.mission) engineMissionId = e.mission.id;
    if (e.type === 'plan' && e.missionId) engineMissionId = e.missionId;
  });
  const { Executor, persistencia } = instrument({ testAdapters });
  if (resumeEngineMissionId) prepareResume(persistencia, resumeEngineMissionId);
  const executor = new Executor();
  bus.emit('phase', { phase: resumeEngineMissionId ? 'RETOMADA' : 'INICIO', message: resumeEngineMissionId ? `retomando ${resumeEngineMissionId}` : 'missão enviada ao Orquestrador' });

  const r = await executor.executarMissaoCompleta(resumeEngineMissionId || objective);
  const missao = r.missao;
  bus.emit('result', {
    ok: !!r.ok,
    engineMissionId: missao ? missao.id : engineMissionId,
    estado: missao ? missao.estado : null,
    estadoFinal: missao ? missao.estadoFinal : null,
    eventosMotor: r.eventos,
  });
  return { status: r.ok ? 'CONCLUIDA' : 'FALHA', engineMissionId: missao ? missao.id : engineMissionId, engineState: missao ? missao.estado : null };
}

if (require.main === module) {
  process.on('message', async (/** @type {any} */ msg) => {
    if (!msg) return;
    if (msg.kind === 'stop') { stopReason = String(msg.reason || stopReason); return; }
    if (msg.kind !== 'start') return;
    try {
      const outcome = await run(msg);
      process.send({ kind: 'done', outcome: { ...outcome, engineMissionId: outcome.engineMissionId || engineMissionId } }, () => process.exit(0));
    } catch (e) {
      bus.emit('error', { stage: 'worker', message: e.message });
      process.send({ kind: 'done', outcome: { status: 'FALHA', reason: e.message, engineMissionId } }, () => process.exit(1));
    }
  });
  // Cancelamento/timeout/desligamento: o estado do motor fica como estava (retomável); não se
  // marca FALHA no motor, só se registra o motivo.
  process.on('SIGTERM', () => {
    bus.emit('cancelled', { reason: stopReason, engineMissionId });
    const bye = () => process.exit(130);
    if (process.connected) process.send({ kind: 'done', outcome: { status: 'CANCELADA', reason: stopReason, engineMissionId } }, bye);
    else bye();
  });
  process.on('disconnect', () => process.exit(1));
}

module.exports = { run, prepareResume };
