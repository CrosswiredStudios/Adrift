import { Color3, Vector3 } from "@babylonjs/core";

/**
 * World-body abstraction for the flight model (DIP: flight.ts depends on
 * this interface, not on the concrete `Body` in planets.ts). Any object
 * satisfying these members — a planet, a star, a test double — can be
 * flown around. `planets.ts` `Body` satisfies it structurally (no import
 * needed there, keeping the dependency one-directional).
 */
export interface IWorldBody {
  name: string;
  radius: number;
  mu: number;
  center: Vector3;
  /** Scattered sky colour for ambient lighting (undefined = starlight only). */
  skyTint?: Color3;
  /** 0..1 atmospheric density at a world point. */
  atmosphereAt(point: Vector3): number;
  /** Height above the visible surface (terrain / sea) at a world point. */
  surfaceAltitudeAt(point: Vector3): number;
  /** Radius from the body center of the visible surface along a unit direction. */
  surfaceRadiusAt(dir: Vector3): number;
  /** True where the terrain along a unit direction is below sea level. */
  isOverWaterAt(dir: Vector3): boolean;
  /** Sea surface radius including waves, from the body center. */
  waterSurfaceRadiusAt(dir: Vector3): number;
}

/** Nearest body measured by height above its visible surface. */
export function nearestWorldBody<T extends IWorldBody>(bodies: T[], position: Vector3): T | null {
  let nearest: T | null = null;
  let nearestAlt = Infinity;
  for (const b of bodies) {
    const alt = b.surfaceAltitudeAt(position);
    if (alt < nearestAlt) {
      nearestAlt = alt;
      nearest = b;
    }
  }
  return nearest;
}
