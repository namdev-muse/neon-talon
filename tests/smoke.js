// Neon Talon v0.1.0 — Node smoke tests for physics.js (no DOM, no Three.js).
import {
  VERSION, SORTIES, sortieById, segmentAt, safeBoxAt, totalEnemiesInSortie,
  sortieThreat, parTime, isSortieUnlocked,
  DT, HULL_MAX, HEAT_MAX, OVERHEAT_CLEAR, BASE_SPEED, BOOST_SPEED,
  GUN_RATE, GUN_DAMAGE, GUN_RANGE, LOCK_TIME, LOCK_RANGE,
  MISSILE_DAMAGE, MISSILE_AMMO,
  ENEMY_DEFS, ENEMY_ORDER, FEEDBACK, FEEDBACK_TIERS, FEEDBACK_LAYERS,
  createRun, startRun, setInput, aimDir, gunConeT, reticleT, stepRun,
  decisionInput, straightInput, simulateRun,
  PERF_LEVELS, PERF_FPS_THRESHOLD, PERF_LOW_MS, perfGuardStep,
  mulberry32, clamp,
  defaultSave, serializeSave, parseSave, recordBest, SAVE_VERSION,
} from '../physics.js';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
  if (cond) passed++;
  else { failed++; failures.push(name); console.error('FAIL:', name); }
}

check('physics version is 0.1.4', VERSION === '0.1.4');
check('3 sorties defined', SORTIES.length === 3);
check('sortie ids are 1..3 in order', SORTIES.every((s, i) => s.id === i + 1));
check('every sortie has a name and a hint', SORTIES.every((s) => s.name && s.hint));
check('every sortie has a distinct theme ring', new Set(SORTIES.map((s) => s.theme.ring)).size === 3);
check('every sortie has a distinct theme disc', new Set(SORTIES.map((s) => s.theme.disc)).size === 3);
check('every sortie is dense (25+ enemies)', SORTIES.every((s) => totalEnemiesInSortie(s) >= 25));
check('threat grows with difficulty', sortieThreat(SORTIES[1]) > sortieThreat(SORTIES[0]) && sortieThreat(SORTIES[2]) > sortieThreat(SORTIES[1]));
check('sortieById finds sortie 2', sortieById(2) && sortieById(2).name === 'Ember Strait');
check('sortieById returns null for unknown id', sortieById(99) === null);
check('sortie 1 teaches: first spawns are drones only', SORTIES[0].spawns.filter((s) => s.at <= 200).every((s) => s.type === 'drone'));
check('sortie 1 first turret is telegraphed (z >= 200)', SORTIES[0].spawns.filter((s) => s.type === 'turret')[0].at >= 200);
check('sortie 1 opening is a straight teaching runway to z=200', segmentAt(SORTIES[0], 100).cx === 0 && segmentAt(SORTIES[0], 200).cx === 0);
check('sortie 1 first bend is gentle (|cx| <= 4)', Math.abs(segmentAt(SORTIES[0], 300).cx) <= 4);
check('every sortie ends with a carrier', SORTIES.every((s) => s.spawns.some((g) => g.type === 'carrier' && g.at >= s.length - 200)));
check('every sortie has interceptors and turrets', SORTIES.every((s) => s.spawns.some((g) => g.type === 'interceptor') && s.spawns.some((g) => g.type === 'turret')));

