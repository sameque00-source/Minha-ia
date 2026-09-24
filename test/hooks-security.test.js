const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { MASTER } = require('./helpers');
const { redact, containsSecret } = require('../src/security/redact');

const GUARD = path.join(__dirname, '..', '.claude', 'hooks', 'guard.js');
const M = MASTER || '/x/claude-mestre-final-skills-em-lotes-completo';
// segredo falso montado em runtime (não há literal de segredo no repositório)
const FAKE_KEY = ['gsk', '_', 'a'.repeat(24)].join('');

function runGuard(tool_name, tool_input) {
  const r = spawnSync(process.execPath, [GUARD], { input: JSON.stringify({ tool_name, tool_input }), encoding: 'utf8' });
  return { code: r.status, stderr: r.stderr };
}

const cases = [
  ['Write no MASTER', 'Write', { file_path: `${M}/README.md`, content: 'x' }, 2],
  ['Edit no MASTER', 'Edit', { file_path: `${M}/AI-ORCHESTRATOR/gateway/server.js`, old_string: 'a', new_string: 'b' }, 2],
  ['Write em cópia gerada (vendor)', 'Write', { file_path: 'vendor/master/ia-avancado/x.js', content: 'x' }, 2],
  ['Write em cópia gerada (.claude/skills)', 'Write', { file_path: '.claude/skills/hive-mind/SKILL.md', content: 'x' }, 2],
  ['segredo em arquivo', 'Write', { file_path: 'src/x.js', content: `const k = '${FAKE_KEY}'` }, 2],
  ['segredo via MultiEdit', 'MultiEdit', { file_path: 'src/x.js', edits: [{ old_string: 'a', new_string: `k=${FAKE_KEY}` }] }, 2],
  ['Write normal', 'Write', { file_path: 'src/ok.js', content: 'module.exports = 1' }, 0],
  ['git status no MASTER', 'Bash', { command: `git -C ${M} status --short` }, 0],
  ['leitura com 2>/dev/null', 'Bash', { command: `ls ${M} 2>/dev/null` }, 0],
  ['git commit no MASTER', 'Bash', { command: `git -C ${M} commit -m x` }, 2],
  ['redirecionamento para o MASTER', 'Bash', { command: `echo x > ${M}/a.txt` }, 2],
  ['sed -i no MASTER', 'Bash', { command: `sed -i s/a/b/ ${M}/x.md` }, 2],
  ['rm -rf ~', 'Bash', { command: 'rm -rf ~' }, 2],
  ['push forçado', 'Bash', { command: 'git push --force origin main' }, 2],
  ['reset --hard', 'Bash', { command: 'git reset --hard HEAD~1' }, 2],
  ['ssh', 'Bash', { command: 'ssh prod' }, 2],
  ['npm test', 'Bash', { command: 'npm test' }, 0],
];

for (const [name, tool, input, expected] of cases) {
  test(`guard: ${name} → exit ${expected}`, () => {
    const r = runGuard(tool, input);
    assert.strictEqual(r.code, expected, r.stderr);
    if (expected === 2) assert.match(r.stderr, /BLOQUEADO/);
  });
}

test('redact mascara segredos e preserva dados comuns', () => {
  assert.strictEqual(redact(`key ${FAKE_KEY}`), 'key [REDACTED]');
  assert.match(redact(`https://x/m:generateContent?key=AIza${'b'.repeat(30)}&y=1`), /\?key=\[REDACTED\]&y=1/);
  assert.strictEqual(redact('{"input_tokens":12,"ok":true}'), '{"input_tokens":12,"ok":true}');
  assert.ok(containsSecret(`Bearer ${'c'.repeat(30)}`));
  assert.ok(!containsSecret('texto comum sem segredo'));
});
