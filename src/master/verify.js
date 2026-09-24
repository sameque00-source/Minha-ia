const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { paths, resolveMasterDir } = require('../config');
const { sha256, masterGitHead, loadManifest, listDestFiles, toPosix } = require('./sync');

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
  const result = { ok: true, problems: [], masterDir: null, masterHead: null, lockHead: null, files: 0, masterDrift: [], vendorTampered: [], missingLocal: [], unexpectedLocal: [], badLinks: [], masterGit: null };
  const masterDir = resolveMasterDir();
  if (!masterDir) {
    result.ok = false;
    result.problems.push('MASTER não encontrado (defina MINHAIA_MASTER_DIR)');
    return result;
  }
  result.masterDir = masterDir;
  result.masterHead = masterGitHead(masterDir);
  result.masterGit = masterGitStatus(masterDir);
  if (!result.masterGit.ok) {
    result.ok = false;
    result.problems.push(`não foi possível rodar git status no MASTER (${result.masterGit.error}) — prova de somente leitura indisponível`);
  } else if (!result.masterGit.clean) {
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
    result.ok = false;
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

  // arquivos presentes nos destinos que o sync não gerou (os links de runtime não são percorridos)
  const manifest = loadManifest();
  const expected = new Set(Object.keys(lock.files));
  for (const source of manifest.sources) {
    for (const rel of listDestFiles(path.join(paths.ROOT, source.to))) {
      const key = toPosix(path.join(source.to, rel));
      if (!expected.has(key)) result.unexpectedLocal.push(key);
    }
  }
  result.unexpectedLocal = [...new Set(result.unexpectedLocal)];

  for (const link of (manifest.runtimeLinks && manifest.runtimeLinks.links) || []) {
    const at = path.join(paths.ROOT, link.at);
    let st = null;
    try { st = fs.lstatSync(at); } catch { /* ausente */ }
    const want = path.join(paths.ROOT, link.target);
    if (!st || !st.isSymbolicLink()) result.badLinks.push(`${link.at}: não é link`);
    else if (path.resolve(path.dirname(at), fs.readlinkSync(at)) !== want) result.badLinks.push(`${link.at}: aponta para ${fs.readlinkSync(at)} (esperado ${link.target})`);
  }

  if (result.unexpectedLocal.length) { result.ok = false; result.problems.push(`${result.unexpectedLocal.length} arquivo(s) nos destinos gerados que não vieram do sync`); }
  if (result.badLinks.length) { result.ok = false; result.problems.push(`link(s) de runtime incorretos: ${result.badLinks.join('; ')} — rode \`minhaia sync\``); }
  if (result.masterDrift.length) { result.ok = false; result.problems.push(`${result.masterDrift.length} arquivo(s) do MASTER divergem do lock`); }
  if (result.missingLocal.length) { result.ok = false; result.problems.push(`${result.missingLocal.length} cópia(s) local(is) ausente(s) — rode \`minhaia sync\``); }
  if (result.vendorTampered.length) { result.ok = false; result.problems.push(`${result.vendorTampered.length} cópia(s) local(is) alterada(s) fora do sync`); }
  return result;
}

module.exports = { verify, masterGitStatus };
