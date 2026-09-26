import { DefaultRenderingPipeline } from "@babylonjs/core";
import { Body } from "../world/planets";
import { CLOUD_TIERS, CloudTier } from "../world/skyExtras";

/**
 * Quality policy (OCP: new quality tiers / per-body rules plug in here
 * instead of editing main.ts). H cycles Ultra -> High -> Balanced -> Lite,
 * defaulting to Ultra (best). Cloud tiers drive the volumetric deck's
 * raymarch step counts; Lite disables the deck. The ocean's cheap path
 * (no foam/shore detail, chop, or refraction) applies below High.
 */
export interface IQualityPolicy {
  readonly tier: CloudTier;
  readonly high: boolean;
  /** Cycle to the next tier (wraps); returns the new tier. */
  toggle(): CloudTier;
  setTier(tier: CloudTier): void;
  apply(): void;
}

export function createQualityPolicy(pipeline: DefaultRenderingPipeline, bodies: Body[]): IQualityPolicy {
  let index = 0; // CLOUD_TIERS[0] = ultra (best) is the default.
  const current = (): CloudTier => CLOUD_TIERS[index];
  const applyTier = (tier: CloudTier): void => {
    const best = tier === "ultra" || tier === "high";
    const high = tier === "ultra";
    pipeline.bloomEnabled = best;
    pipeline.grainEnabled = best;
    pipeline.samples = high ? 4 : 1;
    for (const b of bodies) {
      b.surface?.cloudDeck?.setTier(tier);
      b.surface?.ocean?.setQuality(best);
    }
  };
  return {
    get tier() {
      return current();
    },
    get high() {
      return current() === "ultra";
    },
    toggle(): CloudTier {
      index = (index + 1) % CLOUD_TIERS.length;
      return current();
    },
    setTier(tier: CloudTier): void {
      const at = CLOUD_TIERS.indexOf(tier);
      if (at >= 0) index = at;
    },
    apply(): void {
      applyTier(current());
    },
  };
}
