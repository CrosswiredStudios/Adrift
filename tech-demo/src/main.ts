import { Engine, Scene, Vector3, Color3, Color4, HemisphericLight, DirectionalLight, Mesh, Quaternion, StandardMaterial, ShaderMaterial, FreeCamera, DefaultRenderingPipeline, ImageProcessingConfiguration, SpriteManager, Sprite } from "@babylonjs/core";
import { Constants } from "@babylonjs/core/Engines/constants";
import { makePlanet, atmosphereFactor, bodyAltitude, surfaceRadius, terrainHeightAt, isOverWater, Body } from "./planets";
import { createShip, updateShip, FlightState, SteerState, bankAngle } from "./flight";
import { updateHud } from "./hud";
import { TerrainHandle } from "./terrainMaterial";

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLElement;
const engine = new Engine(canvas, true, { stencil: true, antialias: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 1);

// The star (directional sun below) is the scene's light source. This fill stands in
// for starlight, so unlit/night sides stay dark; inside an atmosphere it is retinted
// to the sky's scattered colour each frame in tick().
const STARLIGHT = new Color3(0.3, 0.38, 0.52);
const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
hemi.intensity = 0.14;
hemi.diffuse = STARLIGHT.clone();
hemi.groundColor = new Color3(0.02, 0.025, 0.035);
const sunDir = new Vector3(-1, -0.3, 0.4).normalize();
const sun = new DirectionalLight("sun", sunDir, scene);
sun.intensity = 3.0;
sun.diffuse = new Color3(1.0, 0.96, 0.9);

// HDR pipeline: ACES tone mapping, bloom, FXAA, vignette + grain for filmic space.
const camera = new FreeCamera("chase", new Vector3(0, 600 + 10, 640), scene);
camera.maxZ = 60000;
camera.minZ = 0.1;
const pipeline = new DefaultRenderingPipeline("hdr", true, scene, [camera]);
pipeline.samples = 4;
pipeline.bloomEnabled = true;
pipeline.bloomThreshold = 0.85;
pipeline.bloomWeight = 0.35;
pipeline.bloomKernel = 64;
pipeline.bloomScale = 0.5;
pipeline.fxaaEnabled = true;
pipeline.sharpenEnabled = true;
pipeline.sharpen.edgeAmount = 0.15;
pipeline.grainEnabled = true;
pipeline.grain.intensity = 6;
pipeline.grain.animated = true;
pipeline.imageProcessingEnabled = true;
pipeline.imageProcessing.toneMappingEnabled = true;
pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
pipeline.imageProcessing.contrast = 1.08;
pipeline.imageProcessing.vignetteEnabled = true;
pipeline.imageProcessing.vignetteWeight = 1.6;
let highQuality = true;

// Starfield: huge inverted sphere drawn with hash-based procedural stars. A sampled
// texture would need an impractically large map to stay crisp (a 1024 map gives ~0.35
// degree blobs) and brings seam/pole artifacts; hashing the view direction gives tight
// points everywhere. brightness is driven by the atmosphere sky factor each frame.
const STAR_VERTEX = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const STAR_FRAGMENT = `
precision highp float;
varying vec3 vDir;
uniform float brightness;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// One layer of point stars: at most one star per hash cell, tight core + soft halo.
vec3 starLayer(vec3 dir, float cellScale, float density, float corePower) {
  vec3 p = dir * cellScale;
  vec3 cell = floor(p);
  if (hash13(cell) >= density) return vec3(0.0);
  vec3 jitter = vec3(hash13(cell + 17.0), hash13(cell + 43.0), hash13(cell + 89.0));
  float d = length(p - (cell + 0.2 + jitter * 0.6));
  float core = exp(-d * d * corePower);
  float halo = exp(-d * d * corePower * 0.12) * 0.12;
  float bright = 0.4 + 0.6 * hash13(cell + 131.0);
  vec3 tint = mix(vec3(0.75, 0.84, 1.0), vec3(1.0, 0.87, 0.68), hash13(cell + 197.0));
  return mix(vec3(1.0), tint, 0.55) * (core + halo) * bright;
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = starLayer(dir, 190.0, 0.0022, 55.0) * 1.5;
  col += starLayer(dir * 1.9, 210.0, 0.0045, 90.0) * 0.5;
  // Faint galactic band so deep space is not a flat black.
  float band = exp(-abs(dot(dir, normalize(vec3(0.35, 0.22, -0.91)))) * 8.0);
  col += band * vec3(0.10, 0.13, 0.21) * 0.35;
  gl_FragColor = vec4(col * brightness, 1.0);
}`;

function makeStars(): Mesh {
  const stars = Mesh.CreateSphere("stars", 16, 40000, scene);
  const mat = new ShaderMaterial(
    "stars-mat",
    scene,
    { vertexSource: STAR_VERTEX, fragmentSource: STAR_FRAGMENT },
    { attributes: ["position"], uniforms: ["worldViewProjection", "brightness"] }
  );
  mat.backFaceCulling = false;
  mat.setFloat("brightness", 1);
  stars.material = mat;
  stars.isPickable = false;
  stars.infiniteDistance = true; // dome follows the camera; keep position at origin
  return stars;
}
const starfield = makeStars();

// Sun glow sprite so the star stays visible from deep space.
function makeSunSprite(): Sprite {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,250,235,1)");
  g.addColorStop(0.2, "rgba(255,240,210,0.9)");
  g.addColorStop(0.5, "rgba(255,220,170,0.25)");
  g.addColorStop(1, "rgba(255,210,150,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const url = c.toDataURL("image/png");
  const mgr = new SpriteManager("sun-mgr", url, 1, { width: 128, height: 128 }, scene);
  mgr.blendMode = Constants.ALPHA_ADD;
  const sprite = new Sprite("sun-sprite", mgr);
  sprite.size = 2500;
  sprite.isPickable = false;
  return sprite;
}
const sunSprite = makeSunSprite();

const vael = makePlanet(scene, {
  name: "Vael Prime", position: new Vector3(0, 0, 0), radius: 600,
  color: new Color3(0.3, 0.5, 0.28), atmosphereHeight: 520,
  atmosphereColor: new Color3(0.35, 0.6, 1), skyColor: new Color3(0.5, 0.75, 1), mu: 90000,
  seed: 1337, relief: 0.045, waterLevel: -0.05, cloudCoverage: 0.5,
  terrain: {
    baseColor: "/textures/terrain/grass_color.jpg",
    baseNormal: "/textures/terrain/grass_normal.jpg",
  },
  vegetation: {},
});
const tethys = makePlanet(scene, {
  name: "Tethys", position: new Vector3(6000, 800, -2500), radius: 160,
  color: new Color3(0.55, 0.55, 0.58), atmosphereHeight: 4,
  atmosphereColor: new Color3(0.4, 0.4, 0.45), skyColor: new Color3(0, 0, 0), mu: 8000,
  seed: 777, atmosphere: false, relief: 0.05,
  terrain: {
    baseColor: "/textures/terrain/dust_color.jpg",
    baseNormal: "/textures/terrain/dust_normal.jpg",
    baseTint: new Color3(0.5, 0.47, 0.42),
    snowStart: null,
  },
});
const bodies: Body[] = [vael, tethys];

// Launch pad sits on the visible terrain: sample the same height function the
// ground mesh uses, then rest the ship at flight-model contact height with
// zero motion so the demo starts perfectly still.
const padDir = new Vector3(0.35, 0.9, 0.25).normalize();
const padR = surfaceRadius(vael, padDir);
const pad = Mesh.CreateBox("pad", 8, scene);
pad.position.copyFrom(vael.center).addInPlace(padDir.scale(padR - 2.8)); // top ~1.2 above ground
const padMat = new StandardMaterial("pad-mat", scene);
padMat.emissiveColor = new Color3(0.2, 0.8, 1);
pad.material = padMat;

const ship = createShip(scene);
// Keep the star dome out of the GlowLayer: its blur spreads the whole 20k-radius
// sphere across the screen and washes the stars out into a milky sky.
scene.getGlowLayerByName("main-glow")?.addExcludedMesh(starfield);
ship.position.copyFrom(vael.center).addInPlace(padDir.scale(padR + 1.2));
// Start upright relative to the surface, nose pointing at the horizon. Note:
// FromLookDirectionLH aims the local -Z at the given vector, so pass the
// negated heading to point the ship's nose (+Z) forward along the horizon.
const spawnFwd = Vector3.Cross(padDir, new Vector3(0, 0, 1)).normalize();
ship.rotationQuaternion = Quaternion.FromLookDirectionLH(spawnFwd.scale(-1), padDir);
const state: FlightState = {
  velocity: new Vector3(0, 0, 0), target: tethys, cruise: 0,
  atmoDensity: 1, heat: 0, verticalSpeed: 0, altitude: 1.2, landed: true,
  floating: false, floatR: 0, rig: null,
};

// Physical-key tokens (e.code) so WASD works on non-QWERTY layouts too.
const KEY_TOKENS: Record<string, string> = {
  KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d", KeyQ: "q", KeyE: "e",
  KeyC: "c", KeyH: "h", ArrowUp: "arrowup", ArrowDown: "arrowdown",
  Space: "space", ShiftLeft: "shift", ShiftRight: "shift", Digit1: "1", Digit2: "2",
};
const HANDLED = new Set(Object.values(KEY_TOKENS));
function keyToken(e: KeyboardEvent): string {
  return KEY_TOKENS[e.code] ?? e.key.toLowerCase();
}
const input: Record<string, boolean> = {};
addEventListener("keydown", (e) => {
  const token = keyToken(e);
  if (!HANDLED.has(token)) return;
  e.preventDefault(); // stop arrows/space from scrolling the page
  input[token] = true;
  if (e.repeat) return; // one-shot toggles must not strobe on key repeat
  if (token === "1") state.target = vael;
  if (token === "2") state.target = tethys;
  if (token === "h") toggleQuality();
});
addEventListener("keyup", (e) => {
  const token = keyToken(e);
  if (HANDLED.has(token)) input[token] = false;
});
// Never leave a key stuck when the window loses focus (alt-tab mid-thrust).
function clearInput(): void {
  for (const k of Object.keys(input)) input[k] = false;
}
addEventListener("blur", clearInput);
document.addEventListener("visibilitychange", () => { if (document.hidden) clearInput(); });

function toggleQuality(): void {
  highQuality = !highQuality;
  pipeline.bloomEnabled = highQuality;
  pipeline.grainEnabled = highQuality;
  pipeline.samples = highQuality ? 4 : 1;
  if (vael.surface?.clouds) vael.surface.clouds.setEnabled(highQuality);
  // Low quality keeps the ocean visible but drops foam/shore detail, chop and
  // the refraction pass (all of which cost fragments / extra passes).
  vael.surface?.ocean?.setQuality(highQuality);
  tethys.surface?.ocean?.setQuality(highQuality);
}

// Mouse-aim steering: the cursor's offset from the canvas center is an analog
// stick deflection; a centered cursor flies straight. No button needed.
const pointer = { x: 0, y: 0 }; // -1..1, +y = cursor above center (nose up)
const clamp1 = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);
const smoothstep01 = (edge0: number, edge1: number, x: number): number => {
  const u = clamp1((x - edge0) / (edge1 - edge0));
  return u * u * (3 - 2 * u);
};
addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  let x = (e.clientX - cx) / (rect.width * 0.38);
  let y = (cy - e.clientY) / (rect.height * 0.38);
  const len = Math.hypot(x, y);
  const dead = 0.06; // resting near center = hands off
  if (len <= dead) { x = 0; y = 0; }
  else {
    const mag = Math.pow(Math.min(1, (len - dead) / (1 - dead)), 1.4); // fine control near center
    x = (x / len) * mag; y = (y / len) * mag;
  }
  pointer.x = clamp1(x); pointer.y = clamp1(y);
});

