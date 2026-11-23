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
