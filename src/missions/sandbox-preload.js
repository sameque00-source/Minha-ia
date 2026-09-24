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
    Object.defineProperty(obj, key, { value, writable: false, configurable: false, enumerable: false });
  };
  const net = require('net');
  lock(net.Socket.prototype, 'connect', deny);
  lock(net, 'connect', deny);
  lock(net, 'createConnection', deny);
  const tls = require('tls');
  lock(tls, 'connect', deny);
  const dgram = require('dgram');
  lock(dgram.Socket.prototype, 'send', deny);
  lock(dgram.Socket.prototype, 'connect', deny);
  lock(globalThis, 'fetch', denyAsync);
  for (const k of ['WebSocket', 'EventSource']) if (k in globalThis) lock(globalThis, k, deny);
}
