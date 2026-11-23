// Neon Talon v0.1.0 — pure simulation core (no DOM, no Three.js).
// 3D neon aerial dogfighter: fly a neon interceptor through canyon
// runs; guns and lock-on missiles take down drones, interceptors and
// turrets; boost builds heat, and heat management is the skill —
// overheating locks boost out and slows your guns. Hull damage from
// canyon walls, enemy fire and rams; hull at 0 = sortie lost. Score
// from kills + time + hull left; best result saved per sortie.
//
// Anti-slop: no auto-aim, no assist of any kind. Lock-on requires
// holding the target inside the reticle for a lock window, and
// missiles need a lock. Carriers are gun-armoured (guns do half
// damage) so missiles are not optional. The bot plays through the
// same public hooks (setInput / stepRun / simulateRun) and must make
// real flying decisions: a bot that flies straight and holds fire
// LOSES on every sortie (see tests/bot.js).

export const VERSION = '0.1.3';
export const DT = 1 / 60;
export const HULL_MAX = 100;
export const HEAT_MAX = 100;
export const OVERHEAT_CLEAR = 35; // heat must fall this far before boost unlocks
export const BASE_SPEED = 26;
export const BOOST_SPEED = 24;
export const LATERAL_SPEED = 24;
export const VERTICAL_SPEED = 18;
export const GUN_RATE = 8; // shots per second
export const GUN_DAMAGE = 6;
export const GUN_RANGE = 70;
export const GUN_HEAT_PER_SHOT = 0.9;
export const LOCK_TIME = 0.8; // seconds the target must stay in the reticle
export const LOCK_RANGE = 80;
export const MISSILE_DAMAGE = 90;
export const MISSILE_SPEED = 95;
export const MISSILE_AMMO = 8;
export const MISSILE_AMMO_MAX = 12;
export const WALL_SCRAPE_DPS = 14;
export const PROJECTILE_SPEED = 55;
export const SAVE_VERSION = 1;

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// --- enemy defs ---
// drone       — drifts toward the player's lane and rams. No guns: the
//               teaching threat, and the reason flying straight dies.
// interceptor — strafes, shoots at the player. The duellist.
// turret      — bolted to a canyon wall, shoots when the player is in
//               range ahead. Must be killed or dodged, not ignored.
// carrier     — big, slow, armoured against guns (50%), launches
//               two-shot bursts. Missiles are the answer.
export const ENEMY_DEFS = {
  drone: { hp: 20, score: 100, ramDamage: 10, r: 0.8, color: '#f472b6' },
  interceptor: { hp: 40, score: 150, ramDamage: 12, fireInterval: 2.6, shotDamage: 8, r: 1.0, color: '#fb7185' },
  turret: { hp: 70, score: 250, fireInterval: 2.2, shotDamage: 8, r: 1.5, color: '#e879f9' },
  carrier: { hp: 260, score: 500, gunArmor: 0.3, fireInterval: 1.6, shotDamage: 12, shotSpeed: 70, r: 4.0, color: '#fbbf24' },
};
export const ENEMY_ORDER = ['drone', 'interceptor', 'turret', 'carrier'];

// --- feedback tiers (game-feel skill: small 0.10-0.20 / no stop,
// medium 0.30-0.50 / 0.04-0.06s, large 0.70-1.00 / 0.10-0.15s) ---
export const FEEDBACK_TIERS = {
  small: { traumaMin: 0.10, traumaMax: 0.20, stopMin: 0, stopMax: 0 },
  medium: { traumaMin: 0.30, traumaMax: 0.50, stopMin: 0.04, stopMax: 0.06 },
  large: { traumaMin: 0.70, traumaMax: 1.00, stopMin: 0.10, stopMax: 0.15 },
};
export const FEEDBACK = {
  gunFire: { tier: 'small', trauma: 0.10, hitStop: 0 },
  kill: { tier: 'small', trauma: 0.12, hitStop: 0 },
  lockAcquired: { tier: 'small', trauma: 0.15, hitStop: 0 },
  missileFire: { tier: 'medium', trauma: 0.35, hitStop: 0.05 },
  missileHit: { tier: 'medium', trauma: 0.45, hitStop: 0.05 },
  playerHit: { tier: 'medium', trauma: 0.45, hitStop: 0.05 },
  wallScrape: { tier: 'medium', trauma: 0.35, hitStop: 0.04 },
  overheat: { tier: 'medium', trauma: 0.40, hitStop: 0.05 },
  blocked: { tier: 'medium', trauma: 0.35, hitStop: 0.04 },
  killStreak: { tier: 'large', trauma: 0.80, hitStop: 0.10 },
  sortieClear: { tier: 'medium', trauma: 0.40, hitStop: 0.05 },
  sortieLost: { tier: 'large', trauma: 0.90, hitStop: 0.12 },
};
export const FEEDBACK_LAYERS = {
  gunFire: ['sound', 'particles', 'shake', 'tracer'],
  kill: ['sound', 'particles', 'shake', 'pop', 'glowPulse'],
  lockAcquired: ['sound', 'shake', 'ringPulse', 'toast'],
  missileFire: ['sound', 'particles', 'shake', 'hitStop', 'pop', 'fovPulse'],
  missileHit: ['sound', 'particles', 'shake', 'hitStop', 'flash', 'pop'],
  playerHit: ['sound', 'particles', 'shake', 'hitStop', 'flash', 'knockback'],
  wallScrape: ['sound', 'particles', 'shake', 'hitStop', 'flash'],
  overheat: ['sound', 'shake', 'flash', 'toast', 'fovPulse'],
  blocked: ['sound', 'shake', 'flash', 'toast'],
  killStreak: ['sound', 'particles', 'shake', 'hitStop', 'slowMo', 'flash', 'pop', 'toast'],
  sortieClear: ['sound', 'particles', 'shake', 'hitStop', 'fovPulse', 'pop', 'toast'],
  sortieLost: ['sound', 'particles', 'shake', 'hitStop', 'flash', 'slowMo', 'toast', 'squash'],
};

