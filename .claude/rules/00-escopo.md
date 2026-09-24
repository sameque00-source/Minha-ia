# Escopo e limites da MinhaIA

> Origem: MASTER `01-USO-DIRETO-CLAUDE/.claude/rules/00-escopo.md` (adaptado). O alvo de
> produção de terceiros (FiveM/VPS imperion) continua fora de escopo; foi acrescentada a
> proteção do próprio MASTER, que é a fonte da infraestrutura.

## Fora de escopo — nunca tocar

| Alvo | Motivo |
|---|---|
| Repositório MASTER `CLAUDE-MESTRE-FINAL-SKILLS-EM-LOTES-COMPLETO` | Fonte somente leitura. Consumido via `minhaia sync`; nunca editar, criar, apagar, mover, commitar. Hook `guard` bloqueia |
| FiveM / FXServer / txAdmin / `server.cfg` / `resources` | Produção de terceiros |
| Qualquer VPS / `ssh` | Produção real — negado em `settings.json` |
| Qualquer projeto fora desta pasta | Não é escopo deste workspace |

Essas restrições valem mesmo quando parecem convenientes de contornar.

## Credenciais

Chaves de provedor vivem só em `.secrets/.env` (gitignored). O gateway vendorizado lê
`vendor/master/ai-orchestrator/config/.env`, que é um link para `.secrets/`.

Nunca escreva API key, token, secret, senha ou cookie em README, JSON, script, documento,
log ou memória. Referencie por nome de variável. Hook `guard` bloqueia escrita com padrão de
segredo; a memória mascara segredos antes de gravar.

## Custo

`FREE_ONLY=true`. O catálogo (`catalog/models.json`) só torna elegível `free: true` e
`requires_card != true`. Nenhum modelo pago pode ser habilitado.

## Antes de alterar arquivo existente fora do Git

Arquivo versionado: o Git é o backup. Arquivo não versionado (ex.: `data/`, `.secrets/`):
copiar antes e registrar `sha256sum`.
