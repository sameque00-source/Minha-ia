/* global document, window */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { SKIP_NO_MASTER, startApi } = require('./helpers');

const BROWSER = [process.env.MINHAIA_BROWSER_EXECUTABLE, '/opt/pw-browsers/chromium'].filter(Boolean).find((p) => fs.existsSync(p));
let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch { /* dependência de dev ausente */ }
const SKIP = SKIP_NO_MASTER || (!BROWSER && 'Chromium não encontrado — NÃO VALIDADO') || (!chromium && 'playwright-core não instalado');

async function openPage(base) {
  const browser = await chromium.launch({ executablePath: BROWSER });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(base);
  await page.waitForSelector('#system .chip');
  return { browser, page, problems };
}

const metaHas = (page, re, timeout = 60000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('#m-meta')?.textContent || ''), re.source, { timeout });

test('Web UI: missão pela interface, abas conectadas a dados reais, sem erros de console', { skip: SKIP }, async (t) => {
  const api = await startApi({ stub: true, env: { MINHAIA_TEST_STUB_DELAY_MS: '500' } });
  const { browser, page, problems } = await openPage(api.base);
  t.after(async () => { await browser.close(); await api.close(); });

  const sys = await page.textContent('#system');
  assert.match(sys, /25 agentes/);
  assert.match(sys, /140 Skills/);

  await page.fill('#objective', 'Crie um script que soma dois números <img src=x onerror="window.__xss=1">');
  await page.click('#send');
  await page.waitForFunction(() => !document.querySelector('#btn-cancel').disabled, null, { timeout: 20000 });
  await metaHas(page, /CONCLUIDA/);
  assert.strictEqual(await page.$eval('#btn-cancel', (b) => b.disabled), true);
  assert.strictEqual(await page.evaluate(() => window.__xss), undefined, 'texto do usuário não pode virar HTML');
  assert.strictEqual(await page.$('#m-objective img'), null);
  assert.match(await page.textContent('#m-meta'), /TEST-STUB/);

  const tab = async (name) => { await page.click(`.tabs button[data-tab="${name}"]`); await page.waitForTimeout(400); return page.textContent(`#tab-${name}`); };
  assert.match(await tab('conversa'), /Agente coding/);
  assert.match(await tab('plano'), /Interpretação do Planejador/);
  await tab('grafo');
  assert.strictEqual(await page.$$eval('#tab-grafo svg g.node', (n) => n.length), 2);
  const agentes = await tab('agentes');
  assert.match(agentes, /Skills carregadas por tarefa/);
  assert.match(agentes, /termos em comum/);
  const exec = await tab('execucao');
  assert.match(exec, /node soma\.js/);
  assert.match(exec, /SUCESSO_VALIDADO/);
  await tab('arquivos');
  await page.click('#file-list button');
  await page.waitForFunction(() => /function soma/.test(document.querySelector('#file-view').textContent));
  assert.match(await tab('testes'), /passou/);
  await tab('logs');
  assert.ok(await page.$$eval('#log-list .log-line', (n) => n.length) > 10);
  assert.match(await page.textContent('#obs'), /TEST-STUB/);
  assert.deepStrictEqual(problems, []);
});

test('Web UI: botão Cancelar encerra a missão em execução', { skip: SKIP }, async (t) => {
  const api = await startApi({ stub: true, env: { MINHAIA_TEST_STUB_DELAY_MS: '5000' } });
  const { browser, page, problems } = await openPage(api.base);
  t.after(async () => { await browser.close(); await api.close(); });
  await page.fill('#objective', 'Crie um script que soma dois números');
  await page.click('#send');
  await page.waitForFunction(() => !document.querySelector('#btn-cancel').disabled, null, { timeout: 20000 });
  await page.click('#btn-cancel');
  await metaHas(page, /CANCELADA/, 30000);
  assert.strictEqual(await page.$eval('#btn-cancel', (b) => b.disabled), true);
  assert.deepStrictEqual(problems, []);
});
