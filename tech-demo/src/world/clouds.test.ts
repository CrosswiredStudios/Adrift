import { Scene, Vector3 } from "@babylonjs/core";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { describe, expect, it } from "vitest";
import { buildClouds, cloudDensityAtPoint, CLOUD_TIERS, CloudTier } from "./skyExtras";

/** NullEngine scene for cloud unit tests (no GPU needed for CPU sampler). */
function makeScene(): Scene {
  const engine = new NullEngine();
  return new Scene(engine);
}

describe("cloud density field", () => {
  it("returns zero outside the slab and rises inside", () => {
    const scene = makeScene();
    const clouds = buildClouds(scene, "test", {
      radius: 600,
      relief: 0.045,
      segments: 96,
      coverage: 0.5,
      seed: 1337,
    });
    const center = new Vector3(0, 0, 0);
    const dir = new Vector3(0, 1, 0);
    const { innerR, outerR } = clouds.bounds;
    // Below the slab: no density.
    expect(cloudDensityAtPoint(clouds.field, center, dir.clone().scale(600), 0)).toBe(0);
    // Above the slab: no density.
    expect(cloudDensityAtPoint(clouds.field, center, dir.clone().scale(outerR + 50), 0)).toBe(0);
    // Mid-slab density is bounded and varies with coverage.
    const mid = dir.clone().scale((innerR + outerR) / 2);
    const d = cloudDensityAtPoint(clouds.field, center, mid, 0);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1);
    const thin = buildClouds(scene, "thin", {
      radius: 600,
      relief: 0.045,
      segments: 96,
      coverage: 0.05,
      seed: 1337,
    });
    const dThin = cloudDensityAtPoint(thin.field, center, mid, 0);
    expect(dThin).toBeLessThanOrEqual(d);
  });

  it("exposes tier step counts defaulting to best", () => {
    expect(CLOUD_TIERS satisfies CloudTier[]).toHaveLength(4);
    expect(CLOUD_TIERS[0]).toBe("ultra");
    const scene = makeScene();
    const clouds = buildClouds(scene, "tier", {
      radius: 600,
      relief: 0.045,
      segments: 96,
      coverage: 0.5,
      seed: 7,
    });
    expect(clouds.tier).toBe("ultra");
    clouds.setTier("balanced");
    expect(clouds.tier).toBe("balanced");
    // The legacy shell mesh stays hidden (the deck is a post-process now);
    // tiers only switch the volume's step counts / enabled state.
    expect(clouds.mesh.isEnabled()).toBe(false);
    clouds.setTier("lite");
    expect(clouds.tier).toBe("lite");
    clouds.setTier("ultra");
    expect(clouds.tier).toBe("ultra");
  });
});
