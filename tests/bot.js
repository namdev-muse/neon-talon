// Neon Talon v0.1.0 — bot harness: the decision bot plays every sortie
// to completion through the public setInput / stepRun hooks, and the
// anti-slop gate asserts a bot that flies straight and holds fire
// LOSES on every sortie. If the straight bot clears a sortie, the
// sortie is not done; if the decision bot cannot clear one, the heat
// economy or the bot is not done.
import { SORTIES, simulateRun } from '../physics.js';

let failures = 0;
for (const sortie of SORTIES) {
  const bot = simulateRun(sortie, 'decision');
  const straight = simulateRun(sortie, 'straight');
  const gunsOnly = simulateRun(sortie, 'gunsOnly');
  console.log(`Sortie ${sortie.id} "${sortie.name}": decision ${bot.completed ? 'CLEAR' : 'FAILED'}`
    + ` in ${bot.time.toFixed(1)}s, score ${bot.score}`
    + ` (${bot.kills} kills, hull ${bot.hull.toFixed(0)}, ${bot.missilesFired} missiles,`
    + ` ${bot.shotsHit}/${bot.shotsFired} hits, streak ${bot.bestStreak})`
    + ` | straight: ${straight.completed ? 'CLEARED (SLOP!)' : `lost at z=${straight.z.toFixed(0)} (hull ${straight.hull.toFixed(0)})`}`
    + ` | guns-only: ${gunsOnly.completed ? 'CLEARED' : `lost at z=${gunsOnly.z.toFixed(0)} (hull ${gunsOnly.hull.toFixed(0)})`}`);
  if (!bot.completed) { failures++; console.error(`  BOT FAIL: sortie ${sortie.id} not completed by the decision bot`); }
  if (bot.hull < 15) { failures++; console.error(`  BOT FAIL: sortie ${sortie.id} decision bot finished with hull ${bot.hull.toFixed(0)} — margin too thin`); }
  if (straight.completed) { failures++; console.error(`  BOT FAIL: sortie ${sortie.id} is clearable by flying straight and holding fire — tighten the sortie`); }
  if (bot.kills === 0) { failures++; console.error(`  BOT FAIL: sortie ${sortie.id} decision bot killed nothing`); }
  if (bot.missilesFired === 0) { failures++; console.error(`  BOT FAIL: sortie ${sortie.id} decision bot never fired a missile — lock-on is not part of the play`); }
}

// Guns-only gate: a bot that flies well but never uses missiles must
// fail at least one sortie — carriers are gun-armoured, so missiles
// are not optional.
{
  const gunsOnlyResults = SORTIES.map((s) => simulateRun(s, 'gunsOnly'));
  const failedCount = gunsOnlyResults.filter((r) => !r.completed).length;
  console.log(`Guns-only bot: ${gunsOnlyResults.map((r) => r.completed ? 'CLEAR' : 'lost').join(', ')}`);
  if (failedCount === 0) {
    failures++;
    console.error('  BOT FAIL: guns-only bot clears every sortie — missiles are optional, carrier armour is not load-bearing');
  }
}

if (failures) { console.error(`bot: ${failures} failure(s)`); process.exit(1); }
console.log(`bot: PASS — decision bot clears all ${SORTIES.length} sorties, straight-line bot loses on all ${SORTIES.length}, guns-only bot fails at least one sortie`);
