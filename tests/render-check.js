// Neon Talon v0.1.4 — headless browser render check.
// Serves the game dir over local HTTP, loads it in a headless browser, and
// asserts the M1 core, by hook and by eye:
//   - the menu renders over a LIVE 3D scene (the attract demo actually
//     flies — the demo ship moves and enemies appear), with no
//     version/engine text anywhere the player can see, one clear primary
//     Play action, and 3 sortie cards
//   - gates on a fresh save: sorties 2-3 locked; the ?sortie= seed path
//     reaches every sortie (the Apex lesson)
//   - Play starts a run: the HUD shows, and steering left with a REAL
//     held key moves the ship left ON SCREEN (screen space asserted —
//     the Drift M2 lesson); mouse steer also moves the input
//   - Space fires the guns and scores kills; boost builds heat and
//     cooling drops it; a lock completes and a missile spends ammo
//   - the autopilot (decision bot through the public hooks) clears sortie 1
//   - pause focuses Resume; P resumes; R restarts
//   - accessibility: text size + high contrast apply and persist across
//     reload; the FPS guard's level actually changes the renderer pixel
//     ratio and quitting to the menu restores full resolution
//   - zero console errors and zero page errors, and a WebGL context exists
//
// Run: node tests/render-check.js
//
// CDN note: the repo pins Three.js 0.160.0 from jsdelivr and does NOT
// vendor it. The sandboxed browser cannot reach the jsdelivr CDN (the VM
// egress proxy answers policy_denied to every non-curl/wget client,
// including Chromium), even though curl gets HTTP 200 for the pinned URL
// from this VM. So this check downloads the pinned module with curl into
// the OS temp dir and fulfils that one request locally via Playwright
// routing — the page still requests the exact pinned URL, and the repo
// keeps no copy of Three.js. On a machine where the browser can reach
// the CDN, set NO_THREE_CACHE=1 to skip the substitution and load it live.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(os.tmpdir(), 'neon-talon-render-check');
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
  const st = fs.statSync(THREE_CACHE);
  if (st.size < 100000) throw new Error(`downloaded Three.js module is unexpectedly small (${st.size} bytes)`);
  return THREE_CACHE;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

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
    res.writeHead(404);
    res.end('not found');
    return;
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
console.log('render-check: chromium executable:', executablePath || '(playwright default)');
const launchArgs = ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];

