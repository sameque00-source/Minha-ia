const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { paths, resolveMasterDir } = require('../config');
const { sha256, masterGitHead } = require('./sync');

function masterGitStatus(masterDir) {
  try {
    const out = execFileSync('git', ['-C', masterDir, 'status', '--porcelain'], { encoding: 'utf8' });
    return { ok: true, clean: out.trim() === '', lines: out.split('\n').filter(Boolean) };
  } catch (e) {
    return { ok: false, clean: null, error: e.message };
  }
}

/**
 * Compara MASTER e cópias locais com master.lock.json.
 * - masterDrift: arquivo de origem mudou/sumiu no MASTER desde o último sync.
 * - vendorTampered: cópia local diferente do que o sync gerou.
 * - masterGit: `git status --porcelain` do MASTER (prova de que continua intocado).
 */
function verify() {
  const result = { ok: true, problems: [], masterDir: null, masterHead: null, lockHead: null, files: 0, masterDrift: [], vendorTampered: [], missingLocal: [], masterGit: null };
  const masterDir = resolveMasterDir();
  if (!masterDir) {
    result.ok = false;
    result.problems.push('MASTER não encontrado (defina MINHAIA_MASTER_DIR)');
    return result;
  }
  result.masterDir = masterDir;
  result.masterHead = masterGitHead(masterDir);
  result.masterGit = masterGitStatus(masterDir);
  if (result.masterGit.ok && !result.masterGit.clean) {
    result.ok = false;
    result.problems.push(`MASTER tem alterações locais (git status não vazio): ${result.masterGit.lines.join(' | ')}`);
  }

  if (!fs.existsSync(paths.LOCK_PATH)) {
    result.ok = false;
    result.problems.push('master.lock.json ausente — rode `minhaia sync`');
    return result;
  }
  const lock = JSON.parse(fs.readFileSync(paths.LOCK_PATH, 'utf8'));
  result.lockHead = lock.masterGitHead;
  if (lock.masterGitHead && result.masterHead && lock.masterGitHead !== result.masterHead) {
    result.problems.push(`MASTER HEAD mudou (${lock.masterGitHead.slice(0, 12)} → ${result.masterHead.slice(0, 12)}) — revise e rode \`minhaia sync\``);
  }

  for (const [dest, e] of Object.entries(lock.files)) {
    result.files += 1;
    const srcAbs = path.join(masterDir, e.from);
    if (!fs.existsSync(srcAbs)) result.masterDrift.push({ file: e.from, kind: 'removido' });
    else if (sha256(fs.readFileSync(srcAbs)) !== e.sha256Source) result.masterDrift.push({ file: e.from, kind: 'alterado' });

    const destAbs = path.join(paths.ROOT, dest);
    if (!fs.existsSync(destAbs)) result.missingLocal.push(dest);
    else if (sha256(fs.readFileSync(destAbs)) !== e.sha256Dest) result.vendorTampered.push(dest);
  }

  if (result.masterDrift.length) { result.ok = false; result.problems.push(`${result.masterDrift.length} arquivo(s) do MASTER divergem do lock`); }
  if (result.missingLocal.length) { result.ok = false; result.problems.push(`${result.missingLocal.length} cópia(s) local(is) ausente(s) — rode \`minhaia sync\``); }
  if (result.vendorTampered.length) { result.ok = false; result.problems.push(`${result.vendorTampered.length} cópia(s) local(is) alterada(s) fora do sync`); }
  return result;
}

module.exports = { verify, masterGitStatus };
