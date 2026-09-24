#!/usr/bin/env node
/**
 * PreToolUse — bloqueia (exit 2) antes de executar:
 *  1. qualquer escrita no MASTER (arquivo ou comando Bash que o altere);
 *  2. edição manual de cópias geradas (vendor/, .claude/agents, .claude/skills) — use `minhaia sync`;
 *  3. conteúdo com padrão de segredo sendo gravado em arquivo;
 *  4. comandos Bash destrutivos.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { resolveMasterDir, isInside } = require(path.join(ROOT, 'src', 'config.js'));
const { containsSecret } = require(path.join(ROOT, 'src', 'security', 'redact.js'));

const MASTER_NAME = /claude-mestre-final-skills-em-lotes-completo/i;
const GENERATED = ['vendor', path.join('.claude', 'agents'), path.join('.claude', 'skills')].map((p) => path.join(ROOT, p));

const MUTATING = /(^|[\s;&|(])(rm|rmdir|mv|cp|touch|mkdir|ln|chmod|chown|truncate|tee|dd|install|unzip|tar|patch|sed\s+(-[a-z]*i|--in-place)|perl\s+-[a-z]*i)\b|>{1,2}\s*(?!&|\/dev\/null)|\bgit\b[^;&|]*\b(commit|push|add|rm|mv|reset|checkout|switch|restore|clean|stash|rebase|merge|pull|apply|am|cherry-pick|tag|branch|init|clone|worktree|config|gc|prune|update-ref|fetch)\b|\bnpm\s+(i|install|ci|uninstall|update|link)\b/i;

const DESTRUCTIVE = [
  [/\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME|\.\.?)(\s|\/?$|\/\*)/i, 'rm recursivo/forçado em raiz, home ou diretório pai'],
  [/\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/i, 'git push forçado'],
  [/\bgit\s+reset\s+--hard\b/i, 'git reset --hard'],
  [/\bgit\s+clean\s+-[a-z]*f/i, 'git clean -f'],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i, 'descartar todas as alterações locais'],
  [/\bgit\s+branch\s+-D\b/, 'git branch -D'],
  [/\bmkfs(\.\w+)?\b|\bdd\s+[^;&|]*of=\/dev\//i, 'formatação/escrita em dispositivo'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
  [/\bchmod\s+-R\s+777\s+\//, 'chmod -R 777 na raiz'],
  [/\b(ssh|scp|sftp|rsync)\b/, 'acesso remoto (produção fora de escopo)'],
];

function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); }
  try { cur = fs.realpathSync(cur); } catch { /* mantém */ }
  return path.join(cur, ...tail);
}

function block(msg) {
  process.stderr.write(`[minhaia guard] BLOQUEADO: ${msg}\n`);
  process.exit(2);
}

function contentsOf(input) {
  if (typeof input.content === 'string') return [input.content];
  if (typeof input.new_string === 'string') return [input.new_string];
  if (Array.isArray(input.edits)) return input.edits.map((e) => e.new_string || '');
  if (typeof input.new_source === 'string') return [input.new_source];
  return [];
}

function checkFile(input, masterDir) {
  const target = input.file_path || input.notebook_path;
  if (!target) return;
  const abs = realish(target);
  if ((masterDir && isInside(abs, masterDir)) || MASTER_NAME.test(abs)) block(`escrita no MASTER (somente leitura): ${target}`);
  if (GENERATED.some((g) => isInside(abs, g))) block(`${path.relative(ROOT, abs)} é gerado a partir do MASTER — altere o manifesto/patches e rode \`minhaia sync\``);
  if (contentsOf(input).some(containsSecret)) block(`conteúdo com padrão de segredo em ${target} — use variável de ambiente ou .secrets/.env`);
}

function checkBash(command, masterDir) {
  for (const [re, why] of DESTRUCTIVE) if (re.test(command)) block(`comando destrutivo (${why}): ${command.slice(0, 200)}`);
  const touchesMaster = MASTER_NAME.test(command) || (masterDir && command.includes(masterDir));
  if (touchesMaster && MUTATING.test(command)) block(`comando que pode alterar o MASTER (somente leitura): ${command.slice(0, 200)}`);
}

function main(raw) {
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch { return; }
  const input = payload.tool_input || {};
  const masterDir = resolveMasterDir();
  if (payload.tool_name === 'Bash') checkBash(String(input.command || ''), masterDir);
  else checkFile(input, masterDir);
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => main(raw));
}

module.exports = { checkBash, checkFile, MUTATING, DESTRUCTIVE };
