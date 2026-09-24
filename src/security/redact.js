const path = require('path');
const { paths } = require('../config');

// Padrões preferenciais: os da memória do MASTER (memoria/core/sanitizacao.js), carregados da
// cópia vendorizada. FALLBACK replica esses mesmos padrões para que a detecção nunca degrade
// em silêncio quando vendor/ ainda não foi sincronizado.
const FALLBACK = [
  /\b(sk-[a-zA-Z0-9]{10,}|gsk_[a-zA-Z0-9]{10,}|AQ\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{12,})\b/g,
  /\b(password|senha|passwd|token|api[_-]?key|secret)\s*[:=]\s*['"]?[^\s'"]{6,}['"]?/gi,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/g,
];

// Formatos que a memória do MASTER não cobre.
/** @type {Array<[RegExp, string]>} */
const EXTRA = [
  [/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]'],
  [/([?&](?:key|api_key|apikey|token)=)[^&\s"']{8,}/gi, '$1[REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]'],
];

let masterMask;
function loadMasterMask() {
  if (masterMask !== undefined) return masterMask;
  try {
    masterMask = require(path.join(paths.ENGINE_DIR, 'memoria', 'core', 'sanitizacao.js')).mascarrarSecrets;
  } catch {
    masterMask = null;
  }
  return masterMask;
}

function redact(text) {
  let out = String(text);
  const mask = loadMasterMask();
  if (mask) out = mask(out).texto;
  for (const re of FALLBACK) out = out.replace(re, '[REDACTED]');
  for (const [re, replacement] of EXTRA) out = out.replace(re, replacement);
  return out;
}

function containsSecret(text) {
  return redact(text) !== String(text);
}

module.exports = { redact, containsSecret, usingMasterPatterns: () => !!loadMasterMask() };
