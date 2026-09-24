const registry = require('../registry');
const { rankSkills } = require('../selection/selector');
const { parseFrontmatter } = require('../registry/frontmatter');
const fs = require('fs');
const path = require('path');
const { paths } = require('../config');
const bus = require('../runtime/bus');

// Chamado pelo motor (patch "skills-context" em executor/core/handlers-tarefa.js) ao montar o
// contrato de cada tarefa: escolhe poucas Skills relevantes para a tarefa + agente, injeta um
// trecho delas no contexto do agente e registra a decisão.

const MAX_SKILLS = Number(process.env.MINHAIA_MAX_SKILLS_PER_TASK || 2);
const MAX_CHARS = Number(process.env.MINHAIA_SKILL_CHARS || 1800);

// O executor do motor só tem arquivos/terminal/navegador/api: Skills que dependem destes
// serviços dariam instruções impossíveis de cumprir ali (continuam disponíveis no Claude Code).
const UNAVAILABLE_IN_ENGINE = new Set(['claude-flow', 'agentdb', 'flow-nexus', 'mcp-tools', 'github']);

let skillsCache = null;
const bodyCache = new Map();
const emitted = new Set();

function skills() {
  if (!skillsCache) skillsCache = registry.loadSkills();
  return skillsCache;
}

// Linhas que mandam usar serviço indisponível no motor são removidas do trecho injetado.
const UNAVAILABLE_LINE = new RegExp(
  [...UNAVAILABLE_IN_ENGINE].map((d) => registry.DEPENDENCY_SIGNALS[d].source).join('|'), 'i'
);

function skillMeta(id) {
  const f = path.join(paths.CLAUDE_SKILLS_DIR, id, 'SKILL.md');
  if (!bodyCache.has(id)) {
    const { data, body } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
    let removed = 0;
    const compact = body
      .replace(/```[\s\S]*?```/g, (m) => {
        if (UNAVAILABLE_LINE.test(m)) { removed += 1; return ''; }
        return m.length > 400 ? '```(bloco de código omitido)```' : m;
      })
      .split('\n').filter((l) => { if (UNAVAILABLE_LINE.test(l)) { removed += 1; return false; } return true; }).join('\n')
      .replace(/\n{3,}/g, '\n\n').trim();
    const declaredTools = data['allowed-tools'] || data.tools_required || null;
    bodyCache.set(id, {
      body: compact,
      removed,
      aboutUnavailable: [...UNAVAILABLE_IN_ENGINE].filter((d) => registry.DEPENDENCY_SIGNALS[d].test(`${id} ${data.name || ''} ${data.description || ''}`)),
      declaredTools: declaredTools ? String(declaredTools) : null,
    });
  }
  return bodyCache.get(id);
}

/**
 * @returns {{texto: string, registro: object}} texto a anexar à persona e o registro da escolha.
 */
function contextoDeSkills(tarefa, missao, especialista) {
  const agente = especialista ? especialista.chave || especialista.arquivo : null;
  const query = [tarefa.descricao, tarefa.tipo, agente, especialista && especialista.especialidade].filter(Boolean).join(' ');
  const ranked = rankSkills(query, skills(), MAX_SKILLS + 6);
  const usadas = [];
  const descartadas = [];
  for (const r of ranked) {
    if (usadas.length >= MAX_SKILLS) break;
    const meta = skillMeta(r.id);
    if (meta.aboutUnavailable.length) { descartadas.push({ id: r.id, motivo: `é sobre ${meta.aboutUnavailable.join(', ')} (indisponível no executor do motor)` }); continue; }
    if (meta.body.length < 200) { descartadas.push({ id: r.id, motivo: 'conteúdo útil insuficiente após remover comandos indisponíveis' }); continue; }
    const trecho = meta.body.length > MAX_CHARS ? `${meta.body.slice(0, MAX_CHARS)}\n…(trecho; Skill completa em .claude/skills/${r.id}/SKILL.md)` : meta.body;
    usadas.push({
      id: r.id,
      score: r.score,
      motivo: `termos em comum com a tarefa: ${r.matched.join(', ')}`,
      tools: meta.declaredTools || `não declarado — herda as do agente (${especialista ? especialista.ferramentas.join(', ') : 'nenhuma'})`,
      requires: r.requires,
      linhasRemovidas: meta.removed,
      origem: r.origin,
      chars: trecho.length,
      trecho,
    });
  }

  const registro = {
    tarefaId: tarefa.id,
    missaoId: missao && missao.id,
    agente,
    skills: usadas.map(({ trecho: _trecho, ...rest }) => rest),
    descartadas,
  };
  tarefa._skills = registro;

  const key = `${registro.missaoId}:${tarefa.id}:${usadas.map((u) => u.id).join(',')}`;
  if (!emitted.has(key)) {
    emitted.add(key);
    bus.emit('skills', registro);
  }

  const texto = usadas.length
    ? `SKILLS CARREGADAS PARA ESTA TAREFA (selecionadas por relevância; siga-as quando se aplicarem, sem violar o CONTRATO abaixo):\n\n${usadas.map((u) => `### Skill: ${u.id}\n${u.trecho}`).join('\n\n')}`
    : '';
  return { texto, registro };
}

module.exports = { contextoDeSkills, UNAVAILABLE_IN_ENGINE };
