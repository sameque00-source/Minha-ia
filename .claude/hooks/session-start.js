#!/usr/bin/env node
/**
 * SessionStart — injeta no contexto da sessão o estado real da infraestrutura:
 * MASTER intacto? cópias íntegras? 25 agentes / 140 Skills sincronizados? chaves de LLM?
 * Nunca bloqueia a sessão (exit 0 sempre); só informa.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function main() {
  const lines = ['[MinhaIA] estado da infraestrutura MASTER:'];
  try {
    const { verify } = require(path.join(ROOT, 'src', 'master', 'verify.js'));
    const v = verify();
    lines.push(`- MASTER: ${v.masterDir || 'NÃO ENCONTRADO'}; git ${v.masterGit && v.masterGit.clean ? 'limpo' : 'COM ALTERAÇÕES ou indisponível'}`);
    lines.push(`- lock: ${v.files} arquivos; drift=${v.masterDrift.length}; cópias alteradas=${v.vendorTampered.length}; ausentes=${v.missingLocal.length}`);
    for (const p of v.problems) lines.push(`- PROBLEMA: ${p}`);
  } catch (e) {
    lines.push(`- verificação falhou: ${e.message}`);
  }
  try {
    const registry = require(path.join(ROOT, 'src', 'registry', 'index.js'));
    lines.push(`- agentes: ${registry.loadAgents().length}/25; Skills: ${registry.loadSkills().length}/140; regras: ${registry.loadRules().length}`);
  } catch (e) {
    lines.push(`- registros indisponíveis (${e.message}) — rode: node bin/minhaia.js sync`);
  }
  try {
    const { providerStatus } = require(path.join(ROOT, 'src', 'engine', 'index.js'));
    const p = providerStatus();
    lines.push(`- chaves LLM: ${p.configured.length ? p.configured.join(', ') : 'nenhuma (missões reais BLOQUEADAS)'}`);
  } catch { /* opcional */ }
  lines.push('- antes de montar equipe: node bin/minhaia.js select "<tarefa>"');
  process.stdout.write(`${lines.join('\n')}\n`);
}

main();
