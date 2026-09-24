const fs = require('fs');
const path = require('path');
const { paths, secretNames } = require('../config');
const registry = require('../registry');

// Nomes de provedor exatamente como em catalog/models.json → variável lida por gateway/providers.js.
const PROVIDER_KEY = { Groq: 'GROQ_API_KEY', 'Google AI Studio': 'GOOGLE_API_KEY', OpenRouter: 'OPENROUTER_API_KEY', '9Router': 'NINEROUTER_API_KEY' };

// Papéis que só revisam/vetam — nunca são "o executor" da tarefa.
const REVIEW_ONLY = new Set(['reviewer', 'security', 'security-auditor', 'queen-coordinator', 'coordinator']);

// Complementa `sugerirComposicaoPorObjetivo` (motor, router/core/composicao-agentes.js).
// O motor cobre 6 papéis, mas usa radicais com \b final (ex.: /\b(arquitetur)\b/), que nunca
// casam com a palavra inteira ("arquitetura"); os 6 são repetidos aqui com \w* e os outros 19
// canônicos são adicionados. Texto comparado já sem acentos (norm).
const EXTRA_AGENT_PATTERNS = {
  research: /\b(pesquis\w*|investig\w*|compar\w*)/,
  architecture: /\b(arquitetur\w*|estrutur\w*|refator\w*|design de sistema)/,
  coding: /\b(implement\w*|desenvolv\w*|refator\w*|codigo|program\w*)/,
  testing: /\b(test\w*|qa|caso extremo|validac\w*)/,
  reviewer: /\b(revis\w*|aprovar)/,
  security: /\b(seguranc\w*|vulnerab\w*)/,
  frontend: /\b(frontend|front-end|interface|tela|componente|react|vue|css|html|ui)\b/,
  backend: /\b(backend|back-end|servidor|rota|endpoint|banco de dados|database|sql|autentica\w*|jwt)\b/,
  devops: /\b(deploy|ci\/cd|pipeline|docker|container|kubernetes|infra\w*)\b/,
  debugger: /\b(bug|erro|exce[cç][aã]o|stack trace|quebrad\w+|falha\w*|n[aã]o funciona|corrigir)\b/,
  performance: /\b(lent[oa]|lentid[aã]o|gargalo|desempenho|performance|lat[eê]ncia)\b/,
  optimizer: /\b(otimiz\w+)\b/,
  docs: /\b(documenta\w+|readme|docs?)\b/,
  uiux: /\b(ux|design system|paleta|layout|visual)\b/,
  seo: /\b(seo|meta tags?|ranqueamento)\b/,
  memory: /\b(mem[oó]ria|lembrar|persistir conhecimento)\b/,
  '3d': /\b(3d|webgl|three\.?js|shader)\b/,
  cli: /\b(script|bash|powershell|linha de comando|cli|automatiz\w+)\b/,
  hooks: /\b(hooks?|sessionstart|pretooluse|posttooluse)\b/,
  integration: /\b(integra\w+|contrato entre|frontend e backend)\b/,
  mcp: /\b(mcp|model context protocol)\b/,
  swarm: /\b(swarm|enxame|hive.?mind|ruflo|claude-flow)\b/,
  'security-auditor': /\b(auditori\w*|audit\w*|varredura\w*|pentest\w*)/,
};

// Nível 1 usa um único executor: o agente mais específico que casou vence o genérico.
const EXECUTOR_PRIORITY = [
  'swarm', 'mcp', 'hooks', '3d', 'cli', 'integration', 'backend', 'frontend', 'devops', 'debugger',
  'performance', 'optimizer', 'seo', 'uiux', 'docs', 'memory', 'research', 'architecture', 'coding',
  'testing',
];

