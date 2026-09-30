# Adrift — Milestones

## M0 — Seamless world (done)

- Miniature star system on rails at 1:1 meters; floating origin, log depth.
- Walk ↔ fly with exact physics in rotating body frames and SOI hand-off.
- Streamed quadtree terrain, ocean, vegetation, atmosphere and volumetric clouds.
- Fixed-step loop, action-based input (keyboard, mouse, gamepad), pause.
- Unit + end-to-end tests, screenshot tour, CI.

## M1 — Vertical slice (in progress)

- [x] Data-driven POIs, salvage, scanning, lore, crafting, objective chain.
- [x] Save / load (versioned, local storage).
- [ ] Survival: oxygen, suit power, thermal; shelter at the pod.
- [ ] Night-one pressure: darkness, cold, the pod as a safe spot.
- [ ] Audio: ambience, thrusters, impacts, UI (hook into `Game.events`).
- [ ] Ship damage consequences (thruster loss, leaks) and field repairs.
- [ ] Onboarding: first-run hints for walking, boarding, landing.

## M2 — Build the way off

- [ ] Ship modules as items (thruster, tank, nav core, heat shield) and a
      skiff → starhopper upgrade path gated by discoveries.
- [ ] Fuel and delta-v; orbital map with trajectory preview.
- [ ] Re-entry heat that matters (heat shield module).
- [ ] More POIs per body; caves; procedural minor sites.

## M3 — The relay

- [ ] Glyph language learned through discoveries, translating UI and lore.
- [ ] Relay network puzzle across bodies; endings (rescue, self-rescue, keeper).

## Tech backlog

- Eccentric orbits and time warp (rails already support arbitrary `t`).
- Physics engine only if many dynamic bodies appear (Havok via Babylon plugin).
- GPU-driven terrain detail (tessellation / virtual texturing) if needed.
- Add typescript-eslint for `src/` (today strict `tsc` flags + Prettier act as the linter).
