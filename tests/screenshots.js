// Neon Talon v0.1.0 — size-sweep screenshots for the by-eye check.
// Serves the game dir over local HTTP, loads it in a headless browser
// at 1280x720, 2560x1080 and 1080x2340, and captures the menu and a
// running game at each size. Inspect every shot for clipped,
// overlapping or ugly elements — a render check that only asserts "no
// console errors" is not a quality check.
//
// Run: node tests/screenshots.js
// Shots land in <os tmpdir>/neon-talon-screenshots/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(os.tmpdir(), 'neon-talon-screenshots');
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
const THREE_CACHE = path.join(os.tmpdir(), 'neon-talon-three-0.160.0.module.js');

async function fetchThreeModule() {
  try {
    const st = fs.statSync(THREE_CACHE);
    if (st.size > 100000) return THREE_CACHE;
  } catch { /* not cached yet */ }
  await new Promise((resolve, reject) => {
    execFile('curl', ['-s', '-o', THREE_CACHE, THREE_URL], (err) => (err ? reject(err) : resolve()));
  });
  return THREE_CACHE;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function findHeadlessShell() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const entry of fs.readdirSync(base)) {
      const candidate = path.join(base, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* cache dir missing */ }
  return null;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(GAME_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(GAME_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const require = createRequire(import.meta.url);
const playwrightPath = fileURLToPath(new URL('../../neon-hexfall/node_modules/playwright-core', import.meta.url));
const { chromium } = require(playwrightPath);
const executablePath = findHeadlessShell();

const SIZES = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '2560x1080', width: 2560, height: 1080 },
  { name: '1080x2340', width: 1080, height: 2340 },
];

const errors = [];
let browser;
try {
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  for (const size of SIZES) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, timezoneId: 'Asia/Bangkok' });
    const page = await context.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${size.name} console: ${msg.text()}`); });
    page.on('pageerror', (err) => errors.push(`${size.name} pageerror: ${String(err)}`));
    if (!process.env.NO_THREE_CACHE) {
      const cached = await fetchThreeModule();
      await page.route(THREE_URL, (route) => route.fulfill({ path: cached }));
    }
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.__talon, null, { timeout: 30000 });
    await page.waitForTimeout(2500); // menu pop-in + attract demo
    // 2560x1080 under software rendering is slow to composite —
    // give the capture a long timeout rather than the 30s default.
    await page.screenshot({ path: path.join(SHOTS_DIR, `menu-${size.name}.png`), timeout: 120000 });
    // Start a run with the autopilot flying so the shot has combat.
    await page.evaluate(() => {
      window.__talon.start(1);
      window.__talon.setSpeed(2);
      window.__talon.autopilot(true);
    });
    await page.waitForTimeout(6000); // enemies ahead, tracers firing
    await page.screenshot({ path: path.join(SHOTS_DIR, `gameplay-${size.name}.png`), timeout: 120000 });
    console.log(`screenshots: ${size.name} menu + gameplay saved`);
    await context.close();
  }
} finally {
  if (browser) await browser.close();
  server.close();
}
if (errors.length) {
  console.error(`screenshots: ${errors.length} console/page error(s):`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log(`screenshots: PASS — 6 shots in ${SHOTS_DIR} — INSPECT BY EYE for clipped, overlapping or ugly elements`);
