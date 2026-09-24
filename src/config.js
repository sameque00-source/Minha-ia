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

/** true se `target` está dentro de `dir` (ou é o próprio), comparando caminhos reais. */
function isInside(target, dir) {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = { paths, resolveMasterDir, requireMasterDir, isInside };
