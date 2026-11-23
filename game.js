// Neon Talon v0.2.2 — 3D neon aerial dogfighter (Three.js 0.160.0).
// Fly a neon interceptor through canyon runs; guns and lock-on
// missiles take down drones, interceptors and turrets; boost builds
// heat, and heat management is the skill. Carriers fill the canyon
// and must be broken with missiles. No auto-aim, no assist of any
// kind — steering IS aiming.
import * as THREE from 'three';
import {
  VERSION, SORTIES, sortieById, segmentAt, safeBoxAt, totalEnemiesInSortie,
  DT, HULL_MAX, HEAT_MAX, LOCK_TIME, MISSILE_AMMO,
  ENEMY_DEFS, FEEDBACK, FEEDBACK_LAYERS, isSortieUnlocked,
  createRun, startRun as physicsStartRun, setInput as physicsSetInput, stepRun,
  decisionInput, aimDir, gunConeT, reticleT,
  PERF_LEVELS, PERF_FPS_THRESHOLD, PERF_LOW_MS, perfGuardStep,
  defaultSave, serializeSave, parseSave, recordBest, clamp,
} from './physics.js';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'neon-talon-save-v1';

// ---------- save ----------
let save = parseSave(localStorage.getItem(SAVE_KEY));
function persistSave() {
  try { localStorage.setItem(SAVE_KEY, serializeSave(save)); } catch { /* storage unavailable */ }
}
function reduceFlashingOn() {
  if (save.reduceFlashing !== null) return save.reduceFlashing;
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------- accessibility ----------
function applyAccessibility() {
  document.documentElement.style.fontSize = `${Math.round(save.textSize * 100)}%`;
  document.body.classList.toggle('high-contrast', !!save.highContrast);
}

// ---------- FPS guard ----------
let perfLevel = 0;
let perfToastShown = false;
let lowFpsSince = null;
function fullPixelRatio() { return Math.min(window.devicePixelRatio || 1, 2); }
function applyPerfLevel(level, { silent = false } = {}) {
  perfLevel = clamp(Math.floor(level) || 0, 0, PERF_LEVELS.length - 1);
  if (renderer) renderer.setPixelRatio(fullPixelRatio() * PERF_LEVELS[perfLevel]);
  if (!silent && perfLevel > 0 && !perfToastShown) {
    perfToastShown = true;
    toast('Performance mode — lowered detail to keep the action smooth');
  }
}
function resetPerf() {
  perfLevel = 0;
  lowFpsSince = null;
  if (renderer) renderer.setPixelRatio(fullPixelRatio());
}

// ---------- audio (Web Audio synth SFX + generative music) ----------
let audioCtx = null, masterGain = null, sfxGain = null, musicGain = null;
let noiseBuf = null;
let musicTimer = null, musicStep = 0, nextStepTime = 0;
let musicLeadOn = false;
const MUSIC_BPM = 126;
const BASS_LINE = [55, 0, 55, 0, 65.41, 0, 55, 0, 49, 0, 49, 0, 58.27, 0, 65.41, 0];
const LEAD_LINE = [440, 0, 0, 523.25, 0, 659.25, 0, 0, 587.33, 0, 523.25, 0, 440, 0, 392, 0];
function ensureAudio() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = save.muted ? 0 : save.volume;
    masterGain.connect(audioCtx.destination);
    sfxGain = audioCtx.createGain(); sfxGain.gain.value = 1; sfxGain.connect(masterGain);
    musicGain = audioCtx.createGain(); musicGain.gain.value = 0.28; musicGain.connect(masterGain);
    noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.5, audioCtx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    startMusic();
  } catch { audioCtx = null; }
}
function tone({ freq = 440, freqEnd = null, dur = 0.1, type = 'square', vol = 0.2, when = 0 }) {
  if (!audioCtx || !save.sfx) return;
  const t0 = audioCtx.currentTime + when;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g); g.connect(sfxGain);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}
function noise({ dur = 0.1, vol = 0.2, freq = 1000, when = 0, type = 'bandpass' }) {
  if (!audioCtx || !save.sfx) return;
  const t0 = audioCtx.currentTime + when;
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuf;
  const filter = audioCtx.createBiquadFilter();
  filter.type = type; filter.frequency.value = freq;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(filter); filter.connect(g); g.connect(sfxGain);
  src.start(t0); src.stop(t0 + dur + 0.02);
}
let lastShootAt = 0;
function sfx(name) {
  if (!audioCtx || !save.sfx) return;
  switch (name) {
    case 'tick': tone({ freq: 1200, dur: 0.03, type: 'sine', vol: 0.07 }); break;
    case 'shoot': { // guns — frequent, so throttled and quiet
      const now = performance.now();
      if (now - lastShootAt < 70) return;
      lastShootAt = now;
      tone({ freq: 880, freqEnd: 440, dur: 0.06, type: 'square', vol: 0.05 });
      break;
    }
    case 'explosion': noise({ dur: 0.35, vol: 0.25, freq: 300, type: 'lowpass' }); tone({ freq: 180, freqEnd: 40, dur: 0.3, type: 'sine', vol: 0.2 }); break;
    case 'lock': tone({ freq: 660, freqEnd: 1320, dur: 0.18, type: 'sine', vol: 0.12 }); break;
    case 'missile': noise({ dur: 0.4, vol: 0.18, freq: 1800, type: 'highpass' }); tone({ freq: 220, freqEnd: 880, dur: 0.35, type: 'sawtooth', vol: 0.08 }); break;
    case 'hit': tone({ freq: 140, freqEnd: 60, dur: 0.18, type: 'sawtooth', vol: 0.22 }); noise({ dur: 0.15, vol: 0.18, freq: 500 }); break;
    case 'overheat': tone({ freq: 520, freqEnd: 130, dur: 0.5, type: 'sawtooth', vol: 0.15 }); break;
    case 'blocked': tone({ freq: 220, dur: 0.12, type: 'square', vol: 0.14 }); tone({ freq: 220, dur: 0.12, type: 'square', vol: 0.14, when: 0.18 }); break;
    case 'streak': [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone({ freq: f, dur: 0.12, type: 'triangle', vol: 0.14, when: i * 0.07 })); break;
    case 'clear': [392, 523.25, 659.25, 783.99].forEach((f, i) => tone({ freq: f, dur: 0.2, type: 'triangle', vol: 0.15, when: i * 0.1 })); break;
    case 'lost': [330, 262, 196, 131].forEach((f, i) => tone({ freq: f, dur: 0.3, type: 'sawtooth', vol: 0.12, when: i * 0.14 })); break;
    case 'launch': tone({ freq: 330, freqEnd: 990, dur: 0.3, type: 'sawtooth', vol: 0.12 }); noise({ dur: 0.3, vol: 0.12, freq: 1200 }); break;
    default: break;
  }
}
function startMusic() {
  if (!audioCtx || musicTimer) return;
  musicStep = 0;
  nextStepTime = audioCtx.currentTime + 0.1;
  const stepDur = 60 / MUSIC_BPM / 4;
  musicTimer = setInterval(() => {
    if (!audioCtx || !save.music || save.muted) { musicStep++; nextStepTime = audioCtx.currentTime + stepDur; return; }
    while (nextStepTime < audioCtx.currentTime + 0.15) {
      const step = musicStep % 16;
      const bass = BASS_LINE[step];
      if (bass) {
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = 'triangle'; osc.frequency.value = bass;
        g.gain.setValueAtTime(0.22, nextStepTime);
        g.gain.exponentialRampToValueAtTime(0.001, nextStepTime + stepDur * 1.8);
        osc.connect(g); g.connect(musicGain);
        osc.start(nextStepTime); osc.stop(nextStepTime + stepDur * 2);
      }
      if (musicLeadOn) {
        const lead = LEAD_LINE[step];
        if (lead) {
          const osc = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          osc.type = 'sine'; osc.frequency.value = lead;
          g.gain.setValueAtTime(0.10, nextStepTime);
          g.gain.exponentialRampToValueAtTime(0.001, nextStepTime + stepDur * 1.5);
          osc.connect(g); g.connect(musicGain);
          osc.start(nextStepTime); osc.stop(nextStepTime + stepDur * 1.6);
        }
      }
      // Hat tick on the off-beats.
      if (step % 4 === 2) {
        const src = audioCtx.createBufferSource();
        src.buffer = noiseBuf;
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'highpass'; filter.frequency.value = 6000;
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0.05, nextStepTime);
        g.gain.exponentialRampToValueAtTime(0.001, nextStepTime + 0.04);
        src.connect(filter); filter.connect(g); g.connect(musicGain);
        src.start(nextStepTime); src.stop(nextStepTime + 0.05);
      }
      musicStep++;
      nextStepTime += stepDur;
    }
  }, 40);
}

