# Arquitetura da MinhaIA

Estado: **fundação** (fase 1). Rótulos de evidência conforme `.claude/rules/20-evidencia.md`.
Decisões e o registro "existe no MASTER?" estão em [`DECISOES.md`](DECISOES.md).

## 1. Visão geral

A MinhaIA **não reimplementa** a infraestrutura. Ela consome o repositório MASTER
(`CLAUDE-MESTRE-FINAL-SKILLS-EM-LOTES-COMPLETO`) em modo somente leitura e acrescenta só o que
falta: integração entre as peças, seleção de recursos por tarefa, isolamento de estado,
segurança operacional (hooks) e testes.

```
                MASTER (somente leitura)
  01-USO-DIRETO-CLAUDE/.claude   AI-ORCHESTRATOR      00-ORIGINAIS-PRESERVADOS/02-IA-AVANCADO-CLAUDE
  25 agentes · 140 Skills · 3    gateway · classifier  orquestrador · planejador · executor · agentes
  regras                         router · catalog      memória · autocorreção · pesquisa · router
        │                              │                        │ multimídia · projetos
        └───────────── minhaia sync (manifesto + patches + lock sha256) ─────────────┘
                                       ▼
  MinhaIA ─ .claude/agents, .claude/skills (Claude Code)   vendor/master/* (runtime)   data/ (estado)
          ─ src/registry · src/selection · src/engine · src/security · bin/minhaia.js · hooks · .mcp.json
```

## 2. Módulos

| Módulo | Origem | Papel |
|---|---|---|
| `src/master/sync.js` | novo | Materializa as fontes do manifesto, aplica patches, cria links de runtime, grava `master.lock.json` |
| `src/master/verify.js` | novo | Prova de somente leitura: `git status` do MASTER + sha256 origem/destino |
| `src/registry/` | novo (lê MASTER) | Registro de 25 agentes (+ metadados de veto/RO do motor), 140 Skills (Use/Skip when, dependências), 3 regras |
| `src/selection/selector.js` | compõe MASTER | Nível (classifier do AI-ORCHESTRATOR) + composição de agentes (motor) + ranking de Skills + governança + prévia de modelo (router do motor) |
| `src/engine/index.js` | fachada | Missão real via `Executor` do motor; acesso a memória, autocorreção, pesquisa, LLM, router |
| `src/security/redact.js` | compõe MASTER | Padrões de segredo da memória do MASTER + chave Google/query/chave privada |
| `src/agents/especialistas-extra.js` | novo | 6 especialistas que o motor não mapeava (3d, cli, hooks, integration, mcp, swarm) |
| `vendor/master/ai-orchestrator` | MASTER | Gateway :20130, classificador, scoring/circuit breaker, adapters, catálogo free-only |
| `vendor/master/ia-avancado` | MASTER | Motor completo (DAG, planejador LLM, executor com ferramentas reais, especialistas com veto, memória, autocorreção, pesquisa web, multimídia, projetos) |
| `.claude/hooks/*` | novo | `guard` (PreToolUse) e `session-start` (SessionStart) |
| `scripts/mcp-playwright.js` | adapta MASTER | Inicia o MCP Playwright com versão fixada, browser detectado, saída em `data/` |

## 3. Dependências

- Node.js ≥ 22 (fetch global, `node:test`). Nenhuma dependência npm em runtime. [CONFIRMADO: v22.22.2]
- MASTER clonado ao lado (`../claude-mestre-final-skills-em-lotes-completo`) ou `MINHAIA_MASTER_DIR`.
- Para missões reais: ao menos uma chave em `.secrets/.env` — `GROQ_API_KEY`, `GOOGLE_API_KEY`,
  `OPENROUTER_API_KEY` ou `NINEROUTER_API_KEY` (+ 9Router rodando em :20128 para esta última).
- Opcional (MCP): `npx` com acesso ao registry npm; Chromium/Chrome para o Playwright.

## 4. Fluxo de execução

