import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "@babylonjs/core";
import { BodySpec, CelestialSystem } from "./celestial";

const specs: BodySpec[] = [
  { id: "star", name: "Star", radius: 8000, mu: 5e9, spin: { period: 0 } },
  {
    id: "planet",
    name: "Planet",
    radius: 2000,
    mu: 3.924e7,
    orbit: { parent: "star", radius: 300000, phase: 0.3, inclination: 0.05 },
    spin: { period: 1200, tilt: 0.2, tiltAzimuth: 0.7 },
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

describe("CelestialSystem", () => {
  const sys = new CelestialSystem(specs);
  const planet = sys.get("planet");
  const moon = sys.get("moon");

  it("derives Kepler periods and Laplace SOIs", () => {
    const expected = 2 * Math.PI * Math.sqrt(12000 ** 3 / 3.924e7);
    expect(moon.orbitPeriod).toBeCloseTo(expected, 6);
    expect(planet.soi).toBeGreaterThan(30000);
    expect(moon.soi).toBeGreaterThan(moon.radius * 2);
    expect(moon.soi).toBeLessThan(12000);
    expect(planet.surfaceGravity).toBeCloseTo(9.81, 2);
  });

  it("keeps orbits circular and velocity consistent with position", () => {
    const p = new Vector3();
    const pp = new Vector3();
    const v = new Vector3();
    for (const t of [0, 123.4, 5000]) {
      moon.positionAt(t, p);
      planet.positionAt(t, pp);
      expect(Vector3.Distance(p, pp)).toBeCloseTo(12000, 6);
      // Finite-difference velocity matches the analytic one.
      const h = 1e-3;
      const a = moon.positionAt(t - h);
      const b = moon.positionAt(t + h);
      const fd = b.subtract(a).scale(1 / (2 * h));
      moon.velocityAt(t, v);
      expect(Vector3.Distance(fd, v)).toBeLessThan(1e-3);
    }
  });

  it("orbits prograde: orbital angular momentum along the spin sense", () => {
    const r = moon.positionAt(10).subtract(planet.positionAt(10));
    const v = moon.velocityAt(10).subtract(planet.velocityAt(10));
    const h = Vector3.Cross(r, v).normalize();
    const w = moon.angularVelocityInertial().normalize();
    expect(Vector3.Dot(h, w)).toBeCloseTo(1, 6);
  });

  it("angular velocity matches the rotation's time derivative", () => {
    for (const body of [planet, moon]) {
      const t = 77;
      const h = 1e-3;
      const q0 = body.rotationAt(t - h);
      const q1 = body.rotationAt(t + h);
      // Rotate a local point and compare its velocity to w x r.
      const local = new Vector3(0.3, 0.5, 0.8);
      const r0 = local.applyRotationQuaternion(q0);
      const r1 = local.applyRotationQuaternion(q1);
      const fd = r1.subtract(r0).scale(1 / (2 * h));
      const rNow = local.applyRotationQuaternion(body.rotationAt(t));
      const pred = Vector3.Cross(body.angularVelocityInertial(), rNow);
      expect(Vector3.Distance(fd, pred)).toBeLessThan(1e-6);
    }
  });

  it("tidally locked moon keeps local +X toward its parent", () => {
    for (const t of [0, 400, 900]) {
      const toParent = planet.positionAt(t).subtract(moon.positionAt(t)).normalize();
      const x = new Vector3(1, 0, 0).applyRotationQuaternion(moon.rotationAt(t));
      expect(Vector3.Dot(x, toParent)).toBeCloseTo(1, 6);
    }
  });

  it("rotations are unit quaternions and spin axis is local +Y", () => {
    const q = planet.rotationAt(321, new Quaternion());
    expect(q.length()).toBeCloseTo(1, 9);
    const axis = new Vector3(0, 1, 0).applyRotationQuaternion(q);
    expect(Vector3.Dot(axis, planet.angularVelocityInertial().normalize())).toBeCloseTo(1, 9);
  });

  it("finds the dominant body by SOI with hysteresis", () => {
    const t = 50;
    const nearMoon = moon.positionAt(t).add(new Vector3(0, moon.radius + 100, 0));
    expect(sys.dominantBody(t, nearMoon).id).toBe("moon");
    const nearPlanet = planet.positionAt(t).add(new Vector3(0, 3000, 0));
    expect(sys.dominantBody(t, nearPlanet).id).toBe("planet");
    const deepSpace = new Vector3(0, 150000, 0);
    expect(sys.dominantBody(t, deepSpace).id).toBe("star");
    // Just outside the moon SOI: still the moon if we were already there.
    const dir = new Vector3(0, 1, 0);
    const edge = moon.positionAt(t).add(dir.scale(moon.soi * 1.01));
    expect(sys.dominantBody(t, edge).id).toBe("planet");
    expect(sys.dominantBody(t, edge, moon).id).toBe("moon");
  });
});