// ---------- game state ----------
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(fullPixelRatio());
  renderer.setSize(window.innerWidth, window.innerHeight);
  $('game-container').appendChild(renderer.domElement);
} catch { renderer = null; }

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0c28);
scene.fog = new THREE.Fog(0x0a0c28, 60, 230);
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 500);
const hemi = new THREE.HemisphereLight(0x8b9cff, 0x1a0b2e, 1.1);
scene.add(hemi);
const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
dirLight.position.set(20, 40, -20);
scene.add(dirLight);

let phase = 'menu'; // 'menu' | 'run'
let paused = false;
let sortie = SORTIES[0];
let run = null; // active run (or demo run in the menu)
let demoRun = null;
let selectedSortieId = 1;
let seedUnlocked = false;
let screenStack = [];
let autoPilot = false;
let speedMul = 1;
let accumulator = 0;
let lastFrameT = 0;
let fpsEma = 60;
let trauma = 0, fovPulse = 0, glowPulse = 0;
let hitStopUntil = 0, slowMoUntil = 0, slowMoScale = 1;
let timeScale = 1;
let shakeStrength = save.shake;
let lastHudAt = 0;
let midWaveTimer = 0;
let feedbackLog = [];
let boostHeld = false;

// Input state (keyboard + mouse + touch, merged every frame).
const keys = new Set();
// Mouse steering (v0.1.4): screen-centre relative, with a dead zone
// around the centre. The ship steers by the cursor's offset from the
// centre of the screen — the tunnel mouth ahead sits at the screen
// centre, so pointing at it flies level, and moving the cursor from
// there steers. This replaces chase-the-cursor (v0.1.3): with a chase
// camera the ship stays fixed on screen, so a cursor at the tunnel
// mouth was always ~250px above the ship and the climb never turned
// off — the v0.1.3 playtest reproduced the v0.1.2 failure exactly.
// Steering arms only once the cursor has moved 30px from where it
// sat at launch, so the resting cursor after clicking Play (left of
// centre, over the Play button) does not steer the ship before the
// player touches anything (the v0.1.0 spawn trap).
const mouseSteer = { active: false, x: 0, y: 0, armX: null, armY: null };
// Last pointer position anywhere on the page, so a run can arm mouse
// steering from where the mouse actually is at launch.
const lastPointer = { x: null, y: null };
window.addEventListener('pointermove', (e) => {
  lastPointer.x = e.clientX;
  lastPointer.y = e.clientY;
}, { passive: true });
let fireHeld = false, boostKeyHeld = false;
let touchSteer = null; // {x, y} drag vector or null
let touchFire = false, touchBoost = false;
let hookInput = null; // set by window.__talon.setInput (tests)

// ---------- scene: stars, sun, canyon, ship, enemies ----------
// Stars: a static shell far away (sky, never scrolls with the run).
{
  const starGeo = new THREE.BufferGeometry();
  const positions = new Float32Array(600 * 3);
  for (let i = 0; i < 600; i++) {
    const r = 180 + Math.random() * 120;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(Math.random() * 2 - 1);
    positions[i * 3] = r * Math.sin(ph) * Math.cos(th);
    positions[i * 3 + 1] = Math.abs(r * Math.cos(ph)) * 0.6 - 10;
    positions[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th) - 100;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xcfe8ff, size: 1.2, sizeAttenuation: false, fog: false });
  scene.add(new THREE.Points(starGeo, starMat));
}
// A distant sun low ahead, for depth on the first screenshot.
{
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(18, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xff9a3c, fog: false }),
  );
  sun.position.set(70, 55, -320);
  scene.add(sun);
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(24, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0xff6a00, transparent: true, opacity: 0.18, fog: false }),
  );
  halo.position.copy(sun.position);
  scene.add(halo);
}

// Shared materials / geometries (one palette, reused everywhere).
const MATS = {
  canyon: new THREE.MeshStandardMaterial({ color: 0x3a2566, roughness: 0.95, metalness: 0.05 }),
  floor: new THREE.MeshStandardMaterial({ color: 0x241448, roughness: 0.95, metalness: 0.05 }),
  rock: new THREE.MeshStandardMaterial({ color: 0x3b2568, roughness: 1, metalness: 0 }),
  ship: new THREE.MeshStandardMaterial({ color: 0x22d3ee, roughness: 0.35, metalness: 0.6, emissive: 0x0e7490, emissiveIntensity: 1.2 }),
  shipWing: new THREE.MeshStandardMaterial({ color: 0x0e7490, roughness: 0.4, metalness: 0.6, emissive: 0x155e75, emissiveIntensity: 0.7 }),
  cockpit: new THREE.MeshStandardMaterial({ color: 0x67e8f9, roughness: 0.1, metalness: 0.2, emissive: 0x22d3ee, emissiveIntensity: 1.4 }),
  engine: new THREE.MeshBasicMaterial({ color: 0x67e8f9 }),
  drone: new THREE.MeshStandardMaterial({ color: 0xf472b6, roughness: 0.3, metalness: 0.4, emissive: 0xbe185d, emissiveIntensity: 1.2 }),
  interceptor: new THREE.MeshStandardMaterial({ color: 0xfb7185, roughness: 0.3, metalness: 0.4, emissive: 0xbe123c, emissiveIntensity: 1.1 }),
  turret: new THREE.MeshStandardMaterial({ color: 0xe879f9, roughness: 0.4, metalness: 0.5, emissive: 0xa21caf, emissiveIntensity: 1.0 }),
  carrier: new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.35, metalness: 0.55, emissive: 0xb45309, emissiveIntensity: 0.9 }),
  carrierTrim: new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.3, metalness: 0.5, emissive: 0xd97706, emissiveIntensity: 1.2 }),
  // Enemy shots are hot orange (v0.1.3): they were the same pink as
  // the drones (0xf472b6), so at distance a player could not tell
  // enemy fire from enemies. Drones stay pink; fire glows orange.
  shot: new THREE.MeshBasicMaterial({ color: 0xfb923c }),
  missile: new THREE.MeshStandardMaterial({ color: 0xfbbf24, roughness: 0.3, metalness: 0.5, emissive: 0xf59e0b, emissiveIntensity: 1.2 }),
};
const GEOS = {
  drone: new THREE.OctahedronGeometry(0.9),
  interceptorCone: new THREE.ConeGeometry(0.7, 2.6, 6),
  interceptorWing: new THREE.BoxGeometry(2.6, 0.12, 0.9),
  turretBase: new THREE.BoxGeometry(1.8, 1.8, 1.8),
  turretBarrel: new THREE.CylinderGeometry(0.28, 0.28, 2.4, 8),
  carrierHull: new THREE.BoxGeometry(6.5, 2.4, 11),
  carrierWing: new THREE.BoxGeometry(11, 0.5, 3.5),
  carrierTrim: new THREE.BoxGeometry(6.7, 0.5, 11.2),
  shipFuselage: new THREE.ConeGeometry(0.75, 3.4, 8),
  shipWing: new THREE.BoxGeometry(3.6, 0.14, 1.3),
  shipTail: new THREE.BoxGeometry(0.14, 1.1, 1.0),
  shipCockpit: new THREE.SphereGeometry(0.42, 12, 12),
  engine: new THREE.SphereGeometry(0.28, 8, 8),
  shot: new THREE.SphereGeometry(0.45, 8, 8),
  missile: new THREE.ConeGeometry(0.35, 1.6, 6),
  particle: new THREE.OctahedronGeometry(0.22),
  rock: new THREE.OctahedronGeometry(1),
};

// The scrolling world: canyon + enemies + projectiles live in this
// group at z = +run.z, and their meshes sit at -absolute-z, so the
// world extends toward -z (the camera's standard forward).
const worldGroup = new THREE.Group();
scene.add(worldGroup);
let canyonGroup = null;
let canyonDisposables = [];