// --- sorties ---
// A sortie is a hand-authored canyon: segments (z range, centre x,
// half-width, floor, ceiling) plus a spawn list. Spawns use offsets
// from the segment centre at their z, so a bend never strands an
// enemy inside a wall. Turrets sit on a wall (side left/right).
// dx/dy are relative to the canyon centre at the spawn z.
export const SORTIES = [
  {
    id: 1, name: 'First Flight', seed: 11,
    hint: 'The teaching run — slow drones first, one telegraphed turret, a carrier at the end.',
    theme: { ring: '#22d3ee', glow: '#0e7490', accent: '#f472b6', disc: '#0b1030', tint: '#67e8f9' },
    length: 700,
    segments: [
      // v0.1.2 teaching runway (live-playtest fix): the opening is
      // straight to z=220 and the first bends are gentle (±4, not
      // ±6). In v0.1.1 the centre swung to +6 at z=150 — a ship that
      // hadn't started steering yet was already in the scrape band
      // the moment spawn protection ended, so a new player was
      // punished before they had flown. A straight ship still never
      // clears: drones ram, turrets shoot, and the carrier at 640
      // blocks the canyon — the straight-line bot gate still holds.
      { z0: 0, z1: 220, cx: 0, hw: 9, floor: 2, ceil: 16 },
      { z0: 220, z1: 380, cx: 4, hw: 8, floor: 2, ceil: 16 },
      { z0: 380, z1: 520, cx: -4, hw: 8, floor: 2, ceil: 16 },
      { z0: 520, z1: 620, cx: 3, hw: 8, floor: 2, ceil: 16 },
      { z0: 620, z1: 700, cx: 0, hw: 9, floor: 2, ceil: 16 },
    ],
    spawns: [
      { at: 80, type: 'drone', count: 3, dx: 0, dy: 9, spread: 3 },
      { at: 140, type: 'drone', count: 3, dx: -2, dy: 8, spread: 3 },
      { at: 200, type: 'drone', count: 4, dx: 2, dy: 10, spread: 4 },
      { at: 220, type: 'turret', side: 'right', y: 9 },
      { at: 280, type: 'interceptor', count: 2, dx: 0, dy: 9, spread: 5 },
      { at: 340, type: 'drone', count: 5, dx: -1, dy: 9, spread: 4 },
      { at: 400, type: 'turret', side: 'left', y: 10 },
      { at: 450, type: 'interceptor', count: 2, dx: 1, dy: 8, spread: 5 },
      { at: 460, type: 'drone', count: 3, dx: 0, dy: 11, spread: 4 },
      { at: 520, type: 'turret', side: 'right', y: 8 },
      { at: 580, type: 'drone', count: 4, dx: 0, dy: 9, spread: 4 },
      { at: 640, type: 'carrier', dx: 0, dy: 9 },
      { at: 640, type: 'interceptor', count: 2, dx: -4, dy: 10, spread: 3 },
      { at: 680, type: 'drone', count: 3, dx: 2, dy: 8, spread: 3 },
    ],
  },
  {
    id: 2, name: 'Ember Strait', seed: 22,
    hint: 'Tighter rock, swinging bends — interceptors hunt in pairs and turrets guard the gates.',
    theme: { ring: '#fb923c', glow: '#c2410c', accent: '#22d3ee', disc: '#1c0e06', tint: '#fdba74' },
    length: 800,
    segments: [
      { z0: 0, z1: 130, cx: 0, hw: 9, floor: 2, ceil: 15 },
      { z0: 130, z1: 280, cx: 6, hw: 8, floor: 2, ceil: 15 },
      { z0: 280, z1: 430, cx: -6, hw: 8, floor: 3, ceil: 15 },
      { z0: 430, z1: 580, cx: 5, hw: 7, floor: 2, ceil: 14 },
      { z0: 580, z1: 700, cx: -4, hw: 8, floor: 2, ceil: 15 },
      { z0: 700, z1: 800, cx: 0, hw: 9, floor: 2, ceil: 15 },
    ],
    spawns: [
      { at: 70, type: 'drone', count: 3, dx: 0, dy: 9, spread: 3 },
      { at: 120, type: 'interceptor', count: 2, dx: 0, dy: 9, spread: 5 },
      { at: 180, type: 'turret', side: 'left', y: 9 },
      { at: 210, type: 'drone', count: 4, dx: 1, dy: 10, spread: 4 },
      { at: 280, type: 'interceptor', count: 2, dx: -2, dy: 8, spread: 5 },
      { at: 330, type: 'turret', side: 'right', y: 10 },
      { at: 360, type: 'drone', count: 5, dx: 0, dy: 9, spread: 4 },
      { at: 420, type: 'carrier', dx: 0, dy: 9 },
      { at: 420, type: 'interceptor', count: 2, dx: 4, dy: 10, spread: 3 },
      { at: 480, type: 'turret', side: 'left', y: 8 },
      { at: 500, type: 'drone', count: 4, dx: -1, dy: 11, spread: 4 },
      { at: 560, type: 'interceptor', count: 3, dx: 0, dy: 9, spread: 6 },
      { at: 620, type: 'turret', side: 'right', y: 9 },
      { at: 640, type: 'turret', side: 'left', y: 11 },
      { at: 680, type: 'drone', count: 5, dx: 0, dy: 9, spread: 4 },
      { at: 740, type: 'carrier', dx: 0, dy: 9 },
      { at: 740, type: 'interceptor', count: 2, dx: -4, dy: 8, spread: 3 },
    ],
  },
  {
    id: 3, name: "Widow's Spine", seed: 33,
    hint: 'Narrow gates and hard swings — turrets in pairs, carriers behind interceptor screens.',
    theme: { ring: '#e879f9', glow: '#a21caf', accent: '#fbbf24', disc: '#16061c', tint: '#f0abfc' },
    length: 900,
    segments: [
      { z0: 0, z1: 120, cx: 0, hw: 8, floor: 2, ceil: 15 },
      { z0: 120, z1: 260, cx: 7, hw: 7, floor: 2, ceil: 14 },
      { z0: 260, z1: 400, cx: -7, hw: 7, floor: 3, ceil: 14 },
      { z0: 400, z1: 540, cx: 6, hw: 6, floor: 2, ceil: 14 },
      { z0: 540, z1: 700, cx: -6, hw: 7, floor: 2, ceil: 15 },
      { z0: 700, z1: 820, cx: 4, hw: 6, floor: 3, ceil: 14 },
      { z0: 820, z1: 900, cx: 0, hw: 8, floor: 2, ceil: 15 },
    ],
    spawns: [
      { at: 60, type: 'drone', count: 3, dx: 0, dy: 9, spread: 3 },
      { at: 110, type: 'interceptor', count: 2, dx: 0, dy: 9, spread: 5 },
      { at: 160, type: 'turret', side: 'right', y: 9 },
      { at: 180, type: 'turret', side: 'left', y: 11 },
      { at: 210, type: 'drone', count: 5, dx: 0, dy: 9, spread: 4 },
      { at: 270, type: 'interceptor', count: 3, dx: 0, dy: 9, spread: 6 },
      { at: 330, type: 'turret', side: 'left', y: 8 },
      { at: 360, type: 'drone', count: 5, dx: 1, dy: 10, spread: 4 },
      { at: 420, type: 'carrier', dx: 0, dy: 9 },
      { at: 420, type: 'interceptor', count: 2, dx: 4, dy: 10, spread: 3 },
      { at: 470, type: 'turret', side: 'right', y: 10 },
      { at: 500, type: 'interceptor', count: 2, dx: -2, dy: 8, spread: 5 },
      { at: 530, type: 'drone', count: 4, dx: 0, dy: 9, spread: 4 },
      { at: 580, type: 'turret', side: 'left', y: 9 },
      { at: 600, type: 'turret', side: 'right', y: 11 },
      { at: 640, type: 'interceptor', count: 3, dx: 0, dy: 9, spread: 6 },
      { at: 700, type: 'drone', count: 6, dx: 0, dy: 9, spread: 5 },
      { at: 760, type: 'carrier', dx: 0, dy: 9 },
      { at: 760, type: 'interceptor', count: 2, dx: -4, dy: 8, spread: 3 },
      { at: 820, type: 'drone', count: 4, dx: 0, dy: 10, spread: 4 },
      { at: 860, type: 'interceptor', count: 2, dx: 0, dy: 9, spread: 5 },
    ],
  },
];

