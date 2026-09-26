import { describe, expect, it } from "vitest";
import { Mesh, Quaternion, Scene, Vector3 } from "@babylonjs/core";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { FlightState, updateShip } from "./flight";
import { IWorldBody } from "../world/worldBody";

/**
 * DIP proof: the flight model runs against a stub IWorldBody with no
 * planets.ts import. A flat infinite plane at y=0 (no atmosphere, no water)
 * is enough to exercise cruise, gravity-free fall, and ground contact.
 */
function makePlaneBody(): IWorldBody {
  const center = new Vector3(0, -1000, 0);
  const radius = 1000;
  return {
    name: "plane",
    radius,
    mu: 0,
    center,
    atmosphereAt: () => 0,
    surfaceAltitudeAt: (p: Vector3) => p.y,
    surfaceRadiusAt: () => radius,
    isOverWaterAt: () => false,
    waterSurfaceRadiusAt: () => radius,
  };
}

function makeShip(scene: Scene): Mesh {
  const ship = new Mesh("ship", scene);
  ship.position = new Vector3(0, 10, 0);
  ship.rotationQuaternion = Quaternion.Identity();
  return ship;
}

function makeState(): FlightState {
  return {
    velocity: new Vector3(0, 0, 0),
    target: null,
    cruise: 0,
    atmoDensity: 0,
    heat: 0,
    verticalSpeed: 0,
    altitude: 10,
    landed: false,
    floating: false,
    floatR: 0,
    rig: null,
  };
}

describe("updateShip against IWorldBody stub", () => {
  it("holds still with no input and lands when dropped", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const ship = makeShip(scene);
    const state = makeState();
    const bodies = [makePlaneBody()];

    // No input, no cruise: gravity is mu=0 so the ship hangs at alt 10.
    updateShip(ship, state, bodies, {}, { pitch: 0, yaw: 0, roll: 0 }, 1 / 60);
    expect(state.altitude).toBeCloseTo(10, 3);
    expect(state.landed).toBe(false);

    // Teleport into contact with downward velocity: contact clamps + lands.
    ship.position = new Vector3(0, 1.0, 0);
    state.velocity = new Vector3(0, -2, 0);
    updateShip(ship, state, bodies, {}, { pitch: 0, yaw: 0, roll: 0 }, 1 / 60);
    expect(state.landed).toBe(true);
    expect(ship.position.y).toBeCloseTo(1.2, 2);
    scene.dispose();
    engine.dispose();
  });

  it("cruise throttle accelerates along the nose", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const ship = makeShip(scene);
    const state = makeState();
    const bodies = [makePlaneBody()];

    for (let i = 0; i < 60; i++) {
      updateShip(ship, state, bodies, { arrowup: true }, { pitch: 0, yaw: 0, roll: 0 }, 1 / 60);
    }
    expect(state.cruise).toBeGreaterThan(30);
    expect(state.velocity.length()).toBeGreaterThan(10);
    scene.dispose();
    engine.dispose();
  });
});