function buildCanyon(s) {
  if (canyonGroup) {
    scene.remove(canyonGroup);
    worldGroup.remove(canyonGroup);
    for (const g of canyonDisposables) g.dispose();
    canyonDisposables = [];
  }
  canyonGroup = new THREE.Group();
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x111111, roughness: 0.4, metalness: 0.3,
    emissive: new THREE.Color(s.theme.ring), emissiveIntensity: 1.6,
  });
  for (const seg of s.segments) {
    const len = seg.z1 - seg.z0;
    // The world extends toward -z (ahead): the camera looks down -z
    // (Three's standard direction), so its right hand is +x and
    // steering left moves the ship left on screen. (Flying toward
    // +z mirrored the whole game — the Drift M2 lesson, caught by
    // the render check's screen-space assertion.)
    const zmid = -((seg.z0 + seg.z1) / 2);
    const h = seg.ceil - seg.floor;
    const ymid = (seg.floor + seg.ceil) / 2;
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      canyonGroup.add(m);
      canyonDisposables.push(geo);
      return m;
    };
    // Floor / ceiling / walls.
    add(new THREE.BoxGeometry(seg.hw * 2 + 8, 0.6, len), MATS.floor, seg.cx, seg.floor - 0.3, zmid);
    add(new THREE.BoxGeometry(seg.hw * 2 + 8, 0.6, len), MATS.canyon, seg.cx, seg.ceil + 0.3, zmid);
    add(new THREE.BoxGeometry(0.8, h, len), MATS.canyon, seg.cx - seg.hw - 0.4, ymid, zmid);
    add(new THREE.BoxGeometry(0.8, h, len), MATS.canyon, seg.cx + seg.hw + 0.4, ymid, zmid);
    // Emissive rims along the top inner edge of each wall.
    add(new THREE.BoxGeometry(0.18, 0.18, len), rimMat, seg.cx - seg.hw + 0.1, seg.ceil - 0.15, zmid);
    add(new THREE.BoxGeometry(0.18, 0.18, len), rimMat, seg.cx + seg.hw - 0.1, seg.ceil - 0.15, zmid);
    // Floor centre line (dashed glow, every 10 units).
    for (let z = seg.z0 + 5; z < seg.z1; z += 10) {
      add(new THREE.BoxGeometry(0.3, 0.1, 4), rimMat, seg.cx, seg.floor + 0.05, -z);
    }
    // Arch across the canyon at the segment start.
    const arch = add(new THREE.BoxGeometry(seg.hw * 2 + 1.6, 0.5, 0.8), rimMat, seg.cx, seg.ceil - 0.4, -(seg.z0 + 0.4));
    arch.material = rimMat;
    // Floating rocks for depth (deterministic per segment).
    const rng = (() => { let a = (s.seed * 1000 + seg.z0) >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
    for (let i = 0; i < 4; i++) {
      const rock = new THREE.Mesh(GEOS.rock, MATS.rock);
      const side = rng() > 0.5 ? 1 : -1;
      rock.position.set(seg.cx + side * (seg.hw + 2 + rng() * 4), seg.floor + rng() * h, -(seg.z0 + rng() * len));
      rock.scale.setScalar(0.8 + rng() * 2.2);
      rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
      canyonGroup.add(rock);
    }
  }
  worldGroup.add(canyonGroup);
}

// The interceptor.
const shipGroup = new THREE.Group();
{
  const fuselage = new THREE.Mesh(GEOS.shipFuselage, MATS.ship);
  fuselage.rotation.x = -Math.PI / 2; // cone points -z (ahead)
  shipGroup.add(fuselage);
  const wing = new THREE.Mesh(GEOS.shipWing, MATS.shipWing);
  wing.position.set(0, -0.1, 0.4);
  shipGroup.add(wing);
  const tail = new THREE.Mesh(GEOS.shipTail, MATS.shipWing);
  tail.position.set(0, 0.55, 1.2);
  shipGroup.add(tail);
  const cockpit = new THREE.Mesh(GEOS.shipCockpit, MATS.cockpit);
  cockpit.position.set(0, 0.45, -0.6);
  cockpit.scale.set(1, 0.7, 1.4);
  shipGroup.add(cockpit);
  const engL = new THREE.Mesh(GEOS.engine, MATS.engine);
  engL.position.set(-0.45, 0, 1.7);
  shipGroup.add(engL);
  const engR = new THREE.Mesh(GEOS.engine, MATS.engine);
  engR.position.set(0.45, 0, 1.7);
  shipGroup.add(engR);
  const light = new THREE.PointLight(0x22d3ee, 12, 12);
  light.position.set(0, 0, 1);
  shipGroup.add(light);
}
scene.add(shipGroup);

// ---------- enemies ----------
const enemyMeshes = new Map();
function enemyMesh(type) {
  const g = new THREE.Group();
  if (type === 'drone') {
    g.add(new THREE.Mesh(GEOS.drone, MATS.drone));
  } else if (type === 'interceptor') {
    const cone = new THREE.Mesh(GEOS.interceptorCone, MATS.interceptor);
    cone.rotation.x = Math.PI / 2; // nose points +z (toward the player)
    g.add(cone);
    const wing = new THREE.Mesh(GEOS.interceptorWing, MATS.interceptor);
    g.add(wing);
  } else if (type === 'turret') {
    const base = new THREE.Mesh(GEOS.turretBase, MATS.turret);
    g.add(base);
    const barrel = new THREE.Mesh(GEOS.turretBarrel, MATS.turret);
    barrel.rotation.x = Math.PI / 2; // barrel points +z — the group lookAt aims +z at the player
    barrel.position.set(0, 0, 1.6);
    barrel.name = 'barrel';
    g.add(barrel);
  } else if (type === 'carrier') {
    const hull = new THREE.Mesh(GEOS.carrierHull, MATS.carrier);
    g.add(hull);
    const wing = new THREE.Mesh(GEOS.carrierWing, MATS.carrierTrim);
    g.add(wing);
    const trim = new THREE.Mesh(GEOS.carrierTrim, MATS.carrierTrim);
    trim.position.y = -0.6;
    g.add(trim);
  }
  return g;
}
function syncEnemies(r) {
  const seen = new Set();
  for (const e of r.enemies) {
    seen.add(e.id);
    let mesh = enemyMeshes.get(e.id);
    if (!mesh) {
      mesh = enemyMesh(e.type);
      enemyMeshes.set(e.id, mesh);
      worldGroup.add(mesh);
    }
    mesh.position.set(e.x, e.y, -e.z);
    if (e.type === 'drone') {
      mesh.rotation.y += 0.03;
      mesh.rotation.x += 0.01;
    } else if (e.type === 'interceptor') {
      mesh.rotation.z = Math.sin(r.time * 1.2 + e.phase) * 0.4;
    } else if (e.type === 'turret') {
      // The group lookAt aims +z at the player (world z=0 plane).
      mesh.lookAt(r.x, r.y, 0);
    } else if (e.type === 'carrier') {
      mesh.rotation.z = Math.sin(r.time * 0.5 + e.phase) * 0.03;
    }
  }
  for (const [id, mesh] of [...enemyMeshes]) {
    if (!seen.has(id)) {
      worldGroup.remove(mesh);
      enemyMeshes.delete(id);
    }
  }
}
function clearEnemyMeshes() {
  for (const [, mesh] of enemyMeshes) worldGroup.remove(mesh);
  enemyMeshes.clear();
}

// ---------- projectiles (pooled), tracers (pooled), missiles (pooled) ----------
const shotPool = [];
for (let i = 0; i < 60; i++) {
  const m = new THREE.Mesh(GEOS.shot, MATS.shot);
  m.visible = false;
  worldGroup.add(m);
  shotPool.push(m);
}
function syncProjectiles(r) {
  shotPool.forEach((m) => { m.visible = false; });
  r.projectiles.forEach((p, i) => {
    if (i >= shotPool.length) return;
    const m = shotPool[i];
    m.visible = true;
    m.position.set(p.x, p.y, -p.z);
  });
}
const tracerPool = [];
for (let i = 0; i < 24; i++) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 5), new THREE.MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.9 }));
  m.visible = false;
  scene.add(m);
  tracerPool.push({ mesh: m, life: 0 });
}
function fireTracer(from, to) {
  const t = tracerPool.find((x) => x.life <= 0);
  if (!t) return;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  t.mesh.visible = true;
  t.mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  t.mesh.scale.set(1, len, 1);
  t.mesh.lookAt(to.x, to.y, to.z);
  t.mesh.rotateX(Math.PI / 2);
  t.life = 0.08;
}
const missilePool = [];
for (let i = 0; i < 8; i++) {
  const m = new THREE.Mesh(GEOS.missile, MATS.missile);
  m.visible = false;
  worldGroup.add(m);
  missilePool.push(m);
}
function syncMissiles(r) {
  missilePool.forEach((m) => { m.visible = false; });
  r.missiles.forEach((mo, i) => {
    if (i >= missilePool.length) return;
    const m = missilePool[i];
    m.visible = true;
    m.position.set(mo.x, mo.y, -mo.z);
    const target = r.enemies.find((e) => e.id === mo.targetId);
    if (target) m.lookAt(target.x, target.y, -target.z);
    m.rotateX(Math.PI / 2);
  });
}

