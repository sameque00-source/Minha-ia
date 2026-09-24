#!/usr/bin/env node
/**
 * Inicia o MCP do Playwright (declarado no MASTER em .mcp.json com @latest) com versão fixada,
 * saída em data/playwright e o browser disponível na máquina:
 *   MINHAIA_BROWSER_EXECUTABLE > /opt/pw-browsers/chromium > Chrome padrão do Playwright.
 * Sem --executable-path o MCP procura /opt/google/chrome e falha onde só há Chromium.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = '0.0.82';
const candidates = [process.env.MINHAIA_BROWSER_EXECUTABLE, '/opt/pw-browsers/chromium'].filter(Boolean);
const executable = candidates.find((p) => fs.existsSync(p));

const outputDir = path.join(ROOT, 'data', 'playwright');
fs.mkdirSync(outputDir, { recursive: true });

const args = ['-y', `@playwright/mcp@${VERSION}`, '--isolated', '--headless', '--output-dir', outputDir];
if (executable) args.push('--browser', 'chromium', '--executable-path', executable);

const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(/** @type {NodeJS.Signals} */ (sig)));
