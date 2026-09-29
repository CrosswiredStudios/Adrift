import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { CharacterSim, emptyCharacterControls } from "./character";
import type { ShipEnvironment, StaticCollider } from "./shipSim";

const R = 2000;

function world(
  g = 9.81,
  opts: { sea?: number; bump?: boolean; colliders?: StaticCollider[] } = {},
): ShipEnvironment {
  // Optional 3 m hill around +Z (smooth bump) for slope tests.
  const surf = (_x: number, _y: number, z: number): number => {
    if (!opts.bump) return R;
    const ang = Math.acos(Math.max(-1, Math.min(1, z)));
    const k = (ang * R) / 6;
    return R + 3 * Math.exp(-k * k);
  };
  return {
    mu: g * R * R,
    spinRate: 0,
    radius: R,
    surfaceRadius: surf,
    surfaceNormal: (x, y, z) => {
      const e = 0.2 / R;
      const t1 = Math.abs(y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
      const d = new Vector3(x, y, z);
      const a = Vector3.Cross(d, t1).normalize();
      const b = Vector3.Cross(d, a).normalize();
      const p = (v: Vector3) => v.normalize().scale(surf(v.x, v.y, v.z));
      const pa = p(d.add(a.scale(e)));
      const pb = p(d.subtract(a.scale(e)));
      const pc = p(d.add(b.scale(e)));
      const pd = p(d.subtract(b.scale(e)));
      const n = Vector3.Cross(pa.subtract(pb), pc.subtract(pd)).normalize();
      if (Vector3.Dot(n, d) < 0) n.scaleInPlace(-1);
      return [n.x, n.y, n.z];
    },
    waterRadius: () => (opts.sea !== undefined ? R + opts.sea : null),
    airDensity: () => 1,
    atmosphereTop: 900,
    colliders: opts.colliders,
  };
}

function run(ch: CharacterSim, seconds: number, e: ShipEnvironment, c = emptyCharacterControls()): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) ch.step(1 / 60, c, e);
}

describe("CharacterSim", () => {
  it("stands still on the ground", () => {
    const e = world();
    const ch = new CharacterSim();
    ch.placeOnSurface(new Vector3(0, 1, 0), new Vector3(0, 0, 1), e);
    const p0 = ch.pos.clone();
    run(ch, 5, e);
    expect(Vector3.Distance(p0, ch.pos)).toBeLessThan(0.01);
    expect(ch.grounded).toBe(true);
  });

  it("walks along the curve of the planet at walking speed", () => {
    const e = world();
    const ch = new CharacterSim();
    ch.placeOnSurface(new Vector3(0, 1, 0), new Vector3(0, 0, 1), e);
    const c = emptyCharacterControls();
    c.moveZ = 1;
    run(ch, 10, e, c);
    const arc = Math.acos(ch.up().y) * R;
    expect(arc).toBeGreaterThan(38);
    expect(arc).toBeLessThan(43);
    expect(Math.abs(ch.pos.length() - R)).toBeLessThan(0.05); // stays on the surface
    expect(ch.grounded).toBe(true);
  });

  it("jumps higher on a low-gravity moon", () => {
    const peak = (g: number): number => {
      const e = world(g);
      const ch = new CharacterSim();
      ch.placeOnSurface(new Vector3(0, 1, 0), new Vector3(0, 0, 1), e);
      const c = emptyCharacterControls();
      c.jump = true;
      ch.step(1 / 60, c, e);
      c.jump = false;
      let top = 0;
      for (let i = 0; i < 600; i++) {
        ch.step(1 / 60, c, e);
        top = Math.max(top, ch.altitude);
      }
      return top;
    };
    const vael = peak(9.81);
    const moon = peak(1.62);
    expect(vael).toBeGreaterThan(0.8);
    expect(vael).toBeLessThan(1.4);
    expect(moon).toBeGreaterThan(vael * 4);
  });

  it("turns with look input and clamps pitch", () => {
    const e = world();
    const ch = new CharacterSim();
    ch.placeOnSurface(new Vector3(0, 1, 0), new Vector3(0, 0, 1), e);
    const c = emptyCharacterControls();
    c.lookX = Math.PI / 2 / 30;
    c.lookY = 1;
    run(ch, 0.5, e, c);
    // After a quarter turn to the right the heading is +X.
    expect(ch.heading.x).toBeGreaterThan(0.99);
    expect(ch.pitch).toBeLessThanOrEqual(1.45);
  });

  it("is blocked by a box and can stand on it", () => {
    const up = new Vector3(0, 1, 0);
    const box: StaticCollider = {
      center: new Vector3(0, R + 0.5, 3),
      axes: [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
      halfExtents: new Vector3(2, 0.5, 1),
    };
    const e = world(9.81, { colliders: [box] });
    const ch = new CharacterSim();
    ch.placeOnSurface(up, new Vector3(0, 0, 1), e);
    const c = emptyCharacterControls();
    c.moveZ = 1;
    run(ch, 3, e, c);
    // A 1 m ledge is higher than the step height: we stop in front of it.
    expect(ch.pos.z).toBeLessThan(2 - 0.3 + 0.05);
    // Drop onto the top instead: we stand on it.
    ch.pos.set(0, R + 1.5, 3);
    ch.vel.setAll(0);
    run(ch, 1, e);
    expect(ch.grounded).toBe(true);
    expect(ch.pos.y).toBeGreaterThan(R + 0.95);
  });

  it("floats when swimming in deep water", () => {
    const e = world(9.81, { sea: 5 });
    const ch = new CharacterSim();
    ch.pos.set(0, R + 4, 0);
    run(ch, 8, e);
    expect(ch.swimming).toBe(true);
    const chest = ch.pos.y + 1.3;
    expect(Math.abs(chest - (R + 5))).toBeLessThan(0.6);
  });

  it("walks over a gentle hill without leaving the ground", () => {
    const e = world(9.81, { bump: true });
    const ch = new CharacterSim();
    const start = new Vector3(0, Math.sin(-0.01), Math.cos(-0.01)); // 20 m before the hill top
    ch.placeOnSurface(start, new Vector3(0, 1, 0), e);
    const c = emptyCharacterControls();
    c.moveZ = 1;
    let airborne = 0;
    for (let i = 0; i < 600; i++) {
      ch.step(1 / 60, c, e);
      if (!ch.grounded) airborne++;
    }
    expect(airborne).toBeLessThan(20);
  });
});