export function sortieById(id) {
  return SORTIES.find((s) => s.id === id) || null;
}
export function segmentAt(sortie, z) {
  for (const seg of sortie.segments) {
    if (z >= seg.z0 && z < seg.z1) return seg;
  }
  return sortie.segments[sortie.segments.length - 1];
}
// Safe flight box at distance z: centre x, half-width, floor, ceiling.
export function safeBoxAt(sortie, z) {
  const seg = segmentAt(sortie, z);
  return { cx: seg.cx, hw: seg.hw, floor: seg.floor, ceil: seg.ceil };
}
export function totalEnemiesInSortie(sortie) {
  let n = 0;
  for (const s of sortie.spawns) n += s.count ?? 1;
  return n;
}
export function sortieThreat(sortie) {
  let t = 0;
  for (const s of sortie.spawns) {
    const def = ENEMY_DEFS[s.type];
    t += (s.count ?? 1) * def.hp * (s.type === 'carrier' ? 1.5 : s.type === 'turret' ? 1.2 : 1);
  }
  return t;
}
export function parTime(sortie) { return sortie.length / 30; }

// --- unlock gates ---
// Sortie N+1 unlocks when sortie N is cleared. The gates live in the
// menu only — startRun itself never enforces them, so the bot, the
// render check and the ?sortie= seed path can start any sortie
// through the public hooks.
export function isSortieUnlocked(best, id) {
  if (id <= 1) return true;
  const prev = best ? best[id - 1] : null;
  return !!prev && prev.cleared === true;
}

// --- run state ---
export function createRun(sortie, seed) {
  const seg0 = sortie.segments[0];
  const spawnQueue = [];
  for (const s of sortie.spawns) {
    const count = s.count ?? 1;
    for (let i = 0; i < count; i++) {
      // Groups arrive as a stream, not a wall: each enemy in a group
      // spawns 6 units behind the last, so the player meets them one
      // or two at a time instead of eating five simultaneous rams.
      spawnQueue.push({ ...s, count: 1, index: i, at: s.at + i * 6 });
    }
  }
  spawnQueue.sort((a, b) => a.at - b.at);
  return {
    sortie,
    time: 0,
    z: 0,
    x: seg0.cx, y: (seg0.floor + seg0.ceil) / 2,
    vx: 0, vy: 0,
    hull: HULL_MAX, heat: 0, overheated: false,
    score: 0, kills: 0, shotsFired: 0, shotsHit: 0,
    missilesFired: 0, missilesHit: 0, ammo: MISSILE_AMMO,
    blocked: false, blockTimer: 0,
    lockTargetId: null, lockT: 0, lockedId: null, lockLoseT: 0, lockMemoryT: 0,
    gunCd: 0,
    enemies: [], projectiles: [], missiles: [],
    spawnQueue, nextEnemyId: 1,
    input: { steerX: 0, steerY: 0, boost: false, fire: false, missile: false },
    rng: mulberry32(seed ?? sortie.seed * 1000 + 7),
    streak: 0, streakTimer: 0, bestStreak: 0,
    scrapeTimer: 0, scrapeActive: false,
    done: false, reason: null, // 'complete' | 'lost'
  };
}
export function startRun(sortie, seed) { return createRun(sortie, seed); }
export function setInput(run, input) {
  run.input.steerX = clamp(input.steerX ?? 0, -1, 1);
  run.input.steerY = clamp(input.steerY ?? 0, -1, 1);
  run.input.boost = !!input.boost;
  run.input.fire = !!input.fire;
  if (input.missile) run.input.missile = true;
}

// Aim direction: the nose tilts toward where the ship is steering,
// so aiming IS steering — point the nose at the target.
export function aimDir(run) {
  const dx = run.input.steerX * 0.35;
  const dy = run.input.steerY * 0.35;
  const len = Math.hypot(dx, dy, 1);
  return { x: dx / len, y: dy / len, z: 1 / len };
}
// Cone test: is this enemy inside the gun cone? Returns the
// along-axis distance t, or null.
export function gunConeT(run, e) {
  const a = aimDir(run);
  const rx = e.x - run.x, ry = e.y - run.y, rz = e.z - run.z;
  const t = rx * a.x + ry * a.y + rz * a.z;
  if (t < 0 || t > GUN_RANGE) return null;
  const lx = rx - a.x * t, ly = ry - a.y * t, lz = rz - a.z * t;
  const lat = Math.hypot(lx, ly, lz);
  if (lat > 2.0 + t * 0.045 + (ENEMY_DEFS[e.type].r ?? 0) * 0.5) return null;
  return t;
}
// Tighter reticle cone for lock-on. The cone widens with the
// target's size: a carrier fills the reticle at close range, a
// drone does not — locking a capital ship point-blank must be easy,
// or the carrier block becomes a trap instead of a fight.
export function reticleT(run, e) {
  const a = aimDir(run);
  const rx = e.x - run.x, ry = e.y - run.y, rz = e.z - run.z;
  const t = rx * a.x + ry * a.y + rz * a.z;
  if (t < 0 || t > LOCK_RANGE) return null;
  const lx = rx - a.x * t, ly = ry - a.y * t, lz = rz - a.z * t;
  const lat = Math.hypot(lx, ly, lz);
  if (lat > 1.9 + t * 0.04 + (ENEMY_DEFS[e.type].r ?? 0)) return null;
  return t;
}
function spawnEnemy(run, spec) {
  const def = ENEMY_DEFS[spec.type];
  const seg = segmentAt(run.sortie, spec.at);
  let x, y;
  if (spec.type === 'turret') {
    const side = spec.side === 'left' ? -1 : 1;
    x = seg.cx + side * (seg.hw - 0.6);
    y = spec.y ?? 9;
  } else {
    const jx = (run.rng() * 2 - 1) * (spec.spread ?? 0);
    const jy = (run.rng() * 2 - 1) * ((spec.spread ?? 0) * 0.4);
    x = seg.cx + (spec.dx ?? 0) + jx;
    y = clamp(spec.dy ?? 9 + jy, seg.floor + 1, seg.ceil - 1);
  }
  const e = {
    id: run.nextEnemyId++, type: spec.type,
    x, y, z: spec.at,
    hp: def.hp, maxHp: def.hp,
    baseX: x, baseY: y, phase: run.rng() * Math.PI * 2,
    fireCd: 1.5 + run.rng() * 1.5,
    burstLeft: 0, burstCd: 0,
    // Drones home on a point near the player, not exactly on them:
    // a drone with a big offset flies past at arm's length, one with
    // a small offset rams. The player who shoots them never finds
    // out which — the one who ignores them does.
    homeX: (run.rng() * 2 - 1) * 2.5,
    homeY: (run.rng() * 2 - 1) * 1.5,
  };
  run.enemies.push(e);
  return e;
}