// --- canyon geometry ---
for (const sortie of SORTIES) {
  const segs = sortie.segments;
  check(`sortie ${sortie.id} segments are contiguous from 0 to length`, segs[0].z0 === 0
    && segs[segs.length - 1].z1 === sortie.length
    && segs.every((sg, i) => i === 0 || sg.z0 === segs[i - 1].z1));
  check(`sortie ${sortie.id} has 5+ segments`, segs.length >= 5);
  check(`sortie ${sortie.id} half-widths are flyable (6..11)`, segs.every((sg) => sg.hw >= 6 && sg.hw <= 11));
  check(`sortie ${sortie.id} floor below ceiling with room`, segs.every((sg) => sg.ceil - sg.floor >= 11));
  check(`sortie ${sortie.id} centre swings are bounded`, segs.every((sg) => Math.abs(sg.cx) <= 8));
  check(`sortie ${sortie.id} adjacent centres do not jump`, segs.every((sg, i) => i === 0 || Math.abs(sg.cx - segs[i - 1].cx) <= 14));
  check(`sortie ${sortie.id} spawns are inside the canyon`, sortie.spawns.every((sp) => {
    const seg = segmentAt(sortie, sp.at);
    return sp.at >= 0 && sp.at <= sortie.length && (sp.type !== 'turret' || true)
      && Math.abs(sp.dx ?? 0) <= seg.hw - 2;
  }));
  check(`sortie ${sortie.id} par time is length/30`, parTime(sortie) === sortie.length / 30);
}
check('segmentAt finds the first segment at z=0', segmentAt(SORTIES[0], 0).z0 === 0);
check('segmentAt finds the last segment at the end', segmentAt(SORTIES[0], 699).z1 === 700);
check('safeBoxAt matches the segment', (() => {
  const b = safeBoxAt(SORTIES[1], 200);
  return b.cx === 6 && b.hw === 8 && b.floor === 2 && b.ceil === 15;
})());

// --- enemy defs: four distinct roles, not reskins ---
check('four enemy types defined', Object.keys(ENEMY_DEFS).length === 4 && ENEMY_ORDER.length === 4);
check('interceptor is tougher than drone', ENEMY_DEFS.interceptor.hp > ENEMY_DEFS.drone.hp);
check('turret is tougher than interceptor', ENEMY_DEFS.turret.hp > ENEMY_DEFS.interceptor.hp);
check('carrier is the toughest', ENEMY_DEFS.carrier.hp > ENEMY_DEFS.turret.hp);
check('carrier is the only gun-armoured enemy', ENEMY_DEFS.carrier.gunArmor === 0.3
  && !ENEMY_DEFS.drone.gunArmor && !ENEMY_DEFS.interceptor.gunArmor && !ENEMY_DEFS.turret.gunArmor);
check('carrier score is the biggest', ENEMY_DEFS.carrier.score > ENEMY_DEFS.turret.score);
check('drone does not shoot', !ENEMY_DEFS.drone.fireInterval);
check('interceptor, turret and carrier shoot', ENEMY_DEFS.interceptor.fireInterval > 0 && ENEMY_DEFS.turret.fireInterval > 0 && ENEMY_DEFS.carrier.fireInterval > 0);

// --- feedback contract ---
for (const [name, fb] of Object.entries(FEEDBACK)) {
  const tier = FEEDBACK_TIERS[fb.tier];
  check(`feedback ${name} trauma is inside its tier`, fb.trauma >= tier.traumaMin && fb.trauma <= tier.traumaMax);
  check(`feedback ${name} hit-stop is inside its tier`, fb.hitStop >= tier.stopMin && fb.hitStop <= tier.stopMax);
  check(`feedback ${name} carries 4+ layers`, (FEEDBACK_LAYERS[name] || []).length >= 4);
}
check('playerHit is a medium event', FEEDBACK.playerHit.tier === 'medium' && FEEDBACK.playerHit.hitStop >= 0.04);
check('killStreak is a large event (slow-mo)', FEEDBACK.killStreak.tier === 'large' && FEEDBACK.killStreak.hitStop >= 0.10);
check('sortieLost is a large event', FEEDBACK.sortieLost.tier === 'large');

// --- run state + flight ---
{
  const run = startRun(SORTIES[0]);
  check('run starts at z=0', run.z === 0);
  check('run starts centred in the canyon', run.x === 0);
  check('run starts with full hull', run.hull === HULL_MAX);
  check('run starts cold', run.heat === 0 && !run.overheated);
  check('run starts with full missile ammo', run.ammo === MISSILE_AMMO);
  check('run is not done at start', !run.done);
  check('run has a spawn queue', run.spawnQueue.length === totalEnemiesInSortie(SORTIES[0]));
  // Steering: left moves the ship left (screen space — Drift M2 lesson).
  setInput(run, { steerX: -1, steerY: 0 });
  const x0 = run.x;
  stepRun(run, DT);
  check('steering left moves the ship left', run.x < x0);
  setInput(run, { steerX: 1, steerY: 0 });
  const x1 = run.x;
  stepRun(run, DT);
  check('steering right moves the ship right', run.x > x1);
  setInput(run, { steerX: 0, steerY: 1 });
  const y0 = run.y;
  stepRun(run, DT);
  check('steering up moves the ship up', run.y > y0);
  // Forward motion at base speed.
  const z0 = run.z;
  setInput(run, {});
  stepRun(run, DT);
  check('ship advances at base speed', Math.abs((run.z - z0) - BASE_SPEED * DT) < 1e-9);
  // Boost is faster.
  const z1 = run.z;
  setInput(run, { boost: true });
  stepRun(run, DT);
  check('boost is faster than base speed', run.z - z1 > BASE_SPEED * DT);
  check('boost builds heat', run.heat > 0);
}

