// Barramento de eventos do processo. No worker de missão, cada evento vai para o processo da
// API via IPC (process.send); fora dele, só para os ouvintes registrados.
const listeners = new Set();
let seq = 0;

function emit(type, data = {}) {
  const event = { seq: ++seq, ts: new Date().toISOString(), type, ...data };
  for (const fn of listeners) {
    try { fn(event); } catch { /* ouvinte nunca derruba o motor */ }
  }
  if (typeof process.send === 'function' && process.connected) {
    try { process.send({ kind: 'event', event }); } catch { /* canal fechado */ }
  }
  return event;
}

function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { emit, on };