// ---------- particles (pooled) ----------
const particlePool = [];
const particleMats = {
  cyan: new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true }),
  magenta: new THREE.MeshBasicMaterial({ color: 0xf472b6, transparent: true }),
  gold: new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true }),
  violet: new THREE.MeshBasicMaterial({ color: 0xa78bfa, transparent: true }),
};
for (let i = 0; i < 120; i++) {
  const m = new THREE.Mesh(GEOS.particle, particleMats.cyan);
  m.visible = false;
  scene.add(m);
  particlePool.push({ mesh: m, life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0 });
}
function spawnBurst(x, y, z, color, n, speed = 8, life = 0.6) {
  let spawned = 0;
  for (const p of particlePool) {
    if (spawned >= n) break;
    if (p.life > 0) continue;
    p.life = life * (0.6 + Math.random() * 0.7);
    p.maxLife = p.life;
    p.mesh.visible = true;
    p.mesh.material = particleMats[color] || particleMats.cyan;
    p.mesh.position.set(x, y, z);
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(Math.random() * 2 - 1);
    const s = speed * (0.4 + Math.random() * 0.8);
    p.vx = s * Math.sin(ph) * Math.cos(th);
    p.vy = s * Math.sin(ph) * Math.sin(th);
    p.vz = s * Math.cos(ph);
    p.mesh.scale.setScalar(0.6 + Math.random() * 1.2);
    spawned++;
  }
}
function updateParticles(dt) {
  for (const p of particlePool) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.mesh.visible = false; continue; }
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    p.mesh.material.opacity = Math.max(0, p.life / p.maxLife);
  }
}

