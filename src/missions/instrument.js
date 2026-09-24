const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths } = require('../config');
const bus = require('../runtime/bus');

// Observa o motor do MASTER sem alterá-lo: envolve funções exportadas ANTES de o Executor ser
// carregado (quem importa por desestruturação recebe a versão envolvida). Nenhuma decisão do
// motor muda — só são emitidos eventos.

const TAIL = 2000;
const tail = (s) => (typeof s === 'string' && s.length > TAIL ? `…${s.slice(-TAIL)}` : s);

function engineModule(rel) {
  return require(path.join(paths.ENGINE_DIR, rel));
}

function snapshot(m) {
  return {
    id: m.id,
    objetivo: m.objetivo,
    estado: m.estado,
    complexidade: m.complexidade,
    progresso: m.progresso,
    proximaAcao: m.proximaAcao,
    historicoEstados: m.historicoEstados,
    plano: m.plano || null,
    agentes: m.agentes,
    modelos: m.modelos,
    subtarefas: (m.subtarefas || []).map((t) => ({
      id: t.id,
      descricao: t.descricao,
      tipo: t.tipo,
      status: t.status,
      agente: t.agente,
      modelo: t.modelo,
      dependeDe: t.dependeDe,
      tentativas: t.tentativas,
      criterioConclusao: t.criterioConclusao,
      skills: t._skills ? t._skills.skills.map((s) => s.id) : [],
      decisaoUsuario: !!t.decisaoUsuario,
      resultado: t.resultado ? { status: t.resultado.status, resultado: tail(String(t.resultado.resultado || '')), arquivos: t.resultado.arquivos, erros: t.resultado.erros } : null,
    })),
    testes: m.testes,
    erros: m.erros,
    correcoes: m.correcoes,
    estadoFinal: m.estadoFinal,
  };
}

