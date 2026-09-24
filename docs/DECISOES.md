# Decisões arquiteturais e registro de reúso

## Registro "EXISTE NO MASTER?"

| Capacidade | Existe no MASTER? | Decisão | Onde |
|---|---|---|---|
| Agentes (25) | Sim — `01-USO-DIRETO-CLAUDE/.claude/agents` | Reutilizar (cópia verificada) | `.claude/agents`, motor |
| Skills (140) | Sim — `.claude/skills-flat-140` (deduplicada) | Reutilizar | `.claude/skills` |
| Regras (3) | Sim — 2 versões divergentes | Adaptar (base canônica + armadilhas extras) | `.claude/rules` |
| Orquestrador / DAG / estados / persistência | Sim — IA-AVANCADO `orquestrador/` | Reutilizar sem alteração | vendor |
| Planejador (LLM) | Sim — `planejador/` | Reutilizar | vendor |
| Executor + ferramentas | Sim — `executor/` | Reutilizar | vendor |
| Registro de especialistas + veto | Sim (19) | Adaptar: +6 via patch | vendor + `src/agents/especialistas-extra.js` |
| Router de modelos + aprendizado | Sim — `router/` + AI-ORCHESTRATOR | Reutilizar | vendor |
| Gateway Anthropic-compatível | Sim — `AI-ORCHESTRATOR/gateway` | Reutilizar + 2 patches de segurança | vendor |
| Fallback / circuit breaker | Sim — `gateway/scoring.js` | Reutilizar | vendor |
| Memória | Sim — `memoria/` (8 tipos) | Reutilizar; estado em `data/` | vendor |
| Autocorreção | Sim — `autocorrecao/` | Reutilizar | vendor |
| Pesquisa web | Sim — `pesquisa/` | Reutilizar | vendor |
| Multimídia / projetos | Sim | Reutilizar (disponível; não exposto na CLI ainda) | vendor |
| MCP claude-flow + Playwright | Sim — `.mcp.json` (só no backup) | Adaptar: versões fixadas, wrapper de browser | `.mcp.json`, `scripts/` |
| Permissões `settings.json` | Sim | Adaptar a lista `deny` | `.claude/settings.json` |
| Hooks | **Não** (`"hooks": {}`) | Implementar | `.claude/hooks` |
| API de missões / Web UI / painel | **Não** | Implementar sobre o motor (sem segundo motor) | `src/server`, `src/missions`, `ui/` |
| Injeção de Skills no contexto do agente | **Não** (motor só injetava a persona) | Patch declarado `skills-context` + `src/skills/context.js` | vendor + `src/skills` |
| Eventos de execução em tempo real | Parcial (motor persiste estado) | Instrumentar funções exportadas, sem alterar o motor | `src/missions/instrument.js` |
| Sandbox do código gerado | **Não** (motor executa código do LLM sem confinamento) | Implementar política no wrapper de ferramentas | `src/missions/instrument.js` |
| Registro de Skills / seleção por tarefa | **Não** (motor só usa persona do agente) | Implementar | `src/registry`, `src/selection` |
| Consumo somente leitura + lock | **Não** | Implementar | `src/master` |
| Redação de segredos em log | Parcial (padrões da memória) | Compor | `src/security/redact.js` |
| Suíte de testes | Sim (8 suítes do motor) | Reutilizar + testes próprios | `test/`, `test-master` |

## ADR-01 — 9Router :20128 vs AI-ORCHESTRATOR :20130

**Evidência** [CONFIRMADO]: nenhuma das portas estava ativa neste ambiente; o 9Router não é
código do MASTER (pacote npm de terceiros `9router@0.5.86`, sem fonte no repositório); o
gateway :20130 tem fonte completa, scoring, fallback e já inclui o 9Router como candidato; o
`settings.json` do MASTER aponta 20128 enquanto `AI-ORCHESTRATOR/MISSION_STATE.md` diz que o
gateway o substituiu (conflito documental).

**Decisão**:
- *Router interno*: módulos do AI-ORCHESTRATOR + router do motor, **in-process** (sem salto HTTP).
- *Gateway*: `AI-ORCHESTRATOR/gateway/server.js` em **127.0.0.1:20130**, para clientes externos
  (ex.: Claude Code via `ANTHROPIC_BASE_URL`, opt-in).
