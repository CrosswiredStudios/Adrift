import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "@babylonjs/core";
import { BodySpec, CelestialSystem } from "./celestial";
import {
  bodyFrameAcceleration,
  pointToBody,
  pointToInertial,
  snapshotFrame,
  transferState,
  velocityToBody,
  velocityToInertial,
} from "./frames";

const specs: BodySpec[] = [
  { id: "star", name: "Star", radius: 8000, mu: 5e9, spin: { period: 0 } },
  {
    id: "planet",
    name: "Planet",
    radius: 2000,
    mu: 3.924e7,
    orbit: { parent: "star", radius: 300000, phase: 0.3 },
    spin: { period: 1200, tilt: 0.2 },
  },
  {
    id: "moon",
    name: "Moon",
    radius: 600,
    mu: 5.832e5,
    orbit: { parent: "planet", radius: 12000, phase: 1.1 },
    spin: { period: 0, tidallyLocked: true },
  },
];

describe("frames", () => {
  const sys = new CelestialSystem(specs);
  const planet = sys.get("planet");
  const moon = sys.get("moon");

  it("round-trips points and velocities", () => {
    const f = snapshotFrame(planet, 432.1);
    const rB = new Vector3(100, 2100, -50);
    const vB = new Vector3(3, -1, 7);
    const rI = pointToInertial(f, rB);
    const vI = velocityToInertial(f, rB, vB);
    const rB2 = pointToBody(f, rI);
    const vB2 = velocityToBody(f, rI, vI);
    expect(Vector3.Distance(rB, rB2)).toBeLessThan(1e-6);
    expect(Vector3.Distance(vB, vB2)).toBeLessThan(1e-9);
  });

  it("a point fixed on the surface moves with the body in inertial space", () => {
    const rB = new Vector3(0, 0, 2000); // equator
    const t = 100;
    const h = 1e-3;
    const a = pointToInertial(snapshotFrame(planet, t - h), rB);
    const b = pointToInertial(snapshotFrame(planet, t + h), rB);
    const fd = b.subtract(a).scale(1 / (2 * h));
    const vI = velocityToInertial(snapshotFrame(planet, t), rB, Vector3.Zero());
    expect(Vector3.Distance(fd, vI)).toBeLessThan(1e-4);
    // Equatorial surface speed = w R (tilt doesn't change it).
    const surface = vI.subtract(planet.velocityAt(t));
    expect(surface.length()).toBeCloseTo((2 * Math.PI * 2000) / 1200, 6);
  });

  it("free motion integrated in the rotating frame matches inertial straight-line motion", () => {
    // mu = 0: in inertial space the object moves in a straight line
    // relative to the body centre. Simulate it in the rotating frame
    // with the Coriolis + centrifugal terms only.
    const w = planet.spinRate;
    const rB = new Vector3(0, 0, 2500);
    const vB = new Vector3(20, 5, 0);
    const f0 = snapshotFrame(planet, 0);
    const r0I = pointToInertial(f0, rB).subtract(f0.position);
    const v0I = velocityToInertial(f0, rB, vB).subtract(f0.velocity);
    const dt = 1 / 240;
    const a = new Vector3();
    const T = 30;
    for (let i = 0; i < T / dt; i++) {
      bodyFrameAcceleration(0, w, rB, vB, a);
      vB.addInPlace(a.scale(dt));
      rB.addInPlace(vB.scale(dt));
    }
    const f1 = snapshotFrame(planet, T);
    const r1I = pointToInertial(f1, rB).subtract(f1.position);
    const expected = r0I.add(v0I.scale(T));
    expect(Vector3.Distance(r1I, expected)).toBeLessThan(0.5);
  });

  it("a circular orbit stays circular when integrated in the rotating frame", () => {
    const r = 2600;
    const f0 = snapshotFrame(planet, 0);
    // Build the orbit in inertial space around the planet, then express it
    // in the body frame (the rotating frame sees a different velocity).
    const rI = f0.position.add(new Vector3(r, 0, 0));
    const vI = f0.velocity.add(new Vector3(0, 0, planet.circularSpeed(r)));
    const rB = pointToBody(f0, rI);
    const vB = velocityToBody(f0, rI, vI);
    const dt = 1 / 60;
    const a = new Vector3();
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / planet.mu);
    let minR = Infinity;
    let maxR = 0;
    for (let i = 0; i < period / dt; i++) {
      bodyFrameAcceleration(planet.mu, planet.spinRate, rB, vB, a);
      vB.addInPlace(a.scale(dt));
      rB.addInPlace(vB.scale(dt));
      const d = rB.length();
      minR = Math.min(minR, d);
      maxR = Math.max(maxR, d);
    }
    expect(maxR - minR).toBeLessThan(r * 0.005); // < 0.5% eccentricity drift over one orbit
  });

  it("transfers state between body frames exactly", () => {
    const t = 250;
    const fp = snapshotFrame(planet, t);
    const fm = snapshotFrame(moon, t);
    const pos = new Vector3(300, 700, -100);
    const vel = new Vector3(10, 2, -3);
    const att = Quaternion.RotationYawPitchRoll(0.3, 0.2, 0.1);
    const rI0 = pointToInertial(fm, pos);
    const vI0 = velocityToInertial(fm, pos, vel);
    transferState(fm, fp, pos, vel, att);
    const rI1 = pointToInertial(fp, pos);
    const vI1 = velocityToInertial(fp, pos, vel);
    expect(Vector3.Distance(rI0, rI1)).toBeLessThan(1e-6);
    expect(Vector3.Distance(vI0, vI1)).toBeLessThan(1e-9);
  });
});
