# Neon Talon — devlog

## M1 — Core (v0.1.0, 2026-11-23)

Flight model (steer, bank, boost, heat), guns + lock-on missiles, four
enemy types, canyon collision + hull damage, 3 dense hand-crafted
sorties, live 3D menu with screen stack and juice. No assist of any
kind: no auto-aim, lock-on requires holding the target in the reticle,
missiles need a lock.

### What the tuning taught us

- **The wall-scrape boundary bug.** The first wall clamp set the ship
  exactly on the safe-box edge, and the next step's strict `x < minX`
  check stopped scraping — a straight-line bot "survived" the canyon
  by sitting on the boundary. Fixed with a 1-unit scrape band inside
  the hard clamp.
- **Rams come in waves, not singles.** Drones spawned as a wall all
  converged on the player at once. Staggering spawns by 6 units and
  giving each drone a homing offset (±2.5) turned the swarm into a
  stream the player can actually fight.
- **Aim steering, not position steering.** Blending a position steer
  with an aim steer overshoots the aim by up to 2x (the position
  steer saturates at ±1), so locks never completed. The bot now steers
  the AIM onto the target and the ship follows the nose — locks work,
  and the decision bot clears all 3 sorties with hull to spare.
- **Carriers must block the canyon.** Fans alone never landed on the
  decision bot (it dodges with perfect closest-approach math), so
  carrier armour was inert and guns-only cleared everything. Now a
  live carrier within 10 units stops forward motion and grinds the
  hull — the only way through is to kill it, and guns do 30% damage
  to it. Missiles are load-bearing again: guns-only loses on all 3.
- **One missile per lock.** The bot dumped its whole 8-missile rack
  at the first locked carrier in eight steps. Firing clears the lock
  (keeping 0.4s of partial credit), so each missile costs a fresh
  lock window.
- **Big targets lock easily.** The reticle cone is size-aware now
  (carrier radius 4.0): locking a capital ship point-blank is easy,
  locking a drone at range is hard. Without this, the carrier block
  was a trap — the lock could never rebuild while blocked.

### Test totals (M1)

- smoke: 146 checks PASS
- bot: decision clears all 3 (hull 91/65/43), straight-line loses all 3,
  guns-only loses all 3
- render-check: PASS (zero console errors)
- Size sweep: menu + gameplay at 1280x720, 2560x1080, 1080x2340,
  inspected by eye

### Known issues (M1)

- M1 is NOT done until a real-browser FUN playtest says GO — that
  playtest happens in the 13:30 run against the live site.
- No human has flown sorties 2–3 yet; the decision bot is the only
  pilot so far.

## v0.1.1 — first live playtest NO-GO, fun fix (2026-11-23, 13:30 run)

The first real-browser playtest of the live v0.1.0 site said NO-GO:
sortie 1 was never cleared in 7 attempts (best 73%, 10 kills), a
passive player died in ~15s, and the opening punished instead of
teaching. Verified each claim against the shipped code before fixing;
the "tutorial teaches missiles first" claim did not hold up (How to
Play orders guns before missiles; the toast the tester quoted is the
lock-acquired toast, not a tutorial step). What was real, and fixed:

- **Spawn steering trap.** Mouse steering was absolute: wherever the
  cursor rested after clicking Play steered the ship into a wall
  before the player touched anything. Steering is now relative to the
  mouse position at launch — that position is neutral.
- **Spawn protection.** No damage lands in the first 4 seconds of a
  run. Rams and shots still fire their feedback, so the threat reads;
  the hull doesn't drop while the player is still orienting.
- **Lock-on forgiveness.** LOCK_TIME 1.0s -> 0.8s, reticle cone
  widened (1.4 -> 1.9 base, 0.03 -> 0.04 slope), lock decay 2x -> 1.5x.
- **Damage readability.** New directional damage edge (red wash on
  the side the hit came from), damage number pops on the ship for
  hits >= 1, throttled wall-scrape warning toast, hit-flash
  0.55 -> 0.7 alpha. Ship emissive raised so the fuselage reads from
  behind.
- **Perf toast once per session** instead of on every step-down.
- **Bot missile discipline.** The wider lock cone let the decision
  bot burn missiles on turrets; it reached sortie 3's second carrier
  with 0 ammo and died grinding (traced: blocked at t=28.9, hull
  63 -> 0 by t=39.0). The bot now fires missiles at carriers only —
  turrets are gun targets (70 HP).
- **Real bug found by the render check:** `fireMissile()` was dead
  while the autopilot flew — the missile queue was only consumed in
  the manual-input branch. Fixed; the queue is now consumed in both
  branches. (The v0.1.0 check had passed only because the bot fired
  missiles on its own.)

### Test totals (v0.1.1)

- smoke: 148 checks PASS (incl. new spawn-protection checks)
- bot: decision clears all 3 (S1 23.3s hull 95, S2 27.5s hull 85,
  S3 33.9s hull 32), straight-line loses all 3, guns-only loses all 3
- render-check: PASS (zero console errors; autopilot clears sortie 1,
  score 4552)
- Size sweep: menu + gameplay at 1280x720, 2560x1080, 1080x2340,
  inspected by eye — no clipping or overlap. Portrait still leaves a
  large empty sky band above the canyon (carried known issue).

### Still open after v0.1.1

- The canyon reads flat/stark in places (big untextured wall planes,
  black sky above the rims) — a visual-richness item for M3, not an
  M1 blocker.
- No human has yet cleared a sortie in real time; the re-playtest of
  v0.1.1 decides M1.