// ---------- feedback (game-feel tiers) ----------
function pushFeedback(type, ev) {
  const layers = FEEDBACK_LAYERS[type] || [];
  // v0.1.2: keep the event kind on the log entry — the render check
  // observes locks through this durable log (a live lockedId is
  // transient: a carrier lock lasts a few frames before the bot fires
  // on it, so polling state.lockedId misses it under slow rendering).
  feedbackLog.push({ type, layers: [...layers], kind: ev?.kind ?? null });
  if (feedbackLog.length > 200) feedbackLog.shift();
  return layers;
}
function applyFeedback(type, ev) {
  const fb = FEEDBACK[type];
  if (!fb) return;
  const layers = pushFeedback(type, ev);
  const has = (l) => layers.includes(l);
  if (has('shake')) trauma = Math.min(1, trauma + fb.trauma * shakeStrength);
  if (fb.hitStop > 0 && has('hitStop')) {
    const now = performance.now() / 1000;
    hitStopUntil = Math.max(hitStopUntil, now + fb.hitStop);
  }
  if (has('slowMo')) {
    slowMoUntil = performance.now() / 1000 + 0.9;
    slowMoScale = 0.35;
  }
  if (has('flash') && !reduceFlashingOn()) {
    const el = $('hit-flash');
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  }
  if (has('fovPulse')) fovPulse = Math.min(1, fovPulse + 0.5);
  if (has('glowPulse')) glowPulse = 1;
  return layers;
}
function toast(msg) {
  // v0.2.2: no toast may ever show on the menu. The menu demo steps
  // the sim without handleEvents, so it cannot fire one — but a toast
  // fired in a run (scrape, overheat) must not survive a quit to the
  // menu from pause, and the live playtest saw a scrape toast on the
  // main menu once. Belt and braces with the quitToMenu clear below.
  if (typeof phase !== 'undefined' && phase === 'menu') return;
  const el = $('hud-toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  // v0.1.2: clear the text when the toast hides, so the stale message
  // doesn't linger in the page text (and the live region) on the
  // death screen and the menu after the run ends.
  toast._t = setTimeout(() => { el.classList.remove('show'); el.textContent = ''; }, 2400);
  $('sr-status').textContent = msg;
}
// Directional damage edge (v0.1.1, live-playtest fix): a hit must say
// WHERE it came from — a red wash on the edge the damage came through
// (wall side, or ahead for rams/shots). The old hit-flash alone was
// too easy to miss while watching the ship.
let lastWallToast = 0;
function damageDir(ev) {
  if (ev.source === 'wall' && run) {
    const seg = segmentAt(sortie, run.z);
    if (run.x <= seg.cx - seg.hw + 2) return 'left';
    if (run.x >= seg.cx + seg.hw - 2) return 'right';
    if (run.y <= seg.floor + 2) return 'bottom';
    if (run.y >= seg.ceil - 2) return 'top';
  }
  return 'top'; // rams, shots, bumps and the carrier grind all come from ahead
}
function flashDamageEdge(dir) {
  const el = $('dmg-edge');
  if (!el) return;
  el.className = 'dmg-edge';
  void el.offsetWidth;
  el.className = `dmg-edge on from-${dir}`;
}
function popAt(x, y, z, text, cls = '') {
  const p = projectToScreen(x, y, -(z - (run ? run.z : 0)));
  if (!p) return;
  const el = document.createElement('div');
  el.className = `pop ${cls}`;
  el.textContent = text;
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
  $('pops').appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

function handleEvents(evs) {
  if (!run) return;
  for (const ev of evs) {
    switch (ev.type) {
      case 'gunFire': {
        sfx('shoot');
        // Scene z is -(absolute z - run.z): the muzzle's absolute z
        // is run.z + 2, so its scene z is about -2, not run.z + 2.
        fireTracer({ x: ev.from.x, y: ev.from.y, z: -(ev.from.z - run.z) }, { x: ev.to.x, y: ev.to.y, z: -(ev.to.z - run.z) });
        if (ev.hit) spawnBurst(ev.to.x, ev.to.y, -(ev.to.z - run.z), 'cyan', 2, 4, 0.25);
        break;
      }
      case 'kill': {
        applyFeedback('kill', ev);
        sfx('explosion');
        const color = ev.kind === 'carrier' ? 'gold' : ev.kind === 'turret' ? 'violet' : 'magenta';
        spawnBurst(ev.x, ev.y, -(ev.z - run.z), color, ev.kind === 'carrier' ? 26 : 12, ev.kind === 'carrier' ? 12 : 8, 0.7);
        popAt(ev.x, ev.y, ev.z, `+${ev.score}`, ev.kind === 'carrier' ? 'gold' : '');
        break;
      }
      case 'carrierDown': {
        // v0.2.2: a carrier kill pays back hull — say so loudly, or
        // the checkpoint reads as nothing happening. Gold pop at the
        // ship plus a toast; the kill case already popped the +500
        // score at the carrier.
        sfx('clear');
        toast(`CARRIER DOWN — hull +${ev.restored}`);
        if (ev.restored > 0) popAt(run.x, run.y, run.z, `+${ev.restored} HULL`, 'gold');
        break;
      }
      case 'killStreak': {
        applyFeedback('killStreak', ev);
        sfx('streak');
        toast(`${ev.streak}-kill streak — slow-mo`);
        break;
      }
      case 'lockAcquired': {
        applyFeedback('lockAcquired', ev);
        sfx('lock');
        toast(`Lock on ${ev.kind} — fire the missile`);
        break;
      }
      case 'missileFire': {
        applyFeedback('missileFire', ev);
        sfx('missile');
        spawnBurst(run.x, run.y, 0, 'gold', 6, 6, 0.4);
        break;
      }
      case 'missileHit': {
        applyFeedback('missileHit', ev);
        sfx('explosion');
        const t = run.enemies.find((e) => e.id === ev.targetId);
        if (t) spawnBurst(t.x, t.y, -(t.z - run.z), 'gold', 20, 11, 0.8);
        break;
      }
      case 'playerHit': {
        applyFeedback('playerHit', ev);
        sfx('hit');
        spawnBurst(run.x, run.y, 0, 'magenta', 8, 7, 0.5);
        flashDamageEdge(damageDir(ev));
        if (ev.damage >= 1) popAt(run.x, run.y, run.z, `-${Math.round(ev.damage)}`, 'damage');
        break;
      }
      case 'ram': {
        applyFeedback('playerHit', ev);
        sfx('hit');
        spawnBurst(ev.x, ev.y, -(ev.z - run.z), 'magenta', 14, 9, 0.6);
        flashDamageEdge('top');
        break;
      }
      case 'wallScrape': {
        applyFeedback('wallScrape', ev);
        sfx('hit');
        spawnBurst(ev.x, ev.y, -(ev.z - run.z), 'violet', 5, 5, 0.4);
        flashDamageEdge(damageDir({ source: 'wall' }));
        // Warn once per run (then at most every 4s): the first scrape
        // must teach, not just tax the hull silently.
        const now = performance.now();
        if (now - lastWallToast > 4000) {
          lastWallToast = now;
          toast('Wall scrape — steer back to the centre of the canyon');
        }
        break;
      }
      case 'overheat': {
        applyFeedback('overheat', ev);
        sfx('overheat');
        toast('OVERHEAT — boost locked, guns slowed. Ease off and cool down.');
        break;
      }
      case 'heatCooled': toast('Cooled down — boost is back.'); break;
      case 'blocked': {
        applyFeedback('blocked', ev);
        sfx('blocked');
        break;
      }
      case 'sortieClear': {
        applyFeedback('sortieClear', ev);
        sfx('clear');
        break;
      }
      case 'sortieLost': {
        applyFeedback('sortieLost', ev);
        sfx('lost');
        break;
      }
      default: break;
    }
  }
}

// ---------- HUD ----------
function projectToScreen(x, y, z) {
  if (!renderer) return null;
  const v = new THREE.Vector3(x, y, z).project(camera);
  if (v.z > 1) return null;
  return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight };
}
function updateHUD() {
  if (!run || phase !== 'run') return;
  $('hud-sortie').textContent = `Sortie ${sortie.id} — ${sortie.name}`;
  $('hud-progress').textContent = `${Math.min(100, Math.floor((run.z / sortie.length) * 100))}%`;
  $('hud-score').textContent = `Score ${run.score}`;
  $('hud-kills').textContent = `Kills ${run.kills}`;
  const hullFill = $('hull-fill');
  hullFill.style.width = `${Math.max(0, run.hull)}%`;
  hullFill.classList.toggle('low', run.hull <= 30);
  $('hull-value').textContent = `${Math.ceil(run.hull)}`;
  const heatFill = $('heat-fill');
  heatFill.style.width = `${Math.min(100, run.heat)}%`;
  heatFill.classList.toggle('overheat', run.overheated);
  $('heat-value').textContent = `${Math.floor(run.heat)}`;
  const pips = $('ammo-pips');
  if (pips.childElementCount !== MISSILE_AMMO + 4) {
    pips.innerHTML = '';
    for (let i = 0; i < MISSILE_AMMO + 4; i++) {
      const s = document.createElement('span');
      s.className = 'ammo-pip';
      pips.appendChild(s);
    }
  }
  [...pips.children].forEach((pip, i) => pip.classList.toggle('spent', i >= run.ammo));
  // Carrier health bar (v0.1.5): when a carrier is ahead within
  // firing range, show its hull so the player can tell the missiles
  // are working — the v0.1.4 playtest reached the carrier, fired
  // missiles, and never saw whether it was dying.
  const carrier = run.enemies.find((e) => e.type === 'carrier' && e.z - run.z >= 0 && e.z - run.z <= 90);
  $('carrier-bar').classList.toggle('hidden', !carrier);
  if (carrier) $('carrier-fill').style.width = `${Math.max(0, (carrier.hp / carrier.maxHp) * 100)}%`;
  // Reticle lock ring.
  const lockRing = $('lock-ring');
  const frac = run.lockedId !== null ? 1 : clamp(run.lockT / LOCK_TIME, 0, 1);
  lockRing.style.strokeDashoffset = `${289 * (1 - frac)}`;
  $('reticle').classList.toggle('locked', run.lockedId !== null);
  // Name the lock target (v0.2.1): the playtest fired missiles at a
  // gold lock on an escort and saw the carrier bar not move — nothing
  // said WHAT was locked. Show the target kind while locking and once
  // locked, so E is never a blind press.
  const lockTarget = run.lockTargetId !== null
    ? run.enemies.find((e) => e.id === run.lockTargetId) : null;
  const lockLabel = $('lock-label');
  if (lockTarget) {
    lockLabel.textContent = `${run.lockedId !== null ? 'LOCK' : 'LOCKING'} — ${lockTarget.type.toUpperCase()}`;
    lockLabel.classList.remove('hidden');
  } else {
    lockLabel.classList.add('hidden');
  }
  $('blocked-banner').classList.toggle('hidden', !run.blocked);
  $('low-hull').classList.toggle('on', run.hull <= 30);
  $('btn-mute-hud').textContent = save.muted ? 'Sound: Off' : 'Sound: On';
}
function updateMuteLabels() {
  const label = save.muted ? 'Sound: Off' : 'Sound: On';
  for (const id of ['btn-mute-hud', 'btn-mute-menu', 'btn-mute-pause']) {
    const el = $(id);
    if (el) el.textContent = label;
  }
  if (masterGain) masterGain.gain.value = save.muted ? 0 : save.volume;
}
function toggleMute() {
  save.muted = !save.muted;
  persistSave();
  updateMuteLabels();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function applySettingsToUI() {
  $('volume-range').value = Math.round(save.volume * 100);
  $('volume-value').textContent = `${Math.round(save.volume * 100)}%`;
  $('shake-range').value = Math.round(save.shake * 100);
  $('shake-value').textContent = `${Math.round(save.shake * 100)}%`;
  $('shake-range-pause').value = Math.round(save.shake * 100);
  $('shake-value-pause').textContent = `${Math.round(save.shake * 100)}%`;
  $('music-toggle').checked = save.music;
  $('sfx-toggle').checked = save.sfx;
  $('reduce-flashing').checked = save.reduceFlashing === null ? false : save.reduceFlashing;
  $('text-size-select').value = String(save.textSize);
  $('high-contrast-toggle').checked = save.highContrast;
  shakeStrength = save.shake;
  applyAccessibility();
}

// ---------- screens (stack, not boolean soup) ----------
const SCREENS = ['menu', 'howto', 'settings', 'complete', 'sortielost', 'pause'];
function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle('hidden', s !== id);
}
function pushScreen(id) {
  screenStack.push(id);
  showScreen(id);
  // Focus the primary control on open, with a focus style distinct
  // from hover (see style.css .btn:focus-visible).
  const focusMap = {
    menu: 'btn-play', howto: 'btn-howto-close', settings: 'btn-settings-close',
    complete: 'btn-next', sortielost: 'btn-retry', pause: 'btn-resume',
  };
  const btn = $(focusMap[id] || 'btn-play');
  if (btn) setTimeout(() => btn.focus({ preventScroll: true }), 30);
}
function popScreen() {
  screenStack.pop();
  const top = screenStack[screenStack.length - 1];
  if (top) showScreen(top);
  else {
    for (const s of SCREENS) $(s).classList.add('hidden');
  }
}
function topScreen() { return screenStack[screenStack.length - 1]; }

// ---------- menu ----------
function refreshSortieSelect() {
  const el = $('sortie-select');
  el.innerHTML = '';
  const best = save.best;
  for (const s of SORTIES) {
    const unlocked = isSortieUnlocked(best, s.id) || seedUnlocked;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `map-card${s.id === selectedSortieId ? ' selected' : ''}${unlocked ? '' : ' locked'}`;
    card.disabled = !unlocked;
    const b = best[s.id];
    // The CSS classes are .map-name / .map-meta (block-level); the
    // earlier .map-card-* names matched no rule, so the two spans
    // ran together on one line.
    card.innerHTML = `<span class="map-name">Sortie ${s.id} — ${s.name}</span>`
      + `<span class="map-meta">${unlocked ? (b ? `Best ${b.score}${b.cleared ? ' · Cleared' : ''}` : 'Not flown yet') : 'Clear the previous sortie to unlock'}</span>`;
    card.addEventListener('click', () => {
      ensureAudio();
      selectedSortieId = s.id;
      refreshSortieSelect();
      refreshMenuScene();
      sfx('tick');
    });
    el.appendChild(card);
  }
  const s = sortieById(selectedSortieId);
  $('sortie-hint').textContent = s ? s.hint : '';
  const bests = Object.values(save.best);
  $('menu-best').textContent = bests.length
    ? `Best score: ${Math.max(...bests.map((b) => b.score))} · Sorties cleared: ${bests.filter((b) => b.cleared).length}/${SORTIES.length}`
    : 'No sorties flown yet — the canyon is waiting.';
}
function refreshMenuScene() {
  sortie = sortieById(selectedSortieId) || SORTIES[0];
  buildCanyon(sortie);
  clearEnemyMeshes();
  demoRun = physicsStartRun(sortie);
  run = demoRun;
}

// ---------- run lifecycle ----------
function startSortie(id) {
  const s = sortieById(id);
  if (!s) return;
  sortie = s;
  selectedSortieId = s.id;
  paused = false;
  autoPilot = false;
  speedMul = 1;
  accumulator = 0;
  run = physicsStartRun(s);
  buildCanyon(s);
  clearEnemyMeshes();
  feedbackLog = [];
  // Mouse steering starts neutral and disarmed (v0.1.4): it arms
  // once the cursor has moved 30px from where it sat at launch.
  mouseSteer.active = false;
  mouseSteer.x = 0; mouseSteer.y = 0;
  mouseSteer.armX = lastPointer.x ?? window.innerWidth / 2;
  mouseSteer.armY = lastPointer.y ?? window.innerHeight / 2;
  lastWallToast = 0;
  phase = 'run';
  screenStack = [];
  for (const sc of SCREENS) $(sc).classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('reticle').classList.remove('hidden');
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    $('touch-controls').classList.remove('hidden');
  }
  resetPerf();
  musicLeadOn = true;
  ensureAudio();
  sfx('launch');
  updateHUD();
  save.totalRuns++;
  persistSave();
}
function onRunEnd() {
  if (!run || !run.done) return;
  // v0.1.3: a toast that is still showing when the run ends (a scrape
  // toast on the killing scrape, an overheat toast on a fatal ram) must
  // not carry onto the death screen — hide it and clear its text here,
  // not only when its 2.4s timer fires. The v0.1.2 fix cleared the
  // text on hide, but the pill stayed visible on the death screen
  // until the timer fired.
  clearTimeout(toast._t);
  const toastEl = $('hud-toast');
  toastEl.classList.remove('show');
  toastEl.textContent = '';
  musicLeadOn = false;
  $('reticle').classList.add('hidden');
  $('touch-controls').classList.add('hidden');
  $('blocked-banner').classList.add('hidden');
  if (run.reason === 'complete') {
    const best = recordBest(save, sortie.id, run.score, run.kills, true);
    persistSave();
    $('complete-score').textContent = `Score ${run.score}`;
    $('complete-detail').textContent = `${run.kills} kills · ${Math.ceil(run.hull)} hull left · ${run.time.toFixed(1)}s · best streak ${run.bestStreak}`;
    $('complete-best').textContent = `Best on this sortie: ${best.score}${best.score === run.score ? ' — a new best!' : ''}`;
    $('btn-next').classList.toggle('hidden', sortie.id >= SORTIES.length);
    $('hud').classList.add('hidden');
    pushScreen('complete');
  } else {
    // v0.1.2: a loss still records the best (score/kills, cleared
    // stays false) — the menu promised "your best result is saved per
    // sortie", but bests were only written on a clear, so after dozens
    // of flights the menu still said "Not flown yet". Unlocks stay
    // clear-gated (isSortieUnlocked needs cleared === true).
    recordBest(save, sortie.id, run.score, run.kills, false);
    persistSave();
    const best = save.best[sortie.id];
    $('sortielost-stats').textContent = `${run.kills} kills · reached ${Math.floor((run.z / sortie.length) * 100)}% of the canyon`;
    $('sortielost-best').textContent = best ? `Best on this sortie: ${best.score}` : 'No best yet on this sortie.';
    $('hud').classList.add('hidden');
    pushScreen('sortielost');
  }
  phase = 'menu';
  refreshMenuScene();
}
function quitToMenu() {
  paused = false;
  autoPilot = false;
  phase = 'menu';
  screenStack = [];
  for (const sc of SCREENS) $(sc).classList.add('hidden');
  $('hud').classList.add('hidden');
  // v0.2.2: a toast showing when the player quits (e.g. pause ->
  // quit right after a scrape) must not carry onto the menu — the
  // live playtest saw a scrape toast on the main menu once. Same
  // clear as onRunEnd.
  clearTimeout(toast._t);
  const toastEl = $('hud-toast');
  toastEl.classList.remove('show');
  toastEl.textContent = '';
  $('reticle').classList.add('hidden');
  $('touch-controls').classList.add('hidden');
  $('blocked-banner').classList.add('hidden');
  musicLeadOn = false;
  resetPerf();
  refreshSortieSelect();
  refreshMenuScene();
  pushScreen('menu');
}
function pauseGame() {
  if (phase !== 'run' || !run || run.done || paused) return;
  paused = true;
  pushScreen('pause');
}
function resumeGame() {
  if (!paused) return;
  paused = false;
  popScreen();
}
function restartCurrentRun() {
  if (!sortie) return;
  paused = false;
  startSortie(sortie.id);
}

