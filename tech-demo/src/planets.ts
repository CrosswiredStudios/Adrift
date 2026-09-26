import { Mesh, Scene, Color3, Vector3 } from "@babylonjs/core";
import {
  buildPlanetSurface, SurfaceResult, terrainHeightNormalized, ShoresOptions, defaultShores, OceanLook,
} from "./planetSurface";
import { WaveSettings } from "./oceanWaves";
import { SkyPalette } from "./shaderChunks";
import { createAtmosphere, AtmosphereResult } from "./atmosphere";

export interface Body {
  name: string;
  mesh: Mesh;
  radius: number;
  atmosphereHeight: number;
  atmosphereColor: Color3;
  skyColor: Color3;
  mu: number;
  /** Terrain parameters, kept so flight collision can sample the visible surface. */
  seed: number;
  relief: number;
  waterLevel: number;
  /** Coastal shaping (beaches/shelves/basins) shared by the mesh, ocean and collision. */
  shore: ShoresOptions;
  surface?: SurfaceResult;
  atmosphere?: AtmosphereResult;
  /** World position of the body center (mesh may be offset for terrain). */
  center: Vector3;
}

export function bodyAltitude(body: Body, point: Vector3): number {
  return point.subtract(body.center).length() - body.radius;
}

/** Normalized shaped terrain height along a unit direction. */
export function terrainHeightAt(body: Body, dir: Vector3): number {
  return terrainHeightNormalized(dir.x, dir.y, dir.z, body.seed, body.waterLevel, body.shore);
}

/**
 * Radius from the body center of the visible surface along a unit direction:
 * displaced terrain, or sea level where the terrain is under water. Matches
 * the ground/water meshes (water sits at radius * (1 + waterLevel * relief)).
 */
export function surfaceRadius(body: Body, dir: Vector3): number {
  return body.radius * (1 + Math.max(terrainHeightAt(body, dir), body.waterLevel) * body.relief);
}

/** True where the terrain is below sea level (the ocean surface is visible). */
export function isOverWater(body: Body, dir: Vector3): boolean {
  return terrainHeightAt(body, dir) < body.waterLevel;
}

/**
 * Sea surface radius including wind waves + run-up (CPU mirror of the ocean
 * shader's field), from the body center. Used by the flight model when floating
 * so the ship rides the waves the player sees.
 */
export function waterSurfaceRadius(body: Body, dir: Vector3): number {
  const ocean = body.surface?.ocean;
  if (!ocean) return body.radius * (1 + body.waterLevel * body.relief);
  return ocean.waterRadiusAt(dir);
}

/**
 * Height above the visible surface (terrain / sea), unlike `bodyAltitude`
 * which is relative to the mean radius. Used by flight + HUD.
 */
export function surfaceAltitude(body: Body, point: Vector3): number {
  const toPoint = point.subtract(body.center);
  const dist = toPoint.length();
  if (dist < 1e-6) return -body.radius;
  return dist - surfaceRadius(body, toPoint.scale(1 / dist));
}

export function atmosphereFactor(body: Body, point: Vector3): number {
  const alt = bodyAltitude(body, point);
  if (alt <= 0) return 1;
  if (alt >= body.atmosphereHeight) return 0;
  return 1 - alt / body.atmosphereHeight;
}

export interface PlanetOptions {
  name: string;
  position: Vector3;
  radius: number;
  color: Color3;
  atmosphereHeight: number;
  atmosphereColor: Color3;
  skyColor: Color3;
  mu: number;
  seed?: number;
  /** Set false for airless bodies (no atmo shells, no clouds/night lights). */
  atmosphere?: boolean;
  /**
   * Atmosphere palette overrides. `skyTint` is the colour the air scatters - blue
   * for N-O2 (default: `atmosphereColor`), orange/red for a dusty CO2 sky, e.g.
   * `new Color3(1.0, 0.5, 0.3)` with a warm `hazeTint` and `hazeStrength` ~0.6.
   */
  skyTint?: Color3;
  /** Scatter strength: higher = deeper sky colour (default 1.35, 1.6 for warm haze). */
  skyStrength?: number;
  /** Aerosol tint that whitens the sky near the sun/horizon (default warm white). */
  hazeTint?: Color3;
  /** Aerosol strength (default 0.28, 0.6 for warm haze). */
  hazeStrength?: number;
  /** Colour of the star's light through this air (default warm white). */
  sunTint?: Color3;
  relief?: number;
  waterLevel?: number;
  waterColor?: Color3;
  cloudCoverage?: number;
  /** Coastal shaping overrides (beaches, shelves, basins). */
  shore?: Partial<ShoresOptions>;
  /** Ocean look overrides (colours, transparency, depth ramp). */
  ocean?: Partial<OceanLook>;
  /** Wave settings (sea state / wind axis / height scale). */
  waves?: WaveSettings;
}

