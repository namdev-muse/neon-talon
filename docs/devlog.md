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

## v0.1.2 — re-playtest NO-GO, the missile race (2026-11-23, 15:30 run)

The v0.1.1 re-playtest (live site, 14:27–15:22) said NO-GO again: sortie
1 never cleared in 20+ runs (best 54%, 10 kills, score 1000). The
blocking defect was **missiles cannot be fired** — E proven broken with
a gold lock (count stayed 8/12), right-click strongly indicated. The
other v0.1.1 fixes were all CONFIRMED (spawn steering neutral, spawn
protection, easy lock, directional damage feedback). Two further
findings: bests never updated (they were only written on a clear, so
the menu said "Not flown yet" after dozens of flights), and the
"Wall scrape" toast text lingered in the page text after the run.

Diagnosis (this run, before fixing — verified, not assumed): a
headless probe proved the E key path itself is FINE — a real keyboard
E on a live carrier lock fires (ammo 8→7). The failure is a
**lock-death race**: the player holds fire while locking, and the
locked drone dies to their own gunfire — or rams — in the beat
between the gold ring and the E press. Two holes:
- Gunfire death cleared the lock (v0.1.1) with no memory, so E found
  `lockedId === null`.
- Ram despawn never touched the lock at all, so `lockedId` dangled at
  a removed enemy while the reticle stayed gold with "LOCK" showing —
  the exact symptom the playtest reported ("gold ring, E does
  nothing").

What v0.1.2 changes (all in the unpushed local tree when this run
started; the opening softening and the race fix below are this run's):
- **Lock memory.** A full lock whose target vanishes is remembered
  for 0.75s; an E press in that window fires at the target now being
  re-locked (needs 0.3s of re-lock credit — the credit a target
  switch banks). One helper (`clearLockOnRemoval`) settles the lock
  at all three removal sites: shot down, rammed, flown past. A lock
  lost because the target left the reticle sets no memory — the 2.5s
  lock grace already covers that. The lock was earned (a full 0.8s
  hold) and the new target must be in the reticle, so this is a
  transfer of an earned lock, not a free missile.
- **Lock transfer + grace** (from the earlier v0.1.2 pass): a dying
  lock target banks 0.4s of re-lock credit instead of zero; lock
  grace 1.5s -> 2.5s.
- **Teaching runway.** Sortie 1's opening is straight to z=220 and
  the first bends are ±4, not ±6: in v0.1.1 the centre swung to +6 at
  z=150, so a ship that hadn't started steering was already in the
  scrape band the moment spawn protection ended. A straight ship
  still never clears — it dies at the carrier block (z=621).
- **Bests on a loss** (recordBest with cleared=false; unlocks stay
  clear-gated) and **toast text cleared on hide**.
- **Render check:** the manual-E regression test now waits for a
  carrier/turret lock like the hook test — a drone lock re-races the
  test at 4x, not the game. The first version of that test FAILED
  (3 attempts, drone locks dying to gunfire/rams in the round-trip
  window), which is what forced the race diagnosis above.
- Smoke tests for the memory: gunfire death, ram death, no-memory
  no-fire, sub-0.3s-credit no-fire.

### Test totals (v0.1.2)

- smoke: 162 checks PASS (incl. 10 new lock-memory checks + 2 new
  teaching-runway checks)
- bot: decision clears all 3 (S1 23.8s hull 94, S2 27.6s hull 84,
  S3 33.9s hull 32), straight-line loses all 3 (S1 now at the carrier
  block, z=621), guns-only loses all 3
- render-check: run 1 — manual E PASSES (real keyboard E on a gold
  carrier lock, ammo 8→7), autopilot clears sortie 1 (Score 4286 —
  exactly the pure-sim bot's score, confirming the new opening),
  Next Sortie unlocks sortie 2, P pause/resume PASS — then FAILED at
  the `?sortie=3` seed step (line 357: phase never became 'run'
  after `start(3)`). An isolated probe of that exact sequence
  PASSES (`?sortie=3` → start(3) → phase 'run' immediately), so it
  looks like a harness race, not a game bug; re-running the check to
  confirm. Run 2: FAILED EARLIER, at the hook lock wait (line 285,
  120s, no carrier/turret lock observed) — but the failure screenshot
  shows "Sortie Clear, Score 4286": the autopilot HAD cleared sortie
  1 during the wait. Root cause is a TEST bug, not a game bug: a
  live `lockedId` is transient (the bot fires on a carrier lock
  within a few frames; turret locks are rare because the bot flies
  centre-lane and wall turrets sit outside the reticle cone), so
  polling `state.lockedId` misses it under slow swiftshader
  rendering. Also found while fixing: the clear step never
  re-enabled the autopilot after the missile tests switched it off —
  run 1's clear only worked because the manual-E missile happened to
  finish the carrier and the final stretch is straight. Fixes: the
  feedback log now carries the event `kind`, and both missile tests
  observe the DURABLE lockAcquired event + PAUSE to freeze the sim
  with the lock live + verify + fire; the clear step restarts with
  the autopilot ON. Run 3: FAILED at the hook test — the turret-only
  wait never resolved (3x120s): the bot never holds a wall turret in
  the reticle at all. Final fix: the missile tests fly straight with
  guns silent at 1x (no autopilot) — the first drones drift into the
  reticle and lock in ~0.8s, and with no gunfire the lock lives
  ~1.7s, ample for the pause-freeze. Run 4: PASS — zero console
  errors; hook missile ammo 8→7, manual E ammo 7→6, autopilot
  clears sortie 1 (Score 4286), Next Sortie unlocks sortie 2,
  ?sortie=3 reaches Widow's Spine, accessibility persists, FPS guard
  steps the pixel ratio. (The run-1 `?sortie=3` failure did not
  recur — harness race, game flow proven by the probe and by run 4.)
- Size sweep: menu + gameplay at 1280x720, 2560x1080, 1080x2340,
  inspected by eye — no clipping or overlap. Portrait still leaves
  a large empty sky band above the canyon (carried known issue); the
  "Performance mode" toast appears in the swiftshader shots (the FPS
  guard stepping down under the slow software renderer — once per
  session, as designed).