// ---------- autopilot (decision bot through the public hooks) ----------
function driveAutopilot(r) {
  if (!r || r.done) return;
  physicsSetInput(r, decisionInput(r));
}

// ---------- input: pointer / keyboard / touch ----------
function computeInput() {
  if (autoPilot || !run || run.done) return null;
  if (hookInput) return { ...run.input, ...hookInput };
  let steerX = 0, steerY = 0;
  if (keys.has('ArrowLeft') || keys.has('a') || keys.has('A')) steerX -= 1;
  if (keys.has('ArrowRight') || keys.has('d') || keys.has('D')) steerX += 1;
  if (keys.has('ArrowUp') || keys.has('w') || keys.has('W')) steerY += 1;
  if (keys.has('ArrowDown') || keys.has('s') || keys.has('S')) steerY -= 1;
  if (steerX === 0 && steerY === 0) {
    if (touchSteer) { steerX = touchSteer.x; steerY = touchSteer.y; }
    else if (mouseSteer.active) { steerX = mouseSteer.x; steerY = mouseSteer.y; }
  }
  return {
    steerX: clamp(steerX, -1, 1),
    steerY: clamp(steerY, -1, 1),
    boost: boostKeyHeld || keys.has('Shift') || touchBoost,
    fire: fireHeld || keys.has(' ') || touchFire,
    missile: false, // missiles are edge-triggered (see keydown / contextmenu)
  };
}
let missileQueued = false;
function queueMissile() {
  if (phase !== 'run' || !run || run.done || paused) return;
  missileQueued = true;
}
if (renderer) {
  const canvas = renderer.domElement;
  // Screen-centre steering curve (v0.1.4): the cursor's offset from
  // the centre of the screen, normalised so the screen edge is ±1.
  // A dead zone of 0.2 (10% of the screen) around the centre reads
  // as level flight; beyond it the steer ramps smoothly to full
  // deflection at the edge.
  function centreSteer(pos, dim) {
    const d = (pos - dim / 2) / (dim / 2);
    const dead = 0.2;
    if (Math.abs(d) <= dead) return 0;
    return clamp((Math.abs(d) - dead) / (1 - dead), 0, 1) * Math.sign(d);
  }
  canvas.addEventListener('pointermove', (e) => {
    if (phase !== 'run' || paused || !run) return;
    // Screen-centre steering (v0.1.4): the ship steers by the
    // cursor's offset from the centre of the screen, with a dead
    // zone around the centre. The tunnel mouth ahead sits at the
    // screen centre, so pointing at it flies level; moving the
    // cursor from there steers. Steering arms only once the cursor
    // has moved 30px from where it sat at launch (the v0.1.0 spawn
    // trap: the resting cursor over the Play button is left of
    // centre and must not steer before the player touches anything).
    if (!mouseSteer.active) {
      const dx = e.clientX - mouseSteer.armX, dy = e.clientY - mouseSteer.armY;
      if (Math.hypot(dx, dy) < 30) return;
      mouseSteer.active = true;
    }
    mouseSteer.x = centreSteer(e.clientX, window.innerWidth);
    mouseSteer.y = -centreSteer(e.clientY, window.innerHeight);
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (phase !== 'run' || paused) return;
    ensureAudio();
    if (e.button === 2) { queueMissile(); return; }
    fireHeld = true;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.button === 0) fireHeld = false;
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    queueMissile();
  });
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    paused = true;
    toast('Graphics paused — the 3D context was lost. It will resume when restored.');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    paused = false;
    toast('Graphics restored.');
  });
  // Touch: drag to steer.
  let dragId = null;
  canvas.addEventListener('touchstart', (e) => {
    if (phase !== 'run' || paused) return;
    const t = e.changedTouches[0];
    dragId = t.identifier;
    touchSteer = { x: 0, y: 0, startX: t.clientX, startY: t.clientY };
    ensureAudio();
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    if (!touchSteer) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== dragId) continue;
      touchSteer.x = clamp((t.clientX - touchSteer.startX) / 120, -1, 1);
      touchSteer.y = clamp(-(t.clientY - touchSteer.startY) / 120, -1, 1);
    }
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === dragId) { dragId = null; touchSteer = null; }
    }
  }, { passive: true });
}
document.addEventListener('keydown', (e) => {
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    if (e.key !== 'Escape') return;
  }
  if (e.key === 'Escape') {
    if (screenStack.length > 1) { popScreen(); return; }
    if (phase === 'run') pauseGame();
    return;
  }
  if (e.key === ' ') e.preventDefault();
  keys.add(e.key.length === 1 ? e.key : e.key);
  if (e.key === 'Shift') boostKeyHeld = true;
  if (phase === 'menu') {
    // v0.1.3: R and Enter must work from the death and complete
    // screens, not only from the menu — the live playtest found R did
    // nothing on the death screen and Enter only worked when Fly Again
    // happened to be focused. Holding a key must not re-fire (a held
    // Enter used to restart the run repeatedly).
    if (e.repeat) return;
    if (e.key === 'Enter' && topScreen() === 'menu') {
      ensureAudio();
      startSortie(selectedSortieId);
    } else if (e.key === 'Enter' && topScreen() === 'sortielost') {
      ensureAudio();
      startSortie(sortie.id);
    } else if (e.key === 'Enter' && topScreen() === 'complete') {
      ensureAudio();
      startSortie(sortie.id < SORTIES.length ? sortie.id + 1 : sortie.id);
    } else if ((e.key === 'r' || e.key === 'R') && (topScreen() === 'sortielost' || topScreen() === 'complete')) {
      ensureAudio();
      startSortie(sortie.id);
    }
    return;
  }
  if (phase !== 'run') return;
  if (e.repeat) return;
  switch (e.key) {
    case 'e': case 'E': ensureAudio(); queueMissile(); break;
    case 'p': case 'P': paused ? resumeGame() : pauseGame(); break;
    case 'm': case 'M': toggleMute(); break;
    case 'r': case 'R': restartCurrentRun(); break;
    default: break;
  }
});
document.addEventListener('keyup', (e) => {
  keys.delete(e.key);
  if (e.key === 'Shift') boostKeyHeld = false;
});