// Combined stick: keyboard adds on top of the pointer and is eased smoothly
// inside the sim tick so __game.step stays deterministic for tests.
const steer: SteerState = { pitch: 0, yaw: 0, roll: 0 };
const mouseEased = { x: 0, y: 0 };
function updateControls(dt: number): void {
  const f = 1 - Math.exp(-16 * dt);
  mouseEased.x += (pointer.x - mouseEased.x) * f;
  mouseEased.y += (pointer.y - mouseEased.y) * f;
  const keyPitch = (input["w"] ? 1 : 0) - (input["s"] ? 1 : 0);
  const keyYaw = (input["a"] ? 1 : 0) - (input["d"] ? 1 : 0);
  const keyRoll = (input["e"] ? 1 : 0) - (input["q"] ? 1 : 0);
  steer.pitch = clamp1(keyPitch + mouseEased.y); // cursor up = nose up
  steer.yaw = clamp1(keyYaw - mouseEased.x);     // cursor right = turn right
  steer.roll = clamp1(keyRoll);                  // E = roll right, Q = roll left
}

const describeTerrain = (t: TerrainHandle | null): object | null => {
  if (!t) return null;
  const tex = t.textures;
  return {
    tilesU: t.look.tilesU, tilesV: t.look.tilesV,
    slopeLo: t.look.slopeLo, slopeHi: t.look.slopeHi,
    snowStart: t.look.snowStart,
    fallbacks: [...tex.fallbacks],
    ready: [tex.baseColor, tex.baseNormal, tex.rockColor, tex.rockNormal].every((x) => x.isReady()),
  };
};