// Aplicado ao texto sem acentos. Conservador de propósito: falso positivo só acrescenta revisão.
const SENSITIVE = /\b(autentic\w*|autoriza\w*|login\w*|senha\w*|token\w*|credencia\w*|permiss\w*|pagamento\w*|pagar|dinheiro|financ\w*|dados? pessoa\w*|lgpd|gdpr|segredo\w*|secret\w*|jwt|oauth\w*|api[ _-]?keys?|chaves?|cartao\w*|criptograf\w*|sessao|sessoes|cookie\w*)/;

// Ponte PT→EN: as descrições das Skills do MASTER são majoritariamente em inglês.
const PT_EN = {
  teste: 'test', testes: 'tests', testar: 'test', seguranca: 'security', revisao: 'review', revisar: 'review',
  memoria: 'memory', desempenho: 'performance', banco: 'database', dados: 'data', implantar: 'deploy',
  arquitetura: 'architecture', documentacao: 'documentation', enxame: 'swarm', busca: 'search', vetorial: 'vector',
  pesquisa: 'research', planejamento: 'planning', planejar: 'plan', codigo: 'code', agentes: 'agents', agente: 'agent',
  otimizar: 'optimization', otimizacao: 'optimization', aprendizado: 'learning', fluxo: 'workflow', automacao: 'automation',
  navegador: 'browser', verificacao: 'verification', qualidade: 'quality', consenso: 'consensus', coordenacao: 'coordination',
  refatorar: 'refactor', migracao: 'migration', vulnerabilidade: 'vulnerability', auditoria: 'audit', embeddings: 'embeddings',
  cena: 'scene', iluminacao: 'lighting', grafico: 'graphics', graficos: 'graphics', renderizacao: 'rendering',
  pesquisar: 'research', investigar: 'research', revisar_codigo: 'code-review', depurar: 'debug', erro: 'error',
  interface: 'interface', tela: 'screen', implantacao: 'deployment', integracao: 'integration', especificacao: 'specification',
  requisitos: 'requirements', pseudocodigo: 'pseudocode', desempenho_web: 'performance', aplicativo: 'app', movel: 'mobile',
};

const STOP = new Set(['para', 'com', 'uma', 'que', 'dos', 'das', 'the', 'and', 'for', 'with', 'use', 'when', 'from', 'this', 'that', 'into', 'your', 'como', 'sobre', 'crie', 'criar', 'fazer', 'faça']);

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Radical simples em inglês ("researcher"/"researching" → "research"), aplicado a palavras longas.
function stem(w) {
  return w.length > 5 ? w.replace(/(ers|er|ing|ed|es|s)$/, '') : w;
}

function tokens(s) {
  const out = new Set();
  for (const w of norm(s).split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w);
    out.add(stem(w));
    if (PT_EN[w]) { out.add(PT_EN[w]); out.add(stem(PT_EN[w])); }
  }
  return out;
}

function loadVendor(rel) {
  const f = path.join(paths.VENDOR_DIR, rel);
  if (!fs.existsSync(f)) throw new Error(`módulo do MASTER não sincronizado: ${rel} — rode \`minhaia sync\``);
  return require(f);
}

