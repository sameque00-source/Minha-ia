const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const MASTER_CANDIDATES = [
  path.join(ROOT, '..', 'claude-mestre-final-skills-em-lotes-completo'),
  path.join(ROOT, '..', 'CLAUDE-MESTRE-FINAL-SKILLS-EM-LOTES-COMPLETO'),
];

const MASTER_MARKER = path.join('01-USO-DIRETO-CLAUDE', '.claude', 'agents');

function resolveMasterDir() {
  const fromEnv = process.env.MINHAIA_MASTER_DIR;
  const candidates = fromEnv ? [fromEnv] : MASTER_CANDIDATES;
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (fs.existsSync(path.join(abs, MASTER_MARKER))) return fs.realpathSync(abs);
  }
  return null;
}

function requireMasterDir() {
  const dir = resolveMasterDir();
  if (!dir) {
    throw new Error(
      'MASTER não encontrado. Defina MINHAIA_MASTER_DIR ou clone CLAUDE-MESTRE-FINAL-SKILLS-EM-LOTES-COMPLETO ao lado do MinhaIA.'
    );
  }
  return dir;
}

const VENDOR_DIR = path.join(ROOT, 'vendor', 'master');

const paths = {
  ROOT,
  VENDOR_DIR,
  AIORCH_DIR: path.join(VENDOR_DIR, 'ai-orchestrator'),
  ENGINE_DIR: path.join(VENDOR_DIR, 'ia-avancado'),
  CLAUDE_AGENTS_DIR: path.join(ROOT, '.claude', 'agents'),
  CLAUDE_SKILLS_DIR: path.join(ROOT, '.claude', 'skills'),
  MANIFEST_PATH: path.join(ROOT, 'master.manifest.json'),
  LOCK_PATH: path.join(ROOT, 'master.lock.json'),
  DATA_DIR: path.join(ROOT, 'data'),
  SECRETS_DIR: path.join(ROOT, '.secrets'),
  SECRETS_ENV: path.join(ROOT, '.secrets', '.env'),
};

/** true se `target` está dentro de `dir` (ou é o próprio). Compara os caminhos como escritos. */
function isInside(target, dir) {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolve symlinks do ancestral existente mais profundo (o restante do caminho ainda não existe). */
function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { tail.unshift(path.basename(cur)); cur = path.dirname(cur); }
  try { cur = fs.realpathSync(cur); } catch { /* mantém */ }
  return path.join(cur, ...tail);
}

const PROVIDER_KEYS = ['GROQ_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'NINEROUTER_API_KEY'];

/**
 * Nomes de variáveis com valor não vazio em .secrets/.env (nunca os valores). Usa o mesmo
 * formato que o gateway do MASTER lê (`gateway/providers.js`: `CHAVE=valor`, sem `export`),
 * para não declarar "configurada" uma chave que o gateway não carregaria.
 */
function secretNames() {
  if (!fs.existsSync(paths.SECRETS_ENV)) return new Set();
  const names = new Set();
  for (const line of fs.readFileSync(paths.SECRETS_ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && /^[A-Z0-9_]+$/.test(m[1].trim()) && m[2].trim()) names.add(m[1].trim());
  }
  return names;
}

module.exports = { paths, resolveMasterDir, requireMasterDir, isInside, realish, secretNames, PROVIDER_KEYS };