```
tarefa
  → select (classifier: nível 0-4/modalidade; agentes; Skills; regras; governança; modelo)
  → nível 0/1: resposta direta (sem equipe)
  → run: Planejador (LLM via router/decisor) decompõe em subtarefas com tipo + critérios
  → Orquestrador: DAG, máquina de estados, paralelismo por levas, persistência por passo
  → Executor: handlers por tipo; especialista resolvido no registro (25); persona .md injetada
       ferramentas reais (Read/Write/Edit/Bash/testarServidor) no workspace da missão
  → QA (testing) roda teste real · Security varre 5 padrões · Reviewer — VETO reabre a tarefa
  → Autocorreção: diagnosticar → estratégia → corrigir (orçamento: 3 tentativas/3 min/8 chamadas)
  → TESTANDO → REVISANDO → CONCLUIDA | FALHA honesta
  → memória: pesquisa/erro/solução/agente gravados (sanitizados) para missões futuras
```

## 5. Fluxo de agentes

- **Claude Code** (sessão interativa): 25 subagentes em `.claude/agents`, chamados pela tool
  `Agent`; o coordenador segue `10-coordenacao.md` (paralelo com `run_in_background`, só o
  coordenador integra, VETO bloqueia).
- **Motor** (missão autônoma): `agentes/core/registro-especialistas.js` — agora com 25 entradas
  (19 originais + 6 via patch). `gerenciador-agentes.js` lê `base-agente/agents` (25 canônicos
  sobrepostos pelo sync) e carrega o corpo do agente sob demanda.
- Portadores de veto: `architecture`, `testing`, `reviewer`, `security`, `security-auditor`.

## 6. Fluxo de Skills

`.claude/skills` (140) → descobertas pelo Claude Code [CONFIRMADO nesta sessão]. O seletor
ranqueia por sobreposição de termos (ponte PT→EN, "Skip when" penaliza) e devolve o motivo do
match. Só o `SKILL.md` das Skills selecionadas deve ser lido. 77 Skills dependem do
claude-flow (CLI/MCP), 21 do AgentDB, 19 do Flow Nexus — o registro expõe isso em `requires`.

## 7. Fluxo de modelos, routing e fallback

- **Classificação**: `classifier/classify.js` (regex, sem LLM) → nível e modalidade.
- **Decisão**: `router/router.js` do motor → `decisor.decidirModelo` (filtro free/sem cartão,
  adapters existentes, visão/ferramentas) → `scoring.ordenar` (aptidão, saúde observada,
  latência p50, folga de contexto, prioridade) + ajuste de aprendizado por histórico.
- **Fallback in-process** (`chamar-llm.js`): até 6 candidatos; pula quem não comporta o
  contexto (nunca trunca); registra resultado no scoring (cooldown por tipo de erro).
- **Fallback HTTP** (gateway :20130): mesma lógica + streaming SSE real + tradução de
  tool-calling Anthropic↔OpenAI↔Gemini; **9Router (:20128) fecha sempre a cadeia** como último
  recurso. [CONFIRMADO: 5 candidatos em 4 provedores tentados em ordem]

## 8. Memória

Motor `memoria/` (MASTER) sem alteração: 8 tipos (missão, projeto, agente, pesquisa, fato,
decisão, erro, solução), TTL por tipo, invalidação sem apagar, confiança ≤ 0,95, recall por
relevância, sanitização (segredos mascarados, id anti-path-traversal, conteúdo marcado como
dado). Persistência em `data/memoria/*.json` (link criado pelo sync; escrita atômica).

## 9. Auto-Repair

Motor `autocorrecao/` (MASTER) sem alteração: `executarComAutocorrecao({executar, avaliar,
corrigir})`, 10 categorias de diagnóstico, estratégia que muda ao detectar repetição (trocar
modelo/ferramenta, decompor, replanejar, consultar memória, bloquear), orçamento anti-loop,
memória de erro→solução. Usado pelo executor e pela multimídia.

## 10. Tools

Executor do motor: `arquivos` (Read/Write/Edit no workspace da missão, com locks),
`terminal` (Bash), `testarServidor`, `navegador`/`api` (pesquisa: npm, Wikipedia, DuckDuckGo).
Sessão Claude Code: ferramentas nativas + MCP.

## 11. MCP

