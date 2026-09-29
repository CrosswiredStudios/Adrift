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
| Rotation assist on/off | — | `T` |
| Match velocity / hover (hold) | — | `X` |
| Landing mode | — | `L` |
| Camera (chase / cockpit) | — | `V` |
| Target Vael / Tethys / Cinder / Vesper | `1`–`4` | `1`–`4` |
| Quality tier | `H` | `H` |
| Pause (Save / Load) | `Esc` | `Esc` |

Flight handles like Outer Wilds: the thrusters push along the ship's own
axes (`W/S` forward/back, `A/D` sideways, `Space`/`C` up/down, `Shift`
boosts forward thrust), they spool up over a moment so taps give fine
nudges, gravity always pulls and there is no speed limit.

- **Rotation assist** (on by default, `T`): the mouse or stick sets a turn
  rate and the ship stops turning when you let go. Off, rotation has
  momentum too.
- **Match velocity** (hold `X`): brakes to rest relative to the ground and
  holds you there against gravity — that's how you hover. Thrusting while
  holding it creeps along that axis at about 6 m/s, so `X` + `C` is a
  controlled descent onto a landing spot.
- **Landing mode** (`L`): keeps the belly pointed at the ground while
  leaving the heading to you (`LANDING` on the HUD).

Vael's orbital speed at the surface is about 140 m/s.

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

Troubleshooting (Windows): if `npm run dev` says `'vite'` (or even `'node'`)
"is not recognized", the `Path` environment variable is probably longer than
the 8191 characters `cmd.exe` accepts (npm runs scripts through `cmd.exe`).
Shorten it (remove stale/duplicate entries), or run the tools directly, e.g.
`node node_modules/vite/bin/vite.js`.

End-to-end tests run on software WebGL, so they drive the simulation with
`window.__game.step(seconds)` instead of real time. The same `__game` object is
handy from the browser console: `__game.placeShip("tethys", 10, 0, 50)`,
`__game.gotoPoi("monolith-ridge")`, `__game.terrainDebug(2)`,
`__game.quality("lite")`, `__game.save()`.