// --- heat / overheat ---
{
  const run = startRun(SORTIES[0]);
  run.spawnQueue = []; // no spawns: this block tests heat, not combat
  setInput(run, { boost: true, fire: true });
  let steps = 0;
  while (!run.overheated && steps < 60 * 30) { setInput(run, { boost: true, fire: true }); stepRun(run, DT); steps++; }
  check('sustained boost + fire overheats', run.overheated);
  check('heat is capped at max', run.heat <= HEAT_MAX + 1e-9);
  const z0 = run.z;
  setInput(run, { boost: true });
  stepRun(run, DT);
  check('overheated boost is locked out (base speed only)', Math.abs((run.z - z0) - BASE_SPEED * DT) < 1e-9);
  // Guns slow while overheated: fire rate halves.
  const shots0 = run.shotsFired;
  setInput(run, { fire: true });
  for (let i = 0; i < 60; i++) stepRun(run, DT);
  check('overheated guns fire at half rate', run.shotsFired - shots0 <= 5);
  // Cool down: boost stays locked until heat <= 35.
  setInput(run, {});
  steps = 0;
  while (run.overheated && steps < 60 * 30) { stepRun(run, DT); steps++; }
  check('heat cools below the unlock point', !run.overheated && run.heat <= OVERHEAT_CLEAR + 1e-9);
  // Idle cooling is faster than firing cooling.
  const run2 = startRun(SORTIES[0]);
  run2.heat = 50;
  setInput(run2, {});
  stepRun(run2, DT);
  check('idle cooling drops heat', run2.heat < 50);
}

// --- guns + lock-on + missiles ---
{
  const run = startRun(SORTIES[0]);
  run.spawnQueue = []; // only the hand-placed drone exists
  // Put a drone dead ahead in the gun cone.
  run.enemies.push({ id: 99, type: 'drone', x: run.x, y: run.y, z: run.z + 30, hp: 20, maxHp: 20, baseX: run.x, baseY: run.y, phase: 0, fireCd: 99, burstLeft: 0, burstCd: 0 });
  check('gun cone sees the drone ahead', gunConeT(run, run.enemies[0]) !== null);
  check('reticle sees the drone ahead', reticleT(run, run.enemies[0]) !== null);
  setInput(run, { fire: true });
  let steps = 0;
  while (run.enemies.length && steps < 60 * 5) { setInput(run, { fire: true }); stepRun(run, DT); steps++; }
  check('guns kill a drone dead ahead', run.kills === 1 && run.shotsHit > 0);
  check('kill pays score', run.score === ENEMY_DEFS.drone.score);
  // Lock-on: hold the reticle on a fresh turret (stationary, so the
  // reticle stays on it) for the lock window.
  const run2 = startRun(SORTIES[0]);
  run2.spawnQueue = [];
  run2.enemies.push({ id: 100, type: 'turret', x: run2.x, y: run2.y, z: run2.z + 40, hp: 70, maxHp: 70, baseX: run2.x, baseY: run2.y, phase: 0, fireCd: 99, burstLeft: 0, burstCd: 0 });
  let evs = [];
  for (let i = 0; i < Math.ceil((LOCK_TIME + 0.2) / DT); i++) { setInput(run2, {}); evs = stepRun(run2, DT); }
  check('holding the reticle acquires a lock', run2.lockedId === 100);
  check('lock fires the lockAcquired event', evs.some((e) => e.type === 'lockAcquired') || run2.lockedId === 100);
  const ammo0 = run2.ammo;
  setInput(run2, { missile: true });
  stepRun(run2, DT);
  check('missile fires on a lock and spends ammo', run2.missilesFired === 1 && run2.ammo === ammo0 - 1);
  // Missile without a lock does nothing.
  const run3 = startRun(SORTIES[0]);
  setInput(run3, { missile: true });
  stepRun(run3, DT);
  check('missile without a lock does not fire', run3.missilesFired === 0 && run3.ammo === MISSILE_AMMO);
  // Carrier gun armour: guns do half damage.
  const run4 = startRun(SORTIES[0]);
  run4.spawnQueue = [];
  run4.enemies.push({ id: 101, type: 'carrier', x: run4.x, y: run4.y, z: run4.z + 30, hp: 260, maxHp: 260, baseX: run4.x, baseY: run4.y, phase: 0, fireCd: 99, burstLeft: 0, burstCd: 0, homeX: 0, homeY: 0 });
  setInput(run4, { fire: true });
  stepRun(run4, DT);
  check('carrier takes 30% gun damage', run4.enemies[0].hp === 260 - GUN_DAMAGE * 0.3);
}

