/**
 * `window.__game`: the automation/debug surface used by the Playwright
 * suites and for poking at the game from the console. Everything a test
 * needs goes through here, so specs don't reach into private fields.
 *
 * Headless software-GL renders a few frames per second, so tests advance
 * the simulation with `step(seconds)` (whole fixed steps, no rendering).
 */
import type { Game } from "../game/game";

export function installDebugApi(game: Game): object {
  const w = game.world;
  const api = {
    game,
    scene: game.scene,
    camera: game.camera,
    input: game.input,
    events: game.events,
    bodies: w.bodies,
    sun: w.sol,
    ship: game.shipPose,
    shipMesh: game.shipMesh,
    state: game.flight,
    steer: game.steer,
    /** Advance `seconds` of simulation in fixed steps (default one step). */
    step: (seconds = 1 / 60) => game.step(seconds),
    /** Run the visual update + draw once (sim state is not advanced). */
    render: () => game.renderFrame(0, 1),
    time: () => game.time,
    paused: () => game.paused,
    setPaused: (on: boolean) => game.setPaused(on),
    bankDeg: () => game.bankDeg(),
    ocean: () => ({
      vael: w.vael.surface?.ocean?.stats() ?? null,
      tethys: w.tethys.surface?.ocean?.stats() ?? null,
      quality: game.quality.tier,
    }),
    clouds: () => ({
      tier: game.quality.tier,
      density: game.cloudObstruction.density,
      veil: game.cloudObstruction.veil,
    }),
    cloudQuality: (tier?: string) => game.setCloudTier(tier),
    oceanDebug: (mode: number) => {
      game.setOceanDebug(mode);
      return mode;
    },
    probe: (dir: number[]) => game.probe(dir),
    terrainDebug: (mode: number) => {
      for (const b of w.bodies) b.surface?.terrain?.setDebug(mode);
      return mode;
    },
    terrain: () => ({
      vael: game.describeTerrain(w.vael.surface?.terrain ?? null),
      tethys: game.describeTerrain(w.tethys.surface?.terrain ?? null),
    }),
    vegetation: () => ({
      vael: w.vael.vegetation?.status() ?? null,
      tethys: w.tethys.vegetation?.status() ?? null,
    }),
    vegetationSample: (bodyIndex: number, layer: "trees" | "shrubs" | "grass", n: number) =>
      w.bodies[bodyIndex]?.vegetation?.sampleDirs(layer, n) ?? [],
    vegetationShow: (on: boolean) => {
      for (const b of w.bodies) b.vegetation?.setVisible(on);
      return on;
    },
  };
  (window as unknown as { __game?: object }).__game = api;
  return api;
}