// ---------- UI wiring ----------
function wire(id, fn) { const el = $(id); if (el) el.addEventListener('click', () => { ensureAudio(); fn(); }); }
wire('btn-play', () => { sfx('launch'); startSortie(selectedSortieId); });
wire('btn-howto', () => pushScreen('howto'));
wire('btn-howto-close', () => popScreen());
wire('btn-settings', () => pushScreen('settings'));
wire('btn-settings-close', () => popScreen());
wire('btn-next', () => startSortie(sortie.id + 1));
wire('btn-replay', () => startSortie(sortie.id));
wire('btn-retry', () => startSortie(sortie.id));
wire('btn-menu-complete', () => quitToMenu());
wire('btn-menu-sortielost', () => quitToMenu());
wire('btn-resume', () => resumeGame());
wire('btn-restart', () => restartCurrentRun());
wire('btn-quit', () => quitToMenu());
wire('btn-pause', () => pauseGame());
wire('btn-mute-hud', () => toggleMute());
wire('btn-mute-menu', () => toggleMute());
wire('btn-mute-pause', () => toggleMute());
// Hover tick on every button (throttled).
let lastTickAt = 0;
document.addEventListener('mouseover', (e) => {
  if (!e.target.closest || !e.target.closest('.btn, .map-card, .icon-btn, .touch-btn')) return;
  const now = performance.now();
  if (now - lastTickAt < 60) return;
  lastTickAt = now;
  sfx('tick');
});
// Settings inputs.
$('volume-range').addEventListener('input', (e) => {
  save.volume = clamp(Number(e.target.value) / 100, 0, 1);
  persistSave(); applySettingsToUI(); updateMuteLabels();
});
$('shake-range').addEventListener('input', (e) => {
  save.shake = clamp(Number(e.target.value) / 100, 0, 1);
  persistSave(); applySettingsToUI();
});
$('shake-range-pause').addEventListener('input', (e) => {
  save.shake = clamp(Number(e.target.value) / 100, 0, 1);
  persistSave(); applySettingsToUI();
});
$('music-toggle').addEventListener('change', (e) => { save.music = e.target.checked; persistSave(); });
$('sfx-toggle').addEventListener('change', (e) => { save.sfx = e.target.checked; persistSave(); });
$('reduce-flashing').addEventListener('change', (e) => { save.reduceFlashing = e.target.checked; persistSave(); });
$('text-size-select').addEventListener('change', (e) => { save.textSize = Number(e.target.value); persistSave(); applySettingsToUI(); });
$('high-contrast-toggle').addEventListener('change', (e) => { save.highContrast = e.target.checked; persistSave(); applySettingsToUI(); });
// Touch buttons.
function bindTouch(id, down, up) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); ensureAudio(); down(); });
  el.addEventListener('pointerup', () => up());
  el.addEventListener('pointerleave', () => up());
}
bindTouch('btn-touch-fire', () => { touchFire = true; }, () => { touchFire = false; });
bindTouch('btn-touch-boost', () => { touchBoost = true; }, () => { touchBoost = false; });
bindTouch('btn-touch-missile', () => { queueMissile(); }, () => {});

