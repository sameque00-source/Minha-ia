const fs = require('fs');
const path = require('path');
const { paths, resolveMasterDir } = require('../config');
const { parseFrontmatter } = require('./frontmatter');

const RULES_DIR = path.join(paths.ROOT, '.claude', 'rules');

// Sinais de dependência externa detectados no corpo de cada SKILL.md.
const DEPENDENCY_SIGNALS = {
  'claude-flow': /claude-flow|npx ruflo|ruflo@/i,
  agentdb: /agentdb/i,
  'flow-nexus': /flow-nexus|flow nexus/i,
  github: /\bgh \w|github api|octokit/i,
  'mcp-tools': /mcp__/,
};

function requireSynced(dir, what) {
  if (!fs.existsSync(dir)) throw new Error(`${what} não sincronizado(s) — rode \`minhaia sync\``);
}

function splitUseSkip(description = '') {
  const useM = description.match(/use when:?\s*(.*?)(?=skip when|$)/is);
  const skipM = description.match(/skip when:?\s*(.*)$/is);
  return {
    useWhen: useM ? useM[1].trim().replace(/[.\s]+$/, '') : null,
    skipWhen: skipM ? skipM[1].trim().replace(/[.\s]+$/, '') : null,
  };
}

function loadEngineSpecialists() {
  const file = path.join(paths.ENGINE_DIR, 'agentes', 'core', 'registro-especialistas.js');
  return fs.existsSync(file) ? require(file).ESPECIALISTAS : {};
}

/** 25 agentes canônicos + metadados de execução do motor (veto, somente-leitura, tipo de scoring). */
function loadAgents() {
  requireSynced(paths.CLAUDE_AGENTS_DIR, 'agentes');
  const engine = loadEngineSpecialists();
  return fs.readdirSync(paths.CLAUDE_AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const id = f.replace(/\.md$/, '');
      const { data, body } = parseFrontmatter(fs.readFileSync(path.join(paths.CLAUDE_AGENTS_DIR, f), 'utf8'));
      const spec = engine[id] || null;
      return {
        id,
        name: data.name || id,
        description: data.description || '',
        tools: data.tools ? String(data.tools).split(',').map((s) => s.trim()).filter(Boolean) : [],
        file: path.relative(paths.ROOT, path.join(paths.CLAUDE_AGENTS_DIR, f)),
        readOnly: spec ? spec.somenteLeitura : !/\b(Edit|Write)\b/.test(String(data.tools || '')),
        veto: spec ? spec.temVeto : false,
        scoringType: spec ? spec.tipoTarefaScoring : null,
        engineMapped: !!spec,
        bodyChars: body.length,
      };
    });
}

function rufloSkillNames() {
  const master = resolveMasterDir();
  const dir = master && path.join(master, '01-USO-DIRETO-CLAUDE', '.claude', 'skills', 'ruflo');
  return dir && fs.existsSync(dir) ? new Set(fs.readdirSync(dir)) : null;
}

/** 140 Skills com descrição, gatilhos Use/Skip when e dependências externas detectadas. */
function loadSkills() {
  requireSynced(paths.CLAUDE_SKILLS_DIR, 'Skills');
  const ruflo = rufloSkillNames();
  return fs.readdirSync(paths.CLAUDE_SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(paths.CLAUDE_SKILLS_DIR, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort()
    .map((id) => {
      const file = path.join(paths.CLAUDE_SKILLS_DIR, id, 'SKILL.md');
      const text = fs.readFileSync(file, 'utf8');
      const { data } = parseFrontmatter(text);
      const description = String(data.description || '');
      return {
        id,
        name: data.name || id,
        nameIsSlug: data.name === id,
        description,
        ...splitUseSkip(description),
        origin: ruflo ? (ruflo.has(id) ? 'ruflo' : 'propria') : 'desconhecida',
        requires: Object.entries(DEPENDENCY_SIGNALS).filter(([, re]) => re.test(text)).map(([k]) => k),
        file: path.relative(paths.ROOT, file),
        chars: text.length,
      };
    });
}

/** Regras da MinhaIA (.claude/rules, versionadas) — adaptadas das 3 regras do MASTER. */
function loadRules() {
  if (!fs.existsSync(RULES_DIR)) return [];
  return fs.readdirSync(RULES_DIR).filter((f) => f.endsWith('.md')).sort().map((f) => {
    const text = fs.readFileSync(path.join(RULES_DIR, f), 'utf8');
    const title = (text.match(/^#\s+(.+)$/m) || [])[1] || f;
    const origin = (text.match(/^>\s*Origem:\s*(.+)$/m) || [])[1] || null;
    return { id: f.replace(/\.md$/, ''), title, origin, file: path.relative(paths.ROOT, path.join(RULES_DIR, f)) };
  });
}

function readAgentBody(id) {
  const f = path.join(paths.CLAUDE_AGENTS_DIR, `${id}.md`);
  return fs.existsSync(f) ? parseFrontmatter(fs.readFileSync(f, 'utf8')).body : null;
}

function readSkillBody(id) {
  const f = path.join(paths.CLAUDE_SKILLS_DIR, id, 'SKILL.md');
  return fs.existsSync(f) ? parseFrontmatter(fs.readFileSync(f, 'utf8')).body : null;
}

module.exports = { loadAgents, loadSkills, loadRules, readAgentBody, readSkillBody, splitUseSkip, DEPENDENCY_SIGNALS };