- *Endpoint principal*: 20130.
- *Fallback*: Groq/Google/OpenRouter por score → **9Router :20128 sempre por último** (só se
  instalado e com `NINEROUTER_API_KEY`).
- O `settings.json` do MinhaIA **não** define `ANTHROPIC_BASE_URL`: forçar um gateway que pode
  não estar rodando quebraria a sessão do Claude Code.

## ADR-02 — Consumir o MASTER por cópia verificada, nunca executar no lugar

Todo módulo de runtime do MASTER grava relativo ao próprio `__dirname` (logs, memória, missões,
cache). Executá-lo no lugar alteraria o MASTER. Solução: `sync` copia para `vendor/` (gitignored),
aplica patches declarados no manifesto (com contagem esperada — aborta se o MASTER mudar) e
grava `master.lock.json` com sha256 de origem e destino. Cópias são arquivos, nunca symlinks
(symlink permitiria escrita no MASTER através do link).

## ADR-03 — Estado de runtime em `data/`

Os diretórios de estado do código do MASTER viram symlinks para `data/` (e `config` → `.secrets/`).
Re-sync não apaga memória; `test-master` e os testes redirecionam para diretório temporário.

## ADR-04 — Patches mínimos e declarados

| Patch | Motivo |
|---|---|
| `windows-aiorch-path` (9×) | `require('C:/Users/Administrator/...')` impedia o motor de rodar fora daquela máquina |
| `windows-audio-env-path` | mesma causa em `multimidia/core/audio.js` |
| `gateway-bind-loopback` | original escutava em todas as interfaces, com auth desligada sem `GATEWAY_API_KEY` |
| `gateway-noauth-host-check` | sem chave, qualquer página/processo local podia usar a cota; passa a exigir `Host` de loopback |
| `gateway-log-redaction` | log gravava corpo de erro de provedor sem redação |
| `extra-specialists` | registro do motor tinha 19 de 25 agentes |
| `skills-context` | motor injetava só a persona; passa a injetar Skills selecionadas por tarefa + agente |

## ADR-05 — Seleção determinística

Seleção por tarefa sem LLM (rápida, auditável, testável): classificador do AI-ORCHESTRATOR +
composição do motor + padrões extras + ranking de Skills com o motivo do match. A decomposição
definitiva continua sendo do Planejador (LLM) durante a missão.

## ADR-06 — Missão sem chave é BLOQUEADA

Sem chave de provedor, `run` retorna `BLOQUEADO` com o motivo; não há provedor/agente simulado
fora de `test/`.

## ADR-07 — Revisão com veto antes de concluir a etapa

`reviewer` e `security` (personas do MASTER) revisaram a fundação de forma independente e
**ambos vetaram** a 1ª versão. Achados corrigidos: guard baseado em lista de bloqueio contornável
(cwd, glob, variáveis, interpretadores) → lista de permissão + fail-closed; `Bash(cat:*)`
contornava a negação de leitura de segredos; guard sem autoproteção; lacunas em padrões
destrutivos; sync não atômico e sem checagem de symlink; `verify` aprovando sem `git`, com HEAD
diferente ou com arquivos/links estranhos; seletor removendo `reviewer`/`security` no nível 1 e
vocabulário sensível estreito; `resume` aceitando texto livre como objetivo; mapa
provedor→chave com nomes errados; gateway sem auth aceitando qualquer `Host`.

## ADR-08 — Hook é defesa em profundidade

O hook reduz acidentes do agente, mas não é sandbox. A proteção forte do MASTER é o sistema
operacional (clone somente leitura). Não foi aplicada aqui porque alterar permissões do MASTER é
decisão do dono.

## ADR-09 — Uma missão por processo worker

Cada missão roda em `fork()` de `src/missions/worker.js`, que instancia o `Executor` do motor.
Motivos: cancelamento real (encerrar o processo, após registrar FALHA no motor), timeout,
falha contida, concorrência limitada. O estado das tarefas continua sendo o da máquina de
estados do motor; a API só observa e comanda — não há segundo motor.

## ADR-10 — Instrumentação em vez de fork do motor

Eventos (LLM, tentativas/fallback, ferramentas, autocorreção, snapshots, plano) vêm de wrappers
aplicados às funções exportadas **antes** de o Executor ser carregado (quem desestrutura recebe
o wrapper). Nenhuma linha do motor muda por causa da observabilidade.

