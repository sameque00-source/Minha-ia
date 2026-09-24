#!/usr/bin/env node
/**
 * PreToolUse — bloqueia (exit 2) antes de executar. Camada de defesa em profundidade, não um
 * sandbox: a proteção forte do MASTER é torná-lo somente leitura no sistema operacional.
 *
 *  1. MASTER: comando Bash que o referencia (texto, caminho, cwd, glob/variável ambígua) só
 *     passa se TODOS os segmentos forem comandos de leitura conhecidos (lista de permissão).
 *     Ferramentas de arquivo: qualquer escrita dentro dele.
 *  2. Segredos: nenhum Bash que toque .secrets/.env; nenhuma escrita com padrão de segredo.
 *  3. Cópias geradas (vendor/, .claude/agents, .claude/skills): só via `minhaia sync`.
 *  4. Autoproteção: settings, hooks, src/security, src/config.js — só com
 *     MINHAIA_ALLOW_PROTECTED_EDIT=1 no ambiente em que o humano iniciou o Claude Code.
 *  5. Comandos destrutivos.
 * Qualquer erro interno ou entrada inválida => bloqueia (fail-closed).
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const MASTER_NAME = /claude-mestre|mestre-final|lotes-completo/i;
const SECRETS_REF = /\.secrets\b|(^|[\s'"=\/:])\.env(\.[\w-]+)?(?=$|[\s'";|&)\/])|ai-orchestrator\/config\b/;
const PROTECTED_REF = /\.claude\/(settings(\.local)?\.json|hooks\b)|src\/security\b|src\/config\.js/;
const AMBIGUOUS = /\$\(|`|\$\{?\w|[*?]/;
// Para arquivos de autoproteção basta barrar operações que alteram conteúdo (git add/commit passam).
const PROTECTED_MUTATING = />{1,2}(?!\s*(&|\/dev\/null\b))|(^|[\s;&|(])(tee|mv|cp|rm|ln|truncate|chmod|chown|dd|install|patch|sed\s+-[a-z]*i|perl\s+-[a-z]*[ie]|node\s+(-e|--eval|-p)|python3?\s+-c)\b|\bgit\s+(checkout|restore|reset|stash|apply|am|cherry-pick|revert)\b/;

const READ_ONLY_CMDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'diff', 'cmp', 'stat', 'file', 'du',
  'tree', 'sha256sum', 'md5sum', 'pwd', 'echo', 'printf', 'true', 'test', 'realpath', 'readlink',
  'basename', 'dirname', 'uniq', 'cut', 'jq', 'cd', 'find', 'git',
]);
const GIT_READ_ONLY = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'blame', 'cat-file', 'describe', 'shortlog', 'grep']);

const DESTRUCTIVE = [
  [/\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/i, 'git push forçado'],
  [/\bgit\s+reset\s+--hard\b/i, 'git reset --hard'],
  [/\bgit\s+clean\s+-[a-z]*f/i, 'git clean -f'],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i, 'descartar todas as alterações locais'],
  [/\bgit\s+branch\s+-D\b/, 'git branch -D'],
  [/\bfind\b[^;&|]*\s-delete\b/, 'find -delete'],
  [/\bmkfs(\.\w+)?\b|\bdd\s+[^;&|]*of=\/dev\//i, 'formatação/escrita em dispositivo'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
  [/\bchmod\s+-R\s+777\s+\//, 'chmod -R 777 na raiz'],
  [/(^|[\s;&|(])(ssh|scp|sftp|rsync)\b/, 'acesso remoto (produção fora de escopo)'],
];
const RM_UNSAFE_TARGET = /^[\/~]|\$|[*?]|^\.\.?\/?$|^\.\.\/|(^|\/)(\.secrets|\.git|data|\.claude)\/?$/;

function block(msg) {
  process.stderr.write(`[minhaia guard] BLOQUEADO: ${msg}\n`);
  process.exit(2);
}

function unquote(t) {
  return t.replace(/^(['"])(.*)\1$/, '$2');
}

function segments(command) {
  return command.split(/\|\||&&|;|\||\n/).map((s) => s.trim()).filter(Boolean);
}

function words(segment) {
  const ws = segment.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  while (ws.length && /^\w+=/.test(ws[0])) ws.shift(); // VAR=valor comando
  return ws.map(unquote);
}

function segmentIsReadOnly(segment) {
  if (/>{1,2}(?!\s*(&|\/dev\/null\b))/.test(segment)) return false;
  if (/\$\(|`/.test(segment)) return false;
  const ws = words(segment);
  if (ws.length === 0) return true;
  const cmd = ws[0];
  if (!READ_ONLY_CMDS.has(cmd)) return false;
  if (cmd === 'find' && ws.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(w))) return false;
  if (cmd === 'git') {
    let i = 1;
    while (i < ws.length && ws[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(ws[i]) ? 2 : 1;
    if (!GIT_READ_ONLY.has(ws[i])) return false;
  }
  return true;
}

function commandIsReadOnly(command) {
  return segments(command).every(segmentIsReadOnly);
}

function checkRm(command) {
  for (const seg of segments(command)) {
    const ws = words(seg);
    if (ws[0] !== 'rm') continue;
    const flags = ws.filter((w) => w.startsWith('-')).join(' ');
    const recursive = /(^|\s)-[a-zA-Z]*[rR]|--recursive/.test(flags);
    const targets = ws.slice(1).filter((w) => !w.startsWith('-'));
    if (recursive && (targets.length === 0 || targets.some((t) => RM_UNSAFE_TARGET.test(t)))) {
      block(`rm recursivo em alvo protegido/ambíguo (${targets.join(' ') || 'sem alvo'})`);
    }
  }
}

function makeChecker({ config, containsSecret, env }) {
  const { resolveMasterDir, isInside, realish } = config;
  const GENERATED = ['vendor', path.join('.claude', 'agents'), path.join('.claude', 'skills')].map((p) => path.join(ROOT, p));
  const PROTECTED = [path.join('.claude', 'settings.json'), path.join('.claude', 'settings.local.json'), path.join('.claude', 'hooks'), path.join('src', 'security'), path.join('src', 'config.js')].map((p) => path.join(ROOT, p));
  const allowProtected = env.MINHAIA_ALLOW_PROTECTED_EDIT === '1';

  function checkBash(command, cwd, masterDir) {
    for (const [re, why] of DESTRUCTIVE) if (re.test(command)) block(`comando destrutivo (${why}): ${command.slice(0, 200)}`);
    checkRm(command);
    if (SECRETS_REF.test(command)) block('comando que acessa .secrets/.env — as chaves são gravadas pelo humano, fora do Claude');

    const cwdReal = cwd ? realish(cwd) : null;
    const inMaster = masterDir && cwdReal && isInside(cwdReal, masterDir);
    const refMaster = inMaster || MASTER_NAME.test(command) || (masterDir && command.includes(masterDir))
      || (/\.\./.test(command) && AMBIGUOUS.test(command))
      || /(^|[\s;&|(])cd\s+[^;&|]*[*?$`]/.test(command);
    if (refMaster && !commandIsReadOnly(command)) {
      block(`comando que referencia o MASTER (ou caminho ambíguo) e não é somente leitura: ${command.slice(0, 200)}`);
    }
    if (!allowProtected && PROTECTED_REF.test(command) && PROTECTED_MUTATING.test(command)) {
      block('comando que pode alterar a proteção (settings/hooks/src/security/src/config.js) — só com MINHAIA_ALLOW_PROTECTED_EDIT=1');
    }
  }

  function contentsOf(input) {
    const out = [];
    for (const k of ['content', 'new_string', 'new_source']) if (typeof input[k] === 'string') out.push(input[k]);
    if (Array.isArray(input.edits)) for (const e of input.edits) out.push(String((e && e.new_string) || ''));
    return out;
  }

  function checkFile(input, masterDir) {
    const target = input.file_path !== undefined ? input.file_path : input.notebook_path;
    if (target === undefined) return;
    if (typeof target !== 'string' || !target) block('caminho de arquivo inválido');
    const abs = realish(target);
    if ((masterDir && isInside(abs, masterDir)) || MASTER_NAME.test(abs)) block(`escrita no MASTER (somente leitura): ${target}`);
    if (isInside(abs, path.join(ROOT, '.secrets'))) block('.secrets/ é gravado pelo humano, fora do Claude');
    if (GENERATED.some((g) => isInside(abs, g))) block(`${path.relative(ROOT, abs)} é gerado a partir do MASTER — altere o manifesto/patches e rode \`minhaia sync\``);
    if (!allowProtected && PROTECTED.some((p) => isInside(abs, p))) block(`${path.relative(ROOT, abs)} é protegido — só com MINHAIA_ALLOW_PROTECTED_EDIT=1`);
    if (contentsOf(input).some(containsSecret)) block(`conteúdo com padrão de segredo em ${target} — use nome de variável; a chave vai em .secrets/.env (gravada pelo humano)`);
  }

  return function check(payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.tool_name !== 'string') block('payload inválido');
    const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
    const masterDir = resolveMasterDir();
    if (payload.tool_name === 'Bash') checkBash(String(input.command || ''), payload.cwd, masterDir);
    else checkFile(input, masterDir);
  };
}

function main(raw) {
  try {
    const check = makeChecker({
      config: require(path.join(ROOT, 'src', 'config.js')),
      containsSecret: require(path.join(ROOT, 'src', 'security', 'redact.js')).containsSecret,
      env: process.env,
    });
    let payload;
    try { payload = JSON.parse(raw); } catch { block('entrada não é JSON válido'); }
    check(payload);
  } catch (e) {
    block(`falha interna do guard (${e.message})`);
  }
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => main(raw));
}

module.exports = { segmentIsReadOnly, commandIsReadOnly, makeChecker };
