# Adrift Tech Demo — Seamless Spaceflight

Goal: fly seamlessly from a planet surface to orbit to another planet in Babylon.js,
with a realistic atmosphere transition (blue sky → thin limb → black space and back).

## Controls

- `W/S`: pitch nose up/down.
- `A/D`: turn (yaw) with automatic banking into the turn.
- `Q/E`: roll left/right manually (auto-level returns wings level when released).
- `Mouse`: pointer steering — the cursor's offset from the screen center is an
  analog steering stick. Centered cursor = straight flight; keyboard works on top.
- `Up/Down`: throttle up/down (arcade cruise speed).
- `Shift`: boost while thrusting.
- `Space` or `C`: full brake (works even while thrusting).
- `1/2/3`: target Vael Prime / Tethys / the star Sol.
- `H`: toggle High/Low quality (bloom, grain, MSAA, clouds).

## What It Proves

- One continuous scene, no teleports.
- Scale strategy: real units with camera far plane management.
- Realistic atmosphere: custom Rayleigh + Mie scattering shaders.
  - Outer limb shell seen from space (limb brightening, twilight band, terminator).
  - Inner sky dome seen from the ground (sun disc + halo aligned to the real star
    body, horizon haze, sunset warming).
  - Star-driven: sky, limb and glare only appear where the sun lights the air, so the
    night side is black with stars; the star is the scene's light source.
  - Per-planet scatter palette (`skyTint`/`skyStrength`, `hazeTint`/`hazeStrength`,
    `sunTint` in `planets.ts`): blue N-O2 skies, or a dusty orange/red sky.
  - Atmosphere height is a per-planet number (Vael: 520 units) and everything -
    shells, fade bands, drag, HUD - scales with it for a long ground-to-space fade.
    Twilight keeps a warm ambient as the star sets, so the day/night line on the ground
    reads as a soft haze band instead of a hard edge, and the cloud deck thins out
    toward the night side and when seen edge-on so its shell never draws a hard line.
  - Cross-faded by camera altitude; sun color, exposure, and starfield fade with depth.
- Real star body: the sun (Sol) is an actual limb-darkened sphere (~7.6 degrees wide at
  36,000 u) with a soft billboard corona, appended to the bodies list (HUD distance,
  weak gravity well, landable). It sits exactly on the scene light axis, so the terminator,
  the sky-dome glare (now drawn about the true camera-to-star direction) and the visible
  disc all agree at every altitude. The opaque star dome spans 55k u, so it no longer
  depth-culls objects beyond 20k u - the bug that made the old sun sprite invisible.
- Procedural planet: FBM terrain with raised relief and masked mountain ranges (ridged
  crests and craggy flanks clustered on high ground), beach/shelf/basin bathymetry and
  biome vertex tints, animated procedural clouds, night-side city lights, and a
  two-layer coastal ocean (below).
- Textured ground: CC0 grass/dust + rock texture sets in `tech-demo/public/textures/terrain/`
  (see the CREDITS there), blended per fragment by slope, altitude and a noise mask,
  with blended normal maps, a snow line and stony beaches/seabed. The blend runs in a
  `TerrainTextures` material plugin on the ground PBR material (also in low quality).
  Vael blends grass+rock; airless Tethys blends rock+dust. Debug views via
  `__game.terrainDebug(1 = rock blend, 2 = slope, 3 = normalized height)`.
- Vegetation biome: deterministic thin-instanced trees (broadleaf + conifer), shrubs and
  grass tufts scattered over Vael's land on the same terrain height field the ground,
  ocean and flight model use (above the shore margin, below the tree/shrub/grass lines,
  off polar caps and steep slopes, clumped into woods by a low-frequency "forest"
  noise). CC0 bark / beech-leaf canopy / fir-branch canopy / weed / grass cutouts in
  `tech-demo/public/textures/vegetation/` (CREDITS there), alpha-tested PBR materials
  with per-instance tint + scale via thin-instance buffers and a subtle wind-sway
  vertex plugin. Layers: Vael only (Tethys is airless). Debug/status via
  `__game.vegetation()`, `__game.vegetationSample(body, layer, n)`,
  `__game.vegetationShow(on)`; the whole set is triangle-budgeted (~130k) and auto-
  hidden when the camera is far from the body.
