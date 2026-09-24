const fs = require('fs');
const path = require('path');
const { paths } = require('../config');

// Padrões preferenciais: os da memória do MASTER (memoria/core/sanitizacao.js), carregados da
// cópia vendorizada. FALLBACK cobre os mesmos formatos e mais alguns, para que a detecção
// nunca degrade em silêncio quando vendor/ ainda não foi sincronizado.
const FALLBACK = [
  /\b(sk-[A-Za-z0-9_-]{10,}|gsk_[A-Za-z0-9]{10,}|AQ\.[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{12,}|nr_[A-Za-z0-9_-]{10,})/g,
  // CHAVE=valor / chave: valor, inclusive com prefixo (NINEROUTER_API_KEY=, x-goog-api-key:)
  /[A-Za-z0-9_-]*(password|senha|passwd|token|api[_-]?key|secret)\s*[:=]\s*['"]?[^\s'"]{6,}/gi,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
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

// Valores literais das chaves configuradas: redigidos em qualquer formato em que apareçam.
let literalCache = { mtimeMs: -1, values: [] };
function literalSecrets() {
  let st;
  try { st = fs.statSync(paths.SECRETS_ENV); } catch { return []; }
  if (st.mtimeMs !== literalCache.mtimeMs) {
    const values = [];
    for (const line of fs.readFileSync(paths.SECRETS_ENV, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^[^#=]+=(.*)$/);
      const v = m && m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (v && v.length >= 8) values.push(v);
    }
    literalCache = { mtimeMs: st.mtimeMs, values: values.sort((a, b) => b.length - a.length) };
  }
  return literalCache.values;
}

function redact(text) {
  let out = String(text);
  for (const v of literalSecrets()) out = out.split(v).join('[REDACTED]');
  const mask = loadMasterMask();
  if (mask) out = mask(out).texto;
  for (const re of FALLBACK) out = out.replace(re, '[REDACTED]');
  for (const [re, replacement] of EXTRA) out = out.replace(re, replacement);
  return out;
}

/** Redige recursivamente todo valor string (e chaves) de um objeto — nunca o JSON já serializado. */
function redactDeep(value, depth = 0) {
  if (depth > 20) return '[profundidade excedida]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[redact(k)] = redactDeep(v, depth + 1);
    return out;
  }
  return value;
}

function containsSecret(text) {
  return redact(text) !== String(text);
}

module.exports = { redact, redactDeep, containsSecret, usingMasterPatterns: () => !!loadMasterMask() };