// Every enemy removal settles the lock the same way (v0.1.2 lock
// memory): a lock whose target vanishes — shot down, rammed, or flown
// past — keeps 0.4s of re-lock credit, and a FULL lock is remembered
// for 0.75s so an E press in the next beat still fires (see the
// missile section). Before this, the ram and despawn paths never
// touched the lock at all: a locked drone that rammed the ship left
// lockedId dangling at a removed enemy, so the reticle stayed gold
// with "LOCK" showing while E silently did nothing — the live
// playtest's "E never fires", reproduced in the render check. A lock
// lost because the target left the reticle does NOT set memory —
// the 2.5s lock grace already covers that — and a partial lock
// (lockTargetId only) never earned a missile, so it sets none either.
function clearLockOnRemoval(run, e) {
  if (run.lockedId === e.id) {
    run.lockedId = null; run.lockTargetId = null; run.lockT = 0.4; run.lockLoseT = 0;
    run.lockMemoryT = 0.75;
  } else if (run.lockTargetId === e.id) {
    run.lockTargetId = null; run.lockT = 0.4; run.lockLoseT = 0;
  }
}

function damageEnemy(run, e, dmg, events, source) {
  e.hp -= dmg;
  if (e.hp > 0) return false;
  const idx = run.enemies.indexOf(e);
  if (idx < 0) return false;
  run.enemies.splice(idx, 1);
  const def = ENEMY_DEFS[e.type];
  run.kills++;
  run.score += def.score;
  run.streak++;
  run.streakTimer = 3;
  run.bestStreak = Math.max(run.bestStreak, run.streak);
  if (e.type === 'carrier') run.ammo = Math.min(run.ammo + 2, MISSILE_AMMO_MAX);
  clearLockOnRemoval(run, e);
  events.push({ type: 'kill', kind: e.type, x: e.x, y: e.y, z: e.z, score: def.score, streak: run.streak, source: source || 'guns' });
  if (run.streak >= 3) events.push({ type: 'killStreak', streak: run.streak, x: e.x, y: e.y, z: e.z });
  return true;
}

function damagePlayer(run, dmg, events, source) {
  if (run.done) return;
  // Spawn protection (v0.1.1, live-playtest fix): the opening teaches,
  // it doesn't punish. For the first 4 seconds no damage lands — a
  // new player reading the screen or centring the mouse isn't killed
  // before they start flying. Rams and shots still fire their feedback
  // events (the caller pushes those separately), so the threat reads.
  if (run.time < 4) return;
  run.hull -= dmg;
  events.push({ type: 'playerHit', damage: dmg, source, hull: Math.max(0, run.hull) });
  if (run.hull <= 0) {
    run.hull = 0;
    run.done = true;
    run.reason = 'lost';
    events.push({ type: 'sortieLost', score: run.score, kills: run.kills, z: run.z });
  }
}

