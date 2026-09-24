'use strict';
// Carregado pela MinhaIA (--require) em TODO código gerado pelo LLM que o motor executa, antes do
// código do usuário. O modelo de permissões do Node 22 não restringe rede; aqui as saídas de
// rede ficam bloqueadas de forma não reconfigurável (propriedades não graváveis e não
// configuráveis). Escutar numa porta continua permitido (servidores gerados são testados pelo
// motor a partir do worker, fora da sandbox). Opt-out consciente: MINHAIA_SANDBOX_ALLOW_NETWORK=1.
if (process.env.MINHAIA_SANDBOX_ALLOW_NETWORK !== '1') {
  const MSG = 'saída de rede bloqueada pela sandbox da MinhaIA (código gerado não acessa a rede)';
  const deny = function denyNetwork() {
    throw Object.assign(new Error(MSG), { code: 'ERR_MINHAIA_NETWORK_DENIED' });
  };
  const denyAsync = function denyNetworkAsync() {
    return Promise.reject(Object.assign(new Error(MSG), { code: 'ERR_MINHAIA_NETWORK_DENIED' }));
  };
  const lock = (obj, key, value) => {
    if (!obj) return;
    // enumerabilidade original preservada: os imports ESM nomeados (node:dns etc.) dependem dela
    const d = Object.getOwnPropertyDescriptor(obj, key);
    Object.defineProperty(obj, key, { value, writable: false, configurable: false, enumerable: d ? d.enumerable : false });
  };
  const net = require('net');
  // lookup só resolve IP literal (e localhost) localmente, sem consulta: mantém
  // server.listen(porta, '127.0.0.1') funcionando; qualquer nome real é negado.
  const literal = (host) => {
    const h = host === 'localhost' ? '127.0.0.1' : String(host);
    const family = net.isIP(h);
    return family ? { address: h, family } : null;
  };
  const lookupLiteral = function lookup(host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const r = literal(host);
    if (!r || typeof cb !== 'function') deny();
    process.nextTick(() => (opts && opts.all ? cb(null, [r]) : cb(null, r.address, r.family)));
  };
  const lookupLiteralAsync = async function lookup(host, opts) {
    const r = literal(host);
    if (!r) return denyAsync();
    return opts && opts.all ? [r] : r;
  };
  lock(net.Socket.prototype, 'connect', deny);
  lock(net, 'connect', deny);
  lock(net, 'createConnection', deny);
  const tls = require('tls');
  lock(tls, 'connect', deny);
  const dgram = require('dgram');
  lock(dgram.Socket.prototype, 'send', deny);
  lock(dgram.Socket.prototype, 'connect', deny);
  // DNS: getaddrinfo (lookup) e c-ares (resolve*/Resolver) consultam a rede no C++, abaixo de
  // net/dgram — sem este bloqueio, rótulos de subdomínio viram canal de exfiltração.
  const dns = require('dns');
  const ALLOWED_DNS = new Set(['getDefaultResultOrder', 'setDefaultResultOrder', 'getServers']);
  const seen = new Set(); // ResolverBase é compartilhado por dns e dns/promises
  /** @type {Array<[any, Function]>} */
  const targets = [[dns, deny], [dns.promises, denyAsync]];
  for (const [mod, d] of targets) {
    for (const C of [mod.Resolver, mod.Resolver && Object.getPrototypeOf(mod.Resolver)]) {
      const proto = C && C.prototype;
      if (!proto || proto === Object.prototype || seen.has(proto)) continue;
      seen.add(proto);
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (k !== 'constructor' && typeof proto[k] === 'function') lock(proto, k, d);
      }
    }
    for (const k of Object.keys(mod)) {
      if (typeof mod[k] !== 'function' || ALLOWED_DNS.has(k)) continue;
      if (k === 'lookup') lock(mod, k, mod === dns ? lookupLiteral : lookupLiteralAsync);
      else lock(mod, k, k === 'Resolver' ? deny : d);
    }
  }
  lock(globalThis, 'fetch', denyAsync);
  for (const k of ['WebSocket', 'EventSource']) if (k in globalThis) lock(globalThis, k, deny);
}
