# Neon Talon

A 3D neon aerial dogfighter built with [Three.js](https://threejs.org/) 0.160.0 — fly a neon interceptor through canyon runs; guns and lock-on missiles take down drones, interceptors and turrets; boost builds heat, and heat management is the skill. Carriers fill the canyon and must be broken with missiles.

**Play it live:** https://namdev-muse.github.io/neon-talon/

![Menu](docs/screenshots/menu.png)
![Gameplay](docs/screenshots/gameplay.png)

## How to play

- **Fly the canyon.** Steer with the mouse or **WASD / arrows**. The walls scrape your hull — stay off the rock.
- **Boost** with **Shift** to close the gap — but boost builds **heat**. At full heat you overheat: boost locks out and your guns fire half as fast until you cool down. Every burst is a decision.
- **Guns** fire with **Space** or by holding the mouse button. Aim by pointing your nose at the target — steering IS aiming.
- **Missiles** need a lock: hold a target inside the reticle for a second until it turns gold, then fire with **E** or right-click. One missile per lock — re-lock to fire again.
- **Drones** drift into your lane and ram. **Interceptors** strafe and shoot. **Turrets** guard the walls. **Carriers** are gun-armoured, fire dense fans, and fill the canyon — you cannot slip past one. Break it with missiles.
- Reach the end of the canyon alive to clear the sortie. Score comes from kills, time and hull left. Your best result is saved per sortie.

## Controls

| Input | Action |
|---|---|
| Mouse / WASD / arrows | Steer |
| Shift | Boost |
| Space / click | Fire guns |
| E / right-click | Fire missile (needs a lock) |
| P | Pause |
| M | Mute |
| R | Restart sortie |
| Esc | Back |
| Touch: drag | Steer |
| Touch: FIRE / BOOST / MISSILE | Fire guns / boost / fire missile |

## Sorties (M1 — 3 of 3)

| Sortie | Identity |
|---|---|
| 1. First Flight | The teaching run — slow drones first, one telegraphed turret, a carrier at the end. |
| 2. Ember Strait | Tighter rock, swinging bends — interceptors hunt in pairs and turrets guard the gates. |
| 3. Widow's Spine | Narrow gates and hard swings — turrets in pairs, carriers behind interceptor screens. |

## Development

No build step — static files served by GitHub Pages from `main`.

```bash
npm test          # smoke tests + bot harness (Node)
npm run render-check   # headless Chromium render check (Playwright)
npm run screenshots    # menu + gameplay shots at 3 resolutions
npm run serve     # serve locally on http://localhost:8127
```

- `physics.js` — pure simulation core (no DOM, no Three.js): flight model, heat, guns, lock-on, missiles, enemies, canyon collision, bots. Fully deterministic.
- `game.js` — Three.js rendering, menu/HUD, audio, game feel, public hooks (`window.__talon`).
- `tests/smoke.js` — 146 Node checks over the simulation.
- `tests/bot.js` — the anti-slop gates: the decision bot clears all 3 sorties, a straight-line hold-fire bot loses on all 3, and a guns-only bot loses on all 3 (carriers are missile problems).

## Anti-slop gates (verified by `npm run bot`)

- A bot that flies straight and holds fire loses on every sortie (walls, rams, turret fire).
- A bot that flies with real boost/heat and lock-on decisions clears all 3 sorties.
- A bot that flies well but never uses missiles loses on every sortie — carriers block the canyon until destroyed, and guns do 30% damage to their armour.