// One fixed step. Input comes through run.input (setInput). Returns
// the events fired this step (for juice / audio / particles).
export function stepRun(run, dt = DT) {
  const events = [];
  if (run.done) return events;
  run.time += dt;
  const inp = run.input;

  // --- heat ---
  const boosting = inp.boost && !run.overheated;
  const firing = inp.fire;
  if (boosting) run.heat += 22 * dt;
  if (firing) run.heat += GUN_RATE * GUN_HEAT_PER_SHOT * dt * (run.overheated ? 0.5 : 1);
  run.heat -= (boosting || firing ? 5 : 16) * dt;
  run.heat = clamp(run.heat, 0, HEAT_MAX);
  if (!run.overheated && run.heat >= HEAT_MAX) {
    run.overheated = true;
    events.push({ type: 'overheat', heat: run.heat });
  } else if (run.overheated && run.heat <= OVERHEAT_CLEAR) {
    run.overheated = false;
    events.push({ type: 'heatCooled', heat: run.heat });
  }

  // --- carrier block: a live carrier fills the canyon — the ship
  // cannot slip past it. Forward motion stops and the hull grinds
  // while blocked; the only way through is to kill it. Guns barely
  // scratch carrier armour (30%), so a blocked carrier is a missile
  // problem — that is what makes missiles load-bearing. A player
  // with no missiles left can still grind it down with guns, but
  // the grind (5/s) plus its fans will kill them first.
  const blocker = run.enemies.find((e) => e.type === 'carrier' && e.z - run.z >= 0 && e.z - run.z <= 10);
  run.blocked = !!blocker;
  if (run.blocked) {
    run.blockTimer += dt;
    damagePlayer(run, 5 * dt, events, 'block');
    if (run.blockTimer >= 1) {
      run.blockTimer = 0;
      events.push({ type: 'blocked', x: blocker.x, y: blocker.y, z: blocker.z });
    }
    if (run.done) return events;
  } else {
    run.blockTimer = 0;
  }

  // --- motion ---
  const speed = run.blocked ? 0 : BASE_SPEED + (boosting ? BOOST_SPEED : 0);
  run.z += speed * dt;
  run.vx = inp.steerX * LATERAL_SPEED;
  run.vy = inp.steerY * VERTICAL_SPEED;
  run.x += run.vx * dt;
  run.y += run.vy * dt;

  // --- canyon walls: clamp + scrape damage while pressed against them ---
  // The scrape band is 1 unit inside the hard clamp: a ship clamped
  // to the wall sits AT the wall and keeps scraping every step
  // (a strict `x < minX` check after clamping to minX would stop
  // scraping the very next step — the bug that let a straight-line
  // bot "survive" the canyon by sitting exactly on the boundary).
  const seg = segmentAt(run.sortie, run.z);
  const wallX0 = seg.cx - seg.hw + 1.2, wallX1 = seg.cx + seg.hw - 1.2;
  const wallY0 = seg.floor + 1, wallY1 = seg.ceil - 1;
  if (run.x < wallX0) run.x = wallX0;
  if (run.x > wallX1) run.x = wallX1;
  if (run.y < wallY0) run.y = wallY0;
  if (run.y > wallY1) run.y = wallY1;
  const scraping = run.x <= wallX0 + 1.0 || run.x >= wallX1 - 1.0
    || run.y <= wallY0 + 1.0 || run.y >= wallY1 - 1.0;
  run.scrapeActive = scraping;
  if (scraping) {
    run.scrapeTimer += dt;
    damagePlayer(run, WALL_SCRAPE_DPS * dt, events, 'wall');
    if (run.scrapeTimer >= 0.5) {
      run.scrapeTimer = 0;
      events.push({ type: 'wallScrape', x: run.x, y: run.y, z: run.z });
    }
    if (run.done) return events;
  } else {
    run.scrapeTimer = 0;
  }

  // --- spawns: enemies appear once the player is within 120 ahead ---
  while (run.spawnQueue.length && run.spawnQueue[0].at - run.z <= 120) {
    const spec = run.spawnQueue.shift();
    if (spec.at - run.z < -30) continue; // flew past it unspawned — gone
    const e = spawnEnemy(run, spec);
    events.push({ type: 'spawn', kind: e.type, x: e.x, y: e.y, z: e.z });
  }

  // --- lock-on: the reticle target must stay inside the reticle ---
  // Lock progress decays (it does not hard-reset) when the target
  // slips out of the reticle for a beat, and switching targets keeps
  // a little credit — a human tracking a strafing interceptor should
  // be able to earn a lock, not lose it to one wobble.
  // Target choice is by type first, then distance: a drone crossing
  // the reticle must not steal a carrier lock. And the lock is
  // sticky: the current lock target keeps the lock while it stays in
  // the reticle and nothing higher-priority is also in it.
  const LOCK_PRIO = { carrier: 0, turret: 1, interceptor: 2, drone: 3 };
  let retTarget = null, retScore = Infinity;
  for (const e of run.enemies) {
    const t = reticleT(run, e);
    if (t === null) continue;
    const s = LOCK_PRIO[e.type] * 1000 + t;
    if (s < retScore) { retScore = s; retTarget = e; }
  }
  const curLock = run.lockTargetId !== null ? run.enemies.find((e) => e.id === run.lockTargetId) : null;
  if (curLock && reticleT(run, curLock) !== null
    && (!retTarget || LOCK_PRIO[curLock.type] <= LOCK_PRIO[retTarget.type])) {
    retTarget = curLock;
  }
  // Lock memory decays with the sim (set when a full lock's target
  // dies; see damageEnemy). It is consumed by firing, and a fresh
  // full lock supersedes it.
  if (run.lockMemoryT > 0) run.lockMemoryT = Math.max(0, run.lockMemoryT - dt);
  if (retTarget) {
    if (run.lockTargetId === retTarget.id) {
      run.lockT += dt;
    } else {
      run.lockTargetId = retTarget.id;
      run.lockT = Math.min(run.lockT, 0.3) + dt;
    }
    run.lockLoseT = 0;
    if (run.lockT >= LOCK_TIME && run.lockedId !== retTarget.id) {
      run.lockedId = retTarget.id;
      run.lockMemoryT = 0;
      events.push({ type: 'lockAcquired', targetId: retTarget.id, kind: retTarget.type });
    }
  } else {
    run.lockT = Math.max(0, run.lockT - dt * 1.5);
    if (run.lockT === 0) run.lockTargetId = null;
    if (run.lockedId !== null) {
      run.lockLoseT += dt;
      // Lock grace (v0.1.2: 1.5s -> 2.5s): a lock survives a couple
      // of seconds out of the reticle, so an E press that lands just
      // after the target slips off still fires at the live target
      // instead of silently doing nothing.
      if (run.lockLoseT >= 2.5) { run.lockedId = null; run.lockT = 0; run.lockLoseT = 0; }
    }
  }

  // --- guns ---
  run.gunCd -= dt;
  if (firing && run.gunCd <= 0) {
    run.gunCd = 1 / (run.overheated ? GUN_RATE / 2 : GUN_RATE);
    run.shotsFired++;
    let target = null, bestT = Infinity;
    for (const e of run.enemies) {
      const t = gunConeT(run, e);
      if (t !== null && t < bestT) { bestT = t; target = e; }
    }
    const a = aimDir(run);
    const muzzle = { x: run.x + a.x * 2, y: run.y + a.y * 2, z: run.z + a.z * 2 };
    if (target) {
      run.shotsHit++;
      const def = ENEMY_DEFS[target.type];
      const dmg = GUN_DAMAGE * (def.gunArmor ?? 1);
      events.push({ type: 'gunFire', from: muzzle, to: { x: target.x, y: target.y, z: target.z }, hit: true });
      damageEnemy(run, target, dmg, events, 'guns');
    } else {
      events.push({ type: 'gunFire', from: muzzle, to: { x: run.x + a.x * GUN_RANGE, y: run.y + a.y * GUN_RANGE, z: run.z + a.z * GUN_RANGE }, hit: false });
    }
  }

  // --- missiles: need a lock, cost one ammo, edge-triggered ---
  // One missile per lock: firing clears the lock, so the player
  // must re-lock (a full lock window) to fire again. Without this
  // the bot dumps its whole rack at the first locked carrier in
  // eight steps and has nothing left for the second one.
  if (inp.missile) {
    run.input.missile = false;
    let target = run.enemies.find((e) => e.id === run.lockedId);
    // Lock memory (v0.1.2): a full lock whose target just died to
    // gunfire still counts for 0.75s — fire at the target now being
    // re-locked, provided it already carries 0.3s of lock credit (the
    // credit a target switch banks: min(lockT, 0.3)). Without this,
    // the E press that lands in the beat after the locked drone dies
    // finds lockedId null and silently does nothing, which is exactly
    // what the live playtest reported. The lock was earned — a full
    // 0.8s hold — and the new target must be in the reticle; this is
    // a transfer of an earned lock, not a free missile.
    if (!target && run.lockMemoryT > 0 && run.lockTargetId !== null && run.lockT >= 0.3) {
      target = run.enemies.find((e) => e.id === run.lockTargetId);
    }
    if (target && run.ammo > 0) {
      run.ammo--;
      run.missilesFired++;
      run.lockMemoryT = 0;
      run.missiles.push({ x: run.x, y: run.y, z: run.z, targetId: target.id, life: 4 });
      events.push({ type: 'missileFire', targetId: target.id, kind: target.type, ammo: run.ammo });
      // Firing keeps partial lock credit (0.4s): the player re-locks
      // in 0.6s to fire again, instead of starting from zero — a
      // full re-lock while blocked would take longer than the grind
      // allows.
      run.lockedId = null; run.lockT = 0.4; run.lockTargetId = target.id; run.lockLoseT = 0;
    }
  }

  // --- missiles in flight: home on the target ---
  for (const m of [...run.missiles]) {
    const target = run.enemies.find((e) => e.id === m.targetId);
    m.life -= dt;
    if (!target || m.life <= 0) {
      run.missiles.splice(run.missiles.indexOf(m), 1);
      continue;
    }
    const dx = target.x - m.x, dy = target.y - m.y, dz = target.z - m.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const step = MISSILE_SPEED * dt;
    m.x += (dx / d) * step; m.y += (dy / d) * step; m.z += (dz / d) * step;
    if (d <= Math.max(3, step)) {
      run.missiles.splice(run.missiles.indexOf(m), 1);
      run.missilesHit++;
      events.push({ type: 'missileHit', targetId: target.id, kind: target.type });
      damageEnemy(run, target, MISSILE_DAMAGE, events, 'missile');
    }
  }

  // --- enemies: movement, firing, rams ---
  for (const e of [...run.enemies]) {
    const dz = e.z - run.z;
    if (e.type === 'drone') {
      // Drift toward a point near the player's lane and close in.
      e.z -= 5 * dt;
      const hx = e.homeX ?? 0, hy = e.homeY ?? 0;
      e.x += clamp(run.x + hx - e.x, -1, 1) * 2.5 * dt;
      e.y += clamp(run.y + hy - e.y, -1, 1) * 2.5 * dt;
    } else if (e.type === 'interceptor') {
      e.z -= 5 * dt;
      e.x = e.baseX + Math.sin(run.time * 1.2 + e.phase) * 5;
      e.y = clamp(e.baseY + Math.sin(run.time * 0.9 + e.phase) * 2, 3, 14);
    } else if (e.type === 'carrier') {
      // Carriers close slowly on the player — unless the canyon is
      // blocked by one, in which case it holds position and grinds.
      if (!run.blocked) e.z -= 2.5 * dt;
    }
    // Ram: a drone or interceptor that reaches the player explodes
    // into them. Turrets and carriers are bolted to the rock / too
    // big to ram — flying into one bounces the ship off instead
    // (see below), so the bot cannot die by steering into a wall
    // turret it was trying to shoot.
    const d2 = (e.x - run.x) * (e.x - run.x) + (e.y - run.y) * (e.y - run.y) + (e.z - run.z) * (e.z - run.z);
    if (e.type === 'drone' || e.type === 'interceptor') {
      if (d2 < 2.2 * 2.2) {
        const def = ENEMY_DEFS[e.type];
        clearLockOnRemoval(run, e);
        run.enemies.splice(run.enemies.indexOf(e), 1);
        events.push({ type: 'ram', kind: e.type, x: e.x, y: e.y, z: e.z });
        damagePlayer(run, def.ramDamage ?? 10, events, 'ram');
        if (run.done) return events;
        continue;
      }
    } else if (d2 < 3.5 * 3.5) {
      // Solid contact: push the ship back out and charge hull.
      e.bumpCd = (e.bumpCd ?? 0) - dt;
      const d = Math.sqrt(d2) || 1;
      const push = (3.5 - d) + 0.5;
      run.x += ((run.x - e.x) / d) * push;
      run.y += ((run.y - e.y) / d) * push;
      if (e.bumpCd <= 0) {
        e.bumpCd = 0.5;
        damagePlayer(run, 8, events, 'bump');
        if (run.done) return events;
      }
    }
    // Enemy fire: turrets, interceptors and carriers shoot when the
    // player is ahead in range. Shots lead the player with spread.
    // A carrier does not fan while it is blocking the canyon — the
    // grind is the pressure there; the fan is for the chase.
    const def = ENEMY_DEFS[e.type];
    if (def.fireInterval && dz > -5 && dz < 90 && !(run.blocked && e.type === 'carrier')) {
      e.fireCd -= dt;
      if (e.fireCd <= 0) {
        e.fireCd = def.fireInterval * (0.9 + run.rng() * 0.2);
        fireEnemyShot(run, e, events);
      }
    }
    // Enemies left behind despawn silently.
    if (dz < -25) { clearLockOnRemoval(run, e); run.enemies.splice(run.enemies.indexOf(e), 1); }
  }

  // --- enemy projectiles ---
  for (const p of [...run.projectiles]) {
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    p.life -= dt;
    const d2 = (p.x - run.x) * (p.x - run.x) + (p.y - run.y) * (p.y - run.y) + (p.z - run.z) * (p.z - run.z);
    if (d2 < 2.0 * 2.0) {
      run.projectiles.splice(run.projectiles.indexOf(p), 1);
      damagePlayer(run, p.damage, events, 'shot');
      if (run.done) return events;
      continue;
    }
    if (p.life <= 0) run.projectiles.splice(run.projectiles.indexOf(p), 1);
  }

  // --- kill streak window ---
  if (run.streakTimer > 0) {
    run.streakTimer -= dt;
    if (run.streakTimer <= 0) run.streak = 0;
  }

  // --- sortie complete ---
  if (run.z >= run.sortie.length) {
    run.done = true;
    run.reason = 'complete';
    const timeBonus = Math.max(0, Math.round((parTime(run.sortie) - run.time) * 15));
    const hullBonus = Math.round(run.hull * 10);
    run.score += 1000 + timeBonus + hullBonus;
    events.push({ type: 'sortieClear', score: run.score, kills: run.kills, hull: run.hull, time: run.time, timeBonus, hullBonus });
  }
  return events;
}

