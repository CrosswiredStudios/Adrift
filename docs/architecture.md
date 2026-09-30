# Adrift — Architecture

How the tech demo (`tech-demo/`) is put together, why, and how to extend it.
Read this before adding a system; the layering rules are what keep the game
testable as it grows.

## Layers

```
data/      content as data: bodies, POIs, items, recipes, discoveries, objectives
core/      fixed-step loop, typed event bus                 (no Babylon scene)
input/     actions + bindings, per-step snapshots           (DOM only)
sim/       celestial rails, frames, ship + character physics, SimWorld
game/      Game composition root, progression, save games
terrain/   height field, cube-sphere quadtree, worker jobs  (math runs in workers)
render/    camera rigs, lighting, starfield, planetary post-process (sky/clouds)
world/     BodyView: everything drawn for one body, props, terrain materials
ocean/     Gerstner wave set (CPU + GPU twins), ocean meshes/shaders
vegetation/ instanced foliage streamed per terrain chunk
ship/      ship mesh + FX
ui/        HUD (incl. the ship motion display), pause menu (DOM)
debug/     window.__game automation surface for tests and the console
```

Rules:

- **`sim/` never imports rendering.** Physics runs on plain `Vector3`/`Quaternion`
  math, so it is unit tested in Node and could run on a server or in a worker.
- **`data/` never imports systems.** A new planet, POI, item or recipe is a data
  change; `data/*.test.ts` and `game/progression.test.ts` check references resolve.
- **Gameplay reads actions, never keys** (`input/bindings.ts`). Tests, autopilots
  and rebinding all go through the same layer.
- **Systems talk through `Game.events`** (`core/events.ts`) for things other
  systems react to (toasts, discoveries, saves, SOI changes) instead of calling
  each other.
- **Anything a test needs goes through `debug/debugApi.ts`**, not private fields.

## Frame of a tick

`core/loop.ts` runs the simulation at a fixed 60 Hz and renders at display rate:

1. `Game.simulate(dt)` — one fixed step: `input.beginStep()` → map actions to
   `ShipControls` / `CharacterControls` → `SimWorld.step(dt)` → interaction and
   progression rules. Nothing visual is touched.
2. `Game.renderFrame(frameDt, alpha)` — interpolate between the previous and
   current sim state (`alpha`), place bodies/ship/player around the camera,
   update visual-only effects (terrain LOD, ocean patch, vegetation, sky, HUD)
   and draw.

Pausing stops step 1 (the loop's accumulator is reset); tests use
`__game.freeze()` + `__game.step(seconds)` for deterministic simulation.

## Scale, frames and the floating origin

- **1 unit = 1 meter.** The system is miniature (Vael is 2 km in radius, 9.81
  m/s² gravity, a 20-minute day; see the table in `data/system.ts`) so everything
  is minutes apart while orbits and day/night stay physically real.
- **Bodies are on rails** (`sim/celestial.ts`): circular Kepler orbits and a
  constant spin with tilt (or tidal lock), evaluated at any time `t`. Saves and
  time warp need only the clock.
- **Each dynamic entity lives in the body-fixed (rotating) frame of its dominant
  body** (`sim/frames.ts`). Standing on the ground is then "at rest", terrain
  collision is a lookup, and gravity + Coriolis + centrifugal terms are exact.
  When an entity leaves a body's sphere of influence (Laplace radius) its state
  is transferred exactly into the new frame (position, velocity, attitude).
- **Floating origin:** the camera is always at render-space `(0, 0, 0)`. Every
  frame each body's root node is placed at `inertialPosition - cameraPosition`
  with the body's rotation; everything on a body (terrain chunks, ocean,
  vegetation, props) is built once in body-local coordinates and rides along.
  Float32 precision is therefore spent near the camera.
- **Logarithmic depth** on every material (`near 0.05 m`, `far 2,000 km`) so one
  frustum covers the cockpit and other planets.

## Terrain

- `terrain/heightField.ts` is the single source of truth: the same function
  builds meshes, answers collision queries (ship gear, feet, props) and bakes the
  ocean depth map. A GLSL twin of the noise exists only for shading detail.
- `terrain/quadtree.ts`: a cube-sphere (6 faces, spherified) quadtree with
  screen-space-error splitting, horizon culling and progressive refinement
  (children are drawn only when all four are built, so there are no holes).
- Chunks are 32×32 cells with skirts; normals use a one-cell apron so seams are
  invisible. Each vertex also stores its offset to the parent chunk's surface,
  and the terrain shader **geomorphs** toward it with distance, so LOD switches
  don't pop while flying. Vegetation shrinks out at the edge of each layer's
  view radius for the same reason. Mesh data is built in a **worker pool** (`terrain/workerPool.ts`)
  with priorities (near the camera first), pruning of stale requests and
  re-prioritisation as the camera moves.

## Rendering

- **Lighting** (`render/lighting.ts`): one directional light along the true
  star direction, attenuated by the CPU atmosphere model so sunsets tint the
  ground; a small sky-illuminance term.
