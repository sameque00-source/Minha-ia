# Evidência e honestidade técnica

> Origem: MASTER `01-USO-DIRETO-CLAUDE/.claude/rules/20-evidencia.md` + armadilhas adicionais da
> versão em `00-ORIGINAIS-PRESERVADOS/02-IA-AVANCADO-CLAUDE/.../base-agente/rules/20-evidencia.md`.
> Armadilhas exclusivas de Windows/Git Bash foram mantidas por serem herdadas do ambiente de origem.

## Nunca inventar

Não invente API, comando, evento, export, permissão, caminho, versão nem teste.
Se não leu, diga que não leu. Se não executou, diga que não executou.

**"Deve funcionar" não é validação.** Prova é: log, hash, contagem, medição ou execução real.
Quando não houver evidência: **NÃO VALIDADO**.

## Rótulos

| Rótulo | Significado |
|---|---|
| `[CONFIRMADO]` | Li ou executei |
| `[INFERIDO]` | Deduzi a partir de outra coisa |
| `[PRECISA VERIFICAÇÃO]` | Não sei |
| `[RECOMENDAÇÃO]` | Opinião |
| `[PENDENTE — NÃO TESTADO]` | Escrito mas não validado |

## Mock nunca é produto

Dublês de provedor/agente/ferramenta existem só em `test/`. Nunca apresentar resultado de
dublê como funcionalidade real.

## Não parar na primeira falha

Investigue a causa, tente outra abordagem, teste de novo. Só declare impossível depois de
provar que a limitação é externa.

## Não entregar pela metade

Se parte ficou de fora, diga qual e por quê.

## Armadilhas já pagas

| Armadilha | Detalhe |
|---|---|
| `((VAR++))` com `set -e` | Sai do script quando `VAR=0`. Use `VAR=$((VAR+1))` |
| Heredoc grande no shell | Come contrabarra. Escreva o arquivo e envie |
| Playwright + `file://` | Bloqueado. Sirva por `http://127.0.0.1:porta` |
| Subagente com `model:` fixo | Falha com 404 se o modelo não existir no backend. Omita `model:` |
| Tool de subagente | Chama-se `Agent`, não `Task` |
| Groq: teto ~7-8k tokens/minuto por conta | Pedidos grandes (13-17k tokens) devem ser excluídos da Groq por estimativa antes de tentar, senão HTTP 413 em loop (tratado no gateway) |
| Módulos do MASTER gravam relativo ao `__dirname` | Nunca executar código do MASTER no lugar: sempre a cópia `vendor/` (estado vai para `data/` via link) |
| `cmd /c` a partir de Git Bash (Windows) | `/c` vira letra de unidade; use `cmd //c` ou `MSYS_NO_PATHCONV=1` |