function instrument({ testAdapters = null } = {}) {
  // 1) provedores — só em teste, e rotulado: nunca apresentado como provedor real
  if (testAdapters) {
    const providers = require(path.join(paths.AIORCH_DIR, 'gateway', 'providers.js'));
    for (const name of Object.keys(providers.ADAPTERS)) providers.ADAPTERS[name] = testAdapters;
    bus.emit('warning', { message: 'MODO TESTE: provedores substituídos por dublê de teste (TEST-STUB). Não é execução real.' });
  }

  // 2) chamadas de LLM (antes de qualquer módulo que desestruture chamarLLM)
  const llm = engineModule('planejador/core/chamar-llm.js');
  const chamarOriginal = llm.chamarLLM;
  let callSeq = 0;
  llm.chamarLLM = async function chamarLLMInstrumentado(prompt, opts = {}) {
    const callId = ++callSeq;
    const t0 = Date.now();
    bus.emit('llm.start', { callId, agente: opts.agente || null, tipoTarefa: opts.tipoTarefa || null, complexidade: opts.complexidade ?? null, promptChars: String(prompt || '').length, testStub: !!testAdapters });
    const r = await chamarOriginal(prompt, opts);
    bus.emit('llm.end', { callId, ok: !!r.ok, model: r.modeloId, provider: testAdapters && r.provider ? `TEST-STUB(${r.provider})` : r.provider, ms: Date.now() - t0, error: r.ok ? null : r.error, categoriaFalha: r.categoriaFalha || null, responseChars: (r.texto || '').length });
    return r;
  };

  // 3) cada tentativa por modelo (fallback incluído)
  const router = engineModule('router/router.js');
  const registrarOriginal = router.registrarResultado;
  router.registrarResultado = function registrarInstrumentado(d) {
    bus.emit('llm.attempt', { model: d.modeloId, provider: testAdapters ? `TEST-STUB(${d.provider})` : d.provider, ok: !!d.sucesso, ms: d.duracaoMs, fallback: !!d.fallbackUsado, agente: d.agente || null, tarefaTipo: d.tarefaTipo || null });
    return registrarOriginal.apply(this, arguments);
  };

  // 4) ferramentas reais do Executor — primeiro a política de sandbox, depois a observação
  const ferramentas = engineModule('executor/core/ferramentas.js');
  applySandboxPolicy(ferramentas);
  for (const name of ['lerArquivo', 'escreverArquivo', 'editarArquivo', 'executarComando', 'testarServidor', 'navegador', 'mcp']) {
    const orig = ferramentas[name];
    if (typeof orig !== 'function') continue;
    ferramentas[name] = function ferramentaInstrumentada(...args) {
      const t0 = Date.now();
      const base = { tool: name, arg: summarizeArgs(name, args) };
      const done = (r) => {
        bus.emit('tool', { ...base, ok: !!(r && r.ok), ms: Date.now() - t0, error: r && (r.erro || r.error) || null, exitCode: r && r.codigoSaida, stdout: tail(r && r.stdout), stderr: tail(r && r.stderr), bytes: r && r.bytes });
        return r;
      };
      const r = orig.apply(this, args);
      return r && typeof r.then === 'function' ? r.then(done) : done(r);
    };
  }

  // 5) autocorreção: cada avaliação, diagnóstico/estratégia e resultado final
  const autocorrecao = engineModule('autocorrecao/autocorrecao.js');
  const loopOriginal = autocorrecao.executarComAutocorrecao;
  autocorrecao.executarComAutocorrecao = async function autocorrecaoInstrumentada(config) {
    const repairId = crypto.randomBytes(4).toString('hex');
    let tentativa = 0;
    const wrapped = {
      ...config,
      avaliar: (res, ctx) => {
        tentativa += 1;
        const a = config.avaliar(res, ctx);
        bus.emit('repair.evaluate', { repairId, tentativa, sucesso: !!a.sucesso, erro: a.sucesso ? null : tail(a.mensagemErro || '') });
        return a;
      },
      corrigir: typeof config.corrigir === 'function' ? async (info) => {
        bus.emit('repair.fix', { repairId, tentativa, categoria: info.diagnostico && info.diagnostico.categoria, causa: info.diagnostico && info.diagnostico.causaProvavel, estrategia: info.estrategia && info.estrategia.acao, motivo: info.estrategia && info.estrategia.motivo });
        return config.corrigir(info);
      } : undefined,
    };
    const r = await loopOriginal(wrapped);
    bus.emit('repair.end', { repairId, status: r.status, tentativas: r.tentativas || tentativa, motivo: r.motivo || null });
    return r;
  };

  // 6) estado persistido da missão (plano, tarefas, testes, erros, correções)
  const persistencia = engineModule('orquestrador/core/persistencia.js');
  const salvarOriginal = persistencia.salvar;
  let lastHash = null;
  persistencia.salvar = function salvarInstrumentado(missao) {
    const ok = salvarOriginal.apply(this, arguments);
    try {
      const snap = snapshot(missao);
      const h = crypto.createHash('sha1').update(JSON.stringify(snap)).digest('hex');
      if (h !== lastHash) { lastHash = h; bus.emit('state', { mission: snap }); }
    } catch (e) {
      bus.emit('warning', { message: `snapshot da missão falhou: ${e.message}` });
    }
    return ok;
  };

  // 7) plano gerado pelo Planejador (interpretação, requisitos, riscos, complexidade)
  const { Planejador } = engineModule('planejador/planejador.js');
  const planejarOriginal = Planejador.prototype.planejar;
  Planejador.prototype.planejar = async function planejarInstrumentado(objetivo, opcoes) {
    bus.emit('phase', { phase: 'PLANEJAMENTO', message: 'Planejador decompondo o objetivo com LLM' });
    const r = await planejarOriginal.call(this, objetivo, opcoes);
    if (r && r.ok) bus.emit('plan', { missionId: r.missao && r.missao.id, plan: r.plano });
    else bus.emit('error', { stage: 'planejamento', message: r && r.error });
    return r;
  };

  return { Executor: engineModule('executor/executor.js').Executor, persistencia };
}

// ------------------------------------------------------------------ sandbox
// O motor do MASTER executa código gerado pelo LLM (execFile/spawn no workspace da missão).
// Política da MinhaIA: só `node` roda, e sempre com o modelo de permissões do Node lendo e
// gravando APENAS no workspace da missão e sem poder criar processos. Outros executáveis
// (python, sh…) não herdam esse confinamento e são recusados, salvo opt-in explícito.
const PERMISSION_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';

/**
 * Argumentos do `node` por LISTA DE PERMISSÃO: só `-e/--eval <código> [args]` ou
 * `<script dentro do workspace> [args]`. Qualquer opção do node antes do script é recusada —
 * várias delas (`--run`, `--report-directory`, `-r`, `--import`, `--env-file`…) escapariam
 * do confinamento ou gravariam fora do workspace.
 */
