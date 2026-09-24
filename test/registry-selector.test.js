const test = require('node:test');
const assert = require('node:assert');
const { SKIP_NO_MASTER } = require('./helpers');

test('registro expõe os 25 agentes canônicos, todos mapeados no motor', { skip: SKIP_NO_MASTER }, () => {
  const agents = require('../src/registry').loadAgents();
  assert.strictEqual(agents.length, 25);
  for (const a of agents) {
    assert.ok(a.description, `${a.id} sem descrição`);
    assert.ok(a.engineMapped, `${a.id} não mapeado no registro do motor`);
  }
  const veto = agents.filter((a) => a.veto).map((a) => a.id).sort();
  assert.deepStrictEqual(veto, ['architecture', 'reviewer', 'security', 'security-auditor', 'testing']);
});

test('registro expõe as 140 Skills com ids únicos e dependências detectadas', { skip: SKIP_NO_MASTER }, () => {
  const skills = require('../src/registry').loadSkills();
  assert.strictEqual(skills.length, 140);
  assert.strictEqual(new Set(skills.map((s) => s.id)).size, 140);
  assert.strictEqual(skills.filter((s) => s.origin === 'ruflo').length, 135);
  assert.ok(skills.find((s) => s.id === 'hive-mind').requires.includes('claude-flow'));
});

test('regras: 3, todas com origem declarada no MASTER', () => {
  const rules = require('../src/registry').loadRules();
  assert.deepStrictEqual(rules.map((r) => r.id), ['00-escopo', '10-coordenacao', '20-evidencia']);
  for (const r of rules) assert.match(r.origin || '', /MASTER/);
});

const { select } = require('../src/selection/selector');

test('nível 0 não aciona agentes nem Skills', { skip: SKIP_NO_MASTER }, () => {
  const r = select('oi');
  assert.strictEqual(r.classification.level, 0);
  assert.deepStrictEqual(r.agents, []);
  assert.deepStrictEqual(r.skills, []);
});

test('tarefa sensível exige security e reviewer; nível 1 usa um executor específico e mantém vetos', { skip: SKIP_NO_MASTER }, () => {
  const r = select('crie uma API REST com autenticação JWT e testes');
  assert.deepStrictEqual(r.agents.map((a) => a.id), ['backend', 'testing', 'security', 'reviewer']);
  assert.strictEqual(r.governance.securityRequired, true);
  assert.strictEqual(r.governance.reviewerRequired, true);
});

for (const task of ['corrija o bug no endpoint de pagamento', 'revise a segurança do login com senhas', 'troque os tokens de api da integração', 'guarde as chaves em um cofre']) {
  test(`alto risco sempre com reviewer + security: "${task}"`, { skip: SKIP_NO_MASTER }, () => {
    const r = select(task);
    assert.ok(r.classification.level >= 1);
    assert.strictEqual(r.governance.reviewerRequired, true);
    assert.strictEqual(r.governance.securityRequired, true);
  });
}

test('nível ≥3 traz planejamento, revisão com veto e consolidação', { skip: SKIP_NO_MASTER }, () => {
  const r = select('refatore a arquitetura do sistema inteiro de pagamentos com migração de banco e revisão de segurança');
  assert.ok(r.classification.level >= 3);
  const ids = r.agents.map((a) => a.id);
  for (const id of ['architecture', 'queen-coordinator', 'reviewer', 'security', 'coordinator']) assert.ok(ids.includes(id), `faltou ${id}`);
  assert.ok(r.governance.vetoHolders.includes('reviewer'));
  assert.ok(r.skills.length > 0);
});

test('agente específico vence o genérico e Skills relevantes são ranqueadas', { skip: SKIP_NO_MASTER }, () => {
  const r = select('configure um swarm hive-mind com memória vetorial agentdb para coordenar agentes');
  assert.strictEqual(r.agents[0].id, 'swarm');
  assert.ok(r.skills.some((s) => s.id === 'hive-mind-advanced'));
  assert.ok(r.skills.every((s) => s.matched.length > 0));
});

test('prévia de modelo vem do router do motor e informa chaves ausentes', { skip: SKIP_NO_MASTER }, () => {
  const r = select('escreva uma função que ordena uma lista');
  assert.match(r.model.motivo, /scoring|cooldown|candidato/);
  for (const m of r.model.fallback) assert.strictEqual(typeof m.keyConfigured, 'boolean');
});
