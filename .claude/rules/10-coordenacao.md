# Coordenação de agentes

> Origem: MASTER `01-USO-DIRETO-CLAUDE/.claude/rules/10-coordenacao.md` (conteúdo mantido;
> acrescentada a seleção determinística via `minhaia select`).

A sessão principal é o **coordenador**. Os 25 especialistas são sincronizados do MASTER para
`.claude/agents/` e chamados com a tool `Agent`. As 140 Skills ficam em `.claude/skills/`.

## Seleção antes de montar equipe

Rode `node bin/minhaia.js select "<tarefa>"`: devolve nível (classificador do
AI-ORCHESTRATOR), agentes, Skills ranqueadas com o motivo do match, regras e governança
(reviewer/security obrigatórios). Não escolha agente ou Skill arbitrariamente.

## Fluxo obrigatório

```
ANALISAR → PLANEJAR → DIVIDIR → PARALELO → REVISAR → INTEGRAR → TESTAR → VALIDAR
```

## Regras

1. **Paralelize com `run_in_background: true`.** Sem essa flag cada `Agent` bloqueia o próximo.
2. **Só o coordenador integra.** Especialista propõe; quem escreve no arquivo final é o
   coordenador. Evita dois agentes gravando o mesmo arquivo.
3. **Alto risco exige duas análises independentes.** Sempre `reviewer`; e `security` quando
   tocar autenticação, permissão, dinheiro, credencial ou dado sensível.
4. **VETO bloqueia.** `security` ou `reviewer` reprovando impede a integração. Corrija
   primeiro. Não contorne.
5. **Contexto sob medida.** Passe ao agente só os caminhos que ele precisa. O combo de modelos
   gratuitos tem teto de 64k tokens.
6. **Relate divergência.** Se dois agentes discordarem, mostre as duas posições e diga qual
   escolheu e por quê.

## Quando NÃO montar equipe

Pergunta simples, leitura de um arquivo, comando único (nível 0/1 do classificador): responda
direto. No nível 1 o `select` indica um único executor, **mas mantém todo agente com veto** que
a tarefa acionar (`testing`, `architecture`, `reviewer`, `security`): governança vale em qualquer
nível.

## Fases com barreira

```
FASE 1 (paralelo)  research · uiux · frontend · seo
        └── barreira
FASE 2 (paralelo)  security · performance · reviewer
        └── barreira
FASE 3 (sequencial) coordinator consolida
```