function sanitizeNodeArgs(args, ws) {
  const a = (args || []).map(String);
  if (a.length === 0) return { denied: 'node sem script: nada a executar' };
  if (a[0] === '-e' || a[0] === '--eval') {
    if (a.length < 2) return { denied: 'node -e sem código' };
    return { args: ['-e', a[1], ...a.slice(2)] };
  }
  if (a[0].startsWith('-')) return { denied: `opção do node "${a[0]}" não permitida pela sandbox (só "node <script-no-workspace>" ou "node -e <código>")` };
  let real;
  try { real = fs.realpathSync(path.resolve(ws, a[0])); } catch { return { denied: `script "${a[0]}" não existe no workspace da missão` }; }
  const rel = path.relative(ws, real);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(real).isFile()) return { denied: `script "${a[0]}" fica fora do workspace da missão` };
  return { args: [real, ...a.slice(1)] };
}

const NETWORK_PRELOAD = path.join(__dirname, 'sandbox-preload.js');

/**
 * Link simbólico ou hardlink dentro do workspace seria seguido pelo código confinado (limitação
 * do modelo de permissões): o workspace precisa conter só arquivos e diretórios comuns.
 */
function findWorkspaceLink(ws, limit = 5000) {
  let seen = 0;
  const stack = [ws];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++seen > limit) return `workspace com mais de ${limit} entradas`;
      const abs = path.join(dir, ent.name);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) return `link simbólico ${path.relative(ws, abs)}`;
      if (st.isDirectory()) stack.push(abs);
      else if (st.isFile() && st.nlink > 1) return `hardlink ${path.relative(ws, abs)}`;
    }
  }
  return null;
}

function sandboxCommand(missaoId, comando, args) {
  const base = path.basename(String(comando || '')).replace(/\.exe$/i, '');
  if (base === 'node' || comando === process.execPath) {
    const { garantirWorkspace } = engineModule('executor/core/workspace.js');
    const ws = fs.realpathSync(garantirWorkspace(missaoId));
    const link = findWorkspaceLink(ws);
    if (link) return { denied: `sandbox recusou executar: ${link} no workspace (poderia apontar para fora dele)` };
    const s = sanitizeNodeArgs(args, ws);
    if (s.denied) return { denied: s.denied };
    return {
      comando: process.execPath,
      args: [PERMISSION_FLAG, `--allow-fs-read=${ws}`, `--allow-fs-read=${NETWORK_PRELOAD}`, `--allow-fs-write=${ws}`, '--require', NETWORK_PRELOAD, ...s.args],
      sandboxed: true,
      workspace: ws,
      network: process.env.MINHAIA_SANDBOX_ALLOW_NETWORK === '1' ? 'liberada (opt-in)' : 'bloqueada',
    };
  }
  if (process.env.MINHAIA_ALLOW_UNSANDBOXED_COMMANDS === '1') return { comando, args, sandboxed: false };
  return { denied: `executável "${base}" bloqueado pela política de sandbox da MinhaIA: só código Node.js roda, confinado ao workspace da missão. Gere a solução em Node.js puro (built-ins).` };
}

function applySandboxPolicy(ferramentas) {
  for (const name of ['executarComando', 'testarServidor']) {
    const orig = ferramentas[name];
    if (typeof orig !== 'function') continue;
    ferramentas[name] = function comandoComSandbox(missaoId, comando, args, opcoes) {
      const d = sandboxCommand(missaoId, comando, args);
      if (d.denied) {
        bus.emit('sandbox', { tool: name, comando: String(comando), allowed: false, motivo: d.denied });
        const r = name === 'executarComando'
          ? { ok: false, codigoSaida: 126, stdout: '', stderr: d.denied, timeout: false, erro: d.denied }
          : { ok: false, erro: d.denied };
        return Promise.resolve(r);
      }
      bus.emit('sandbox', { tool: name, comando: String(comando), allowed: true, sandboxed: d.sandboxed, workspace: d.workspace || null, network: d.network || null, unsafe: !d.sandboxed });
      return orig.call(this, missaoId, d.comando, d.args, opcoes);
    };
  }
}

function summarizeArgs(name, args) {
  switch (name) {
    case 'lerArquivo': return { caminho: args[1] };
    case 'escreverArquivo': return { tarefa: args[1], caminho: args[2], bytes: typeof args[3] === 'string' ? Buffer.byteLength(args[3]) : null };
    case 'editarArquivo': return { tarefa: args[1], caminho: args[2] };
    case 'executarComando': return { comando: [args[1], ...(args[2] || [])].join(' ').slice(0, 300) };
    case 'testarServidor': return { comando: [args[1], ...(args[2] || [])].join(' ').slice(0, 300), porta: args[3] && args[3].porta };
    default: return {};
  }
}

module.exports = { instrument, snapshot, sanitizeNodeArgs, sandboxCommand, findWorkspaceLink };