// Expose live state for automated playtests (see repo memory: no screenshots).
// __game.step(dt) advances simulation without rendering, so headless tests can
// simulate minutes of flight deterministically (software GL is too slow realtime).
const game = {
  ship, state, bodies, camera, scene, input, pointer, controls: steer,
  bankDeg: () => (bankAngle(ship, bodies) * 180) / Math.PI,
  step: (dt: number) => tick(dt),
  ocean: () => ({
    vael: vael.surface?.ocean?.stats() ?? null,
    tethys: tethys.surface?.ocean?.stats() ?? null,
    quality: highQuality,
  }),
  /** Ocean debug views: 0 normal, 1 depth, 2 breaking, 3 slope. */
  oceanDebug: (mode: number) => {
    for (const b of bodies) {
      const o = b.surface?.ocean;
      if (!o) continue;
      for (const mesh of [o.shell, o.patch]) {
        (mesh.material as ShaderMaterial | null)?.setFloat("uDebugMode", mode);
      }
    }
    return mode;
  },
  // Terrain/water probe (used by tests to find coastlines to fly to).
  probe: (dir: number[]) => {
    const d = new Vector3(dir[0], dir[1], dir[2]).normalize();
    return {
      h: terrainHeightAt(vael, d),
      water: isOverWater(vael, d),
      waterLevel: vael.waterLevel,
      seaRadius: vael.radius * (1 + vael.waterLevel * vael.relief),
    };
  },
  /** Ground texture debug views: 0 normal, 1 rock-blend mask, 2 slope, 3 height. */
  terrainDebug: (mode: number) => {
    for (const b of bodies) b.surface?.terrain?.setDebug(mode);
    return mode;
  },
  /** Ground texture status (fallbacks + readiness) for the terrain tests. */
  terrain: () => ({
    vael: describeTerrain(vael.surface?.terrain ?? null),
    tethys: describeTerrain(tethys.surface?.terrain ?? null),
  }),
  /** Vegetation status (instances, texture readiness, placement limits). */
  vegetation: () => ({
    vael: vael.vegetation?.status() ?? null,
    tethys: tethys.vegetation?.status() ?? null,
  }),
  /** Up to n body-frame directions sampled from a vegetation layer's instances. */
  vegetationSample: (bodyIndex: number, layer: "trees" | "shrubs" | "grass", n: number) =>
    bodies[bodyIndex]?.vegetation?.sampleDirs(layer, n) ?? [],
  vegetationShow: (on: boolean) => {
    for (const b of bodies) b.vegetation?.setVisible(on);
    return on;
  },
};
(window as unknown as { __game?: object }).__game = game;

