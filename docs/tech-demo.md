# Adrift Tech Demo

A playable slice of the Vesper Drift system in Babylon.js: walk away from the
crash, salvage the escape pod, take the skiff from the survey pad, and fly —
without loading screens — from Vael's surface through its atmosphere to orbit,
to the moon Tethys, and on to Cinder.

See [architecture.md](./architecture.md) for how it is built.

## Controls

Keyboard + mouse (click the view to capture the mouse; `Esc` releases it and
pauses). A standard gamepad also works. The pause menu lists the live bindings.

| Action | On foot | In the skiff |
| --- | --- | --- |
| Move / thrust | `W A S D` | `W/S` forward/back, `A/D` strafe |
| Up / down | `Space` jump | `Space` / `C` vertical thrusters |
| Look / steer | Mouse or arrow keys | Mouse (virtual stick) or arrows (pitch/yaw) |
| Roll | — | `Q` / `E` |
| Sprint / boost | `Shift` | `Shift` |
| Interact, board, step out | `F` | `F` |
| Inventory + crafting | `Tab` | `Tab` |
| Flight assist on/off | — | `T` |
| Match velocity (brake to rest) | — | `X` |
| Camera (chase / cockpit) | — | `V` |
| Target Vael / Tethys / Cinder / Vesper | `1`–`4` | `1`–`4` |
| Quality tier | `H` | `H` |
| Pause (Save / Load) | `Esc` | `Esc` |

Flight tips: with assist on, releasing the controls holds a hover near the
ground and holding `C` lands you gently. In space, assist only stops rotation —
you keep your velocity, so orbits work. Vael's orbital speed at the surface is
about 140 m/s.

## What the demo shows

- **One continuous world at 1:1 meters**: a miniature star system on rails
  (real gravity, orbits, spin and day/night), a floating origin and
  logarithmic depth — no teleports, no scene switches.
- **Walk ↔ fly**: a capsule character and a Newtonian ship with flight assist,
  both simulated in the rotating frame of the body they're on, with exact
  hand-off between spheres of influence.
- **Planets**: streamed cube-sphere quadtree terrain built in workers, triplanar
  texturing, craters on airless bodies, a coastal ocean with Gerstner waves the
  ship floats on, instanced vegetation.
- **Sky**: single-scattering atmosphere (sunsets, limbs from orbit, aerial
  perspective), raymarched volumetric clouds you can fly into, stars that fade
  in at night.
- **Game layer**: POIs, salvage, scanning, lore, crafting, an objective chain
  and save/load — all data-driven.

## Run

```sh
cd tech-demo
npm install
npm run dev
```

## Test

```sh
cd tech-demo
npm test            # typecheck + lint + format check + unit tests (Vitest)
npm run test:e2e    # production build + Playwright end-to-end suites
npm run test:shots  # screenshot tour into test-results/shots/
```

End-to-end tests run on software WebGL, so they drive the simulation with
`window.__game.step(seconds)` instead of real time. The same `__game` object is
handy from the browser console: `__game.placeShip("tethys", 10, 0, 50)`,
`__game.gotoPoi("monolith-ridge")`, `__game.terrainDebug(2)`,
`__game.quality("lite")`, `__game.save()`.
