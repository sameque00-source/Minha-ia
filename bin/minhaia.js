#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { paths, resolveMasterDir } = require('../src/config');

const [, , cmd, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const asJson = flags.has('--json');
const out = (obj, text) => console.log(asJson ? JSON.stringify(obj, null, 2) : text);

function flagValue(name, fallback) {
  const hit = rest.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

const MASTER_SUITES = [
  'suite-regressao-fase0', 'teste-fase1-orquestrador', 'teste-fase2-planejador', 'teste-fase3-executor',
  'teste-fase4-agentes', 'teste-fase5-6-pesquisa-memoria', 'teste-fase7-8-router-autocorrecao',
  'teste-fase9-10-multimidia-projetos',
];

/** Cria/retoma uma missão pelo MissionManager e acompanha os eventos no terminal até o fim. */
async function followMission(startFn) {
  const { MissionManager } = require('../src/missions/manager');
  const manager = new MissionManager();
  let id = null;
  const done = new Promise((resolve) => {
    manager.subscribe((jobId, e) => {
      if (id && jobId !== id) return;
      if (!asJson) {
        const detail = e.type === 'llm.end' ? `${e.model || '-'} (${e.provider || '-'}) ${e.ok ? 'ok' : e.error}`
          : e.type === 'tool' ? `${e.tool} ${(e.arg && (e.arg.comando || e.arg.caminho)) || ''} ${e.ok ? 'ok' : 'erro'}`
            : e.type === 'skills' ? `${e.agente}: ${e.skills.map((s) => s.id).join(', ') || 'nenhuma'}`
              : e.type === 'state' ? `motor ${e.mission.estado} · ${Math.round((e.mission.progresso || 0) * 100)}%`
                : e.message || e.reason || e.phase || e.status || '';
        console.error(`[${e.type}] ${detail}`);
      }
      if (e.type === 'finished') resolve(e);
    });
  });
  const stop = () => { if (id) manager.cancel(id); };
  process.once('SIGINT', stop);
  id = startFn(manager);
  const fin = await done;
  process.removeListener('SIGINT', stop);
  const job = require('../src/missions/store').get(id);
  out(job, `${fin.status}${job.reason ? `: ${job.reason}` : ''} — ${id}${job.engineMissionId ? ` (motor ${job.engineMissionId}: ${job.engineState})` : ''}`);
  process.exitCode = fin.status === 'CONCLUIDA' ? 0 : 1;
}

const commands = {
  sync() {
    const lock = require('../src/master/sync').sync({ log: console.log });
    console.log(`OK: ${lock.fileCount} arquivos do MASTER materializados (somente leitura no MASTER).`);
  },

  verify() {
    const r = require('../src/master/verify').verify();
    out(r, [
      `MASTER: ${r.masterDir || 'não encontrado'}`,
      `HEAD: ${r.masterHead || '-'} (lock: ${r.lockHead || '-'})`,
      `git status do MASTER: ${r.masterGit ? (r.masterGit.clean ? 'limpo' : 'COM ALTERAÇÕES') : '-'}`,
      `arquivos no lock: ${r.files} | drift no MASTER: ${r.masterDrift.length} | cópias alteradas: ${r.vendorTampered.length} | ausentes: ${r.missingLocal.length}`,
      ...r.problems.map((p) => `PROBLEMA: ${p}`),
      r.ok ? 'OK' : 'FALHOU',
    ].join('\n'));
    process.exitCode = r.ok ? 0 : 1;
  },

  doctor() {
    const { verify } = require('../src/master/verify');
    const { providerStatus } = require('../src/engine');
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok, detail });
    add('node >= 22', Number(process.versions.node.split('.')[0]) >= 22, process.version);
    add('MASTER encontrado', !!resolveMasterDir(), resolveMasterDir() || 'defina MINHAIA_MASTER_DIR');
    const v = verify();
    add('MASTER intacto e lock íntegro', v.ok, v.problems.join('; ') || `${v.files} arquivos verificados`);
    let agents = [];
    let skills = [];
    try { agents = require('../src/registry').loadAgents(); skills = require('../src/registry').loadSkills(); } catch (e) { add('registros', false, e.message); }
    add('25 agentes disponíveis', agents.length === 25, `${agents.length} (motor mapeia ${agents.filter((a) => a.engineMapped).length})`);
    add('140 Skills disponíveis', skills.length === 140, `${skills.length}`);
    const p = providerStatus();
    add('chave de provedor LLM', p.configured.length > 0, p.configured.length ? `configuradas: ${p.configured.join(', ')}` : `nenhuma em .secrets/.env (${p.missing.join(', ')}) — missões reais ficam BLOQUEADAS`);
    out(checks, checks.map((c) => `${c.ok ? 'OK  ' : 'FALHA'} ${c.name} — ${c.detail}`).join('\n'));
    if (flags.has('--brief')) return;
    process.exitCode = checks.slice(0, 5).every((c) => c.ok) ? 0 : 1;
  },

  agents() {
    const list = require('../src/registry').loadAgents();
    out(list, list.map((a) => `${a.id.padEnd(18)} ${a.veto ? 'VETO ' : '     '}${a.readOnly ? 'RO ' : 'RW '} ${a.description.slice(0, 90)}`).join('\n') + `\n${list.length} agentes`);
  },

  skills() {
    const filter = (args[0] || '').toLowerCase();
    const list = require('../src/registry').loadSkills().filter((s) => !filter || `${s.id} ${s.description}`.toLowerCase().includes(filter));
    out(list, list.map((s) => `${s.id.padEnd(40)} [${s.origin}]${s.requires.length ? ` requer: ${s.requires.join(',')}` : ''}`).join('\n') + `\n${list.length} Skills`);
  },

  rules() {
    const list = require('../src/registry').loadRules();
    out(list, list.map((r) => `${r.id}: ${r.title} (${r.origin || 'MinhaIA'})`).join('\n'));
  },

  select() {
    const task = args.join(' ');
    if (!task) throw new Error('uso: minhaia select "<tarefa>"');
    const r = require('../src/selection/selector').select(task);
    out(r, [
      `nível ${r.classification.level} (${r.classification.effort}) — modalidade: ${r.classification.modality.join(', ')}`,
      `agentes: ${r.agents.map((a) => `${a.id}${a.veto ? '[VETO]' : ''}`).join(', ') || '(nenhum — responder direto)'}`,
      `Skills: ${r.skills.map((s) => `${s.id} (${s.matched.join('/')})`).join(', ') || '(nenhuma)'}`,
      `regras: ${r.rules.join(', ')}`,
      `governança: reviewer=${r.governance.reviewerRequired} security=${r.governance.securityRequired} equipe=${r.governance.teamRecommended}`,
      `modelo: ${r.model.chosen || '-'} (${r.model.tipoTarefa}); chaves configuradas na cadeia: ${r.model.fallback.filter((m) => m.keyConfigured).length}/${r.model.fallback.length}`,
    ].join('\n'));
  },

  // run/resume usam o mesmo caminho da API: processo worker + sandbox do código gerado.
  async run() {
    const objective = args.join(' ');
    if (!objective) throw new Error('uso: minhaia run "<objetivo>"');
    await followMission((m) => m.create(objective).id);
  },

  async resume() {
    if (!args[0]) throw new Error('uso: minhaia resume <mia_id>');
    await followMission((m) => m.start(args[0], { resume: true }).id);
  },

  missions() {
    const list = require('../src/missions/store').list();
    out(list, list.map((m) => `${m.id} ${m.status.padEnd(14)} ${m.engineState || '-'} ${m.objective.slice(0, 70)}`).join('\n') || '(nenhuma missão)');
  },

  memory() {
    const mem = require('../src/engine').memory();
    const [sub, ...restArgs] = args;
    if (sub === 'recall') {
      const r = mem.lembrar(restArgs.join(' '));
      out(r, r.achou ? r.registros.map((x) => `[${x.tipo} rel=${x._relevancia} conf=${x._confiancaAtual}] ${x.conteudo.slice(0, 120)}`).join('\n') : '(nada relevante na memória)');
    } else if (sub === 'save') {
      const tipo = flagValue('--type', 'fato');
      const r = mem.gravar({ tipo, conteudo: restArgs.join(' '), origem: 'cli' });
      out(r, r.ok ? `gravado ${r.id}` : `erro: ${r.error}`);
    } else {
      throw new Error('uso: minhaia memory recall "<consulta>" | minhaia memory save [--type=fato] "<conteúdo>"');
    }
  },

  async serve() {
    const port = Number(flagValue('--port', process.env.MINHAIA_PORT || '4317'));
    const { server, port: actual, host } = await require('../src/server').start({ port });
    console.log(`MinhaIA em http://${host}:${actual} (somente esta máquina)`);
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  },

  gateway() {
    const server = path.join(paths.AIORCH_DIR, 'gateway', 'server.js');
    if (!fs.existsSync(server)) throw new Error('gateway não sincronizado — rode `minhaia sync`');
    const port = flagValue('--port', process.env.GATEWAY_PORT || '20130');
    const host = process.env.GATEWAY_HOST || '127.0.0.1';
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
    if (!loopback && !require('../src/engine').providerStatus().gatewayKey) {
      throw new Error(`GATEWAY_HOST=${host} expõe o gateway fora da máquina; defina GATEWAY_API_KEY em .secrets/.env antes`);
    }
    const child = spawn(process.execPath, [server], { stdio: 'inherit', env: { ...process.env, GATEWAY_PORT: port } });
    child.on('exit', (code) => { process.exitCode = code || 0; });
  },

  async 'test-master'() {
    const suites = args.length ? args : MASTER_SUITES;
    const { createRuntimeLinks } = require('../src/master/sync');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minhaia-test-master-'));
    const results = [];
    const restore = () => { createRuntimeLinks(); fs.rmSync(tmp, { recursive: true, force: true }); };
    let aborted = null;
    let current = null;
    const onSignal = (sig) => { aborted = sig; if (current) current.kill(sig); };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal);
    createRuntimeLinks(undefined, { dataRoot: tmp });
    try {
      for (const s of suites) {
        if (aborted) break;
        const file = path.join(paths.ENGINE_DIR, 'testes', `${s}.js`);
        const r = await new Promise((resolve) => {
          let text = '';
          current = spawn(process.execPath, [file], { cwd: path.dirname(file) });
          const timer = setTimeout(() => current.kill('SIGKILL'), 15 * 60 * 1000);
          current.stdout.on('data', (d) => { text += d; });
          current.stderr.on('data', (d) => { text += d; });
          current.on('close', (status) => { clearTimeout(timer); current = null; resolve({ status, text }); });
        });
        const { text } = r;
        const m = text.match(/(\d+)\/(\d+) testes aprovados/);
        const failed = text.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.replace(/\s+/g, ' ').slice(0, 160));
        results.push({ suite: s, passed: m ? Number(m[1]) : 0, total: m ? Number(m[2]) : null, exit: r.status, failed, crash: m ? null : text.split('\n').find((l) => /Error/.test(l)) || 'sem resumo' });
      }
    } finally {
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(sig, onSignal);
      restore();
    }
    if (aborted) { console.error(`test-master interrompido (${aborted}); links de runtime restaurados.`); process.exitCode = 130; return; }
    const passed = results.reduce((n, r) => n + r.passed, 0);
    const total = results.reduce((n, r) => n + (r.total || 0), 0);
    process.exitCode = results.every((r) => r.total !== null && r.passed === r.total) ? 0 : 1;
    out({ passed, total, results }, results.map((r) => `${r.suite}: ${r.total === null ? `ERRO (${r.crash})` : `${r.passed}/${r.total}`}${r.failed.length ? `\n    ${r.failed.join('\n    ')}` : ''}`).join('\n') + `\nTOTAL ${passed}/${total} (estado isolado em diretório temporário, já removido)`);
  },

  help() {
    console.log(`minhaia <comando>
  sync                      materializa o MASTER (somente leitura) em vendor/ e .claude/
  verify                    prova que o MASTER está intacto e as cópias batem com o lock
  doctor [--brief]          checagem do ambiente
  agents | skills [filtro] | rules
  select "<tarefa>"         agentes, Skills, regras, governança e modelo para a tarefa
  run "<objetivo>"          missão real (planejar → executar → testar → revisar)
  missions | resume <mia_id>
  memory recall "<q>" | memory save [--type=fato] "<conteúdo>"
  serve [--port=4317]       Web UI + API de missões (loopback)
  gateway [--port=20130]    gateway Anthropic-compatível (loopback)
  test-master [suíte...]    roda as suítes originais do MASTER com estado isolado
  --json                    saída estruturada`);
  },
};

(async () => {
  const name = cmd || 'help';
  if (!Object.hasOwn(commands, name)) { commands.help(); process.exitCode = 2; return; }
  const fn = commands[name];
  try {
    await fn();
  } catch (e) {
    console.error(`erro: ${e.message}`);
    process.exitCode = 1;
  }
})();
