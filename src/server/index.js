const fs = require('fs');
const http = require('http');
const path = require('path');
const { paths } = require('../config');
const { MissionManager } = require('../missions/manager');
const views = require('../missions/views');
const store = require('../missions/store');
const registry = require('../registry');
const { select } = require('../selection/selector');
const { providerStatus } = require('../engine');
const { verify } = require('../master/verify');

const UI_DIR = path.join(paths.ROOT, 'ui');
const MAX_BODY = 16 * 1024;
const MAX_SSE = 50;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // descarta o excesso para conseguir responder 413; corta só se passar de 1 MB
        if (size > 1024 * 1024) req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(httpError(413, 'corpo da requisição acima de 16 KB'));
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(httpError(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

/** Só aceita a própria máquina: Host de loopback (anti DNS rebinding) e, em escrita, Origin igual. */
function checkRequest(req) {
  if (!LOOPBACK_HOST.test(String(req.headers.host || ''))) throw httpError(403, 'Host não permitido');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) throw httpError(403, 'Origin não permitida');
    if (!/^application\/json\b/.test(String(req.headers['content-type'] || ''))) throw httpError(415, 'Content-Type deve ser application/json');
  }
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
  fs.createReadStream(file).pipe(res);
  return true;
}

function createServer({ manager = new MissionManager() } = {}) {
  const sseClients = new Set();

  function openSSE(req, res) {
    if (sseClients.size >= MAX_SSE) throw httpError(503, 'limite de conexões de streaming atingido');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY_HEADERS });
    res.write('retry: 3000\n\n');
    const client = { res, filter: null };
    sseClients.add(client);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
    return client;
  }

  const unsubscribe = manager.subscribe((jobId, event) => {
    const frame = `id: ${event.seq}\nevent: mission\ndata: ${JSON.stringify(event)}\n\n`;
    for (const c of sseClients) if (!c.filter || c.filter === jobId) c.res.write(frame);
  });

  function runningSummary() {
    return [...manager.running.keys()].map((id) => {
      const d = views.detail(id);
      const t = d && d.mission ? (d.mission.subtarefas || []).find((x) => x.status === 'em_progresso') : null;
      return { id, phase: d && (d.mission ? d.mission.estado : d.phase), task: t ? { id: t.id, descricao: t.descricao, agente: t.agente, skills: t.skills } : null };
    });
  }

  /** @type {Array<[string, RegExp, (req: any, url: URL, res: any, params: string[]) => any]>} */
  const routes = [
    ['GET', /^\/api\/health$/, () => ({ ok: true })],
    ['GET', /^\/api\/system$/, () => {
      const v = verify();
      const p = providerStatus();
      return {
        master: { ok: v.ok, problems: v.problems, head: v.masterHead, files: v.files },
        agents: registry.loadAgents().length,
        skills: registry.loadSkills().length,
        rules: registry.loadRules().map((r) => r.id),
        providers: { configured: p.configured, missing: p.missing },
        missionsBlocked: p.configured.length === 0,
        limits: { maxConcurrent: manager.maxConcurrent, timeoutMs: manager.timeoutMs },
      };
    }],
    ['GET', /^\/api\/agents$/, () => registry.loadAgents()],
    ['GET', /^\/api\/skills$/, (_, url) => {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      return registry.loadSkills().filter((s) => !q || `${s.id} ${s.description}`.toLowerCase().includes(q)).map(({ file: _file, ...s }) => s);
    }],
    ['GET', /^\/api\/rules$/, () => registry.loadRules()],
    ['POST', /^\/api\/select$/, async (req) => {
      const body = await readBody(req);
      if (typeof body.task !== 'string' || !body.task.trim()) throw httpError(400, 'campo "task" obrigatório');
      return select(body.task.slice(0, 4000));
    }],
    ['GET', /^\/api\/missions$/, () => store.list()],
    ['POST', /^\/api\/missions$/, async (req, _url, res) => {
      const body = await readBody(req);
      const job = manager.create(body.objective, { start: body.start !== false });
      res.statusCode = 201;
      return job;
    }],
    ['POST', /^\/api\/missions\/([^/]+)\/start$/, (_, __, ___, [id]) => manager.start(id)],
    ['POST', /^\/api\/missions\/([^/]+)\/resume$/, (_, __, ___, [id]) => manager.start(id, { resume: true })],
    ['POST', /^\/api\/missions\/([^/]+)\/cancel$/, (_, __, ___, [id]) => manager.cancel(id)],
    ['GET', /^\/api\/missions\/([^/]+)$/, (_, __, ___, [id]) => views.detail(id)],
    ['GET', /^\/api\/missions\/([^/]+)\/tasks$/, (_, __, ___, [id]) => views.tasks(id)],
    ['GET', /^\/api\/missions\/([^/]+)\/agents$/, (_, __, ___, [id]) => views.agents(id)],
    ['GET', /^\/api\/missions\/([^/]+)\/skills$/, (_, __, ___, [id]) => views.skills(id)],
    ['GET', /^\/api\/missions\/([^/]+)\/execution$/, (_, url, ___, [id]) => views.execution(id, Number(url.searchParams.get('after') || 0))],
    ['GET', /^\/api\/missions\/([^/]+)\/logs$/, (_, url, ___, [id]) => views.logs(id, { afterSeq: Number(url.searchParams.get('after') || 0), types: url.searchParams.get('types') ? url.searchParams.get('types').split(',') : null })],
    ['GET', /^\/api\/missions\/([^/]+)\/result$/, (_, __, ___, [id]) => views.result(id)],
    ['GET', /^\/api\/missions\/([^/]+)\/files$/, (_, url, ___, [id]) => {
      const p = url.searchParams.get('path');
      if (!p) return views.files(id);
      const r = views.fileContent(id, p);
      if (r.status !== 200) throw httpError(r.status, r.error);
      return r;
    }],
    ['GET', /^\/api\/observability$/, () => views.observability({ running: runningSummary() })],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      checkRequest(req);
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        openSSE(req, res);
        return;
      }
      const sse = url.pathname.match(/^\/api\/missions\/([^/]+)\/events$/);
      if (req.method === 'GET' && sse) {
        const id = sse[1];
        if (!store.get(id)) throw httpError(404, 'missão não encontrada');
        const after = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
        const client = openSSE(req, res);
        client.filter = id;
        for (const e of store.readEvents(id, { afterSeq: after })) res.write(`id: ${e.seq}\nevent: mission\ndata: ${JSON.stringify(e)}\n\n`);
        return;
      }
      for (const [method, re, handler] of routes) {
        const m = url.pathname.match(re);
        if (!m || method !== req.method) continue;
        if (m.slice(1).some((id) => !store.validId(id))) throw httpError(404, 'missão não encontrada');
        const out = await handler(req, url, res, m.slice(1));
        if (out === null || out === undefined) throw httpError(404, 'não encontrado');
        return sendJSON(res, res.statusCode === 201 ? 201 : 200, out);
      }
      if (url.pathname.startsWith('/api/')) throw httpError(404, 'rota não encontrada');
      if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
      throw httpError(404, 'não encontrado');
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      sendJSON(res, e.status || 500, { error: e.status ? e.message : 'erro interno' });
      if (!e.status) process.stderr.write(`[minhaia api] ${e.stack}\n`);
    }
  });

  server.on('close', () => { unsubscribe(); manager.shutdown(); });
  return { server, manager };
}

async function start({ port = Number(process.env.MINHAIA_PORT || 4317), host = process.env.MINHAIA_HOST || '127.0.0.1' } = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('a API da MinhaIA só escuta em loopback (MINHAIA_HOST deve ser 127.0.0.1/localhost/::1)');
  const { server, manager } = createServer();
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, manager, port: /** @type {import('net').AddressInfo} */ (server.address()).port, host })));
}

module.exports = { createServer, start };
