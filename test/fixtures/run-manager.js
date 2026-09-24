// Processo "dono" de teste: roda um MissionManager com o dublê e informa o workspace do código
// gerado assim que ele começa a executar. O teste mata ESTE processo com SIGKILL.
const { MissionManager } = require('../../src/missions/manager');
const m = new MissionManager();
m.subscribe((id, e) => { if (e.type === 'sandbox' && e.allowed) process.stdout.write(`SANDBOX ${e.workspace}\n`); });
m.create('Crie um script que soma dois números');
setInterval(() => {}, 1000);
