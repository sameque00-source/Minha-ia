# MinhaIA

Sistema de agentes construído **sobre** a infraestrutura MASTER
(`CLAUDE-MESTRE-FINAL-SKILLS-EM-LOTES-COMPLETO`), que é **somente leitura**. Arquitetura completa
em `docs/ARQUITETURA.md`; decisões e reúso em `docs/DECISOES.md`.

## Regras

`.claude/rules/00-escopo.md`, `10-coordenacao.md`, `20-evidencia.md` valem sempre.
Resumo: nunca alterar o MASTER; nunca segredo em arquivo/log; FREE_ONLY; não inventar; rotular
evidência; VETO de `reviewer`/`security` bloqueia.

## Como o MASTER entra aqui

- `master.manifest.json` declara o que é consumido; `node bin/minhaia.js sync` copia para
  `vendor/master/` (motor + AI-ORCHESTRATOR) e `.claude/agents` (25) / `.claude/skills` (140),
  aplica patches declarados e grava `master.lock.json` (sha256 origem/destino).
- `vendor/`, `.claude/agents/`, `.claude/skills/` são **gerados** (gitignored). Não edite: mude o
  manifesto/patch e rode `sync`. O hook `guard` bloqueia edição direta.
- Estado de runtime vai para `data/` (links criados pelo sync). Segredos só em `.secrets/.env`.

## Comandos

```
node bin/minhaia.js serve             # Web UI + API de missões em http://127.0.0.1:4317
node bin/minhaia.js doctor            # ambiente + MASTER intacto + 25/140 + chaves
node bin/minhaia.js verify            # prova de somente leitura (git status do MASTER + hashes)
node bin/minhaia.js select "<tarefa>" # agentes, Skills, regras, governança, modelo
node bin/minhaia.js run "<objetivo>"  # missão real (precisa de chave em .secrets/.env)
node bin/minhaia.js gateway           # gateway Anthropic-compatível em 127.0.0.1:20130
node bin/minhaia.js test-master       # suítes originais do MASTER com estado isolado
npm run check                         # typecheck + lint + testes (inclui API, integração, sandbox, UI)
```

## Fluxo de trabalho

1. `select` a tarefa antes de montar equipe (nível 0/1: responder direto).
2. Agentes pela tool `Agent`, em paralelo com `run_in_background: true` quando independentes.
3. Só o coordenador integra. `reviewer` sempre em alto risco; `security` se tocar
   auth/credencial/dado sensível.
4. Validar com execução real (`npm test`, `verify`) antes de declarar concluído.
