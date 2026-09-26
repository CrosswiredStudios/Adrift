import {
  Engine,
  Scene,
  Vector3,
  Color3,
  Color4,
  Quaternion,
  ShaderMaterial,
  FreeCamera,
  DefaultRenderingPipeline,
  ImageProcessingConfiguration,
} from "@babylonjs/core";
import { atmosphereFactor, bodyAltitude, terrainHeightAt, isOverWater, Body } from "./world/planets";
import { createShip, updateShip, FlightState, bankAngle } from "./flight/flight";
import { updateHud } from "./app/hud";
import { TerrainHandle } from "./world/terrainMaterial";
import { makeStars } from "./app/starfield";
import { createLighting, twilightFactor } from "./app/lighting";
import { createCameraRig } from "./app/cameraRig";
import { createInput, daylightFactor, updateControls } from "./app/input";
import { buildWorld } from "./app/world";
import { createQualityPolicy } from "./app/qualityPolicy";
import { CloudTier } from "./world/skyExtras";

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLElement;
const engine = new Engine(canvas, true, { stencil: true, antialias: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 1);

// Scene lighting (see lighting.ts): directional sun + starlight fill retinted
// to the sky colour inside an atmosphere each frame in tick().
const sunDir = new Vector3(-1, -0.3, 0.4).normalize();
const lighting = createLighting(scene, sunDir);
const sun = lighting.sun;

// HDR pipeline: ACES tone mapping, bloom, FXAA, vignette + grain for filmic space.
const camera = new FreeCamera("chase", new Vector3(0, 600 + 10, 640), scene);
camera.maxZ = 60000;
camera.minZ = 0.1;
const pipeline = new DefaultRenderingPipeline("hdr", true, scene, [camera]);
pipeline.samples = 4;
pipeline.bloomEnabled = true;
pipeline.bloomThreshold = 1.0;
pipeline.bloomWeight = 0.25;
pipeline.bloomKernel = 32;
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
pipeline.imageProcessing.vignetteWeight = 0.8;

// Procedural starfield dome (see starfield.ts); brightness driven by sky factor.
const starfield = makeStars(scene);

// World composition (see world.ts): planets, star, launch pad.
const world = buildWorld(scene, sunDir);
const { vael, tethys, sol, bodies, padDir, pad } = world;

const ship = createShip(scene);
// Keep the star dome and the sun out of the GlowLayer: its blur spreads the huge
// meshes across the screen (milky sky, smeared sun). HDR bloom lights both instead.
const glowLayer = scene.getGlowLayerByName("main-glow");
glowLayer?.addExcludedMesh(starfield.mesh);
glowLayer?.addExcludedMesh(sol.core);
glowLayer?.addExcludedMesh(sol.corona);
// Ship starts resting on the pad: pad top sits ~1.2 above the ground and the
// flight model holds the ship 1.2 above the surface, so spawn 4 above the pad
// center (pad is 8 tall, top at +4) lands exactly at contact height.
ship.position.copyFrom(pad.position).addInPlace(padDir.scale(4));
// Start upright relative to the surface, nose pointing at the horizon. Note:
// FromLookDirectionLH aims the local -Z at the given vector, so pass the
// negated heading to point the ship's nose (+Z) forward along the horizon.
const spawnFwd = Vector3.Cross(padDir, new Vector3(0, 0, 1)).normalize();
ship.rotationQuaternion = Quaternion.FromLookDirectionLH(spawnFwd.scale(-1), padDir);
const state: FlightState = {
  velocity: new Vector3(0, 0, 0),
  target: tethys,
  cruise: 0,
  atmoDensity: 1,
  heat: 0,
  verticalSpeed: 0,
  altitude: 1.2,
  landed: true,
  floating: false,
  floatR: 0,
  rig: null,
};

// Render quality (see qualityPolicy.ts): H cycles Ultra -> High -> Balanced
// -> Lite, defaulting to Ultra (best). Tiers drive the volumetric cloud
// deck's raymarch steps plus bloom/grain/MSAA and the ocean's passes.
const quality = createQualityPolicy(pipeline, bodies);
quality.apply();

// Pause menu: Esc toggles the overlay and freezes the sim tick while the
// scene keeps rendering behind it. __game.step stays unpaused so headless
// tests can still advance the sim deterministically.
const pauseOverlay = document.getElementById("pause") as HTMLElement;
const resumeButton = document.getElementById("resume") as HTMLButtonElement;
let paused = false;
function setPaused(on: boolean): void {
  paused = on;
  pauseOverlay.classList.toggle("visible", on);
}
resumeButton.addEventListener("click", () => setPaused(false));

const controls = createInput(canvas, {
  onToggleQuality: () => {
    quality.toggle();
    quality.apply();
  },
  onSelectTarget: (i: number) => {
    if (bodies[i]) state.target = bodies[i];
  },
  onTogglePause: () => setPaused(!paused),
});
const input = controls.input;
const pointer = controls.pointer;
const steer = controls.steer;

const describeTerrain = (t: TerrainHandle | null): object | null => {
  if (!t) return null;
  const tex = t.textures;
  return {
    tilesU: t.look.tilesU,
    tilesV: t.look.tilesV,
    slopeLo: t.look.slopeLo,
    slopeHi: t.look.slopeHi,
    snowStart: t.look.snowStart,
    fallbacks: [...tex.fallbacks],
    ready: [tex.baseColor, tex.baseNormal, tex.rockColor, tex.rockNormal].every((x) => x.isReady()),
  };
};

// Expose live state for automated playtests (see repo memory: no screenshots).
// __game.step(dt) advances simulation without rendering, so headless tests can
// simulate minutes of flight deterministically (software GL is too slow realtime).
const game = {
  ship,
  state,
  bodies,
  camera,
  scene,
  input,
  pointer,
  controls: steer,
  sun: sol,
  bankDeg: () => (bankAngle(ship, bodies) * 180) / Math.PI,
  step: (dt: number) => tick(dt),
  paused: () => paused,
  setPaused: (on: boolean) => setPaused(on),
  ocean: () => ({
    vael: vael.surface?.ocean?.stats() ?? null,
    tethys: tethys.surface?.ocean?.stats() ?? null,
    quality: quality.tier,
  }),
  /** Cloud deck status: tier, density at camera/ship, veil strength. */
  clouds: () => ({
    tier: quality.tier,
    density: cloudObstruction.density,
    veil: cloudObstruction.veil,
  }),
  /** Cycle/set the cloud quality tier (H key cycles; default ultra). */
  cloudQuality: (tier?: string) => {
    if (tier !== undefined) quality.setTier(tier as CloudTier);
    else {
      quality.toggle();
    }
    quality.apply();
    return quality.tier;
  },
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

// Smooth chase camera (see cameraRig.ts), initialized behind the ship.
const cameraRig = createCameraRig(camera, ship, state, bodies, input, padDir.clone());

// In-cloud obstruction: sample the volumetric deck's CPU density field at the
// camera each tick and drive scene fog as a whiteout veil, so dense cloud
// blocks the player's view when flying through. Eased to avoid popping.
// Declared after `game` (the debug handle reads it) but before tick() uses it.
scene.fogMode = Scene.FOGMODE_EXP2;
scene.fogColor = new Color3(0.92, 0.94, 0.97);
scene.fogDensity = 0;
const cloudObstruction = { density: 0, veil: 0 };
let cloudClock = 0;
function updateCloudObstruction(dt: number): void {
  cloudClock += dt;
  let density = 0;
  for (const b of bodies) {
    const deck = b.surface?.cloudDeck;
    // Lite disables the deck (post-process detached): no veil either.
    if (!deck || deck.tier === "lite") continue;
    density = Math.max(density, deck.sample(camera.position, cloudClock));
  }
  cloudObstruction.density = density;
  // Veil ramps in fast once inside real cloud, eases out on exit.
  const target = density <= 0.01 ? 0 : Math.min(1, density * 1.6);
  const rate = target > cloudObstruction.veil ? 3.5 : 1.2;
  cloudObstruction.veil += (target - cloudObstruction.veil) * Math.min(1, rate * dt);
  scene.fogDensity = cloudObstruction.veil * 0.028;
}

/** Advance simulation + visuals state by dt (no rendering). Shared by loop and tests. */
function tick(dt: number): void {
  updateControls(controls, dt);
  updateShip(ship, state, bodies, input, steer, dt);

  const atmo = Math.max(...bodies.map((b) => atmosphereFactor(b, ship.position)));
  // Host body + local sunlight: sky colour only appears where the star is lighting
  // the planet, so the night side shows stars instead of a glowing sky.
  let host = vael;
  let hostDensity = -1;
  for (const b of bodies) {
    const d = atmosphereFactor(b, ship.position);
    if (d > hostDensity) {
      hostDensity = d;
      host = b;
    }
  }
  const sunAboveRaw = ship.position.subtract(host.center).normalize().dot(sun.direction.scale(-1));
  // Sky light lingers past the terminator so the terrain never snaps from full sun to
  // black - that step is what reads as a hard line across the ground.
  const daylight = daylightFactor(sunAboveRaw);
  const twilight = twilightFactor(sunAboveRaw, atmo);

  // Sky background: inner sky dome shader covers the view when inside; the clear
  // colour only matters in space or during transitions.
  scene.clearColor = Color4.FromColor3(
    Color3.Lerp(Color3.Black(), host.skyColor.scale(0.35), atmo * 0.5 * daylight),
    1,
  );

  lighting.update(host, atmo, daylight, twilight, state.altitude);

  // Exposure: slightly hotter in space for star/planet pop, softer in thick air.
  pipeline.imageProcessing.exposure = 1.1 - atmo * 0.2;

  // Drive atmosphere + surface shaders. Each body gets the local sunlight factor so
  // its sky only lights up where the star reaches it.
  const sunToward = sun.direction.scale(-1);
  // Unit vector from the camera to the real star body: the sky dome centres its
  // thin-air aureole about this direction so the glare sits exactly on the visible sun.
  const solTowardView = sol.body.center.subtract(camera.position).normalize();
  for (const b of bodies) {
    const alt = bodyAltitude(b, ship.position);
    const toShip = ship.position.subtract(b.center);
    const sunAbove = toShip.lengthSquared() > 1e-6 ? toShip.normalize().dot(sunToward) : 1;
    b.atmosphere?.update(alt, sun.direction, daylightFactor(sunAbove), solTowardView);
    b.surface?.update(dt, sun.direction, b === host);
    b.vegetation?.update(dt);
  }
  sol.update(dt); // advance the star's surface shader (convection scroll)

  // Stars show where the sky layers have cleared (brightness 1 in clear space, ~0
  // under a thick sky) and again at night, when the star's light no longer washes the
  // sky out: the sun is the light source for the sky itself.
  const sky = Math.max(...bodies.map((b) => b.atmosphere?.skyFactor ?? 0));
  const starBright = Math.max((1 - sky) ** 3, (1 - daylight) * 0.85, 0.02);
  starfield.setBrightness(starBright);

  // Sampled after the ship moved so the veil tracks the camera this tick.
  updateCloudObstruction(dt);

  updateHud(hud, ship, state, bodies);
}

engine.runRenderLoop(() => {
  if (!paused) {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
    tick(dt);
    cameraRig.update(dt);
    // The rig moves the camera after the sim tick; re-sample the veil so the
    // rendered frame's fog matches the camera's final position.
    updateCloudObstruction(0);
  }
  scene.render();
});
addEventListener("resize", () => engine.resize());