// ---------- frame loop ----------
function frame(t) {
  requestAnimationFrame(frame);
  const now = performance.now();
  const realDt = Math.min((now - lastFrameT) / 1000, 0.1);
  lastFrameT = now;
  if (realDt > 0) fpsEma = fpsEma * 0.95 + (1 / realDt) * 0.05;

  // FPS guard (run phase only).
  if (phase === 'run' && !paused && run && !run.done) {
    if (fpsEma < PERF_FPS_THRESHOLD) {
      if (lowFpsSince === null) lowFpsSince = now;
      else if (now - lowFpsSince >= PERF_LOW_MS) {
        applyPerfLevel(perfLevel + 1);
        lowFpsSince = null;
      }
    } else lowFpsSince = null;
  }

  // Trauma / pulses decay with real time, so shake settles during hit-stop.
  trauma = Math.max(0, trauma - realDt * 1.4);
  fovPulse = Math.max(0, fovPulse - realDt * 1.8);
  glowPulse = Math.max(0, glowPulse - realDt * 2);

  const slowActive = now / 1000 < slowMoUntil;
  timeScale = slowActive ? slowMoScale : 1;
  const hitStop = now / 1000 < hitStopUntil;

  // Step the sim (demo in the menu, run in play).
  const activeRun = phase === 'menu' ? demoRun : run;
  if (renderer && activeRun && !paused && !hitStop) {
    const rate = phase === 'menu' ? 1 : speedMul;
    accumulator += realDt * timeScale * rate;
    let steps = 0;
    while (accumulator >= DT && steps < 30) {
      accumulator -= DT;
      steps++;
      if (phase === 'menu') {
        driveAutopilot(demoRun);
        const evs = stepRun(demoRun, DT);
        // The menu demo is ambience: no feedback, no audio.
        if (demoRun.done) {
          demoRun = physicsStartRun(sortie);
          run = demoRun;
        }
      } else {
        // Autopilot drives the input — but a queued missile (E key,
        // right-click, touch button, or the __talon.fireMissile hook)
        // must still fire on the lock. v0.1.1: the queue was only
        // consumed in the manual-input branch, so fireMissile() was
        // dead while the autopilot flew — the render check caught it
        // when the bot stopped firing at turrets on its own.
        if (autoPilot) {
          driveAutopilot(run);
          if (missileQueued) { run.input.missile = true; missileQueued = false; }
        } else {
          const inp = computeInput();
          if (inp) {
            if (missileQueued) { inp.missile = true; missileQueued = false; }
            physicsSetInput(run, inp);
          }
        }
        boostHeld = !!(run.input.boost && !run.overheated);
        const evs = stepRun(run, DT);
        handleEvents(evs);
        if (run.done) onRunEnd();
      }
    }
    if (steps === 30) accumulator = 0;
  }

  // Ship + camera: chase cam, partial lateral follow so steering
  // reads on screen (the ship moves across the frame when it banks).
  const r = activeRun;
  if (renderer && r) {
    const amp = trauma * trauma * 0.55 * shakeStrength;
    const shX = amp * Math.sin(t * 0.09);
    const shY = amp * Math.cos(t * 0.113);
    shipGroup.position.set(r.x, r.y, 0);
    shipGroup.rotation.z = -r.input.steerX * 0.7;
    shipGroup.rotation.x = r.input.steerY * 0.25;
    shipGroup.rotation.y = -r.input.steerX * 0.15;
    shipGroup.visible = true;
    const boosting = phase === 'run' && boostHeld;
    // Portrait framing: the vertical FOV is fixed, so a narrow
    // viewport squeezes the horizontal FOV and the ship fills the
    // frame. Pull the chase camera back and widen the FOV as the
    // aspect narrows, so the ship keeps the same screen size.
    const aspect = window.innerWidth / window.innerHeight;
    const narrow = Math.max(0, 1 - aspect);
    const camBack = 10 + narrow * 12;
    const camUp = 3.4 + narrow * 2.5;
    camera.position.set(r.x * 0.45 + shX, r.y + camUp + shY, camBack);
    camera.lookAt(r.x * 0.85, r.y + 0.3, -30);
    const targetFov = 62 + narrow * 18 + (boosting ? 6 : 0) + fovPulse * 4;
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
    }
    // Engine glow pulses with boost.
    shipGroup.children.forEach((c) => {
      if (c.material === MATS.engine) c.scale.setScalar(boosting ? 1.6 : 1 + Math.sin(t * 0.02) * 0.15);
    });
    // The world group holds the canyon, enemies and projectiles.
    // The sim's z grows toward the player, the world extends
    // toward -z, so the group scrolls +z as the ship advances.
    worldGroup.position.z = r.z;
    syncEnemies(r);
    syncProjectiles(r);
    syncMissiles(r);
  }

  for (const tr of tracerPool) {
    if (tr.life <= 0) continue;
    tr.life -= realDt;
    if (tr.life <= 0) tr.mesh.visible = false;
    else tr.mesh.material.opacity = Math.max(0, tr.life / 0.08) * 0.9;
  }
  updateParticles(realDt);
  if (phase === 'run' && now - lastHudAt > 100) { lastHudAt = now; updateHUD(); }

  if (renderer) renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  if (!renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- public hooks (bot + render check drive the game through these) ----------
window.__talon = {
  get version() { return VERSION; },
  get state() {
    return {
      phase, paused,
      sortieId: sortie ? sortie.id : null,
      selectedSortieId,
      hull: run ? run.hull : null,
      heat: run ? run.heat : null,
      overheated: run ? run.overheated : null,
      ammo: run ? run.ammo : null,
      score: run ? run.score : null,
      kills: run ? run.kills : null,
      z: run ? run.z : null,
      length: sortie ? sortie.length : null,
      blocked: run ? run.blocked : null,
      lockedId: run ? run.lockedId : null,
      lockT: run ? run.lockT : null,
      done: run ? run.done : null,
      reason: run ? run.reason : null,
      perf: { fps: Math.round(fpsEma), pixelRatio: renderer ? renderer.getPixelRatio() : null, level: perfLevel },
    };
  },
  sorties() {
    return SORTIES.map((s) => ({
      id: s.id, name: s.name, length: s.length,
      best: save.best[s.id] || null,
      unlocked: isSortieUnlocked(save.best, s.id) || seedUnlocked,
    }));
  },
  unlocks() {
    return { sorties: Object.fromEntries(SORTIES.map((s) => [s.id, isSortieUnlocked(save.best, s.id) || seedUnlocked])) };
  },
  info() {
    const r = run || (phase === 'menu' ? demoRun : null);
    if (!r) return null;
    return {
      sortieId: sortie.id, sortieName: sortie.name, length: sortie.length,
      phase: r === run ? 'run' : 'menu',
      z: r.z, x: r.x, y: r.y,
      hull: r.hull, heat: r.heat, overheated: r.overheated, ammo: r.ammo,
      score: r.score, kills: r.kills,
      lockedId: r.lockedId, lockT: r.lockT, lockTargetId: r.lockTargetId,
      blocked: r.blocked,
      done: r.done, reason: r.reason,
      ship: { x: r.x, y: r.y, z: r.z, screen: projectToScreen(r.x, r.y, 0), bank: -r.input.steerX * 0.7 },
      enemies: r.enemies.map((e) => ({
        id: e.id, type: e.type, x: e.x, y: e.y, z: e.z, hp: e.hp, maxHp: e.maxHp,
        screen: projectToScreen(e.x, e.y, -(e.z - r.z)),
      })),
      projectiles: r.projectiles.map((p) => ({ x: p.x, y: p.y, z: p.z, screen: projectToScreen(p.x, p.y, -(p.z - r.z)) })),
      missiles: r.missiles.map((m) => ({ x: m.x, y: m.y, z: m.z, targetId: m.targetId })),
      input: { ...r.input },
      trauma, timeScale, fov: camera.fov, fovPulse,
      shakeAmp: trauma * trauma * shakeStrength,
      perf: { fps: Math.round(fpsEma), pixelRatio: renderer ? renderer.getPixelRatio() : null, level: perfLevel },
      feedback: feedbackLog.map((f) => ({ type: f.type, layers: [...f.layers], kind: f.kind ?? null })),
      audio: audioCtx
        ? { state: audioCtx.state, music: !!musicTimer, musicStep, lead: musicLeadOn, sfxOn: save.sfx, musicOn: save.music }
        : null,
    };
  },
  start(sortieId) { startSortie(sortieId ?? selectedSortieId); },
  restart() { restartCurrentRun(); },
  pause() { pauseGame(); },
  resume() { resumeGame(); },
  quitToMenu() { quitToMenu(); },
  selectSortie(id) { selectedSortieId = id; refreshSortieSelect(); refreshMenuScene(); },
  setInput(input) {
    if (!input) { hookInput = null; return; }
    hookInput = { ...(hookInput || {}), ...input };
    autoPilot = false;
  },
  fireMissile() { queueMissile(); },
  autopilot(on) { autoPilot = !!on; if (on) hookInput = null; },
  setSpeed(mul) { speedMul = [1, 2, 4].includes(mul) ? mul : 1; updateHUD(); },
  setShake(v) { save.shake = clamp(v, 0, 1); shakeStrength = save.shake; persistSave(); applySettingsToUI(); },
  setReduceFlashing(b) { save.reduceFlashing = !!b; persistSave(); applySettingsToUI(); },
  setTextSize(v) {
    save.textSize = [1, 1.2, 1.4].includes(v) ? v : 1;
    persistSave(); applySettingsToUI();
  },
  setHighContrast(b) { save.highContrast = !!b; persistSave(); applySettingsToUI(); },
  debugPerfSetLevel(level) {
    applyPerfLevel(level, { silent: true });
    return renderer ? renderer.getPixelRatio() : null;
  },
  get shake() { return shakeStrength; },
  get reduceFlashing() { return reduceFlashingOn(); },
  save() { return JSON.parse(JSON.stringify(save)); },
};

// ---------- boot ----------
{
  // Seed path (Apex lesson): ?sortie=N selects that sortie directly,
  // bypassing the menu gates, so playtests can reach every sortie.
  // It is not shown anywhere in the player-facing UI.
  const params = new URLSearchParams(window.location.search);
  const seedSortie = Number(params.get('sortie'));
  if (Number.isInteger(seedSortie) && seedSortie >= 1 && seedSortie <= SORTIES.length) {
    selectedSortieId = seedSortie;
    seedUnlocked = true;
  }
}
refreshSortieSelect();
applySettingsToUI();
updateMuteLabels();
refreshMenuScene();
if (renderer) {
  pushScreen('menu');
  requestAnimationFrame((t) => { lastFrameT = t; requestAnimationFrame(frame); });
} else {
  $('menu').classList.remove('hidden');
  $('webgl-error').classList.remove('hidden');
}
