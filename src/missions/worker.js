// Processo filho que executa UMA missão no motor do MASTER (vendorizado). Isolar em processo
// dá cancelamento real (encerra o processo), timeout e falha contida.
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

let executor = null;
let engineMissionId = null;

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
  const { Executor } = instrument({ testAdapters });
  executor = new Executor();
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

function cancel(reason) {
  try {
    if (executor && engineMissionId) {
      const m = executor.orquestrador.obterMissao(engineMissionId);
      if (m && !['CONCLUIDA', 'FALHA'].includes(m.estado)) executor.orquestrador.falharMissao(engineMissionId, reason);
    }
  } catch (e) {
    bus.emit('warning', { message: `falha ao registrar cancelamento no motor: ${e.message}` });
  }
  bus.emit('cancelled', { reason, engineMissionId });
}

if (require.main === module) {
  process.on('message', async (/** @type {any} */ msg) => {
    if (!msg || msg.kind !== 'start') return;
    try {
      const outcome = await run(msg);
      process.send({ kind: 'done', outcome: { ...outcome, engineMissionId: outcome.engineMissionId || engineMissionId } }, () => process.exit(0));
    } catch (e) {
      bus.emit('error', { stage: 'worker', message: e.message });
      process.send({ kind: 'done', outcome: { status: 'FALHA', reason: e.message, engineMissionId } }, () => process.exit(1));
    }
  });
  const onSignal = () => {
    cancel('cancelada pelo usuário');
    const bye = () => process.exit(130);
    if (process.connected) process.send({ kind: 'done', outcome: { status: 'CANCELADA', engineMissionId } }, bye);
    else bye();
  };
  process.on('SIGTERM', onSignal);
  process.on('disconnect', () => process.exit(0));
}

module.exports = { run };
