const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { SKIP_NO_MASTER, startApi, req, waitFinished, waitEvent, STUB } = require('./helpers');

// Pipeline REAL do motor (planejador → grafo → executor → ferramentas → autocorreção → revisão)
// com o dublê de LLM de teste no lugar do provedor. Tudo sai rotulado TEST-STUB.

test('missão ponta a ponta via API: plano, agentes, Skills injetadas, ferramentas, arquivos, resultado', { skip: SKIP_NO_MASTER }, async (t) => {
  const api = await startApi({ stub: true });
  t.after(() => api.close());
  const fake = ['gsk', '_', 'q'.repeat(24)].join('');
  const created = await req(api.base, 'POST', '/api/missions', { body: { objective: `Crie um script que soma dois números (chave de exemplo ${fake})` } });
  assert.strictEqual(created.status, 201);
  const id = created.json.id;
  const fin = await waitFinished(api.manager, id);
  assert.strictEqual(fin.status, 'CONCLUIDA');

  const d = (await req(api.base, 'GET', `/api/missions/${id}`)).json;
  assert.strictEqual(d.mission.estado, 'CONCLUIDA');
  assert.ok(d.testStub, 'missão com dublê precisa ser marcada como TEST-STUB');
  assert.ok(!d.job.objective.includes(fake), 'segredo no objetivo precisa ser mascarado');
  assert.ok(d.plan && d.plan.interpretacao);

  const tasks = (await req(api.base, 'GET', `/api/missions/${id}/tasks`)).json;
  assert.deepStrictEqual(tasks.map((x) => [x.tipo, x.status]), [['codigo', 'concluida'], ['revisao', 'concluida']]);

  const agents = (await req(api.base, 'GET', `/api/missions/${id}/agents`)).json;
  assert.deepStrictEqual(agents.used.map((a) => a.id).sort(), ['coding', 'reviewer']);

  const skills = (await req(api.base, 'GET', `/api/missions/${id}/skills`)).json;
  assert.strictEqual(skills.perTask.length, 2);
  for (const p of skills.perTask) {
    assert.ok(p.skills.length >= 1 && p.skills.length <= 2, 'poucas Skills por tarefa');
    for (const s of p.skills) {
      assert.match(s.motivo, /termos em comum/);
      assert.ok(s.tools);
      assert.ok(Array.isArray(s.requires));
    }
    assert.strictEqual(p.resultadoTarefa, 'concluida');
  }
  const prompts = fs.readFileSync(api.promptLog, 'utf8').trim().split('\n').map(JSON.parse);
  const agentPrompts = prompts.filter((p) => /CONTRATO DESTA TAREFA/.test(p.prompt));
  assert.ok(agentPrompts.length >= 2);
  for (const p of agentPrompts) assert.match(p.prompt, /### Skill: /, 'prompt do agente precisa conter as Skills carregadas');
  assert.ok(!prompts.some((p) => /módulo Planejador/.test(p.prompt) && /### Skill:/.test(p.prompt)), 'Planejador não recebe Skills de agente');

  const exec = (await req(api.base, 'GET', `/api/missions/${id}/execution`)).json;
  const run = exec.find((e) => e.type === 'tool' && e.tool === 'executarComando');
  assert.ok(run && run.ok && run.exitCode === 0 && /5/.test(run.stdout));
  assert.ok(exec.some((e) => e.type === 'llm.end' && /^TEST-STUB/.test(e.provider)));
  assert.ok(exec.some((e) => e.type === 'repair.end' && e.status === 'SUCESSO_VALIDADO'));

  const files = (await req(api.base, 'GET', `/api/missions/${id}/files`)).json;
  assert.deepStrictEqual(files.map((f) => f.path), ['soma.js']);
  const content = (await req(api.base, 'GET', `/api/missions/${id}/files?path=soma.js`)).json;
  assert.match(content.content, /function soma/);

  const result = (await req(api.base, 'GET', `/api/missions/${id}/result`)).json;
  assert.strictEqual(result.result.ok, true);
  assert.ok(result.tests.some((x) => x.resultado === 'passou'));

  const obs = (await req(api.base, 'GET', '/api/observability')).json;
  assert.ok(obs.providers.some((p) => /TEST-STUB/.test(p.provider) && p.attempts >= 3));
  assert.ok(obs.tools.some((x) => x.tool === 'executarComando'));

  const raw = fs.readFileSync(`${process.env.MINHAIA_JOBS_DIR || `${api.dir}/jobs`}/${id}/events.jsonl`, 'utf8');
  assert.ok(!raw.includes(fake), 'nenhum segredo nos eventos gravados');
});

test('cancelamento real encerra o worker e registra no motor', { skip: SKIP_NO_MASTER }, async (t) => {
  const api = await startApi({ stub: true, env: { MINHAIA_TEST_STUB_DELAY_MS: '4000' } });
  t.after(() => api.close());
  const id = (await req(api.base, 'POST', '/api/missions', { body: { objective: 'Crie um script que soma dois números' } })).json.id;
  await waitEvent(api.manager, id, 'llm.start');
  const finished = waitFinished(api.manager, id, 20000); // assina antes: o fim pode chegar antes da resposta
  const c = await req(api.base, 'POST', `/api/missions/${id}/cancel`, { body: {} });
  assert.strictEqual(c.status, 200);
  const fin = await finished;
  assert.strictEqual(fin.status, 'CANCELADA');
  assert.strictEqual(api.manager.running.size, 0);
});

test('timeout encerra a missão como TEMPO_ESGOTADO', { skip: SKIP_NO_MASTER }, async (t) => {
  const api = await startApi({ stub: true, env: { MINHAIA_TEST_STUB_DELAY_MS: '5000' } });
  t.after(() => api.close());
  api.manager.timeoutMs = 1500;
  const id = (await req(api.base, 'POST', '/api/missions', { body: { objective: 'Crie um script que soma dois números' } })).json.id;
  const fin = await waitFinished(api.manager, id, 20000);
  assert.strictEqual(fin.status, 'TEMPO_ESGOTADO');
});

test('dublê de teste é recusado fora de NODE_ENV=test', { skip: SKIP_NO_MASTER }, async (t) => {
  const api = await startApi({ env: { NODE_ENV: 'production', MINHAIA_TEST_ADAPTERS: STUB } });
  t.after(() => api.close());
  const id = (await req(api.base, 'POST', '/api/missions', { body: { objective: 'Crie um script que soma dois números' } })).json.id;
  const fin = await waitFinished(api.manager, id, 20000);
  assert.strictEqual(fin.status, 'FALHA');
  const logs = (await req(api.base, 'GET', `/api/missions/${id}/logs`)).json;
  assert.ok(logs.some((e) => e.type === 'error' && /NODE_ENV=test/.test(e.message)));
});

// Sandbox: o código gerado pelo "LLM" tenta escapar do workspace. Alvo = diretório-isca.
for (const [scenario, check] of [
  ['escape', (exec, decoy) => {
    const run = exec.find((e) => e.type === 'tool' && e.tool === 'executarComando');
    assert.ok(run && !run.ok, 'execução que escreve fora do workspace precisa falhar');
    assert.match(`${run.stderr} ${run.error}`, /ERR_ACCESS_DENIED|Access to this API has been restricted/);
    assert.ok(!fs.existsSync(require('path').join(decoy, 'ESCAPOU.txt')), 'nada pode ser gravado fora do workspace');
  }],
  ['secrets', (exec) => {
    const run = exec.find((e) => e.type === 'tool' && e.tool === 'executarComando');
    assert.ok(run && !run.ok, 'leitura fora do workspace precisa falhar');
    assert.match(`${run.stderr} ${run.error}`, /ERR_ACCESS_DENIED|Access to this API has been restricted/);
  }],
  ['python', (exec) => {
    const sb = exec.find((e) => e.type === 'sandbox');
    assert.ok(sb && sb.allowed === false && /python3/.test(sb.comando));
    assert.ok(!exec.some((e) => e.type === 'tool' && e.tool === 'executarComando' && e.ok));
  }],
]) {
  test(`sandbox do código gerado: cenário "${scenario}" é contido`, { skip: SKIP_NO_MASTER }, async (t) => {
    const decoy = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'minhaia-decoy-'));
    const api = await startApi({ stub: true, env: { MINHAIA_TEST_STUB_SCENARIO: scenario, MINHAIA_TEST_DECOY: decoy } });
    t.after(async () => { await api.close(); fs.rmSync(decoy, { recursive: true, force: true }); });
    const id = (await req(api.base, 'POST', '/api/missions', { body: { objective: 'Crie um script que soma dois números' } })).json.id;
    await waitFinished(api.manager, id, 90000);
    const exec = (await req(api.base, 'GET', `/api/missions/${id}/execution`)).json;
    check(exec, decoy);
    const sandboxed = exec.filter((e) => e.type === 'sandbox' && e.allowed);
    assert.ok(sandboxed.every((e) => e.sandboxed), 'todo comando permitido roda confinado');
  });
}
