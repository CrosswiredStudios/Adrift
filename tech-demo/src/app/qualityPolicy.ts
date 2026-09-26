import { DefaultRenderingPipeline } from "@babylonjs/core";
import { Body } from "../world/planets";

/**
 * Quality policy (OCP: new quality tiers / per-body rules plug in here
 * instead of editing main.ts). The default policy toggles bloom + grain +
 * MSAA on the pipeline, enables clouds only at high quality, and drops the
 * ocean to its cheap path (no foam/shore detail, chop, or refraction).
 */
export interface IQualityPolicy {
  readonly high: boolean;
  toggle(): boolean;
  apply(): void;
}

export function createQualityPolicy(pipeline: DefaultRenderingPipeline, bodies: Body[]): IQualityPolicy {
  let high = true;
  return {
    get high() {
      return high;
    },
    toggle(): boolean {
      high = !high;
      return high;
    },
    apply(): void {
      pipeline.bloomEnabled = high;
      pipeline.grainEnabled = high;
      pipeline.samples = high ? 4 : 1;
      for (const b of bodies) {
        if (b.surface?.clouds) b.surface.clouds.setEnabled(high);
        b.surface?.ocean?.setQuality(high);
      }
    },
  };
}
