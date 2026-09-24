/**
 * Os 6 agentes canônicos (01-USO-DIRETO-CLAUDE/.claude/agents) que o registro do motor
 * (IA-AVANCADO, agentes/core/registro-especialistas.js) não mapeava. Mesmo formato dos 19
 * originais; injetado no registro vendorizado pelo patch "extra-specialists" do manifesto.
 * Ferramentas usam o vocabulário do Executor (arquivos/terminal/navegador/api) e seguem o
 * campo `tools` do frontmatter de cada .md (sem Edit/Write => somenteLeitura).
 */
module.exports = {
  '3d': {
    arquivo: '3d', especialidade: 'gráficos 3D (WebGL, Three.js, shaders)', tipoTarefaScoring: 'codigo',
    ferramentas: ['arquivos', 'terminal'], somenteLeitura: false, temVeto: false,
    complexidadeTipica: 3, entradaEsperada: 'objetivo de cena/render 3D', saidaEsperada: 'código 3D real + medição de FPS antes/depois',
  },
  cli: {
    arquivo: 'cli', especialidade: 'scripts de automação (bash, PowerShell, Python)', tipoTarefaScoring: 'codigo',
    ferramentas: ['arquivos', 'terminal'], somenteLeitura: false, temVeto: false,
    complexidadeTipica: 2, entradaEsperada: 'operação a automatizar', saidaEsperada: 'script real executado e validado',
  },
  hooks: {
    arquivo: 'hooks', especialidade: 'hooks do Claude Code (SessionStart, PreToolUse, PostToolUse)', tipoTarefaScoring: 'codigo',
    ferramentas: ['arquivos', 'terminal'], somenteLeitura: false, temVeto: false,
    complexidadeTipica: 2, entradaEsperada: 'gatilho e comportamento desejado', saidaEsperada: 'hook configurado + teste com payload real',
  },
  integration: {
    arquivo: 'integration', especialidade: 'contratos entre camadas/sistemas', tipoTarefaScoring: 'codigo',
    ferramentas: ['arquivos', 'terminal'], somenteLeitura: false, temVeto: false,
    complexidadeTipica: 3, entradaEsperada: 'duas partes que precisam conversar', saidaEsperada: 'contrato + integração testada ponta a ponta',
  },
  mcp: {
    arquivo: 'mcp', especialidade: 'servidores e ferramentas MCP', tipoTarefaScoring: 'codigo',
    ferramentas: ['arquivos', 'terminal'], somenteLeitura: false, temVeto: false,
    complexidadeTipica: 2, entradaEsperada: 'servidor MCP a configurar/diagnosticar', saidaEsperada: 'config MCP + handshake validado',
  },
  swarm: {
    arquivo: 'swarm', especialidade: 'topologia/coordenação do swarm Ruflo', tipoTarefaScoring: 'raciocinio',
    ferramentas: ['arquivos', 'terminal'], somenteLeitura: true, temVeto: false,
    complexidadeTipica: 3, entradaEsperada: 'configuração de swarm a diagnosticar', saidaEsperada: 'diagnóstico/recomendação de topologia',
  },
};
