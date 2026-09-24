const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { paths } = require('../src/config');
const { SKIP_NO_MASTER, isolateRuntime, freePort } = require('./helpers');
const engine = require('../src/engine');

const NO_KEYS = engine.providerStatus().configured.length === 0;


test('memória do MASTER: grava, recupera, mascara segredo, persiste em data/', { skip: SKIP_NO_MASTER }, () => {
  const rt = isolateRuntime();
  try {
    const mem = engine.memory();
    const fake = ['gsk', '_', 'z'.repeat(24)].join('');
    const r = mem.gravar({ tipo: 'fato', conteudo: `a biblioteca zeptojson usa parser incremental; chave ${fake}`, origem: 'teste', tags: ['zeptojson'] });
    assert.ok(r.ok, r.error);
    const hit = mem.lembrar('parser da biblioteca zeptojson');
    assert.ok(hit.achou);
    assert.ok(!hit.registros[0].conteudo.includes(fake), 'segredo não foi mascarado');
    assert.ok(hit.registros[0]._confiancaAtual < 1, 'confiança nunca absoluta');
    assert.ok(fs.existsSync(path.join(rt.dir, 'memoria', 'fato.json')), 'não persistiu no diretório de dados');
  } finally {
    rt.restore();
  }
});

test('autocorreção do MASTER: corrige com diagnóstico e para com FALHA_HONESTA no orçamento', { skip: SKIP_NO_MASTER }, async () => {
  const rt = isolateRuntime();
  try {
    const { executarComAutocorrecao, criarOrcamento } = engine.autoRepair();
    const ok = await executarComAutocorrecao({
      contextoInicial: { valor: 1 },
      executar: async (ctx) => ({ saida: ctx.valor * 2 }),
      avaliar: (res) => (res.saida === 8 ? { sucesso: true } : { sucesso: false, mensagemErro: `AssertionError: esperado 8, obtido ${res.saida}` }),
      corrigir: async ({ contextoAnterior }) => ({ valor: contextoAnterior.valor * 2 }),
    });
    assert.strictEqual(ok.status, 'SUCESSO_VALIDADO');
    assert.strictEqual(ok.tentativas, 3);

    const falha = await executarComAutocorrecao({
      orcamento: criarOrcamento({ maxTentativas: 3 }),
      executar: async () => ({}),
      avaliar: () => ({ sucesso: false, mensagemErro: 'Cannot find module \'inexistente\'' }),
      corrigir: async ({ contextoAnterior }) => contextoAnterior,
    });
    assert.strictEqual(falha.status, 'FALHA_HONESTA');
    assert.ok(falha.historico.length >= 2);
  } finally {
    rt.restore();
  }
});

test('facade do motor não expõe execução fora do worker (sem sandbox)', () => {
  assert.strictEqual(engine.runMission, undefined);
  assert.strictEqual(engine.resumeMission, undefined);
});

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitUp(port) {
  for (let i = 0; i < 50; i++) {
    try { return await request(port, 'GET', '/health'); } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('gateway não subiu');
}

test('gateway do MASTER: health, models, loopback e fallback honesto sem chaves', { skip: SKIP_NO_MASTER }, async () => {
  const rt = isolateRuntime();
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(paths.AIORCH_DIR, 'gateway', 'server.js')], { env: { ...process.env, GATEWAY_PORT: String(port) }, stdio: 'ignore' });
  try {
    const health = await waitUp(port);
    assert.strictEqual(health.status, 200);
    const models = JSON.parse((await request(port, 'GET', '/v1/models')).body);
    assert.ok(models.data.length > 0);

    if (process.platform === 'linux') {
      const hex = port.toString(16).toUpperCase().padStart(4, '0');
      const line = fs.readFileSync('/proc/net/tcp', 'utf8').split('\n').find((l) => l.includes(`:${hex} `) && l.includes(' 0A '));
      assert.ok(line && line.includes('0100007F:'), `gateway não está só em loopback: ${line}`);
    }

    if (NO_KEYS) {
      const r = await request(port, 'POST', '/v1/messages', { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: 'oi' }] });
      const j = JSON.parse(r.body);
      assert.strictEqual(j.type, 'error');
      assert.ok(j.error.attempts.length >= 2, 'fallback deveria tentar vários candidatos');
      const log = fs.readFileSync(path.join(rt.dir, 'logs', 'gateway', 'gateway.jsonl'), 'utf8');
      assert.match(log, /não configurada/);

      // sem GATEWAY_API_KEY, Host que não é loopback (ex.: DNS rebinding) é recusado
      const rebinding = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { host: 'evil.example:80', 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'x', max_tokens: 5, messages: [{ role: 'user', content: 'oi' }] }));
      });
      assert.strictEqual(rebinding, 401);
    }
  } finally {
    child.kill();
    rt.restore();
  }
});
