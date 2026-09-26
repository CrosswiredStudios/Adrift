import { Mesh, Scene, Color3, Vector3 } from "@babylonjs/core";
import { IWorldBody } from "./worldBody";
import { buildPlanetSurface, SurfaceResult, OceanLook } from "./planetSurface";
import { ShoresOptions, defaultShores, terrainHeightNormalized } from "../common/heightField";
import { WaveSettings } from "../ocean/oceanWaves";
import { SkyPalette } from "../common/shaderChunks";
import { createAtmosphere, AtmosphereResult } from "./atmosphere";
import { TerrainLook, defaultTerrainLook } from "./terrainMaterial";
import {
  buildVegetation,
  defaultVegetationLook,
  VegetationHandle,
  VegetationLook,
} from "../vegetation/vegetation";

export interface Body extends IWorldBody {
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
  /** Instanced trees/shrubs/grass (undefined on bare bodies like Tethys). */
  vegetation?: VegetationHandle | null;
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
  /** Ground texture blend overrides (see TerrainLook in terrainMaterial.ts). */
  terrain?: Partial<TerrainLook>;
  /** Instanced vegetation (trees/shrubs/grass). Omit to leave the body bare. */
  vegetation?: Partial<VegetationLook> | null;
}

export function makePlanet(scene: Scene, opts: PlanetOptions): Body {
  const seed = opts.seed ?? 1337;
  const relief = opts.relief ?? 0.022;
  const waterLevel = opts.waterLevel ?? -0.05;
  const hasAtmo = opts.atmosphere ?? opts.atmosphereHeight > 1;
  const shore: ShoresOptions = { ...defaultShores, ...(opts.shore ?? {}) };
  const terrain: TerrainLook = { ...defaultTerrainLook, ...(opts.terrain ?? {}) };

  // Sky palette for water reflections, mirroring the atmosphere below.
  const warmHaze = opts.atmosphereColor.r > 0.5 && opts.atmosphereColor.g < 0.6;
  const sunTint = opts.sunTint ?? new Color3(1.0, 0.97, 0.92);
  const skyPalette: SkyPalette = hasAtmo
    ? {
        skyTint: opts.skyTint ?? opts.atmosphereColor,
        skyStrength: opts.skyStrength ?? (warmHaze ? 1.4 : 1.0),
        hazeTint: opts.hazeTint ?? (warmHaze ? new Color3(1.0, 0.6, 0.32) : new Color3(1.0, 0.97, 0.92)),
        hazeStrength: opts.hazeStrength ?? (warmHaze ? 0.45 : 0.22),
        hazeG: 0.7,
        sunTint,
        sunGlow: 0.35,
      }
    : {
        skyTint: new Color3(0, 0, 0),
        skyStrength: 0,
        hazeTint: new Color3(0, 0, 0),
        hazeStrength: 0,
        hazeG: 0.7,
        sunTint,
        sunGlow: 0.6,
      };

  const surface = buildPlanetSurface(scene, opts.name, {
    radius: opts.radius,
    seed,
    relief,
    position: opts.position,
    segments: opts.radius > 300 ? 192 : 128,
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
    terrain,
  });
  // The ocean meshes stay at the origin (the shader places them with
  // uPlanetCenter), so only the clouds / night shell are moved here.
  if (surface.cloudDeck) surface.cloudDeck.setCenter(opts.position);
  else if (surface.clouds) surface.clouds.position.copyFrom(opts.position);
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
      hazeAnisotropy: 0.7,
      sunTint,
      sunIntensity: 0.45,
    });
    atmosphere.outer.position.copyFrom(opts.position);
    atmosphere.inner.position.copyFrom(opts.position);
  }

  // Vegetation is built last: it parents to the ground mesh and samples the
  // same height field, so it lands exactly on the visible surface.
  let vegetation: VegetationHandle | null = null;
  if (opts.vegetation) {
    vegetation = buildVegetation(scene, {
      name: opts.name,
      seed,
      radius: opts.radius,
      relief,
      waterLevel,
      shore,
      ground: surface.ground,
      center: opts.position,
      look: { ...defaultVegetationLook, ...opts.vegetation },
    });
  }

  // IWorldBody implementation: thin methods over the module's free
  // functions so the flight model can depend on the interface (DIP).
  const body: Body = {
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
    vegetation,
    atmosphere,
    center: opts.position.clone(),
    skyTint: opts.atmosphereColor.clone(),
    atmosphereAt: (point: Vector3) => atmosphereFactor(body, point),
    surfaceAltitudeAt: (point: Vector3) => surfaceAltitude(body, point),
    surfaceRadiusAt: (dir: Vector3) => surfaceRadius(body, dir),
    isOverWaterAt: (dir: Vector3) => isOverWater(body, dir),
    waterSurfaceRadiusAt: (dir: Vector3) => waterSurfaceRadius(body, dir),
  };
  return body;
}