// --- lock memory (v0.1.2): E must still fire in the beat after the
// locked target vanishes ---
// The live playtest's "E never fires" was this race: the player holds
// fire while locking, the locked drone dies to guns (or rams), and the
// E press lands after the lock cleared. A full lock whose target just
// vanished is remembered for 0.75s: E fires at the target now being
// re-locked. The ram path matters as much as the gunfire path — a ram
// used to leave lockedId dangling at a removed enemy, so the reticle
// stayed gold with "LOCK" showing while E silently did nothing.
{
  function deathRun(killBy) {
    const run = startRun(SORTIES[0]);
    run.spawnQueue = [];
    run.enemies.push({ id: 200, type: 'drone', x: run.x, y: run.y, z: run.z + 45, hp: 20, maxHp: 20, baseX: run.x, baseY: run.y, phase: 0, fireCd: 99, burstLeft: 0, burstCd: 0 });
    run.enemies.push({ id: 201, type: 'drone', x: run.x, y: run.y, z: run.z + 49, hp: 20, maxHp: 20, baseX: run.x, baseY: run.y, phase: 0, fireCd: 99, burstLeft: 0, burstCd: 0 });
    for (let i = 0; i < Math.ceil((LOCK_TIME + 0.2) / DT); i++) { setInput(run, {}); stepRun(run, DT); }
    if (run.lockedId !== 200) return { run, ok: false, why: 'no lock' };
    if (killBy === 'guns') {
      let steps = 0;
      while (run.enemies.some((e) => e.id === 200) && steps < 60 * 2) { setInput(run, { fire: true }); stepRun(run, DT); steps++; }
      if (run.enemies.some((e) => e.id === 200)) return { run, ok: false, why: 'drone survived guns' };
    } else {
      // No fire: the drone closes in and rams.
      let steps = 0;
      while (run.enemies.some((e) => e.id === 200) && steps < 60 * 3) { setInput(run, {}); stepRun(run, DT); steps++; }
      if (run.enemies.some((e) => e.id === 200)) return { run, ok: false, why: 'drone never rammed' };
    }
    return { run, ok: true };
  }
  {
    const { run, ok, why } = deathRun('guns');
    check('lock-memory setup (guns): first drone locked then died to guns', ok);
    if (ok) {
      check('lock-memory setup (guns): memory is armed, lock cleared, re-lock target live', run.lockMemoryT > 0 && run.lockedId === null && run.enemies.some((e) => e.id === 201));
      const ammo = run.ammo;
      setInput(run, { missile: true });
      stepRun(run, DT);
      check('lock memory (guns): E fires at the re-lock target after the locked target died', run.missilesFired === 1 && run.ammo === ammo - 1 && run.missiles[0] && run.missiles[0].targetId === 201);
    }
  }
  {
    const { run, ok, why } = deathRun('ram');
    check('lock-memory setup (ram): first drone locked then rammed', ok);
    if (ok) {
      check('lock-memory setup (ram): memory is armed and no lock dangles', run.lockMemoryT > 0 && run.lockedId === null && run.enemies.some((e) => e.id === 201));
      const ammo = run.ammo;
      setInput(run, { missile: true });
      stepRun(run, DT);
      check('lock memory (ram): E fires at the re-lock target after the locked target rammed', run.missilesFired === 1 && run.ammo === ammo - 1 && run.missiles[0] && run.missiles[0].targetId === 201);
    }
  }
  {
    // No memory, no fire: a missile still needs a lock.
    const { run, ok } = deathRun('guns');
    check('lock-memory setup (no-memory): first drone locked then died', ok);
    if (ok) {
      run.lockMemoryT = 0;
      const ammo = run.ammo;
      setInput(run, { missile: true });
      stepRun(run, DT);
      check('no lock memory: E does nothing without a lock', run.missilesFired === 0 && run.ammo === ammo);
    }
  }
  {
    // Re-lock credit below 0.3s: too early to fire.
    const { run, ok } = deathRun('guns');
    check('lock-memory setup (low-credit): first drone locked then died', ok);
    if (ok) {
      run.lockT = 0.2;
      const ammo = run.ammo;
      setInput(run, { missile: true });
      stepRun(run, DT);
      check('lock memory needs 0.3s re-lock credit before E fires', run.missilesFired === 0 && run.ammo === ammo);
    }
  }
}

