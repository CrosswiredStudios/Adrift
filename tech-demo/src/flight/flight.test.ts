import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "@babylonjs/core";
import { EngineCommand, FlightState, updateShip } from "./flight";
import { Pose, makePose } from "../common/pose";
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

function makeShip(): Pose {
  return makePose(new Vector3(0, 10, 0), Quaternion.Identity());
}

const idle: EngineCommand = { throttleUp: false, throttleDown: false, brake: false, boost: false };

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
    const ship = makeShip();
    const state = makeState();
    const bodies = [makePlaneBody()];

    // No input, no cruise: gravity is mu=0 so the ship hangs at alt 10.
    updateShip(ship, state, bodies, idle, { pitch: 0, yaw: 0, roll: 0 }, 1 / 60);
    expect(state.altitude).toBeCloseTo(10, 3);
    expect(state.landed).toBe(false);

    // Teleport into contact with downward velocity: contact clamps + lands.
    ship.position.set(0, 1.0, 0);
    state.velocity = new Vector3(0, -2, 0);
    updateShip(ship, state, bodies, idle, { pitch: 0, yaw: 0, roll: 0 }, 1 / 60);
    expect(state.landed).toBe(true);
    expect(ship.position.y).toBeCloseTo(1.2, 2);
  });

  it("cruise throttle accelerates along the nose", () => {
    const ship = makeShip();
    const state = makeState();
    const bodies = [makePlaneBody()];

    for (let i = 0; i < 60; i++) {
      updateShip(ship, state, bodies, { ...idle, throttleUp: true }, { pitch: 0, yaw: 0, roll: 0 }, 1 / 60);
    }
    expect(state.cruise).toBeGreaterThan(30);
    expect(state.velocity.length()).toBeGreaterThan(10);
  });
});
