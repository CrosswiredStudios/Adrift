import { describe, expect, it } from "vitest";
import { CelestialSystem } from "../sim/celestial";
import { VAEL_YEAR, VESPER_DRIFT } from "./system";

describe("Vesper Drift system", () => {
  const sys = new CelestialSystem(VESPER_DRIFT);
  const vael = sys.get("vael");
  const tethys = sys.get("tethys");
  const cinder = sys.get("cinder");

  it("has short, Keplerian years", () => {
    expect(vael.orbitPeriod).toBeCloseTo(VAEL_YEAR, 6);
    expect(cinder.orbitPeriod).toBeGreaterThan(vael.orbitPeriod);
    expect(cinder.orbitPeriod).toBeLessThan(2 * 3600);
    // Circular orbit speed around the star equals the rail speed.
    const v = vael.velocityAt(0).subtract(sys.root.velocityAt(0)).length();
    expect(v).toBeCloseTo(sys.root.circularSpeed(300000), 6);
  });

  it("keeps Tethys (and its whole SOI) inside Vael's SOI", () => {
    expect(12000 + tethys.soi).toBeLessThan(vael.soi * 0.8);
    expect(vael.soi).toBeLessThan(300000 - 8000);
  });

  it("keeps the solar days at 20 min (Vael) and 30 min (Cinder)", () => {
    const solar = (b: typeof vael) => (2 * Math.PI) / (b.spinRate - (2 * Math.PI) / b.orbitPeriod);
    expect(solar(vael)).toBeCloseTo(1200, 3);
    expect(solar(cinder)).toBeCloseTo(1800, 3);
  });
});