// Smooth chase camera state, initialized behind the ship, horizon-aligned up.
const camPos = ship.position.add(new Vector3(0, 3.4, -13).applyRotationQuaternion(ship.rotationQuaternion ?? Quaternion.Identity()));
camera.position.copyFrom(camPos);
const camUp = padDir.clone();
let camFov = 60;
camera.fov = camFov / 180 * Math.PI;

/** Advance simulation + visuals state by dt (no rendering). Shared by loop and tests. */
function tick(dt: number): void {
  updateControls(dt);
  updateShip(ship, state, bodies, input, steer, dt);

  const atmo = Math.max(...bodies.map((b) => atmosphereFactor(b, ship.position)));
  // Host body + local sunlight: sky colour only appears where the star is lighting
  // the planet, so the night side shows stars instead of a glowing sky.
  let host = vael;
  let hostDensity = -1;
  for (const b of bodies) {
    const d = atmosphereFactor(b, ship.position);
    if (d > hostDensity) { hostDensity = d; host = b; }
  }
  const sunAboveRaw = ship.position.subtract(host.center).normalize().dot(sun.direction.scale(-1));
  // Sky light lingers past the terminator so the terrain never snaps from full sun to
  // black - that step is what reads as a hard line across the ground.
  const daylight = smoothstep01(-0.06, 0.3, sunAboveRaw);
  const twilight = smoothstep01(0.4, 0.0, Math.abs(sunAboveRaw)) * atmo;

  // Sky background: inner sky dome shader covers the view when inside; the clear
  // colour only matters in space or during transitions.
  scene.clearColor = Color4.FromColor3(Color3.Lerp(Color3.Black(), host.skyColor.scale(0.35), atmo * 0.5 * daylight), 1);

  // Sun: dim + warm when deep in atmosphere (sunset effect), full white in space.
  // Near the terminator the direct light eases off and its energy moves into the
  // ambient term instead, which softens the day/night line without dimming noon.
  sun.intensity = (3.0 - atmo * 1.2) * (1 - 0.3 * twilight);
  const warmth = atmo * Math.max(0, 0.5 - state.altitude / 90);
  sun.diffuse = new Color3(1.0, 0.96 - warmth * 0.25, 0.9 - warmth * 0.35);
  // Ambient fill: starlight in space, sky colour in daylight, warm haze at twilight.
  const twilightTint = new Color3(1.0, 0.68, 0.46);
  const skyAmbient = Color3.Lerp(host.atmosphereColor, twilightTint, Math.min(1, twilight * 1.2));
  hemi.diffuse = Color3.Lerp(STARLIGHT, skyAmbient, Math.min(1, atmo * Math.max(daylight, twilight * 0.8)));
  hemi.intensity = 0.14 + atmo * daylight * 0.3 + twilight * 0.55;

  // Exposure: slightly hotter in space for star/planet pop, softer in thick air.
  pipeline.imageProcessing.exposure = 1.15 - atmo * 0.15;

  // Drive atmosphere + surface shaders. Each body gets the local sunlight factor so
  // its sky only lights up where the star reaches it.
  const sunToward = sun.direction.scale(-1);
  for (const b of bodies) {
    const alt = bodyAltitude(b, ship.position);
    const toShip = ship.position.subtract(b.center);
    const sunAbove = toShip.lengthSquared() > 1e-6 ? toShip.normalize().dot(sunToward) : 1;
    b.atmosphere?.update(alt, sun.direction, smoothstep01(-0.06, 0.3, sunAbove));
    b.surface?.update(dt, sun.direction, b === host);
    b.vegetation?.update(dt);
  }

  // Stars show where the sky layers have cleared (brightness 1 in clear space, ~0
  // under a thick sky) and again at night, when the star's light no longer washes the
  // sky out: the sun is the light source for the sky itself.
  const sky = Math.max(...bodies.map((b) => b.atmosphere?.skyFactor ?? 0));
  const starBright = Math.max((1 - sky) ** 3, (1 - daylight) * 0.85, 0.02);
  (starfield.material as ShaderMaterial).setFloat("brightness", starBright);

  // Sun sprite parked far along the sun direction from the camera.
  sunSprite.position.copyFrom(camera.position).addInPlace(sun.direction.scale(-30000));
  updateHud(hud, ship, state, bodies);
}