- Coastal ocean: analytic Gerstner cascades (swell / wind / chop, sea states
  calm/mild/rough) with distance LOD fade on a camera-following patch over a global sea
  shell; depth-based colour + transparency, surf-zone shoaling/refraction, breaking
  whitewater, swash run-up with a wet-sand band and receding foam lace on the beach,
  waterline foam from the depth buffer, sun glitter and a refraction pass over a ground
  colour target. The ship floats and rides the waves; splashdown throws a spray burst.
  Guide: port of `Popov72/OceanDemo` (WebGPU FFT) concepts to a WebGL2 wave field.
  `H` low quality drops foam/shore detail, chop and the refraction pass.
- Procedural PBR ship: hull, canopy, wings, nacelles, emissive strips, nav lights,
  engine glow + lights + exhaust particles scaling with thrust, re-entry heat shell.
- Flight model: gravity wells, altitude-dependent drag, control-authority falloff,
  soft landing / hard-impact bounce, re-entry heat estimate.
- HUD shows speed, vertical speed, altitude, atmosphere + heat bars, target distances.
- HDR pipeline: ACES tone mapping, bloom, FXAA/MSAA, sharpen, vignette, grain.

## Structure

- `tech-demo/src/main.ts`: scene setup, HDR pipeline, procedural starfield, chase camera, `__game` debug handle.
- `tech-demo/src/flight.ts`: ship controller (thrust, drag, heat, landing).
- `tech-demo/src/planets.ts`: bodies registry (`makePlanet`, `bodyAltitude`, `atmosphereFactor`).
- `tech-demo/src/sun.ts`: the star Sol (limb-darkened core shader + billboard corona, registers as a body).
- `tech-demo/src/planetSurface.ts`: procedural terrain (mountain ranges + coastal shaping), seabed, clouds, night lights, baked ocean height field, wet-sand plugin.
- `tech-demo/src/terrainMaterial.ts`: ground texture sets (+ procedural fallbacks) and the slope/altitude/noise blend plugin (`TerrainTextures`).
- `tech-demo/src/vegetation.ts`: instanced tree/shrub/grass biome (placement, cutout card geometry, alpha-test materials, wind-sway plugin, per-body instance registry).
- `tech-demo/src/ocean.ts`: two-layer ocean (global shell + camera patch), surf shading, refraction/depth targets, debug views.
- `tech-demo/src/oceanWaves.ts`: wave source (sea states, Gerstner set, GLSL chunks, CPU wave samplers for buoyancy).
- `tech-demo/src/shaderChunks.ts`: shared GLSL helpers (sky palette, water noise).
- `tech-demo/src/atmosphere.ts`: Rayleigh/Mie outer limb + inner sky dome shaders (altitude cross-fade).
- `tech-demo/src/shipBuilder.ts`: procedural PBR ship, engines, glow, particles.
- `tech-demo/src/noise.ts`: seeded value-noise/FBM helpers.
- `tech-demo/src/hud.ts`: overlay readouts.
- `tech-demo/tests/smoke.spec.ts`: Playwright tests (load, climb to space, reentry, atmosphere hand-off).
- `tech-demo/tests/ocean.spec.ts`: ocean tests (patch gating, float/buoyancy determinism, coastal + orbit screenshots).
- `tech-demo/tests/sun.spec.ts`: sun tests (body wiring/alignment, space + ground + mid-atmosphere screenshots, no-sprite regression).
- `tech-demo/tests/terrain.spec.ts`: terrain tests (plugin wiring, texture loading, relief statistics, orbit/range/cliff/blend-mask screenshots).
- `tech-demo/tests/vegetation.spec.ts`: vegetation tests (instance counts/budget, texture loading, placement constraints vs the terrain field, forest/coast/orbit screenshots).

## Run

```powershell
cd tech-demo
npm install
npm run dev
```

## Test

```powershell
cd tech-demo
npm run build
npx playwright test
```

Flight tests drive the simulation via `window.__game.step(dt)` (deterministic,
no rendering) because software-GL CI browsers render too slowly for realtime flight.
The smoke test verifies the scene loads clean and renders frames.
