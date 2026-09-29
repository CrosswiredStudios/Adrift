/**
 * Scene lighting rig. The directional sun is the light source; the
 * hemispheric fill stands in for starlight (dark night sides) and is
 * retinted to the sky's scattered colour inside an atmosphere each frame.
 * Includes the terminator softening: light lingers past the line and a warm
 * twilight ambient replaces the old hard day/night step.
 */
import { Color3, DirectionalLight, HemisphericLight, Scene, Vector3 } from "@babylonjs/core";
import { smoothstep } from "../common/math";
import type { IWorldBody } from "../world/worldBody";

export const STARLIGHT = new Color3(0.3, 0.38, 0.52);

export interface LightingRig {
  hemi: HemisphericLight;
  sun: DirectionalLight;
  /** Sun travel direction (kept for planet/surface updates). */
  sunDir: Vector3;
  update(host: IWorldBody, atmo: number, daylight: number, twilight: number, altitude: number): void;
}

export function createLighting(scene: Scene, sunDir: Vector3): LightingRig {
  const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.14;
  hemi.diffuse = STARLIGHT.clone();
  hemi.groundColor = new Color3(0.02, 0.025, 0.035);
  const sun = new DirectionalLight("sun", sunDir, scene);
  sun.intensity = 3.0;
  sun.diffuse = new Color3(1.0, 0.96, 0.9);

  return {
    hemi,
    sun,
    sunDir,
    update(host: IWorldBody, atmo: number, daylight: number, twilight: number, altitude: number): void {
      // Sun: dim + warm when deep in atmosphere (sunset effect), full white in space.
      // Near the terminator the direct light eases off and its energy moves into the
      // ambient term instead, which softens the day/night line without dimming noon.
      sun.intensity = (3.0 - atmo * 1.2) * (1 - 0.3 * twilight);
      const warmth = atmo * Math.max(0, 0.5 - altitude / 90);
      sun.diffuse = new Color3(1.0, 0.96 - warmth * 0.25, 0.9 - warmth * 0.35);
      // Ambient fill: starlight in space, sky colour in daylight, warm haze at twilight.
      const twilightTint = new Color3(1.0, 0.68, 0.46);
      const skyAmbient = Color3.Lerp(host.skyTint ?? STARLIGHT, twilightTint, Math.min(1, twilight * 1.2));
      hemi.diffuse = Color3.Lerp(
        STARLIGHT,
        skyAmbient,
        Math.min(1, atmo * Math.max(daylight, twilight * 0.8)),
      );
      hemi.intensity = 0.14 + atmo * daylight * 0.3 + twilight * 0.55;
    },
  };
}

/** Twilight warmth 0..1 peaking at the terminator, scaled by atmosphere. */
export function twilightFactor(sunAbove: number, atmo: number): number {
  return smoothstep(0.4, 0.0, Math.abs(sunAbove)) * atmo;
}

/** Daylight ramp shared by the sky, lighting, and atmosphere updates. */
export function daylightFactor(sunAbove: number): number {
  return smoothstep(-0.06, 0.3, sunAbove);
}