function fireEnemyShot(run, e, events) {
  const def = ENEMY_DEFS[e.type];
  const shotSpeed = def.shotSpeed ?? PROJECTILE_SPEED;
  // Lead the player by their current velocity, then add spread.
  // A predictable target gets hit; a dodging one does not.
  const flight = Math.max(0.2, (e.z - run.z) / shotSpeed);
  const tx = run.x + run.vx * flight + (run.rng() * 2 - 1) * 2.2;
  const ty = run.y + run.vy * flight + (run.rng() * 2 - 1) * 2.2;
  const tz = run.z + BASE_SPEED * flight;
  // Carriers fire a 9-shot fan around the predicted position:
  // the shots are 2 units apart — tighter than the ship — so the
  // fan cannot be threaded, only outrun before it arrives. Dodging
  // the aimed shot puts the player in a flanker's path, so a
  // carrier left alive for a whole chase costs real hull. That is
  // what makes missiles load-bearing: guns alone (30% damage)
  // cannot finish a carrier before it fans three or four times.
  const fan = e.type === 'carrier' ? [-8, -6, -4, -2, 0, 2, 4, 6, 8] : [0];
  for (const ox of fan) {
    const dx = (tx + ox) - e.x, dy = (ty + ox * 0.5) - e.y, dz = tz - e.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    run.projectiles.push({
      x: e.x, y: e.y, z: e.z,
      vx: (dx / d) * shotSpeed, vy: (dy / d) * shotSpeed, vz: (dz / d) * shotSpeed,
      damage: def.shotDamage, life: 3,
    });
  }
  events.push({ type: 'enemyFire', kind: e.type, x: e.x, y: e.y, z: e.z });
}