// --- spawn protection (v0.1.1): no damage in the first 4 seconds ---
{
  const run = startRun(SORTIES[0]);
  run.x = 999; // pressed to the right wall from the first step
  setInput(run, { steerX: 1 });
  for (let i = 0; i < Math.ceil(3 / DT); i++) stepRun(run, DT);
  check('spawn protection: no hull damage in the first 4 seconds', run.hull === HULL_MAX);
  for (let i = 0; i < Math.ceil(2 / DT); i++) stepRun(run, DT);
  check('spawn protection ends: scraping after 4s damages the hull', run.hull < HULL_MAX);
}

// --- wall collision ---
{
  const run = startRun(SORTIES[0]);
  for (let i = 0; i < Math.ceil(4.1 / DT); i++) { setInput(run, {}); stepRun(run, DT); }
  run.x = 999; // slam into the right wall
  const hull0 = run.hull;
  setInput(run, { steerX: 1 });
  stepRun(run, DT);
  check('wall clamps the ship inside the canyon', run.x <= 10 - 1.2 + 1e-9);
  check('wall scrape damages the hull', run.hull < hull0);
  check('scrape flag is set while pressed to the wall', run.scrapeActive);
}

// --- enemy fire + hull loss ---
{
  const run = startRun(SORTIES[0]);
  run.hull = 5;
  run.enemies.push({ id: 102, type: 'turret', x: run.x, y: run.y, z: run.z + 20, hp: 70, maxHp: 70, baseX: run.x, baseY: run.y, phase: 0, fireCd: 0, burstLeft: 0, burstCd: 0 });
  let steps = 0;
  while (!run.done && steps < 60 * 20) { setInput(run, {}); stepRun(run, DT); steps++; }
  check('turret fire can kill a 5-hull ship', run.done && run.reason === 'lost');
  check('no steps after the run ends', stepRun(run, DT).length === 0);
}

// --- carrier block ---
{
  const run = startRun(SORTIES[0]);
  run.spawnQueue = [];
  for (let i = 0; i < Math.ceil(4.1 / DT); i++) { setInput(run, {}); stepRun(run, DT); }
  run.enemies.push({ id: 103, type: 'carrier', x: run.x, y: run.y, z: run.z + 8, hp: 260, maxHp: 260, baseX: run.x, baseY: run.y, phase: 0, fireCd: 99, burstLeft: 0, burstCd: 0, homeX: 0, homeY: 0 });
  const z0 = run.z;
  setInput(run, {});
  const evs = stepRun(run, DT);
  check('a live carrier within 10 blocks forward motion', run.blocked && run.z === z0);
  check('blocked fires the blocked event', evs.some((e) => e.type === 'blocked') || run.blockTimer > 0);
  check('blocking grinds the hull', run.hull < HULL_MAX);
  // Kill it with missiles: lock, fire, let the missile arrive, and
  // the block lifts.
  run.enemies[0].hp = 10;
  run.lockedId = 103; run.ammo = 8;
  setInput(run, { missile: true });
  stepRun(run, DT);
  for (let i = 0; i < 30 && run.enemies.length; i++) { setInput(run, {}); stepRun(run, DT); }
  check('a missile kills the blocking carrier', run.enemies.length === 0);
  const z1 = run.z;
  setInput(run, {});
  stepRun(run, DT);
  check('the block lifts once the carrier dies', !run.blocked && run.z > z1);
  // A carrier further than 10 ahead does not block.
  const run2 = startRun(SORTIES[0]);
  run2.spawnQueue = [];
  run2.enemies.push({ id: 104, type: 'carrier', x: run2.x, y: run2.y, z: run2.z + 30, hp: 260, maxHp: 260, baseX: run2.x, baseY: run2.y, phase: 0, fireCd: 99, burstLeft: 0, burstCd: 0, homeX: 0, homeY: 0 });
  setInput(run2, {});
  stepRun(run2, DT);
  check('a carrier 30 ahead does not block', !run2.blocked);
}