export function makePlanet(scene: Scene, opts: PlanetOptions): Body {
  const seed = opts.seed ?? 1337;
  const relief = opts.relief ?? 0.022;
  const waterLevel = opts.waterLevel ?? -0.05;
  const hasAtmo = opts.atmosphere ?? opts.atmosphereHeight > 1;
  const shore: ShoresOptions = { ...defaultShores, ...(opts.shore ?? {}) };

  // Sky palette for water reflections, mirroring the atmosphere below.
  const warmHaze = opts.atmosphereColor.r > 0.5 && opts.atmosphereColor.g < 0.6;
  const sunTint = opts.sunTint ?? new Color3(1.0, 0.97, 0.92);
  const skyPalette: SkyPalette = hasAtmo ? {
    skyTint: opts.skyTint ?? opts.atmosphereColor,
    skyStrength: opts.skyStrength ?? (warmHaze ? 1.4 : 1.0),
    hazeTint: opts.hazeTint ?? (warmHaze ? new Color3(1.0, 0.6, 0.32) : new Color3(1.0, 0.97, 0.92)),
    hazeStrength: opts.hazeStrength ?? (warmHaze ? 0.55 : 0.32),
    hazeG: 0.85,
    sunTint,
    sunGlow: 0.35,
  } : {
    skyTint: new Color3(0, 0, 0), skyStrength: 0,
    hazeTint: new Color3(0, 0, 0), hazeStrength: 0, hazeG: 0.85,
    sunTint, sunGlow: 0.6,
  };

  const surface = buildPlanetSurface(scene, opts.name, {
    radius: opts.radius,
    seed,
    relief,
    position: opts.position,
    segments: opts.radius > 300 ? 160 : 96,
    groundAlbedo: opts.color,
    waterLevel,
    waterColor: opts.waterColor ?? new Color3(0.05, 0.2, 0.35),
    iceCaps: true,
    nightLights: hasAtmo,
    clouds: hasAtmo,
    cloudCoverage: opts.cloudCoverage ?? 0.45,
    shore,
    ocean: opts.ocean,
    waves: opts.waves,
    sky: skyPalette,
  });
  // The ocean meshes stay at the origin (the shader places them with
  // uPlanetCenter), so only the clouds / night shell are moved here.
  if (surface.clouds) surface.clouds.position.copyFrom(opts.position);
  const nightShell = scene.getMeshByName(`${opts.name}-night-shell`);
  if (nightShell) nightShell.position.copyFrom(opts.position);

  let atmosphere: AtmosphereResult | undefined;
  if (hasAtmo) {
    atmosphere = createAtmosphere(scene, opts.name, {
      radius: opts.radius,
      height: opts.atmosphereHeight,
      skyTint: skyPalette.skyTint,
      skyStrength: skyPalette.skyStrength,
      hazeTint: skyPalette.hazeTint,
      hazeStrength: skyPalette.hazeStrength,
      hazeAnisotropy: 0.85,
      sunTint,
      sunIntensity: 0.7,
    });
    atmosphere.outer.position.copyFrom(opts.position);
    atmosphere.inner.position.copyFrom(opts.position);
    const cloudMat = surface.clouds?.material as unknown as { setVector3?: (n: string, v: Vector3) => void } | null;
    cloudMat?.setVector3?.("planetCenter", opts.position);
  }

  return {
    name: opts.name,
    mesh: surface.ground,
    radius: opts.radius,
    atmosphereHeight: opts.atmosphereHeight,
    atmosphereColor: opts.atmosphereColor,
    skyColor: opts.skyColor,
    mu: opts.mu,
    seed,
    relief,
    waterLevel,
    shore,
    surface,
    atmosphere,
    center: opts.position.clone(),
  };
}