/**
 * Chase camera: damped position boom, roll-damped horizon-stable up vector
 * (banking no longer whips the world around), smooth time-based shake, FOV kick.
 */
function updateCamera(dt: number): void {
  const rot = ship.rotationQuaternion ?? Quaternion.Identity();
  const speed = state.velocity.length();

  // Damped boom that eases out a little with speed.
  const boom = 13 + Math.min(6, speed * 0.008);
  const back = new Vector3(0, 3.4, -boom).applyRotationQuaternion(rot);
  camPos.copyFrom(Vector3.Lerp(camPos, ship.position.add(back), 1 - Math.exp(-8 * dt)));
  camera.position.copyFrom(camPos);

  // Smooth atmospheric shake: time-based, fades out at low speed (no idle jitter).
  const atmo = Math.max(...bodies.map((b) => atmosphereFactor(b, ship.position)));
  const shake = clamp1((atmo - 0.3) / 0.7) * clamp1(speed / 300) * 0.4;
  if (shake > 0.002) {
    const t = performance.now() / 1000;
    camera.position.addInPlace(new Vector3(1, 0, 0).applyRotationQuaternion(rot).scale(Math.sin(t * 37.7) * shake * 0.5));
    camera.position.addInPlace(new Vector3(0, 1, 0).applyRotationQuaternion(rot).scale(Math.sin(t * 29.3 + 1.7) * shake * 0.5));
  }

  // Follow the ship's yaw/pitch, but only ~1/3 of its roll, heavily damped.
  let nearest: Body = vael;
  let nearestAlt = Infinity;
  for (const b of bodies) {
    const alt = bodyAltitude(b, ship.position);
    if (alt < nearestAlt) { nearestAlt = alt; nearest = b; }
  }
  const planetUp = ship.position.subtract(nearest.center).normalize();
  const shipUp = new Vector3(0, 1, 0).applyRotationQuaternion(rot);
  const upTarget = Vector3.Lerp(planetUp, shipUp, 0.35);
  if (upTarget.lengthSquared() < 1e-4) upTarget.copyFrom(shipUp);
  upTarget.normalize();
  camUp.copyFrom(Vector3.Lerp(camUp, upTarget, 1 - Math.exp(-6 * dt)));
  camUp.normalize();
  camera.upVector.copyFrom(camUp);
  camera.setTarget(ship.position.add(state.velocity.scale(0.03))); // slight look-ahead

  const targetFov = 60 + Math.min(18, speed * 0.06) + (input["shift"] && input["arrowup"] ? 5 : 0);
  camFov += (targetFov - camFov) * (1 - Math.exp(-3 * dt));
  camera.fov = camFov / 180 * Math.PI;
}

engine.runRenderLoop(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
  tick(dt);
  updateCamera(dt);
  scene.render();
});
addEventListener("resize", () => engine.resize());