`.mcp.json` do MinhaIA (adaptado do `.mcp.json` preservado no MASTER):
- `claude-flow`: `npx -y ruflo@3.44.0 mcp start` (versão fixada). [CONFIRMADO: handshake, 353 ferramentas]
- `playwright`: `node scripts/mcp-playwright.js` → `@playwright/mcp@0.0.82`, `--isolated --headless`,
  `--output-dir data/playwright`, browser detectado. [CONFIRMADO: navegação real renderizou página local]

## 12. Segurança

- MASTER: nunca executado no lugar; `sync` só lê, recusa MASTER com alterações locais, recusa
  destino fora do MinhaIA, dentro do MASTER (também após resolver symlinks) ou que atravesse
  symlink; é atômico (monta em staging e troca — falha deixa a instalação anterior intacta);
  symlinks do MASTER não são seguidos; cópias são arquivos, nunca symlink para o MASTER.
- `verify`: falha se `git status` do MASTER não puder rodar ou não estiver limpo, se o HEAD mudou,
  se houver cópia alterada/ausente, arquivo extra nos destinos gerados ou link de runtime desviado.
- Hook `guard` (PreToolUse, fail-closed) — **defesa em profundidade, não sandbox**:
  - Bash que referencia o MASTER (texto, caminho, `cwd`, glob/variável/substituição ambígua) só
    passa se todos os segmentos forem comandos de leitura de uma lista de permissão
    (`ls`, `cat`, `grep`, `git status|log|diff|show`…); interpretadores (`node -e`, `python -c`),
    `find -delete`, `npm --prefix`, redirecionamentos e `ln` são bloqueados.
  - Qualquer Bash que toque `.secrets`/`.env`/`ai-orchestrator/config` é bloqueado; escrita com
    padrão de segredo é bloqueada; `.secrets/` é gravado só pelo humano.
  - Autoproteção: `settings*.json`, `.claude/hooks/`, `src/security/`, `src/config.js` só com
    `MINHAIA_ALLOW_PROTECTED_EDIT=1` no ambiente em que o humano iniciou o Claude Code.
  - Destrutivos: `rm -r` em alvo raiz/home/pai/glob/variável/dados, push forçado (inclui `+ref`),
    `reset --hard`, `clean -f`, `find -delete`, acesso remoto.
  - Limites conhecidos (casamento de texto não é sandbox): qualquer indireção passa — nome montado
    por concatenação (`'claude-mes'+'tre…'` dentro de `node -e`), script gravado no MinhaIA e
    executado depois, ou symlink criado fora do Claude. Falso positivo conservador: `|` e `>`
    dentro de aspas (`grep 'a|b'`, `--format='%h > %s'`) são tratados como separador/
    redirecionamento. Qualquer Bash que cite `.env` é bloqueado, inclusive `.env.example`.
  - **Proteção forte recomendada** (decisão do dono do MASTER, não aplicada aqui): tornar o clone do
    MASTER somente leitura no SO (`chmod -R a-w` ou montagem read-only) e `.secrets/` com
    `chmod 600`.
- `settings.json`: nega leitura de `.env`/`.secrets`/chaves SSH, escrita em `.secrets`, acesso
  remoto; `cat` não é pré-aprovado (evita contornar os bloqueios de leitura).
- Gateway: bind em 127.0.0.1, sem `GATEWAY_API_KEY` só aceita `Host` de loopback (anti DNS
  rebinding), log com redação — 3 patches; `minhaia gateway` recusa host não-loopback sem chave.
- Segredos só em `.secrets/.env` (gitignored); `providerStatus` expõe só nomes, nunca valores, e
  lê no mesmo formato do gateway (`CHAVE=valor`, valor não vazio).

## 13. Observabilidade

| Sinal | Onde |
|---|---|
| Cada tentativa de provedor (latência, erro classificado) | `data/logs/gateway/gateway.jsonl` |
| Saúde/cooldown por modelo | `data/logs/gateway/health-state.json` |
| Uso de agentes | `data/logs/agentes/agentes.jsonl` |
| Estado e eventos da missão | `data/missions/<id>/MISSION_STATE.json` |
| Integridade do MASTER/cópias | `minhaia verify`, hook SessionStart |

