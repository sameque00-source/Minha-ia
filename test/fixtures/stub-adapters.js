// DUBLÊ DE TESTE — nunca usado em produção. Só é carregado pelo worker com NODE_ENV=test e
// MINHAIA_TEST_ADAPTERS apontando para este arquivo; todos os eventos saem rotulados TEST-STUB.
// Responde no formato que cada módulo do motor espera, para exercitar o pipeline real
// (planejador → grafo → executor → ferramentas → QA → revisão) sem provedor de LLM.
const fs = require('fs');

function promptOf(ctx) {
  const c = ctx.messages && ctx.messages[0] && ctx.messages[0].content;
  return typeof c === 'string' ? c : JSON.stringify(c);
}

const PLAN = {
  interpretacao: 'criar um script Node que soma dois números e validar',
  requisitos: ['função soma(a, b)', 'imprimir soma(2, 3)'],
  restricoes: ['R$0'],
  entregaveis: ['soma.js'],
  modalidade: ['codigo'],
  riscos: ['nenhum relevante'],
  criteriosSucessoGeral: ['node soma.js imprime 5'],
  tarefas: [
    { id: 't1', descricao: 'Implementar soma.js com a função soma(a, b) e imprimir soma(2, 3)', tipo: 'codigo', dependeDe: [], agenteFuncao: 'developer', ferramentas: ['arquivos', 'terminal'], precisaPesquisa: false, justificativaPesquisa: null, criterioConclusao: ['node soma.js imprime 5'], decisaoUsuario: false, motivoDecisaoUsuario: null, recursoExclusivo: null },
    { id: 't2', descricao: 'Revisar criticamente o código de soma.js produzido', tipo: 'revisao', dependeDe: ['t1'], agenteFuncao: 'reviewer', ferramentas: ['arquivos'], precisaPesquisa: false, justificativaPesquisa: null, criterioConclusao: ['revisão aprovada'], decisaoUsuario: false, motivoDecisaoUsuario: null, recursoExclusivo: null },
  ],
};

const CODE = {
  arquivos: [{ caminho: 'soma.js', conteudo: 'function soma(a, b) { return a + b; }\nconsole.log(soma(2, 3));\nmodule.exports = { soma };\n' }],
  comandoTeste: 'node',
  comandoTesteArgs: ['soma.js'],
  tipoExecucao: 'unica',
  porta: null,
  rotaTeste: '/',
  explicacao: 'soma.js criado (dublê de teste)',
};

module.exports = async function stubAdapter(candidate, ctx) {
  const prompt = promptOf(ctx);
  const delay = Number(process.env.MINHAIA_TEST_STUB_DELAY_MS || 0);
  if (delay) await new Promise((r) => setTimeout(r, delay));
  if (process.env.MINHAIA_TEST_PROMPT_LOG) fs.appendFileSync(process.env.MINHAIA_TEST_PROMPT_LOG, `${JSON.stringify({ model: candidate.id, prompt })}\n`);
  let text;
  if (/módulo Planejador/.test(prompt)) text = JSON.stringify(PLAN);
  else if (/modo IMPLEMENTAÇÃO/.test(prompt)) text = JSON.stringify(CODE);
  else if (/"aprovado": true\|false/.test(prompt)) text = JSON.stringify({ aprovado: true, motivo: 'dublê de teste: aprovado', problemas: [], casosNaoCobertos: [] });
  else text = 'dublê de teste: resposta textual';
  return { ok: true, text, usage: { input_tokens: 0, output_tokens: 0 } };
};

// Cenários adversariais (só teste): código gerado que tenta escapar do workspace.
const SCENARIOS = {
  escape: () => ({ ...CODE, arquivos: [{ caminho: 'soma.js', conteudo: `const fs = require('fs');\nfs.writeFileSync(${JSON.stringify(require('path').join(process.env.MINHAIA_TEST_DECOY || '/nonexistent', 'ESCAPOU.txt'))}, 'x');\nconsole.log(5);\n` }] }),
  secrets: () => ({ ...CODE, arquivos: [{ caminho: 'soma.js', conteudo: `console.log(require('fs').readFileSync(${JSON.stringify(require('path').resolve(__dirname, '..', '..', 'package.json'))}, 'utf8').length);\n` }] }),
  python: () => ({ ...CODE, arquivos: [{ caminho: 'soma.py', conteudo: 'print(2 + 3)\n' }], comandoTeste: 'python3', comandoTesteArgs: ['soma.py'] }),
};
const baseAdapter = module.exports;
module.exports = async function scenarioAdapter(candidate, ctx) {
  const scenario = SCENARIOS[process.env.MINHAIA_TEST_STUB_SCENARIO];
  if (scenario && /modo IMPLEMENTAÇÃO/.test(promptOf(ctx))) {
    await baseAdapter({ id: candidate.id }, ctx); // registra prompt/atraso do mesmo jeito
    return { ok: true, text: JSON.stringify(scenario()), usage: { input_tokens: 0, output_tokens: 0 } };
  }
  return baseAdapter(candidate, ctx);
};