/** Ranqueia Skills por sobreposição de termos com nome/descrição; "Skip when" penaliza. */
function rankSkills(task, skills, limit) {
  const t = tokens(task);
  return skills.map((s) => {
    const nameTok = tokens(`${s.id} ${s.name}`);
    const useTok = tokens(s.useWhen || s.description);
    const skipTok = s.skipWhen ? tokens(s.skipWhen) : new Set();
    const matched = [...t].filter((w) => nameTok.has(w) || useTok.has(w));
    const nameHits = [...t].filter((w) => nameTok.has(w)).length;
    const skipHits = [...t].filter((w) => skipTok.has(w)).length;
    const score = nameHits * 2 + matched.length - skipHits * 1.5;
    return { id: s.id, score, matched, requires: s.requires, origin: s.origin };
  }).filter((r) => r.score >= 2).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/**
 * Seleciona, para uma tarefa, os recursos do MASTER a usar: nível, agentes, Skills, regras,
 * governança e prévia de modelo. Determinístico, sem chamar LLM.
 */
function select(task, { maxSkills = 5 } = {}) {
  const { classify } = loadVendor('ai-orchestrator/classifier/classify.js');
  const { sugerirComposicaoPorObjetivo } = loadVendor('ia-avancado/router/core/composicao-agentes.js');
  const router = loadVendor('ia-avancado/router/router.js');

  const cls = classify(task);
  const text = norm(task);
  const agentsAll = registry.loadAgents();
  const known = new Set(agentsAll.map((a) => a.id));
  const reasons = {};
  const add = (id, why) => { if (known.has(id)) { reasons[id] = reasons[id] || []; reasons[id].push(why); } };

  const sensitive = SENSITIVE.test(text);
  if (cls.level > 0) {
    for (const [id, re] of Object.entries(EXTRA_AGENT_PATTERNS)) if (re.test(text)) add(id, `padrão: ${re.source.slice(0, 40)}`);
    const specific = Object.keys(reasons).length > 0;
    for (const id of sugerirComposicaoPorObjetivo(task)) {
      // o motor devolve 'coding' como fallback quando nada casa; só vale se nada específico casou
      if (id === 'coding' && specific && !reasons.coding) continue;
      add(id, 'composicao-agentes (motor)');
    }
    if (sensitive) { add('security', 'regra 10-coordenacao §3: toca dado sensível'); add('reviewer', 'regra 10-coordenacao §3: alto risco'); }
    if (cls.level >= 3) {
      add('queen-coordinator', 'nível ≥3: planejamento de fases no início');
      add('reviewer', 'nível ≥3: revisão adversarial obrigatória');
      add('coordinator', 'nível ≥3: consolidação no fim');
    }
  }
  let agents = Object.keys(reasons);
  if (cls.level === 1 && agents.length > 1) {
    // nível 1 = sem equipe (regra 10): um único executor — mas a redução nunca remove quem
    // tem veto (governança da regra 10 §3/§4 vale em qualquer nível).
    const executor = EXECUTOR_PRIORITY.find((a) => agents.includes(a)) || null;
    const vetoHolders = agents.filter((id) => agentsAll.find((a) => a.id === id).veto);
    agents = [...new Set([executor, ...vetoHolders].filter(Boolean))];
  }

  const skills = cls.level === 0 ? [] : rankSkills(task, registry.loadSkills(), cls.level === 1 ? Math.min(3, maxSkills) : maxSkills);

  const primary = agentsAll.find((a) => a.id === agents.find((x) => !REVIEW_ONLY.has(x)));
  const tipoTarefa = primary && primary.scoringType ? primary.scoringType : (cls.level >= 3 ? 'raciocinio' : 'texto');
  const decisao = router.decidirModelo({ tipoTarefa, complexidade: cls.level, precisaVisao: (cls.modality || []).includes('vision') });
  const keys = secretNames();
  const model = {
    tipoTarefa,
    motivo: decisao.motivo,
    chosen: decisao.escolhido ? decisao.escolhido.id : null,
    fallback: (decisao.ordemFallback || []).slice(0, 6).map((m) => ({ id: m.id, provider: m.provider, keyConfigured: keys.has(PROVIDER_KEY[m.provider]) })),
  };

  return {
    task,
    classification: cls,
    agents: agents.map((id) => ({ id, reasons: reasons[id], veto: agentsAll.find((a) => a.id === id).veto })),
    skills,
    rules: registry.loadRules().map((r) => r.id),
    governance: {
      reviewerRequired: agents.includes('reviewer'),
      securityRequired: agents.includes('security'),
      vetoHolders: agents.filter((id) => agentsAll.find((a) => a.id === id).veto),
      teamRecommended: cls.level >= 2,
    },
    model,
  };
}

module.exports = { select, rankSkills, tokens, EXTRA_AGENT_PATTERNS };
