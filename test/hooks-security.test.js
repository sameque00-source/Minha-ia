const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { MASTER } = require('./helpers');
const { redact, containsSecret } = require('../src/security/redact');

const ROOT = path.join(__dirname, '..');
const GUARD = path.join(ROOT, '.claude', 'hooks', 'guard.js');
const M = MASTER || '/x/claude-mestre-final-skills-em-lotes-completo';
// segredo falso montado em runtime (não há literal de segredo no repositório)
const FAKE_KEY = ['gsk', '_', 'a'.repeat(24)].join('');

function runGuard(tool_name, tool_input, { cwd = ROOT, env = {}, raw } = {}) {
  const input = raw !== undefined ? raw : JSON.stringify({ tool_name, tool_input, cwd });
  const r = spawnSync(process.execPath, [GUARD], { input, encoding: 'utf8', env: { ...process.env, MINHAIA_ALLOW_PROTECTED_EDIT: '', ...env } });
  return { code: r.status, stderr: r.stderr };
}

const BLOCK = [
  // MASTER — ferramentas de arquivo
  ['Write no MASTER', 'Write', { file_path: `${M}/README.md`, content: 'x' }],
  ['Edit no MASTER', 'Edit', { file_path: `${M}/AI-ORCHESTRATOR/gateway/server.js`, old_string: 'a', new_string: 'b' }],
  ['Write relativo no MASTER', 'Write', { file_path: '../claude-mestre-final-skills-em-lotes-completo/x', content: 'x' }],
  // MASTER — Bash (bypasses reportados na revisão de segurança)
  ['git commit no MASTER', 'Bash', { command: `git -C ${M} commit -m x` }],
  ['redirecionamento para o MASTER', 'Bash', { command: `echo x > ${M}/a.txt` }],
  ['sed -ie no MASTER', 'Bash', { command: `sed -ie s/a/b/ ${M}/x.md` }],
  ['cd por glob', 'Bash', { command: 'cd ../claude-mestre-* && echo x > a' }],
  ['cd por variável', 'Bash', { command: 'D=../claude-mestre-final-skills-em-lotes-; cd ${D}completo && echo>a' }],
  ['cd por substituição', 'Bash', { command: 'cd $(ls -d ../claude*) && touch a' }],
  ['git -C com glob', 'Bash', { command: 'git -C ../claude-mestre* commit -am x' }],
  ['symlink para o MASTER', 'Bash', { command: 'ln -s ../claude-mestre-final-skills-em-lotes-completo m' }],
  ['node -e escrevendo', 'Bash', { command: `node -e "require('fs').writeFileSync('${M}/a','x')"` }],
  ['python -c escrevendo', 'Bash', { command: `python3 -c "open('${M}/a','w')"` }],
  ['find -delete', 'Bash', { command: `find ${M} -delete` }],
  ['npm --prefix', 'Bash', { command: `npm --prefix ${M} run build` }],
  ['rm com glob', 'Bash', { command: 'rm ../claude-mestre-*/README.md' }],
  ['executar código do MASTER no lugar', 'Bash', { command: `cd ${M}/AI-ORCHESTRATOR && node gateway/server.js` }],
  // segredos
  ['cat .secrets/.env', 'Bash', { command: 'cat .secrets/.env' }],
  ['cat via link config', 'Bash', { command: 'cat vendor/master/ai-orchestrator/config/.env' }],
  ['Write em .secrets', 'Write', { file_path: '.secrets/.env', content: 'A=1' }],
  ['segredo em arquivo', 'Write', { file_path: 'src/x.js', content: `const k = '${FAKE_KEY}'` }],
  ['segredo via MultiEdit', 'MultiEdit', { file_path: 'src/x.js', edits: [{ old_string: 'a', new_string: `k=${FAKE_KEY}` }] }],
  // cópias geradas e autoproteção
  ['Write em vendor', 'Write', { file_path: 'vendor/master/ia-avancado/x.js', content: 'x' }],
  ['Write em .claude/skills', 'Write', { file_path: '.claude/skills/hive-mind/SKILL.md', content: 'x' }],
  ['Write em settings', 'Write', { file_path: '.claude/settings.json', content: '{}' }],
  ['Write no próprio guard', 'Write', { file_path: '.claude/hooks/guard.js', content: 'x' }],
  ['Write em src/security', 'Write', { file_path: 'src/security/redact.js', content: 'x' }],
  ['Bash sobrescrevendo settings', 'Bash', { command: "echo '{}' > .claude/settings.json" }],
  // destrutivos
  ['rm -fr /*', 'Bash', { command: 'rm -fr /*' }],
  ['rm -rf "$HOME"', 'Bash', { command: 'rm -rf "$HOME"' }],
  ['rm -rf ./', 'Bash', { command: 'rm -rf ./ ' }],
  ['cd / && rm -rf *', 'Bash', { command: 'cd / && rm -rf *' }],
  ['rm -rf de dados', 'Bash', { command: 'rm -rf vendor .secrets data' }],
  ['find . -delete', 'Bash', { command: 'find . -delete' }],
  ['push forçado', 'Bash', { command: 'git push --force origin main' }],
  ['push +refspec', 'Bash', { command: 'git push origin +main' }],
  ['reset --hard', 'Bash', { command: 'git reset --hard HEAD~1' }],
  ['ssh', 'Bash', { command: 'ssh prod' }],
  // entrada inválida (fail-closed)
  ['file_path não string', 'Write', { file_path: 123, content: 'x' }],
];