// --- bots (play through the same public hooks) ---
// The decision bot: steers toward the canyon centre when clear,
// toward the nearest killable target when one is ahead, dodges
// incoming fire, fires when a target is in the gun cone, boosts in
// open stretches while heat allows, and fires a missile the moment
// a carrier or turret locks.
export function decisionInput(run) {
  const input = { steerX: 0, steerY: 0, boost: false, fire: false, missile: false };
  // Clamp against the CURRENT segment's safe box — clamping to a
  // lookahead segment scraped the walls on every bend (the bot flew
  // into rock the next segment allows but this one does not).
  // Intersect with the safe box 40 units ahead, so the bot never
  // sits where the next bend's wall is about to be.
  const boxNow = safeBoxAt(run.sortie, run.z);
  const boxNext = safeBoxAt(run.sortie, run.z + 40);
  const box = {
    cx: (Math.max(boxNow.cx - boxNow.hw, boxNext.cx - boxNext.hw)
      + Math.min(boxNow.cx + boxNow.hw, boxNext.cx + boxNext.hw)) / 2,
    hw: (Math.min(boxNow.cx + boxNow.hw, boxNext.cx + boxNext.hw)
      - Math.max(boxNow.cx - boxNow.hw, boxNext.cx - boxNext.hw)) / 2,
    floor: Math.max(boxNow.floor, boxNext.floor),
    ceil: Math.min(boxNow.ceil, boxNext.ceil),
  };
  // Keep 2.5 inside the safe box: the wall scrape band reaches 1
  // unit in from the clamp, so a 1.4 margin would scrape constantly.
  const margin = 2.5;
  const safeX0 = box.cx - box.hw + margin, safeX1 = box.cx + box.hw - margin;
  const safeY0 = box.floor + margin, safeY1 = box.ceil - margin;

  // Dodge: an incoming projectile whose path passes near the ship.
  // Suppressed while blocked: the ship is stopped against a carrier
  // and the lock is the way out — dodging drones costs the lock and
  // the grind kills the ship before the drones do.
  let dodgeX = 0, dodgeY = 0;
  if (run.blocked) {
    dodgeX = 0; dodgeY = 0;
  } else {
  for (const p of run.projectiles) {
    const dx = p.x - run.x, dy = p.y - run.y, dz = p.z - run.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > 35) continue;
    // Time to closest approach along the projectile's path.
    const pv = Math.hypot(p.vx, p.vy, p.vz) || 1;
    const tca = -(dx * p.vx + dy * p.vy + dz * p.vz) / (pv * pv);
    if (tca < 0 || tca > 1.2) continue;
    const cx = p.x + p.vx * tca - run.x, cy = p.y + p.vy * tca - run.y;
    if (Math.hypot(cx, cy) < 4) {
      dodgeX += cx > 0 ? -1 : 1;
      dodgeY += cy > 0 ? -1 : 1;
    }
  }

  // Close-enemy dodge: an enemy inside 15 units and 3.5 lateral is
  // about to ram or be rammed into — veer off it. The guns lose the
  // target for a beat; the hull keeps the 10 damage.
  for (const e of run.enemies) {
    const dz = e.z - run.z;
    if (dz < 0 || dz > 15) continue;
    const lat = Math.hypot(e.x - run.x, e.y - run.y);
    if (lat < 3.5) {
      // Dead-on (lat ~ 0) still needs a side: pick by enemy id so
      // the dodge is deterministic.
      const dirX = lat > 0.01 ? (run.x - e.x) / lat : (e.id % 2 ? 1 : -1);
      const dirY = lat > 0.01 ? (run.y - e.y) / lat : 0;
      dodgeX += dirX * 1.2;
      dodgeY += dirY * 1.2;
    }
  }
  } // end: dodges suppressed while blocked

  // Target: nearest enemy ahead, carriers and turrets first — but a
  // drone inside 35 units is urgent: it is about to ram, and the
  // carrier it is screening can wait half a second.
  let target = null, bestScore = Infinity;
  for (const e of run.enemies) {
    const dz = e.z - run.z;
    if (dz < 0 || dz > 65) continue;
    const prio = e.type === 'carrier' ? 0 : e.type === 'turret' ? 5 : e.type === 'interceptor' ? 10 : 15;
    const s = (e.type === 'drone' && dz < 35) ? dz - 25 : dz + prio;
    if (s < bestScore) { bestScore = s; target = e; }
  }

  // wantX/wantY is the no-target cruise point (canyon centre, or the
  // target when one exists — the pull-off and stand-off for big
  // targets live in the aim point below, not here).
  let wantX = box.cx, wantY = (box.floor + box.ceil) / 2;
  if (target) { wantX = target.x; wantY = target.y; }
  // Turrets and carriers are engaged from a lateral offset, never
  // head-on at the wall: the gun cone at 40 units is ~3.8 wide, so
  // a 3.5-unit stand-off still hits and never bumps the rock.
  const wantMargin = (target && (target.type === 'turret' || target.type === 'carrier')) ? 3.5 : margin;
  wantX = clamp(wantX, box.cx - box.hw + wantMargin, box.cx + box.hw - wantMargin);
  wantY = clamp(wantY, box.floor + wantMargin, box.ceil - wantMargin);
  wantX = clamp(wantX, safeX0, safeX1);
  wantY = clamp(wantY, safeY0, safeY1);
  // --- steering: PURE AIM. The nose tilt is 0.35 per unit of steer,
  // so the steer that puts the aim line through a point is
  // (point - ship) / (0.35 * distance) — and a blend with a
  // position steer overshoots the aim by up to 2x (the position
  // steer saturates at ±1 while the aim steer is a fraction), which
  // is why locks never completed: the reticle swept past the target
  // instead of sitting on it. So the bot aims, and the ship follows
  // the nose — the dogfighter way. Position safety comes from the
  // aim point itself (never past a wall) and the wall guard below.
  const segNow = segmentAt(run.sortie, run.z);
  const wX0 = segNow.cx - segNow.hw + 1.2, wX1 = segNow.cx + segNow.hw - 1.2;
  const wY0 = segNow.floor + 1, wY1 = segNow.ceil - 1;
  let steerX = clamp((wantX - run.x) * 0.3, -1, 1);
  let steerY = clamp((wantY - run.y) * 0.3, -1, 1);
  if (target) {
    const dzT = target.z - run.z;
    let aimX = target.x, aimY = target.y;
    if (target.type === 'turret' || target.type === 'carrier') {
      // Close on a big target: aim at a 4-unit stand-off toward the
      // canyon centre instead of at the target itself. The bump
      // radius is 3.5, so 4 units of lateral stand-off clears it
      // even as the ship passes — the guns go quiet for the last
      // stretch, but the missile (fired on the lock) does the work.
      // No stand-off while blocked: the ship is already stopped
      // against the carrier, and the guns must land to break it.
      if (dzT < 25 && !run.blocked) {
        const dirX = Math.abs(box.cx - target.x) > 0.5
          ? Math.sign(box.cx - target.x)
          : (run.x >= target.x ? 1 : -1);
        aimX = target.x + dirX * 4;
        aimY = target.y;
      }
    } else if (dzT < 12) {
      // Pull off a small target that is about to be passed: aim at
      // the canyon centre and fly past it instead of into it.
      aimX = box.cx; aimY = (box.floor + box.ceil) / 2;
    }
    const dzA = Math.max(dzT, 10);
    let aimSteerX = clamp((aimX - run.x) / (0.35 * dzA), -1, 1);
    let aimSteerY = clamp((aimY - run.y) / (0.35 * dzA), -1, 1);
    // Never aim-steer further toward a wall the ship is already
    // near: park off the wall and let the gun cone cover the
    // wall-side turret instead of grinding the rock to chase it.
    if (run.x > wX1 - 3) aimSteerX = Math.min(aimSteerX, 0);
    if (run.x < wX0 + 3) aimSteerX = Math.max(aimSteerX, 0);
    if (run.y > wY1 - 3) aimSteerY = Math.min(aimSteerY, 0);
    if (run.y < wY0 + 3) aimSteerY = Math.max(aimSteerY, 0);
    steerX = aimSteerX;
    steerY = aimSteerY;
  }
  // Wall guard LAST, after the dodge: inside the scrape band,
  // steering back to open sky overrides everything else — no kill
  // is worth grinding the rock.
  input.steerX = clamp(steerX + dodgeX * 0.9, -1, 1);
  input.steerY = clamp(steerY + dodgeY * 0.9, -1, 1);
  if (run.x <= wX0 + 1.0) input.steerX = Math.max(input.steerX, 0.6);
  if (run.x >= wX1 - 1.0) input.steerX = Math.min(input.steerX, -0.6);
  if (run.y <= wY0 + 1.0) input.steerY = Math.max(input.steerY, 0.6);
  if (run.y >= wY1 - 1.0) input.steerY = Math.min(input.steerY, -0.6);

  // Fire when anything is in the gun cone.
  for (const e of run.enemies) {
    if (gunConeT(run, e) !== null) { input.fire = true; break; }
  }
  // Boost in open stretches while heat allows — never into a fight.
  const enemyNear = run.enemies.some((e) => e.z - run.z > 0 && e.z - run.z < 45);
  const shotNear = run.projectiles.some((p) => Math.hypot(p.x - run.x, p.y - run.y, p.z - run.z) < 30);
  input.boost = !run.overheated && run.heat < 55 && !enemyNear && !shotNear;
  // Missile the moment a carrier locks. Turrets are gun targets too
  // (70 HP) — spending a 90-damage missile on one starves the
  // carrier budget (3 missiles per 260-HP carrier), and the wider
  // v0.1.1 lock cone made the bot do exactly that: it burned 3
  // missiles on turrets before the first carrier, reached the second
  // carrier with 0 ammo, and died grinding against it (trace:
  // t=28.9 blocked, hull 63 -> 0 by t=39.0).
  if (run.lockedId !== null && run.ammo > 0) {
    const locked = run.enemies.find((e) => e.id === run.lockedId);
    if (locked && locked.type === 'carrier') {
      input.missile = true;
    }
  }
  return input;
}
// The straight-line bot: holds fire, flies straight, never boosts,
// never locks. It must lose on every sortie.
export function straightInput() {
  return { steerX: 0, steerY: 0, boost: false, fire: true, missile: false };
}