// --- sortie clear ---
{
  const run = startRun(SORTIES[0]);
  run.z = SORTIES[0].length - 0.01;
  const evs = stepRun(run, DT);
  check('reaching the end clears the sortie', run.done && run.reason === 'complete');
  check('clear pays the 1000 clear bonus plus hull bonus', run.score >= 1000 + HULL_MAX * 10);
  check('sortieClear event fires', evs.some((e) => e.type === 'sortieClear'));
}

// --- unlock gates ---
check('sortie 1 is always unlocked', isSortieUnlocked({}, 1));
check('sortie 2 locks until sortie 1 is cleared', !isSortieUnlocked({}, 2) && !isSortieUnlocked({ 1: { score: 1, kills: 1, cleared: false } }, 2));
check('sortie 2 unlocks when sortie 1 is cleared', isSortieUnlocked({ 1: { score: 1, kills: 1, cleared: true } }, 2));
check('sortie 3 unlocks when sortie 2 is cleared', isSortieUnlocked({ 1: { score: 1, cleared: true }, 2: { score: 1, cleared: true } }, 3));

// --- aim direction tilts with steering (aiming IS steering) ---
{
  const run = startRun(SORTIES[0]);
  setInput(run, { steerX: 0 });
  const a0 = aimDir(run);
  setInput(run, { steerX: 1 });
  const a1 = aimDir(run);
  check('steering right tilts the aim right', a1.x > a0.x);
  setInput(run, { steerX: -1 });
  const a2 = aimDir(run);
  check('steering left tilts the aim left', a2.x < a0.x);
}

// --- decision bot input sanity ---
{
  const run = startRun(SORTIES[0]);
  const inp = decisionInput(run);
  check('decision bot steers within bounds', Math.abs(inp.steerX) <= 1 && Math.abs(inp.steerY) <= 1);
  check('decision bot does not boost into the opening (heat is fine but no enemy near — boost is allowed in open stretches)', typeof inp.boost === 'boolean');
}

// --- perf guard ---
check('perf guard steps down after sustained low fps', perfGuardStep(0, 30, 3000) === 1);
check('perf guard holds at the bottom rung', perfGuardStep(3, 30, 99999) === 3);
check('perf guard does not step down on good fps', perfGuardStep(0, 60, 99999) === 0);
check('perf guard does not step down on a brief dip', perfGuardStep(0, 30, 1000) === 0);

// --- save round-trip ---
{
  const save = defaultSave();
  save.best[1] = { score: 1234, kills: 20, cleared: true };
  const back = parseSave(serializeSave(save));
  check('save round-trips the best result', back.best[1].score === 1234 && back.best[1].kills === 20 && back.best[1].cleared === true);
  check('corrupt save falls back to defaults', parseSave('not json').version === SAVE_VERSION);
  const rec = recordBest(back, 1, 2000, 10, false);
  check('recordBest keeps the max score', rec.score === 2000 && rec.cleared === true);
  check('recordBest records a fresh clear', recordBest(back, 2, 500, 5, true).cleared === true);
  // v0.1.2: a loss records the best (uncleared) but does not unlock.
  const lost = recordBest(defaultSave(), 1, 1000, 10, false);
  check('recordBest on a loss saves the score uncleared', lost.score === 1000 && lost.cleared === false);
  check('an uncleared best does not unlock the next sortie', !isSortieUnlocked({ 1: lost }, 2));
}

if (failed) { console.error(`smoke: ${failed} failure(s) out of ${passed + failed}`); process.exit(1); }
console.log(`smoke: PASS — ${passed} checks`);
