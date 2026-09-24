const path = require('path');
const { paths } = require('../config');

// Reutiliza os padrões de segredo da memória do MASTER (memoria/core/sanitizacao.js) e soma
// os formatos que ela não cobre: chave Google (AIza...), `key=` em query string, chave privada.
const EXTRA = [
  [/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]'],
  [/([?&](?:key|api_key|apikey|token)=)[^&\s"']{8,}/gi, '$1[REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]'],
];

let masterMask = null;
function loadMasterMask() {
  if (masterMask) return masterMask;
  try {
    masterMask = require(path.join(paths.ENGINE_DIR, 'memoria', 'core', 'sanitizacao.js')).mascarrarSecrets;
  } catch {
    masterMask = (t) => ({ texto: t, sanitizado: false });
  }
  return masterMask;
}

function redact(text) {
  let out = loadMasterMask()(String(text)).texto;
  for (const [re, replacement] of EXTRA) out = out.replace(re, replacement);
  return out;
}

function containsSecret(text) {
  return redact(text) !== String(text);
}

module.exports = { redact, containsSecret };