// Simulate a whole sortie. policy: 'decision' | 'straight' | 'gunsOnly'.
// Returns the outcome.
export function simulateRun(sortie, policy, opts = {}) {
  const run = startRun(sortie, opts.seed);
  const maxSteps = Math.ceil(600 / DT); // 10 minutes of game time
  let steps = 0;
  const events = [];
  while (!run.done && steps < maxSteps) {
    let input;
    if (policy === 'decision') input = decisionInput(run);
    else if (policy === 'gunsOnly') { input = decisionInput(run); input.missile = false; }
    else input = straightInput();
    setInput(run, input);
    const evs = stepRun(run, DT);
    events.push(...evs);
    steps++;
  }
  return {
    completed: run.done && run.reason === 'complete',
    reason: run.reason || (steps >= maxSteps ? 'timeout' : 'running'),
    score: run.score, kills: run.kills, hull: run.hull,
    heat: run.heat, overheated: run.overheated,
    shotsFired: run.shotsFired, shotsHit: run.shotsHit,
    missilesFired: run.missilesFired, missilesHit: run.missilesHit,
    ammo: run.ammo, bestStreak: run.bestStreak,
    time: run.time, z: run.z, steps,
    events: events.length,
  };
}

// Seeded RNG (mulberry32) — only the sim's spread/jitter uses it;
// the sim itself is fully deterministic for a given seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- FPS guard (M5) ---
export const PERF_LEVELS = [1, 0.75, 0.6, 0.5];
export const PERF_FPS_THRESHOLD = 45;
export const PERF_LOW_MS = 3000;
export function perfGuardStep(level, fps, lowMs) {
  const l = clamp(Math.floor(level) || 0, 0, PERF_LEVELS.length - 1);
  if (fps < PERF_FPS_THRESHOLD && lowMs >= PERF_LOW_MS && l < PERF_LEVELS.length - 1) return l + 1;
  return l;
}

// --- save (localStorage) ---
export function defaultSave() {
  return {
    version: SAVE_VERSION, best: {},
    totalRuns: 0, muted: false, shake: 1,
    reduceFlashing: null, music: true, sfx: true, volume: 0.6,
    textSize: 1, highContrast: false,
  };
}
export function serializeSave(save) { return JSON.stringify(save); }
export function parseSave(text) {
  const d = defaultSave();
  try {
    const s = JSON.parse(text);
    if (!s || typeof s !== 'object') return d;
    if (s.best && typeof s.best === 'object') {
      for (const [k, v] of Object.entries(s.best)) {
        if ((/^[1-9]$/.test(k) || /^[1-9][0-9]$/.test(k)) && v && typeof v === 'object'
          && Number.isFinite(v.score)) {
          d.best[k] = {
            score: clamp(Math.floor(v.score), 0, 10000000),
            cleared: v.cleared === true,
            kills: Number.isFinite(v.kills) ? clamp(Math.floor(v.kills), 0, 10000) : 0,
          };
        }
      }
    }
    if (Number.isInteger(s.totalRuns)) d.totalRuns = clamp(s.totalRuns, 0, 100000);
    if (typeof s.muted === 'boolean') d.muted = s.muted;
    if (typeof s.shake === 'number' && Number.isFinite(s.shake)) d.shake = clamp(s.shake, 0, 1);
    if (s.reduceFlashing === null || typeof s.reduceFlashing === 'boolean') d.reduceFlashing = s.reduceFlashing;
    if (typeof s.music === 'boolean') d.music = s.music;
    if (typeof s.sfx === 'boolean') d.sfx = s.sfx;
    if (typeof s.volume === 'number' && Number.isFinite(s.volume)) d.volume = clamp(s.volume, 0, 1);
    if ([1, 1.2, 1.4].includes(s.textSize)) d.textSize = s.textSize;
    if (typeof s.highContrast === 'boolean') d.highContrast = s.highContrast;
    return d;
  } catch { return d; }
}
export function recordBest(save, sortieId, score, kills, cleared) {
  const prev = save.best[sortieId];
  const best = {
    score: Math.max(prev ? prev.score : 0, score),
    kills: Math.max(prev ? prev.kills : 0, kills),
    cleared: (prev ? prev.cleared : false) || cleared === true,
  };
  save.best[sortieId] = best;
  return best;
}
