/**
 * `window.__game`: the automation/debug surface used by the Playwright
 * suites and for poking at the game from the console. Tests go through here
 * instead of reaching into private fields.
 *
 * Headless software-GL renders a few frames per second, so tests advance
 * the simulation with `step(seconds)` (whole fixed steps, no rendering) and
 * call `render()` when they need visual state updated.
 */
import { Vector3 } from "@babylonjs/core";
import type { Game } from "../game/game";
import { latLonToDir, headingVector, tangentAxes } from "../data/pois";
import { terrainHeight, terrainRadius } from "../terrain/heightField";
import { cloudDensityAt } from "../render/cloudModel";
import { snapshotFrame, pointToInertial, velocityToInertial } from "../sim/frames";
import { quatFromAxes } from "../sim/shipSim";
import type { SkyQuality } from "../render/planetaryPass";

export function installDebugApi(game: Game): object {
  const sim = game.sim;
  const shape = (bodyId: string) => {
    const s = sim.defs.get(bodyId)?.terrain;
    if (!s) throw new Error(`no terrain on ${bodyId}`);
    return s;
  };
  const api = {
    game,
    sim,
    scene: game.scene,
    camera: game.camera,
    input: game.input,
    events: game.events,
    views: game.views,
    /** Advance `seconds` of simulation in fixed steps (default one step). */
    step: (seconds = 1 / 60) => game.step(seconds),
    /** Run the visual update + draw once (sim state is not advanced). */
    render: () => game.renderFrame(0, 1),
    time: () => sim.time,
    /** Stop real-time simulation (rendering continues); tests then drive it with step(). */
    freeze: (on = true) => {
      game.loop.timeScale = on ? 0 : 1;
      game.loop.resetAccumulator();
    },
    paused: () => game.paused,
    setPaused: (on: boolean) => game.setPaused(on),
    mode: () => sim.mode,
    quality: (tier?: SkyQuality) => (tier ? game.cycleQuality(tier) : game.qualityTier),

    /** Terrain height (m above the mean radius) at lat/lon on a body. */
    terrainHeightAt: (bodyId: string, lat: number, lon: number) => {
      const d = latLonToDir(lat, lon);
      return terrainHeight(shape(bodyId), d[0], d[1], d[2]);
    },
    /** Put the ship at lat/lon, `alt` m above the ground or sea, level, nose along `headingDeg`, at rest. */
    placeShip: (bodyId: string, lat: number, lon: number, alt: number, headingDeg = 0) => {
      const body = sim.system.get(bodyId);
      const d = latLonToDir(lat, lon);
      const up = new Vector3(d[0], d[1], d[2]);
      const ground = sim.defs.get(bodyId)?.terrain
        ? terrainRadius(shape(bodyId), d[0], d[1], d[2])
        : body.radius;
      const water = sim.env(body).waterRadius(d[0], d[1], d[2]);
      const r = water !== null ? Math.max(ground, water) : ground; // above the sea surface, not the sea floor
      const h = headingVector(d, headingDeg);
      const fwd = new Vector3(h[0], h[1], h[2]);
      sim.shipBody = body;
      sim.ship.pos.copyFrom(up.scale(r + alt));
      sim.ship.vel.setAll(0);
      sim.ship.angVel.setAll(0);
      quatFromAxes(Vector3.Cross(up, fwd), up, fwd, sim.ship.att);
      sim.ship.landed = false;
      sim.ship.wake();
      game.resetCamera();
    },
    /** Stand the player at lat/lon facing `headingDeg`. */
    placePlayer: (bodyId: string, lat: number, lon: number, headingDeg = 0) => {
      const body = sim.system.get(bodyId);
      const d = latLonToDir(lat, lon);
      const h = headingVector(d, headingDeg);
      sim.playerBody = body;
      sim.player.placeOnSurface(new Vector3(d[0], d[1], d[2]), new Vector3(h[0], h[1], h[2]), sim.env(body));
      game.resetCamera();
    },
    /** Back to the start: player at the crash site, skiff on the pad, inputs cleared. */
    reset: () => {
      game.input.clearOverrides();
      game.input.releaseAll();
      sim.ship.assist = true;
      sim.ship.hull = 1;
      sim.ship.heat = 0;
      game.progression.reset();
      game.setInventoryOpen(false);
      game.spawn();
      game.resetCamera();
    },
    board: () => sim.board(),
    exitShip: () => sim.exitShip(),
    /** Force control mode (skips proximity checks; tests). */
    setMode: (mode: "ship" | "onFoot") => {
      if (mode === "ship") {
        sim.mode = "ship";
        sim.ship.wake();
      } else if (!sim.exitShip()) {
        sim.mode = "onFoot";
      }
      game.resetCamera();
    },
    shipInertial: () => {
      const f = snapshotFrame(sim.shipBody, sim.time);
      return {
        pos: pointToInertial(f, sim.ship.pos).asArray(),
        vel: velocityToInertial(f, sim.ship.pos, sim.ship.vel).asArray(),
      };
    },
    bodyPosition: (bodyId: string) => sim.system.get(bodyId).positionAt(sim.time).asArray(),
    terrain: (bodyId: string) => game.views.get(bodyId)?.terrain?.stats() ?? null,
    terrainDebug: (mode: number) => {
      for (const v of game.views.values()) v.terrainHandle?.setDebug(mode);
      return mode;
    },
    textures: (bodyId: string) => {
      const t = game.views.get(bodyId)?.terrainHandle?.textures;
      if (!t) return null;
      return {
        fallbacks: [...t.fallbacks],
        ready: [t.baseColor, t.baseNormal, t.rockColor, t.rockNormal].every((x) => x.isReady()),
      };
    },
    vegetation: (bodyId: string) => game.views.get(bodyId)?.vegetation?.status() ?? null,
    vegetationSample: (bodyId: string, species: "broadleaf" | "conifer" | "shrub" | "grass", n: number) =>
      game.views.get(bodyId)?.vegetation?.sample(species, n) ?? [],
    ocean: (bodyId: string) => game.views.get(bodyId)?.ocean?.stats() ?? null,
    /** Water surface radius under a body-frame direction (CPU wave field). */
    waterRadius: (bodyId: string, dir: number[]) =>
      sim.env(sim.system.get(bodyId)).waterRadius(dir[0], dir[1], dir[2]),
    oceanDebug: (mode: number) => {
      game.setOceanDebug(mode);
      return mode;
    },
    clouds: () => ({ density: game.cloudVeil.density, veil: game.cloudVeil.veil, quality: game.qualityTier }),
    /** CPU cloud density at a body-frame point (same field the GPU draws). */
    cloudDensity: (bodyId: string, p: number[], t = sim.time) => {
      const cp = game.views.get(bodyId)?.clouds;
      return cp ? cloudDensityAt(game.planetary.volume, cp, p[0], p[1], p[2], t) : 0;
    },
    workers: () => game.pool.stats(),
    /** True once terrain and vegetation near the camera have finished streaming. */
    settled: () => {
      for (const v of game.views.values()) {
        if (v.terrain && !v.terrain.settled()) return false;
        const veg = v.vegetation?.status();
        if (veg && veg.pending > 0) return false;
      }
      return game.pool.stats().queued === 0 && game.pool.stats().inFlight === 0;
    },
    localHour: () =>
      game.localHour(
        sim.mode === "ship" ? sim.shipBody.id : sim.playerBody.id,
        sim.mode === "ship" ? sim.ship.pos : sim.player.pos,
      ),
    interactable: () => game.nearestInteractable?.poi.id ?? null,
    interact: () => game.interact(),
    progression: game.progression,
    objective: () => game.progression.objective,
    inventory: () => Object.fromEntries(game.progression.inventory),
    craft: (recipe: string) => game.craft(recipe),
    setInventoryOpen: (on: boolean) => game.setInventoryOpen(on),
    save: () => game.save(),
    load: () => game.load(),
    /** Stand the player at a POI (next to its interaction point). */
    gotoPoi: (poiId: string) => {
      const it = game.interactables.find((i) => i.poi.id === poiId);
      if (!it) throw new Error(`no interactable ${poiId}`);
      const body = sim.system.get(it.bodyId);
      if (sim.mode === "ship") sim.mode = "onFoot";
      sim.playerBody = body;
      const d0 = it.position.clone().normalize();
      const { east } = tangentAxes([d0.x, d0.y, d0.z]);
      const e = new Vector3(east[0], east[1], east[2]);
      // A little to the side of the interaction point, facing it.
      const dir = it.position.add(e.scale(Math.min(2.5, it.radius * 0.5))).normalize();
      sim.player.placeOnSurface(dir, e.scale(-1), sim.env(body));
      game.resetCamera();
    },
  };
  (window as unknown as { __game?: object }).__game = api;
  return api;
}