for (const [name, tool, input] of BLOCK) {
  test(`guard bloqueia: ${name}`, () => {
    const r = runGuard(tool, input);
    assert.strictEqual(r.code, 2, r.stderr);
    assert.match(r.stderr, /BLOQUEADO/);
  });
}

test('guard bloqueia escrita quando o cwd está dentro do MASTER', () => {
  for (const command of ['echo x > README.md', 'git commit -am x']) {
    assert.strictEqual(runGuard('Bash', { command }, { cwd: M }).code, 2, command);
  }
});

test('guard é fail-closed para JSON inválido', () => {
  assert.strictEqual(runGuard(null, null, { raw: 'not json' }).code, 2);
});

const ALLOW = [
  ['git status no MASTER', 'Bash', { command: `git -C ${M} status --short` }],
  ['ls com >/dev/null', 'Bash', { command: `ls ${M} > /dev/null` }],
  ['leitura com 2>&1 e pipe', 'Bash', { command: `ls ${M} 2>&1 | head` }],
  ['cat + grep no MASTER', 'Bash', { command: `cat ${M}/AI-ORCHESTRATOR/gateway/server.js | grep listen` }],
  ['npm test', 'Bash', { command: 'npm test' }],
  ['rm -rf vendor (regenerável)', 'Bash', { command: 'rm -rf vendor' }],
  ['git add/commit de arquivos protegidos', 'Bash', { command: 'git add .claude/settings.json src/security/redact.js && git commit -m x' }],
  ['CLI da MinhaIA', 'Bash', { command: 'node bin/minhaia.js verify' }],
  ['Write normal', 'Write', { file_path: 'src/ok.js', content: 'module.exports = 1' }],
];

for (const [name, tool, input] of ALLOW) {
  test(`guard permite: ${name}`, () => {
    const r = runGuard(tool, input);
    assert.strictEqual(r.code, 0, r.stderr);
  });
}

test('guard: leitura dentro do MASTER via cwd é permitida', () => {
  assert.strictEqual(runGuard('Bash', { command: 'git status' }, { cwd: M }).code, 0);
});

test('guard: edição de arquivo protegido só com MINHAIA_ALLOW_PROTECTED_EDIT=1', () => {
  const r = runGuard('Write', { file_path: '.claude/hooks/guard.js', content: 'x' }, { env: { MINHAIA_ALLOW_PROTECTED_EDIT: '1' } });
  assert.strictEqual(r.code, 0, r.stderr);
});

test('redact mascara segredos e preserva dados comuns', () => {
  assert.strictEqual(redact(`key ${FAKE_KEY}`), 'key [REDACTED]');
  assert.match(redact(`https://x/m:generateContent?key=AIza${'b'.repeat(30)}&y=1`), /\?key=\[REDACTED\]&y=1/);
  assert.strictEqual(redact('{"input_tokens":12,"ok":true}'), '{"input_tokens":12,"ok":true}');
  assert.ok(containsSecret(`Bearer ${'c'.repeat(30)}`));
  assert.ok(!containsSecret('texto comum sem segredo'));
});