Painel/agregação: **não implementado** (seção 20).

## 14. Testes e quality gates

- `npm test` — 78 testes da MinhaIA (`pretest` roda `sync`): sync/lock/verify (incl. atomicidade,
  intruso, link desviado), registros, seletor (governança de alto risco), 50 casos do guard
  (bypasses reais da revisão de segurança), redação, memória, autocorreção, missão/resume
  bloqueados sem chave, gateway real (loopback, fallback, anti-rebinding). Estado isolado em tmp,
  restaurado também em SIGINT/SIGTERM.
- `minhaia test-master` — as 8 suítes originais do MASTER contra a cópia vendorizada, estado isolado.
- Gates antes de concluir etapa: `npm test` verde · `minhaia verify` OK · revisão `reviewer` +
  `security` sem veto · nenhum segredo (hook + redação).

## 15. CLI

`bin/minhaia.js`: `sync`, `verify`, `doctor`, `agents`, `skills`, `rules`, `select`, `run`,
`missions`, `resume`, `memory recall|save`, `gateway`, `test-master`; `--json` em todos.

## 16. API

- **Existente**: gateway Anthropic Messages API (`/v1/messages`, `/v1/models`, `/health`) em
  `127.0.0.1:20130`. Uso opt-in: `ANTHROPIC_BASE_URL=http://127.0.0.1:20130` num cliente.
- **Planejado**: API de missões da MinhaIA (criar/listar/retomar/eventos). Não implementado.

## 17. Web UI

Não implementada nesta fase. Plano: painel sobre `data/` (missões, eventos, saúde de
provedores) consumindo a API de missões.

## 18. Checkpoints e recuperação

O orquestrador persiste `MISSION_STATE.json` a cada transição (escrita atômica .tmp+rename);
`minhaia resume <id>` retoma sem reexecutar tarefas concluídas (coberto pelas suítes do MASTER).
Re-sync nunca apaga `data/`. Backups de estado fora do Git: `data/` e `.secrets/` são do usuário.

## 19. Estrutura de diretórios

```
Minha-ia/
├── CLAUDE.md · package.json · master.manifest.json · master.lock.json · .mcp.json
├── bin/minhaia.js
├── src/{config.js, master/, registry/, selection/, engine/, security/, agents/}
├── scripts/mcp-playwright.js
├── .claude/{settings.json, hooks/, rules/}   (+ agents/, skills/ gerados)
├── test/*.test.js
├── docs/{ARQUITETURA.md, DECISOES.md}
├── vendor/master/{ai-orchestrator, ia-avancado}   (gerado, gitignored)
├── data/   (runtime, gitignored)   · .secrets/ (gitignored)
```

## 20. Contratos/interfaces

- `select(tarefa) → {classification:{level,modality,effort}, agents:[{id,reasons,veto}],
  skills:[{id,score,matched,requires,origin}], rules:[id], governance:{reviewerRequired,
  securityRequired,vetoHolders,teamRecommended}, model:{chosen,tipoTarefa,motivo,fallback:[{id,provider,keyConfigured}]}}`
- `runMission(objetivo) → {status:'CONCLUIDA'|'FALHA'|'BLOQUEADO', missionId, state, events, selection, reason?}`
- `verify() → {ok, problems, masterGit:{clean}, masterDrift, vendorTampered, missingLocal}`
- Contrato de tarefa do motor (`agentes/core/contrato.js`): INPUT/CONTEXT/OBJECTIVE/TOOLS/
  CONSTRAINTS/EXPECTED_OUTPUT/SUCCESS_CRITERIA.
- Hooks: stdin JSON do Claude Code; `exit 2` + stderr = bloqueio.

## 21. Pendências (próximas fases)

API de missões · Web UI · comando de observabilidade agregada · uso das Skills dentro do motor
autônomo (hoje: seleção + Claude Code; o motor injeta só a persona do agente) · missão real com
LLM **NÃO VALIDADA** neste ambiente (sem chave; Groq/OpenRouter bloqueados pela rede).
