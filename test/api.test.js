const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { SKIP_NO_MASTER, startApi, req, waitFinished } = require('./helpers');
const { providerStatus } = require('../src/engine');

const NO_KEYS = providerStatus().configured.length === 0;

test('API de missões: rotas, bloqueio honesto sem provedor e segurança', { skip: SKIP_NO_MASTER }, async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const { base } = api;

  await t.test('health, sistema, agentes, Skills, regras', async () => {
    assert.deepStrictEqual((await req(base, 'GET', '/api/health')).json, { ok: true });
    const sys = (await req(base, 'GET', '/api/system')).json;
    assert.strictEqual(sys.agents, 25);
    assert.strictEqual(sys.skills, 140);
    assert.strictEqual((await req(base, 'GET', '/api/agents')).json.length, 25);
    const hive = (await req(base, 'GET', '/api/skills?q=hive')).json;
    assert.ok(hive.some((s) => s.id === 'hive-mind'));
    assert.strictEqual((await req(base, 'GET', '/api/rules')).json.length, 3);
  });

  await t.test('select devolve análise determinística', async () => {
    const r = await req(base, 'POST', '/api/select', { body: { task: 'corrija o bug no endpoint de pagamento' } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.governance.securityRequired && r.json.governance.reviewerRequired);
    assert.strictEqual((await req(base, 'POST', '/api/select', { body: {} })).status, 400);
  });

  await t.test('missão sem provedor fica BLOQUEADA com motivo, com análise registrada', { skip: !NO_KEYS && 'há chave configurada' }, async () => {
    const created = await req(base, 'POST', '/api/missions', { body: { objective: 'Crie um script que soma dois números' } });
    assert.strictEqual(created.status, 201);
    const id = created.json.id;
    const fin = await waitFinished(api.manager, id, 30000);
    assert.strictEqual(fin.status, 'BLOQUEADA');
    const d = (await req(base, 'GET', `/api/missions/${id}`)).json;
    assert.match(d.blocked, /chave de provedor/);
    assert.ok(d.analysis && d.analysis.agents.length >= 1);
    const types = (await req(base, 'GET', `/api/missions/${id}/logs`)).json.map((e) => e.type);
    assert.deepStrictEqual(types, ['created', 'queued', 'started', 'analysis', 'blocked', 'finished']);
    assert.strictEqual((await req(base, 'POST', `/api/missions/${id}/cancel`, { body: {} })).status, 409);
    assert.strictEqual((await req(base, 'POST', `/api/missions/${id}/resume`, { body: {} })).status, 409);
    assert.strictEqual((await req(base, 'POST', `/api/missions/${id}/start`, { body: {} })).status, 409);
  });

  await t.test('SSE reenvia o histórico e usa event-stream', async () => {
    const list = (await req(base, 'GET', '/api/missions')).json;
    if (!list.length) return;
    const id = list[0].id;
    const frames = await new Promise((resolve, reject) => {
      const r = http.get(`${base}/api/missions/${id}/events`, (res) => {
        assert.match(res.headers['content-type'], /text\/event-stream/);
        let buf = '';
        res.on('data', (c) => { buf += c; if ((buf.match(/event: mission/g) || []).length >= 3) { r.destroy(); resolve(buf); } });
      });
      r.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
      setTimeout(() => { r.destroy(); reject(new Error('SSE sem dados')); }, 5000);
    });
    assert.match(frames, /^id: 1$/m);
  });

  await t.test('segurança: Host, Origin, Content-Type, tamanho, ids e traversal', async () => {
    // fetch não permite trocar o Host; http.request permite (simula DNS rebinding)
    const hostStatus = await new Promise((resolve, reject) => {
      const u = new URL(base);
      http.get({ host: u.hostname, port: u.port, path: '/api/health', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.strictEqual(hostStatus, 403);
    assert.strictEqual((await req(base, 'POST', '/api/missions', { body: { objective: 'x' }, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.strictEqual((await req(base, 'POST', '/api/missions', { body: 'objective=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.strictEqual((await req(base, 'POST', '/api/missions', { body: { objective: 'x'.repeat(20000) } })).status, 413);
    assert.strictEqual((await req(base, 'POST', '/api/missions', { body: '{nao json' })).status, 400);
    assert.strictEqual((await req(base, 'POST', '/api/missions', { body: { objective: '   ' } })).status, 400);
    assert.strictEqual((await req(base, 'GET', '/api/missions/..%2F..%2Fetc')).status, 404);
    assert.strictEqual((await req(base, 'GET', '/api/missions/mia_inexistente00')).status, 404);
    const list = (await req(base, 'GET', '/api/missions')).json;
    if (list.length) assert.strictEqual((await req(base, 'GET', `/api/missions/${list[0].id}/files?path=${encodeURIComponent('../../../../.secrets/.env')}`)).status, 404);
    assert.strictEqual((await req(base, 'GET', '/../.secrets/.env')).status, 404);
    assert.strictEqual((await req(base, 'GET', '/api/nada')).status, 404);
  });

  await t.test('UI servida com CSP estrita e cabeçalhos de segurança', async () => {
    const r = await req(base, 'GET', '/');
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /<title>MinhaIA<\/title>/);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.strictEqual(r.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual((await req(base, 'GET', '/app.js')).status, 200);
  });

  await t.test('shutdown encerra mesmo com stream SSE aberto', async () => {
    const { start } = require('../src/server');
    const s = await start({ port: 0 });
    const port = s.server.address().port;
    await new Promise((resolve, reject) => { http.get(`http://127.0.0.1:${port}/api/stream`, (res) => { res.once('data', resolve); }).on('error', reject); });
    const t0 = Date.now();
    await s.shutdown({ deadlineMs: 2000 });
    assert.ok(Date.now() - t0 < 3000, 'shutdown precisa terminar mesmo com SSE aberto');
    assert.strictEqual(s.server.listening, false);
  });

  await t.test('API só aceita escutar em loopback', async () => {
    const { start } = require('../src/server');
    await assert.rejects(() => start({ port: 0, host: '0.0.0.0' }), /loopback/);
  });
});