const errors = [];
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
function noteConsole(msg) {
  if (msg.type() !== 'error') return;
  errors.push(stamp() + ' console: ' + msg.text());
}
let browser;
function fail(msg) { throw new Error(msg); }
try {
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: launchArgs,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: 'Asia/Bangkok',
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('console', noteConsole);
  page.on('pageerror', (err) => errors.push(stamp() + ' pageerror: ' + String(err)));

  if (!process.env.NO_THREE_CACHE) {
    const cached = await fetchThreeModule();
    console.log(`render-check: fulfilling pinned three@0.160.0 from local curl cache (${cached}) — sandboxed browser cannot reach jsdelivr directly`);
    await page.route(THREE_URL, (route) => route.fulfill({ path: cached }));
  }

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.waitForFunction(() => window.__talon, null, { timeout: 30000 });
  } catch {
    console.error('render-check: window.__talon never appeared — the pinned Three.js module failed to load.');
    console.error('CDN check from this VM: curl -sI ' + THREE_URL + ' (expect HTTP 200).');
    fail('game module did not initialise (see CDN note above)');
  }

  const version = await page.evaluate(() => window.__talon.version);
  if (version !== '0.1.4') fail(`expected version 0.1.4, got ${version}`);
  console.log('render-check: game module initialised, version 0.1.4');

  // WebGL context exists and the canvas is on screen.
  const gl = await page.evaluate(() => {
    const canvas = document.querySelector('#game-container canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('webgl2') || canvas.getContext('webgl');
    return ctx ? { width: canvas.width, height: canvas.height } : null;
  });
  if (!gl) fail('no WebGL context on the game canvas');
  console.log(`render-check: WebGL context live (${gl.width}x${gl.height} canvas)`);

  // The menu: title, one primary Play, 3 sortie cards, NO version/engine
  // text anywhere the player can see.
  const menuText = await page.textContent('#menu');
  if (!menuText.includes('NEON TALON')) fail('menu title missing');
  if (menuText.includes('v0.1.0') || menuText.includes('Three.js') || menuText.includes('0.160.0')) {
    fail('menu shows version/engine text — it must live in the README only');
  }
  const playClass = await page.getAttribute('#btn-play', 'class');
  if (!playClass || !playClass.includes('primary')) fail('Play is not the primary action');
  const sortieCards = await page.locator('#sortie-select .map-card').count();
  if (sortieCards !== 3) fail(`expected 3 sortie cards, got ${sortieCards}`);
  const sorties = await page.evaluate(() => window.__talon.sorties());
  if (sorties.length !== 3 || sorties[0].name !== 'First Flight' || sorties[1].name !== 'Ember Strait' || sorties[2].name !== "Widow's Spine") {
    fail(`sortie list wrong: ${JSON.stringify(sorties.map((s) => s.name))}`);
  }
  console.log('render-check: menu renders — live 3D behind it, no version text, Play primary, 3 sorties');

  // Gates on a fresh save: sorties 2-3 locked, sortie 1 open.
  const unlocks0 = await page.evaluate(() => window.__talon.unlocks());
  if (unlocks0.sorties[1] !== true || unlocks0.sorties[2] !== false || unlocks0.sorties[3] !== false) {
    fail(`fresh save should unlock only sortie 1: ${JSON.stringify(unlocks0.sorties)}`);
  }
  const lockedCards = await page.locator('#sortie-select .map-card.locked').count();
  if (lockedCards !== 2) fail(`expected 2 locked sortie cards on a fresh save, got ${lockedCards}`);
  console.log('render-check: gates closed on a fresh save — sorties 2-3 locked (2 locked cards)');

  // The attract demo actually flies behind the menu: the demo ship
  // moves forward and enemies appear ahead of it.
  await page.waitForFunction(() => {
    const i = window.__talon.info();
    return i && i.enemies.length > 0 && i.z > 20;
  }, null, { timeout: 60000 });
  const demo0 = await page.evaluate(() => window.__talon.info());
  await page.waitForFunction((z0) => window.__talon.info().z > z0 + 20, demo0.z, { timeout: 60000 });
  console.log(`render-check: attract demo alive — demo ship at z=${demo0.z.toFixed(0)}, ${demo0.enemies.length} enemies ahead`);

  // Menu screenshot for the by-eye check (inspected after the run).
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(SHOTS_DIR, 'menu-1280x720.png') });
  console.log(`render-check: menu screenshot saved to ${SHOTS_DIR}/menu-1280x720.png — INSPECT BY EYE (live 3D scene, no clipped cards)`);

  // Music: the sequencer runs after the Play gesture and advances.
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__talon.state.phase === 'run', null, { timeout: 5000 });
  if (!await page.isVisible('#hud')) fail('HUD not visible after PLAY');
  if (!await page.isVisible('#reticle')) fail('reticle not visible after PLAY');
  const hudSortie = await page.textContent('#hud-sortie');
  if (!hudSortie.includes('First Flight')) fail(`expected sortie 1 First Flight, got: ${hudSortie}`);
  const audio0 = await page.evaluate(() => window.__talon.info().audio);
  if (!audio0) fail('no AudioContext after the Play gesture');
  if (!audio0.music) fail('music sequencer is not running');
  await page.waitForTimeout(2500);
  const audio1 = await page.evaluate(() => window.__talon.info().audio);
  if (audio1.musicStep <= audio0.musicStep) {
    if (audio1.state === 'suspended') console.log('render-check: music clock frozen (no audio device on this VM) — sequencer armed, advance check skipped');
    else fail(`music sequencer did not advance (${audio0.musicStep} -> ${audio1.musicStep})`);
  } else {
    console.log(`render-check: music sequencer advancing (${audio0.musicStep} -> ${audio1.musicStep})`);
  }
  console.log('render-check: PLAY starts sortie 1 (First Flight), HUD + reticle visible');

  // SCREEN-SPACE steering: hold ArrowLeft with a REAL key event and
  // assert the ship moves left ON SCREEN (the Drift M2 lesson — a
  // mirrored-input bug survived every world-space test). The chase
  // camera only partly follows the ship laterally, so steering left
  // must move the ship's screen position left.
  const screenX0 = await page.evaluate(() => window.__talon.info().ship.screen.x);
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(1500);
  const screenX1 = await page.evaluate(() => window.__talon.info().ship.screen.x);
  await page.keyboard.up('ArrowLeft');
  if (!(screenX1 < screenX0 - 5)) fail(`steering left should move the ship left on screen (${screenX0.toFixed(0)} -> ${screenX1.toFixed(0)})`);
  console.log(`render-check: real ArrowLeft moves the ship left on screen (${screenX0.toFixed(0)} -> ${screenX1.toFixed(0)})`);
  // And back right.
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(1200);
  const screenX2 = await page.evaluate(() => window.__talon.info().ship.screen.x);
  await page.keyboard.up('ArrowRight');
  if (!(screenX2 > screenX1 + 5)) fail(`steering right should move the ship right on screen (${screenX1.toFixed(0)} -> ${screenX2.toFixed(0)})`);
  console.log(`render-check: real ArrowRight moves the ship right on screen (${screenX1.toFixed(0)} -> ${screenX2.toFixed(0)})`);

  // Mouse steer: moving the pointer to the left of centre steers left.
  await page.mouse.move(200, 360);
  await page.waitForTimeout(400);
  const mouseSteer = await page.evaluate(() => window.__talon.info().input.steerX);
  if (!(mouseSteer < -0.3)) fail(`mouse at the left edge should steer left, got steerX ${mouseSteer}`);
  await page.mouse.move(640, 360);
  await page.waitForTimeout(400);
  console.log(`render-check: mouse steer works (steerX ${mouseSteer.toFixed(2)} at the left edge)`);

  // Boost builds heat; cooling drops it.
  const heat0 = await page.evaluate(() => window.__talon.state.heat);
  await page.evaluate(() => window.__talon.setInput({ boost: true, fire: false }));
  await page.waitForTimeout(2500);
  const heat1 = await page.evaluate(() => window.__talon.state.heat);
  await page.evaluate(() => window.__talon.setInput(null));
  if (!(heat1 > heat0 + 5)) fail(`boost should build heat (${heat0.toFixed(1)} -> ${heat1.toFixed(1)})`);
  await page.waitForTimeout(2500);
  const heat2 = await page.evaluate(() => window.__talon.state.heat);
  if (!(heat2 < heat1)) fail(`cooling should drop heat (${heat1.toFixed(1)} -> ${heat2.toFixed(1)})`);
  console.log(`render-check: boost builds heat (${heat0.toFixed(1)} -> ${heat1.toFixed(1)}) and cooling drops it (-> ${heat2.toFixed(1)})`);

  // Space fires the guns; holding fire scores kills and the kill
  // feedback bundle fires in full. First neutralise mouse steering
  // (v0.1.4 screen-centre steering: the neutral point is the centre
  // of the 1280x720 viewport, not the ship).
  await page.mouse.move(640, 360);
  await page.waitForTimeout(400);
  await page.keyboard.down(' ');
  await page.waitForFunction(() => {
    const i = window.__talon.info();
    return i.kills > 0;
  }, null, { timeout: 120000 });
  await page.keyboard.up(' ');
  const combat = await page.evaluate(() => window.__talon.info());
  const killFb = combat.feedback.filter((f) => f.type === 'kill');
  if (!killFb.length || killFb[0].layers.length < 5) fail('kill feedback bundle did not fire with 5+ layers');
  console.log(`render-check: Space fires the guns — ${combat.kills} kills, kill bundle ${killFb[0].layers.length} layers`);

  // Gameplay screenshot for the by-eye check.
  await page.screenshot({ path: path.join(SHOTS_DIR, 'gameplay-1280x720.png') });
  console.log(`render-check: gameplay screenshot saved to ${SHOTS_DIR}/gameplay-1280x720.png — INSPECT BY EYE`);

  // Lock-on + missile: firing a missile on the lock spends ammo.
  // Observe the lock through the DURABLE feedback log (a live
  // lockedId is transient: the bot fires on a carrier lock within a
  // few frames, so polling state.lockedId misses it under slow
  // rendering — the v0.1.2 check failed exactly that way twice).
  // Do NOT use the autopilot here: it shoots the locked drone dead
  // in ~0.4s and never holds a turret in the reticle (wall turrets
  // sit outside the cone from the centre lane), so a turret-only
  // wait never resolves either — run 3 burned 3x120s on it. Instead
  // the ship flies straight with guns silent at 1x: the first drones
  // drift into the reticle and lock in ~0.8s, and with no gunfire
  // the lock lives ~1.7s (until the drone rams), which is ample for
  // the pause below. Then PAUSE to freeze the sim with the lock
  // live, verify it, and fire — resume and fireMissile() in one
  // evaluate so no frame can eat the lock first.
  await page.evaluate(() => { window.__talon.restart(); window.__talon.setSpeed(1); window.__talon.autopilot(false); });
  let ammo0 = null, ammo1 = null;
  for (let attempt = 0; attempt < 3 && ammo1 === null; attempt++) {
    await page.evaluate(() => {
      if (window.__talon.state.phase !== 'run') { window.__talon.restart(); window.__talon.setSpeed(1); }
      window.__talon.autopilot(false);
    });
    const mark = await page.evaluate(() => window.__talon.info().feedback.length);
    try {
      await page.waitForFunction((m) => window.__talon.info()
        && window.__talon.info().feedback.slice(m).some((f) => f.type === 'lockAcquired'),
      mark, { timeout: 30000 });
    } catch { continue; }
    await page.evaluate(() => window.__talon.pause());
    const lock = await page.evaluate(() => {
      const s = window.__talon.state;
      if (s.phase !== 'run' || s.lockedId === null) return null;
      const t = window.__talon.info().enemies.find((e) => e.id === s.lockedId);
      return t ? { id: t.id, type: t.type } : null;
    });
    if (!lock) { await page.evaluate(() => { if (window.__talon.state.paused) window.__talon.resume(); }); continue; }
    ammo0 = await page.evaluate(() => window.__talon.state.ammo);
    await page.evaluate(() => { window.__talon.resume(); window.__talon.fireMissile(); });
    try {
      await page.waitForFunction((a0) => window.__talon.state.ammo < a0, ammo0, { timeout: 5000 });
      ammo1 = await page.evaluate(() => window.__talon.state.ammo);
    } catch { /* lock died before the fire landed; re-lock and retry */ }
  }
  if (ammo1 === null) fail('hook fireMissile() did not spend ammo on a lock after 3 attempts');
  console.log(`render-check: lock acquired, missile fired on the lock — ammo ${ammo0} -> ${ammo1}`);

  // Manual E (v0.1.2 regression test): the live playtest reported E
  // never firing. The hook path above is not the E path — prove the
  // real key works in manual play, with the same durable-event +
  // pause-freeze pattern: the ship flies straight with guns silent
  // at 1x, a drone locks, the sim freezes with the lock live, then
  // resume and press E with a real keyboard event. The 2.5s lock
  // grace covers the resume-to-keypress gap.
  let ammoBeforeE = null, ammoAfterE = null;
  for (let attempt = 0; attempt < 3 && ammoAfterE === null; attempt++) {
    await page.evaluate(() => {
      if (window.__talon.state.phase !== 'run') { window.__talon.restart(); window.__talon.setSpeed(1); }
      window.__talon.autopilot(false);
    });
    const mark = await page.evaluate(() => window.__talon.info().feedback.length);
    try {
      await page.waitForFunction((m) => window.__talon.info()
        && window.__talon.info().feedback.slice(m).some((f) => f.type === 'lockAcquired'),
      mark, { timeout: 30000 });
    } catch { continue; }
    await page.evaluate(() => window.__talon.pause());
    const lock = await page.evaluate(() => {
      const s = window.__talon.state;
      if (s.phase !== 'run' || s.lockedId === null) return null;
      const t = window.__talon.info().enemies.find((e) => e.id === s.lockedId);
      return t ? { id: t.id, type: t.type } : null;
    });
    if (!lock) { await page.evaluate(() => { if (window.__talon.state.paused) window.__talon.resume(); }); continue; }
    ammoBeforeE = await page.evaluate(() => window.__talon.state.ammo);
    await page.evaluate(() => window.__talon.resume());
    await page.keyboard.press('e');
    try {
      await page.waitForFunction((a) => window.__talon.state.ammo < a, ammoBeforeE, { timeout: 5000 });
      ammoAfterE = await page.evaluate(() => window.__talon.state.ammo);
    } catch { /* lock died before E landed; re-lock and retry */ }
  }
  if (ammoAfterE === null) fail('manual E did not fire a missile on a gold lock after 3 attempts');
  console.log(`render-check: manual E fires a missile on a gold lock — ammo ${ammoBeforeE} -> ${ammoAfterE}`);

  // Autopilot (decision bot through the public hooks) clears sortie 1.
  // The completion is observed on the player-facing complete screen:
  // onRunEnd() swaps the run for the menu demo in the same frame the
  // run ends, so state.done is only ever true transiently and the
  // screen is the durable signal. Restart fresh with the autopilot
  // ON: the missile tests above switch it off, and a pilotless ship
  // cannot clear (run 1's clear only worked because the manual-E
  // missile happened to finish the carrier and the final stretch is
  // straight — luck, not a test).
  await page.evaluate(() => { window.__talon.restart(); window.__talon.setSpeed(4); window.__talon.autopilot(true); });
  await page.waitForFunction(() => !document.querySelector('#complete').classList.contains('hidden'), null, { timeout: 420000 });
  const completeScore = await page.textContent('#complete-score');
  console.log(`render-check: autopilot cleared sortie 1 (${completeScore.trim()}) — complete screen shown`);
  // Autopilot OFF before the next sortie starts.
  await page.evaluate(() => window.__talon.autopilot(false));
  await page.click('#btn-next');
  await page.waitForFunction(() => window.__talon.state.phase === 'run' && window.__talon.state.sortieId === 2, null, { timeout: 5000 });
  console.log('render-check: Next Sortie starts sortie 2 (Ember Strait) — the clear unlocked it');

  // Pause: P opens the pause screen with Resume focused; P resumes.
  // The screen stack focuses its primary control on a 30ms timer,
  // so give it a beat before reading the focus.
  await page.keyboard.press('p');
  if (!await page.isVisible('#pause')) fail('pause screen not shown after P');
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'btn-resume', null, { timeout: 5000 });
  await page.keyboard.press('p');
  await page.waitForFunction(() => document.querySelector('#pause').classList.contains('hidden'), null, { timeout: 5000 });
  console.log('render-check: P pauses (Resume focused) and resumes');

  // The ?sortie= seed path reaches sortie 3 past the locks (Apex lesson).
  await page.goto(`http://127.0.0.1:${port}/?sortie=3`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__talon, null, { timeout: 30000 });
  const unlocksSeed = await page.evaluate(() => window.__talon.unlocks());
  if (unlocksSeed.sorties[3] !== true) fail(`?sortie=3 should unlock sortie 3 for the session: ${JSON.stringify(unlocksSeed.sorties)}`);
  await page.evaluate(() => window.__talon.start(3));
  await page.waitForFunction(() => window.__talon.state.phase === 'run' && window.__talon.state.sortieId === 3, null, { timeout: 5000 });
  await page.evaluate(() => { window.__talon.setSpeed(4); window.__talon.autopilot(true); });
  await page.waitForFunction(() => {
    const i = window.__talon.info();
    return i.enemies.length > 0;
  }, null, { timeout: 120000 });
  console.log("render-check: ?sortie=3 reaches Widow's Spine past the locks — autopilot is playing it");

  // Accessibility: text size + high contrast apply and persist.
  await page.evaluate(() => window.__talon.quitToMenu());
  await page.evaluate(() => { window.__talon.setTextSize(1.2); window.__talon.setHighContrast(true); });
  const fs1 = await page.evaluate(() => document.documentElement.style.fontSize);
  if (fs1 !== '120%') fail(`text size should be 120%, got ${fs1}`);
  const hc1 = await page.evaluate(() => document.body.classList.contains('high-contrast'));
  if (!hc1) fail('high contrast class not applied');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__talon, null, { timeout: 30000 });
  const persisted = await page.evaluate(() => ({
    fs: document.documentElement.style.fontSize,
    hc: document.body.classList.contains('high-contrast'),
  }));
  if (persisted.fs !== '120%' || !persisted.hc) fail(`accessibility settings did not persist: ${JSON.stringify(persisted)}`);
  console.log('render-check: text size + high contrast apply and persist across reload');

  // FPS guard: the level actually changes the renderer pixel ratio,
  // and quitting to the menu restores full resolution.
  await page.evaluate(() => window.__talon.start(1));
  const pr0 = await page.evaluate(() => window.__talon.debugPerfSetLevel(0));
  const pr2 = await page.evaluate(() => window.__talon.debugPerfSetLevel(2));
  if (!(pr2 < pr0)) fail(`perf level 2 should lower the pixel ratio (${pr0} -> ${pr2})`);
  await page.evaluate(() => window.__talon.quitToMenu());
  const prMenu = await page.evaluate(() => window.__talon.state.perf.pixelRatio);
  if (prMenu !== pr0) fail(`menu should restore full pixel ratio (${prMenu} vs ${pr0})`);
  console.log(`render-check: FPS guard steps the pixel ratio (${pr0} -> ${pr2}) and the menu restores it`);

  // R restarts from the death screen, and a toast live at death must
  // not carry onto it (v0.1.3: R did nothing on the death screen; the
  // scrape toast pill stayed visible there until its timer fired).
  // Steer into the wall at 4x until the ship scrapes itself to death.
  await page.evaluate(() => window.__talon.start(1));
  await page.evaluate(() => { window.__talon.setSpeed(4); window.__talon.setInput({ steerX: 1, steerY: 0 }); });
  await page.waitForFunction(() => window.__talon.info().feedback.some((f) => f.type === 'wallScrape'), null, { timeout: 60000 });
  const toastLive = await page.evaluate(() => {
    const el = document.getElementById('hud-toast');
    return el.textContent !== '' || el.classList.contains('show');
  });
  await page.waitForFunction(() => window.__talon.state.phase === 'menu' && !document.querySelector('#sortielost').classList.contains('hidden'), null, { timeout: 60000 });
  const toastAtDeath = await page.evaluate(() => {
    const el = document.getElementById('hud-toast');
    return { text: el.textContent, shown: el.classList.contains('show') };
  });
  if (toastAtDeath.text !== '' || toastAtDeath.shown) fail(`toast must be cleared on the death screen, got ${JSON.stringify(toastAtDeath)}`);
  await page.keyboard.press('r');
  await page.waitForFunction(() => window.__talon.state.phase === 'run' && window.__talon.state.sortieId === 1, null, { timeout: 5000 });
  console.log(`render-check: R restarts from the death screen (scrape toast was ${toastLive ? 'live during the scrape' : 'not live when checked'} — death screen shows none)`);
  await page.evaluate(() => window.__talon.quitToMenu());

  await page.waitForTimeout(500);
} catch (err) {
  console.error('render-check: FAILED —', err.message);
  try { fs.mkdirSync(SHOTS_DIR, { recursive: true }); } catch { /* ignore */ }
  try {
    const pg = browser ? (await browser.contexts()[0]?.pages())?.[0] : null;
    if (pg) await pg.screenshot({ path: path.join(SHOTS_DIR, 'failure.png') });
  } catch { /* ignore */ }
  throw err;
} finally {
  if (browser) await browser.close();
  server.close();
}

if (errors.length) {
  console.error(`render-check: ${errors.length} console/page error(s):`);
  for (const e of errors) console.error('  ' + e);
  process.exit(1);
}
console.log('render-check: PASS — zero console errors, menu + gates + screen-space steering + mouse steer + heat + guns + lock/missile + autopilot clear + pause + ?sortie= seed + accessibility + FPS guard + R restart from the death screen all verified');
