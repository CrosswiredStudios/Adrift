import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "@babylonjs/core";
import { ShipSim, emptyControls, type ShipEnvironment } from "./shipSim";

const R = 2000;
const MU = 9.81 * R * R;

/** A smooth sphere world (optionally with a sea and an atmosphere). */
function env(opts: { sea?: number; atmo?: number; spin?: number } = {}): ShipEnvironment {
  return {
    mu: MU,
    spinRate: opts.spin ?? 0,
    radius: R,
    surfaceRadius: () => R,
    surfaceNormal: (x, y, z) => [x, y, z],
    waterRadius: () => (opts.sea !== undefined ? R + opts.sea : null),
    airDensity: (alt) => (opts.atmo ? (alt < opts.atmo ? Math.exp(-Math.max(alt, 0) / 220) : 0) : 0),
    atmosphereTop: opts.atmo ?? null,
  };
}

const up = new Vector3(0, 1, 0);
const north = new Vector3(0, 0, 1);

function run(ship: ShipSim, seconds: number, e: ShipEnvironment, c = emptyControls(), events = {}): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) ship.step(1 / 60, c, e, events);
}

describe("ShipSim", () => {
  it("rests on the ground without drift or jitter", () => {
    const e = env({ atmo: 900 });
    const ship = new ShipSim();
    ship.placeOnSurface(up, north, e);
    run(ship, 2, e);
    const p0 = ship.pos.clone();
    run(ship, 10, e);
    expect(Vector3.Distance(p0, ship.pos)).toBeLessThan(0.05);
    expect(ship.landed).toBe(true);
    expect(ship.hull).toBe(1);
  });

  it("settles after a short drop and lands", () => {
    const e = env({ atmo: 900 });
    const ship = new ShipSim();
    ship.placeOnSurface(up, north, e);
    ship.pos.y += 4;
    ship.landed = false;
    ship.assist = false;
    run(ship, 6, e);
    expect(ship.landed).toBe(true);
    expect(ship.altitude).toBeLessThan(2);
    expect(ship.hull).toBe(1);
    const nose = ship.axis(Vector3.Forward());
    expect(Math.abs(Vector3.Dot(nose, up))).toBeLessThan(0.1); // still level
  });

  it("thrusters lift off; holding match velocity hovers in place", () => {
    const e = env({ atmo: 900 });
    const ship = new ShipSim();
    ship.placeOnSurface(up, north, e);
    const c = emptyControls();
    c.thrust.y = 1;
    run(ship, 2, e, c);
    c.thrust.y = 0;
    c.matchVelocity = true;
    run(ship, 3, e, c);
    const alt0 = ship.altitude;
    run(ship, 4, e, c);
    expect(alt0).toBeGreaterThan(5);
    expect(Math.abs(ship.altitude - alt0)).toBeLessThan(0.5);
    expect(ship.vel.length()).toBeLessThan(0.3);
    // Let go and gravity takes over (no automatic hover).
    c.matchVelocity = false;
    run(ship, 1, e, c);
    expect(ship.verticalSpeed).toBeLessThan(-5);
  });

  it("releasing a hover just above the ground sets the ship down gently", () => {
    const e = env({ atmo: 900 });
    const ship = new ShipSim();
    ship.placeOnSurface(up, north, e);
    ship.pos.y += 1.2;
    ship.landed = false;
    let impacts = 0;
    run(ship, 3, e, emptyControls(), { impact: () => impacts++ });
    expect(ship.landed).toBe(true);
    expect(ship.hull).toBe(1);
    expect(impacts).toBe(0);
  });

  it("thrusting while holding match velocity creeps at a capped speed", () => {
    const e = env({ atmo: 900 });
    const ship = new ShipSim();
    ship.pos.set(0, R + 60, 0);
    const c = emptyControls();
    c.matchVelocity = true;
    c.thrust.y = -1;
    let maxDown = 0;
    let impacts = 0;
    for (let i = 0; i < 60 * 20 && !ship.landed; i++) {
      ship.step(1 / 60, c, e, { impact: () => impacts++ });
      maxDown = Math.max(maxDown, -ship.verticalSpeed);
    }
    expect(ship.landed).toBe(true);
    expect(maxDown).toBeLessThan(6.5);
    expect(maxDown).toBeGreaterThan(5);
    expect(impacts).toBe(0);
    expect(ship.hull).toBe(1);
  });

  it("thrusters spool up: a short tap gives a small nudge", () => {
    const e = env();
    const ship = new ShipSim();
    ship.pos.set(0, R + 5000, 0);
    ship.vel.set(0, Math.sqrt(MU / (R + 5000)) * 0, 0);
    const c = emptyControls();
    c.thrust.z = 1;
    const v0 = Vector3.Dot(ship.vel, ship.axis(Vector3.Forward()));
    run(ship, 0.05, e, c);
    const tap = Vector3.Dot(ship.vel, ship.axis(Vector3.Forward())) - v0;
    expect(tap).toBeGreaterThan(0);
    expect(tap).toBeLessThan(0.5 * 24 * 0.05); // well under full thrust
  });

  it("without assist the ship falls (pure Newtonian)", () => {
    const e = env({ atmo: 900 });
    const ship = new ShipSim();
    ship.assist = false;
    ship.pos.set(0, R + 300, 0);
    run(ship, 2, e);
    expect(ship.verticalSpeed).toBeLessThan(-12); // g is ~7.4 m/s^2 at 300 m on a 2 km planet
  });

  it("coasts on a stable orbit with assist off (Newtonian)", () => {
    const e = env();
    const ship = new ShipSim();
    ship.assist = false;
    const r = R + 1800; // above the hover ceiling: no assist damping
    ship.pos.set(r, 0, 0);
    ship.vel.set(0, 0, Math.sqrt(MU / r));
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / MU);
    let minR = Infinity;
    let maxR = 0;
    for (let i = 0; i < period * 60; i++) {
      ship.step(1 / 60, emptyControls(), e);
      const d = ship.pos.length();
      minR = Math.min(minR, d);
      maxR = Math.max(maxR, d);
    }
    expect((maxR - minR) / r).toBeLessThan(0.01);
  });

  it("orbits correctly in a rotating frame too", () => {
    const w = (2 * Math.PI) / 1200;
    const e = env({ spin: w });
    const ship = new ShipSim();
    ship.assist = false;
    const r = R + 1800;
    ship.pos.set(r, 0, 0);
    // Inertial circular speed along +z (prograde), minus the frame's w x r.
    const vI = new Vector3(0, 0, Math.sqrt(MU / r));
    const wxr = Vector3.Cross(new Vector3(0, w, 0), ship.pos);
    ship.vel.copyFrom(vI.subtract(wxr));
    let minR = Infinity;
    let maxR = 0;
    for (let i = 0; i < 600 * 60; i++) {
      ship.step(1 / 60, emptyControls(), e);
      const d = ship.pos.length();
      minR = Math.min(minR, d);
      maxR = Math.max(maxR, d);
    }
    expect((maxR - minR) / r).toBeLessThan(0.01);
  });

  it("landing mode turns the belly toward the ground but leaves the heading", () => {
    const e = env({ atmo: 900 });
    const ship = new ShipSim();
    ship.pos.set(0, R + 200, 0);
    // Tilt the ship 50 degrees about its forward axis and pitch it 30 degrees.
    ship.att.copyFrom(
      Quaternion.RotationAxis(new Vector3(0, 0, 1), 0.87).multiply(
        Quaternion.RotationAxis(new Vector3(1, 0, 0), 0.5),
      ),
    );
    ship.landingMode = true;
    const c = emptyControls();
    c.matchVelocity = true;
    run(ship, 3, e, c);
    expect(Vector3.Dot(ship.axis(Vector3.Up()), up)).toBeGreaterThan(0.995);
  });

  it("assisted rotation stops when the stick is released", () => {
    const e = env();
    const ship = new ShipSim();
    ship.pos.set(0, R + 3000, 0);
    const c = emptyControls();
    c.rotate.x = 1; // pitch up
    run(ship, 0.5, e, c);
    const noseUp = Vector3.Dot(ship.axis(Vector3.Forward()), up);
    expect(noseUp).toBeGreaterThan(0.3);
    c.rotate.x = 0;
    run(ship, 1, e, c);
    expect(ship.angVel.length()).toBeLessThan(0.02);
  });

  it("match velocity brakes to rest", () => {
    const e = env();
    const ship = new ShipSim();
    ship.pos.set(0, R + 3000, 0);
    ship.vel.set(40, 0, -20);
    const c = emptyControls();
    c.matchVelocity = true;
    run(ship, 6, e, c);
    expect(ship.vel.length()).toBeLessThan(1);
  });

  it("forward thrust + boost accelerate along the nose", () => {
    const e = env();
    const ship = new ShipSim();
    ship.pos.set(0, R + 3000, 0);
    const c = emptyControls();
    c.thrust.z = 1;
    run(ship, 1, e, c);
    const v1 = Vector3.Dot(ship.vel, ship.axis(Vector3.Forward()));
    c.boost = true;
    run(ship, 1, e, c);
    const v2 = Vector3.Dot(ship.vel, ship.axis(Vector3.Forward()));
    expect(v1).toBeGreaterThan(18);
    expect(v2 - v1).toBeGreaterThan(45);
  });

  it("hard impacts damage the hull and report an event", () => {
    const e = env({ atmo: 900 });
    const ship = new ShipSim();
    ship.assist = false;
    ship.placeOnSurface(up, north, e);
    ship.pos.y += 3;
    ship.vel.set(0, -30, 0);
    ship.landed = false;
    let impacts = 0;
    run(ship, 2, e, emptyControls(), { impact: () => impacts++ });
    expect(impacts).toBeGreaterThan(0);
    expect(ship.hull).toBeLessThan(1);
    expect(ship.pos.length()).toBeGreaterThan(R); // never tunnels through the ground
  });

  it("floats on water", () => {
    const e = env({ sea: 10, atmo: 900 });
    const ship = new ShipSim();
    ship.assist = false;
    ship.pos.set(0, R + 16, 0);
    run(ship, 15, e);
    expect(ship.floating).toBe(true);
    // Centre of mass sits near the waterline with the gear submerged.
    const aboveSea = ship.pos.y - (R + 10);
    expect(aboveSea).toBeGreaterThan(-1.2);
    expect(aboveSea).toBeLessThan(1.2);
    expect(Math.abs(ship.verticalSpeed)).toBeLessThan(0.5);
  });
});
