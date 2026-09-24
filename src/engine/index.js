const fs = require('fs');
const path = require('path');
const { paths, secretNames, PROVIDER_KEYS } = require('../config');

// Acesso aos módulos do motor do MASTER (cópia vendorizada). Missões NÃO rodam por aqui:
// sempre pelo MissionManager (processo worker + sandbox do código gerado).

function engine(rel) {
  const f = path.join(paths.ENGINE_DIR, rel);
  if (!fs.existsSync(f)) throw new Error(`motor do MASTER não sincronizado (${rel}) — rode \`minhaia sync\``);
  return require(f);
}

/** Nomes das chaves de provedor configuradas em .secrets/.env (nunca os valores). */
function providerStatus() {
  const names = secretNames();
  const configured = PROVIDER_KEYS.filter((k) => names.has(k));
  return { secretsFile: fs.existsSync(paths.SECRETS_ENV), configured, missing: PROVIDER_KEYS.filter((k) => !names.has(k)), gatewayKey: names.has('GATEWAY_API_KEY') };
}

module.exports = {
  providerStatus,
  memory: () => engine('memoria/memoria.js'),
  autoRepair: () => engine('autocorrecao/autocorrecao.js'),
  research: () => engine('pesquisa/pesquisa.js'),
  llm: () => engine('planejador/core/chamar-llm.js'),
  router: () => engine('router/router.js'),
  specialists: () => engine('agentes/core/registro-especialistas.js'),
};