## ADR-11 — Sandbox do código gerado

O motor do MASTER executa com `execFile` o código que o LLM gera. Testado: o modelo de
permissões do Node confina processos `node`, mas um filho com permissão de criar processos
escapa via outro executável (ex.: `python3`). Decisão: só `node` roda, com `--permission`
restrito ao workspace e **sem** permissão de criar processos; outros executáveis são recusados
(opt-in explícito `MINHAIA_ALLOW_UNSANDBOXED_COMMANDS=1`). Custo: soluções em Python ficam
bloqueadas por padrão.

## ADR-12 — UI sem framework e sem build

HTML/CSS/JS servido pela própria API, compatível com CSP `script-src 'self'` (nada inline).
Evita toolchain de build para uma UI de painel; tipagem via `checkJs` e testes no Chromium.

## ADR-13 — Dublê de LLM só em teste

`test/fixtures/stub-adapters.js` substitui os adapters de provedor **apenas** com
`NODE_ENV=test` + `MINHAIA_TEST_ADAPTERS` (o worker recusa fora disso — testado). Todo evento
sai rotulado `TEST-STUB(...)` e a UI mostra um aviso. Serve para validar o pipeline real do
motor (plano → grafo → ferramentas → revisão) sem provedor; nunca como resultado de produto.

## Conflitos encontrados no MASTER (registrados, não alterados)

| # | Onde | Conflito | Impacto | Tratamento na MinhaIA |
|---|---|---|---|---|
| 1 | `01-USO-DIRETO-CLAUDE/.claude/settings.json` × `AI-ORCHESTRATOR/MISSION_STATE.md` | rota ativa 20128 × 20130 | cliente pode apontar para proxy errado | ADR-01 |
| 2 | `.claude/rules/*` × `02-IA-AVANCADO-CLAUDE/.../base-agente/rules/*` | 3 regras com escopo diferente | regra errada aplicada | regras adaptadas, origem citada |
| 3 | `router/core/composicao-agentes.js` | regex com radical + `\b` final (`arquitetur\b`) nunca casa a palavra inteira | agentes deixam de ser sugeridos | seletor complementa com `\w*` |
| 4 | `registro-especialistas.js` × agentes canônicos | 19 × 25 | 6 agentes invisíveis ao motor | patch `extra-specialists` (teste do MASTER "exatamente 19" passa a falhar — intencional) |
| 5 | 20 `SKILL.md` | `name` é título ("AgentDB Advanced Features"), não slug | referência por nome ambígua | registro usa o nome da pasta como id |
| 6 | `02-IA-AVANCADO-CLAUDE/MISSION_STATE.md` | diz "fase 5+6 concluída", mas código e testes das fases 7-10 existem | estado documental desatualizado | considerar o código como fonte |
| 7 | `.mcp.json` do MASTER | `ruflo@latest`, `@playwright/mcp@latest` | supply chain / quebra silenciosa | versões fixadas nas testadas |
| 8 | `@playwright/mcp` padrão | procura `/opt/google/chrome` | falha onde só há Chromium | wrapper com `--executable-path` |
| 9 | `V2/manifests/SKILLS-INVENTARIO-275.md` | nome diz 275, conteúdo diz 140 | contagem errada | contagem real: 140 |
| 10 | `01-USO-DIRETO-CLAUDE/.claude/skills/` | `ruflo/` = `ruflo_135_skills_Pasta_1 (1)/Pasta 1/` (+ `ruflo.zip`) | duplicação | usa só `skills-flat-140` |

## Componentes do MASTER não usados

| Componente | Motivo |
|---|---|
| `AI-ORCHESTRATOR/router/execute.js` | versão anterior ao gateway (sem 9Router); substituído por `gateway/` |
| `AI-ORCHESTRATOR/test-agentic*` | scripts de fumaça triviais |
| `logs/`, `dados/`, `missions/` do MASTER | estado de outra máquina; MinhaIA começa limpa |
| zips da raiz, `ruflo_135_skills_Pasta_1 (1)`, `ruflo.zip` | duplicatas; zip com entrada corrompida (`console.log((i.isDirectory()`) |
| `CLAUDE-CODE-VS-AUTO-ULTIMATE/`, `V2/` (docs) | documentação/planejamento da origem; scripts PowerShell de Windows |
