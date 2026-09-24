const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { paths, requireMasterDir, isInside } = require('../config');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function globToRegex(glob) {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${esc}$`);
}

function loadManifest() {
  return JSON.parse(fs.readFileSync(paths.MANIFEST_PATH, 'utf8'));
}

function masterGitHead(masterDir) {
  try {
    return execFileSync('git', ['-C', masterDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Lista arquivos regulares de uma fonte do manifesto. Nunca segue symlinks do MASTER. */
function listSourceFiles(masterDir, source) {
  const base = path.join(masterDir, source.from);
  if (!fs.existsSync(base)) throw new Error(`fonte "${source.id}" ausente no MASTER: ${source.from}`);
  const excludeDirs = new Set(source.excludeDirs || []);
  const excludeFiles = (source.excludeFilePatterns || []).map((p) => new RegExp(p));
  const includeRes = (source.include || ['*']).map(globToRegex);
  const out = [];

  function walk(abs, rel) {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const entRel = rel ? `${rel}/${ent.name}` : ent.name;
      const entAbs = path.join(abs, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (excludeDirs.has(ent.name)) continue;
        walk(entAbs, entRel);
      } else if (ent.isFile()) {
        if (excludeFiles.some((re) => re.test(ent.name))) continue;
        out.push(entRel);
      }
    }
  }

  for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
    if (!includeRes.some((re) => re.test(ent.name))) continue;
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      if (excludeDirs.has(ent.name)) continue;
      walk(path.join(base, ent.name), ent.name);
    } else if (ent.isFile()) {
      out.push(ent.name);
    }
  }
  return out.sort();
}

function assertSafeDest(destAbs, masterDir) {
  if (!isInside(destAbs, paths.ROOT)) throw new Error(`destino fora do MinhaIA recusado: ${destAbs}`);
  if (isInside(destAbs, masterDir)) throw new Error(`destino dentro do MASTER recusado: ${destAbs}`);
}

function resolveTemplate(str, fileAbs) {
  return str.replace(/\{\{REL:([^}]+)\}\}/g, (_, target) => {
    const rel = path.relative(path.dirname(fileAbs), path.join(paths.ROOT, target));
    return toPosix(rel);
  });
}

function applyPatches(manifest, sourcesById) {
  const report = [];
  for (const patch of manifest.patches || []) {
    const src = sourcesById[patch.source];
    const destBase = path.join(paths.ROOT, src.to);
    const candidates = patch.file
      ? [patch.file]
      : listDestFiles(destBase).filter((f) => globToRegex(patch.fileGlob).test(f));
    let total = 0;
    const files = {};
    for (const relFile of candidates) {
      const abs = path.join(destBase, relFile);
      if (!fs.existsSync(abs)) throw new Error(`patch "${patch.id}": arquivo ausente ${relFile}`);
      const text = fs.readFileSync(abs, 'utf8');
      const count = text.split(patch.find).length - 1;
      if (count === 0) continue;
      const replacement = resolveTemplate(patch.replaceWith, abs);
      fs.writeFileSync(abs, text.split(patch.find).join(replacement));
      files[toPosix(path.join(src.to, relFile))] = count;
      total += count;
    }
    if (patch.expectCount !== undefined && total !== patch.expectCount) {
      throw new Error(`patch "${patch.id}": esperado ${patch.expectCount} ocorrência(s), encontrado ${total} — MASTER mudou? sync abortado`);
    }
    if (total === 0) throw new Error(`patch "${patch.id}": nenhuma ocorrência encontrada — MASTER mudou? sync abortado`);
    report.push({ id: patch.id, total, files });
  }
  return report;
}

function listDestFiles(base) {
  const out = [];
  function walk(abs, rel) {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const entRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) walk(path.join(abs, ent.name), entRel);
      else if (ent.isFile()) out.push(entRel);
    }
  }
  if (fs.existsSync(base)) walk(base, '');
  return out.sort();
}

/**
 * Cria os links de runtime. Com `dataRoot`, os alvos em data/ apontam para outra raiz
 * (usado por `test-master` para isolar o estado das suítes do MASTER).
 */
function createRuntimeLinks(manifest = loadManifest(), { dataRoot = null } = {}) {
  const created = [];
  for (const link of (manifest.runtimeLinks && manifest.runtimeLinks.links) || []) {
    const at = path.join(paths.ROOT, link.at);
    const redirected = dataRoot && link.target.startsWith('data/');
    const target = redirected ? path.join(dataRoot, link.target.slice('data/'.length)) : path.join(paths.ROOT, link.target);
    if (!isInside(at, paths.ROOT) || (!redirected && !isInside(target, paths.ROOT))) throw new Error(`runtime link fora do MinhaIA: ${link.at}`);
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.rmSync(at, { recursive: true, force: true });
    fs.symlinkSync(path.relative(path.dirname(at), target), at, 'dir');
    created.push(link);
  }
  return created;
}

/**
 * Materializa as fontes do MASTER em vendor/ e .claude/ (somente leitura no MASTER),
 * aplica os patches declarados, cria os links de runtime e grava master.lock.json.
 */
function sync({ log = () => {} } = {}) {
  const masterDir = requireMasterDir();
  const manifest = loadManifest();
  const sourcesById = Object.fromEntries(manifest.sources.map((s) => [s.id, s]));

  const toDirs = manifest.sources.map((s) => path.join(paths.ROOT, s.to));
  for (const [i, dir] of toDirs.entries()) {
    assertSafeDest(dir, masterDir);
    const nestedInEarlier = toDirs.slice(0, i).some((d) => isInside(dir, d));
    if (!nestedInEarlier) fs.rmSync(dir, { recursive: true, force: true });
  }

  const entries = {};
  for (const source of manifest.sources) {
    const files = listSourceFiles(masterDir, source);
    for (const rel of files) {
      const srcAbs = path.join(masterDir, source.from, rel);
      const destAbs = path.join(paths.ROOT, source.to, rel);
      assertSafeDest(destAbs, masterDir);
      const buf = fs.readFileSync(srcAbs);
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.writeFileSync(destAbs, buf);
      entries[toPosix(path.join(source.to, rel))] = {
        source: source.id,
        from: toPosix(path.join(source.from, rel)),
        sha256Source: sha256(buf),
      };
    }
    log(`[sync] ${source.id}: ${files.length} arquivo(s) de ${source.from}`);
  }

  const patchReport = applyPatches(manifest, sourcesById);
  for (const p of patchReport) log(`[sync] patch ${p.id}: ${p.total} ocorrência(s) em ${Object.keys(p.files).length} arquivo(s)`);

  for (const [dest, e] of Object.entries(entries)) {
    e.sha256Dest = sha256(fs.readFileSync(path.join(paths.ROOT, dest)));
    e.patched = e.sha256Dest !== e.sha256Source;
  }

  const links = createRuntimeLinks(manifest);
  log(`[sync] ${links.length} link(s) de runtime → data/ e .secrets/`);

  const lock = {
    _doc: 'Gerado por `minhaia sync`. Não editar à mão. sha256Source = arquivo no MASTER; sha256Dest = cópia no MinhaIA após patches.',
    masterGitHead: masterGitHead(masterDir),
    patches: patchReport,
    fileCount: Object.keys(entries).length,
    files: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.writeFileSync(paths.LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
  log(`[sync] lock gravado: ${lock.fileCount} arquivos, MASTER HEAD ${lock.masterGitHead || 'desconhecido'}`);
  return lock;
}

module.exports = { sync, sha256, listSourceFiles, loadManifest, masterGitHead, globToRegex, toPosix, createRuntimeLinks };