- **Planetary pass** (`render/planetaryPass.ts`): a post-process chain *before*
  the HDR pipeline — scene copy → half-res raymarched clouds → full-res
  composite with single-scattering Rayleigh + Mie atmosphere (sky, limbs,
  aerial perspective) for up to two bodies. Cloud coverage is modulated by a
  low-frequency *weather* field (clear, broken and overcast regions), denser
  cores tower higher, and each noise layer drifts in its own direction so
  clouds build and dissolve (after the Babylon volumetric-clouds playground
  `#MAONNT`, slowed down); the
  composite darkens the ground under clouds (cloud shadows) and the cloud
  pass adds light shafts where sunlight falls through gaps. The CPU twins
  (`render/atmosphereModel.ts`, `render/cloudModel.ts`) drive sunlight colour,
  the in-cloud whiteout veil and tests.
- **Ocean** (`ocean/`): Gerstner cascades evaluated identically on CPU (buoyancy,
  splash) and GPU; a camera-following patch over a sea shell; depth-aware
  colour, foam, swash and refraction.
- **Quality tiers** (`H`): ultra / high / balanced / lite scale MSAA, bloom,
  cloud steps, light shafts, cloud shadows, refraction and ocean detail.
- **Scene depth**: one depth texture (camera-space z) feeds clouds, haze and
  the ocean. Babylon's depth-renderer shaders are patched to depth-test with a
  logarithmic depth buffer like the main pass (`patchDepthShaders`), otherwise
  distant surfaces flicker in it.

## Flight and on-foot

- `sim/shipSim.ts`: Newtonian rigid body with Outer Wilds style handling:
  thrusters push along the ship's axes with a short spool-up, gravity always
  applies and there is no speed cap. Helpers: rotation assist (`T`, the stick
  sets a turn rate), match velocity (hold `X`: brake to rest and hold
  against gravity; thrust input then creeps at a capped speed) and landing
  mode (`L`: rotation keeps the belly toward the ground; off on touchdown
  or above 600 m). The strafe lean is visual only (`Game.renderFrame`), and
  the chase camera (`render/cameraRig.ts`) follows a damped copy of the
  ship's attitude at a fixed boom, so it behaves the same at any speed or
  altitude. Contacts are
  sequential-impulse with friction; the ship floats; resting ships sleep.
- `sim/character.ts`: capsule controller on the exact height field and static
  colliders, with swimming and slope limits.
- `sim/world.ts` (`SimWorld`): owns the ship, the player, which body each is
  in, boarding/exiting, SOI transfers.

## Content, progression and saves

- `data/pois.ts`: points of interest by lat/lon or offsets from other POIs;
  props are dropped onto the height field at load.
- `data/content.ts`: items, recipes (with discovery gates and effects),
  discoveries (lore) and the **objective chain** — each objective is completed
  by a trigger (`salvaged`, `discovered`, `crafted`, `boarded`, `arrived`).
- `game/progression.ts`: pure rules over those tables — salvage once, scan
  once, gated scans consume items, crafting, and an objective chain that
  remembers facts so doing things out of order just works.
- `game/saveGame.ts`: versioned JSON of the sim (clock, bodies each entity is
  in, body-frame states) + progression, in `localStorage`. `migrate()` is the
  place to upgrade old versions. Pause menu → Save / Load.

## Testing

- **Unit** (`src/**/*.test.ts`, Vitest): math, frames, rails, ship/character
  physics, terrain, waves, input, loop, content integrity, progression, saves.
- **End to end** (`tests/*.spec.ts`, Playwright + headless Chromium with
  SwiftShader): each file boots the game once and drives it through
  `window.__game` (step, place, render, query). They cover boot, pause, input,
  on-foot, flight (hover, landing, landing mode, orbit, SOI transfer), frames (spin, day/night,
  tidal lock, floating origin), terrain LOD/collision, ocean, sky/clouds,
  vegetation and progression/saves.
- **Screenshot tour** (`npm run test:shots`): renders a fixed list of views into
  `test-results/shots/` for eyeballing rendering changes.

## Extending

- **New planet or moon:** add a `BodyDef` to `data/system.ts` (orbit, spin, mu,
  terrain shape, optional atmosphere/ocean/clouds/vegetation). The view, sim
  environment, workers and HUD pick it up; add it to `TARGET_IDS` in `game.ts`
  if it should be targetable.
- **New POI / item / recipe / story beat:** edit `data/pois.ts` and
  `data/content.ts`; the integrity test tells you about dangling ids.
- **New input action:** add it to `ButtonAction`/`AxisAction` and the default
  bindings; the pause menu's controls list is generated from the bindings.
- **New system reacting to gameplay:** subscribe to `Game.events`; add a new
  event type to `GameEvents` if needed.

## Known gaps / next steps

- Survival stats (oxygen, power, thermal) are modelled in the HUD but not
  simulated yet.
- Orbits are circular; eccentric orbits would only change `sim/celestial.ts`.
- No audio yet (subscribe to `Game.events` for impacts, splashes, discoveries).
- Physics is custom and deliberately small; a physics engine (e.g. Havok) is
  worth it only once there are many dynamic bodies.
- Lint is `tsc` strict flags + Prettier; ESLint covers config files only.
