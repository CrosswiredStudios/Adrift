/**
 * The Vesper Drift system: every celestial body as data.
 *
 * Scale: 1 unit = 1 meter. This is a deliberately miniature system (Outer
 * Wilds-like) so on-foot exploration, suborbital hops and interplanetary
 * flights all fit in minutes of play, while gravity, orbits and day/night
 * still follow real physics:
 *
 *   body     radius   surface g   orbit              day
 *   Vesper   8 km     (star)      -                  -
 *   Vael     2 km     9.81 m/s2   300 km, 6 h year   20 min
 *   Tethys   600 m    1.62 m/s2   12 km around Vael  tidally locked (~22 min)
 *   Cinder   1.5 km   7.4 m/s2    480 km             30 min
 *
 * Orbits and spins are on rails (see sim/celestial.ts). Visual and terrain
 * parameters live alongside so a new planet is one entry here.
 *
 * Names: "Vesper" (star) and "Cinder" (second planet) are working names;
 * the design docs list the second planet as "Cinder / Pelagos (undecided)".
 */
import { Color3 } from "@babylonjs/core";
import type { BodySpec } from "../sim/celestial";
import { defaultShores, type TerrainShape } from "../terrain/heightField";

const G = (radius: number, g: number): number => g * radius * radius;

export interface AtmosphereSpec {
  /** Height of the top of the atmosphere above the mean radius (m). */
  height: number;
  /** Rayleigh density scale height (m). */
  rayleighScale: number;
  /** Mie (haze) density scale height (m). */
  mieScale: number;
  /** Rayleigh scattering colour weights (blue for N2/O2, orange for dust). */
  rayleighColor: Color3;
  /** Rayleigh strength multiplier (optical depth tuning for this scale). */
  rayleighStrength: number;
  mieColor: Color3;
  mieStrength: number;
  /** Mie anisotropy g. */
  mieG: number;
  /** Sea-level density multiplier for drag (1 = Earth-like). */
  drag: number;
}

export interface OceanSpec {
  seaState: "calm" | "mild" | "rough";
  shallowColor: Color3;
  deepColor: Color3;
}

export interface CloudSpec {
  coverage: number;
  /** Cloud base above the mean radius (m). */
  base: number;
  /** Deck thickness (m). */
  thickness: number;
}

export interface SurfaceLookSpec {
  baseColor: string;
  baseNormal: string;
  rockColor: string;
  rockNormal: string;
  /** Fallback tint if textures fail. */
  baseTint: Color3;
  /** Snow line in normalized height, or null for no snow. */
  snowLine: number | null;
  /** Vertex tint for lowland / highland (multiplied with the textures). */
  lowTint: Color3;
  highTint: Color3;
  /** Polar ice caps (|lat| above this in dir.y). */
  iceCapLat: number | null;
}

export interface BodyDef extends BodySpec {
  kind: "star" | "planet" | "moon";
  terrain?: TerrainShape;
  surface?: SurfaceLookSpec;
  atmosphere?: AtmosphereSpec;
  ocean?: OceanSpec;
  clouds?: CloudSpec;
  vegetation?: boolean;
  nightLights?: boolean;
  /** Star colour and HDR intensity. */
  star?: { color: Color3; intensity: number };
}

const TEX = "/textures/terrain";

export const VESPER_DRIFT: BodyDef[] = [
  {
    id: "vesper",
    name: "Vesper",
    kind: "star",
    radius: 8000,
    // Vael's 300 km orbit takes 6 hours: mu = 4 pi^2 a^3 / T^2.
    mu: (4 * Math.PI * Math.PI * 300000 ** 3) / 21600 ** 2,
    spin: { period: 0 },
    star: { color: new Color3(1.0, 0.93, 0.82), intensity: 3.0 },
  },
  {
    id: "vael",
    name: "Vael",
    kind: "planet",
    radius: 2000,
    mu: G(2000, 9.81),
    orbit: { parent: "vesper", radius: 300000, phase: 0 },
    spin: { period: 1200, tilt: 0.21, tiltAzimuth: 0.4, phase: 2.2 },
    terrain: {
      seed: 1337,
      radius: 2000,
      relief: 95,
      waterLevel: -0.08,
      shore: defaultShores,
      continentFreq: 2.2,
      mountains: 1,
      microRelief: 3.5,
    },
    surface: {
      baseColor: `${TEX}/grass_color.jpg`,
      baseNormal: `${TEX}/grass_normal.jpg`,
      rockColor: `${TEX}/rock_color.jpg`,
      rockNormal: `${TEX}/rock_normal.jpg`,
      baseTint: new Color3(0.36, 0.5, 0.24),
      snowLine: 1.05,
      lowTint: new Color3(1, 1, 1),
      highTint: new Color3(0.8, 0.9, 0.74),
      iceCapLat: 0.86,
    },
    atmosphere: {
      height: 900,
      rayleighScale: 220,
      mieScale: 70,
      rayleighColor: new Color3(0.175, 0.41, 1.0),
      rayleighStrength: 1.0,
      mieColor: new Color3(1.0, 0.97, 0.92),
      mieStrength: 1.0,
      mieG: 0.76,
      drag: 1,
    },
    ocean: {
      seaState: "mild",
      shallowColor: new Color3(0.12, 0.5, 0.55),
      deepColor: new Color3(0.008, 0.055, 0.115),
    },
    clouds: { coverage: 0.5, base: 420, thickness: 160 },
    vegetation: true,
    nightLights: false,
  },
  {
    id: "tethys",
    name: "Tethys",
    kind: "moon",
    radius: 600,
    mu: G(600, 1.62),
    orbit: { parent: "vael", radius: 12000, phase: 0.55, inclination: 0.09 },
    spin: { period: 0, tidallyLocked: true },
    terrain: {
      seed: 777,
      radius: 600,
      relief: 30,
      waterLevel: -9,
      shore: defaultShores,
      continentFreq: 1.6,
      mountains: 0.35,
      microRelief: 1.5,
      craters: [
        { frequency: 3, density: 0.55, radius: [0.25, 0.45], depthRatio: 0.18 },
        { frequency: 9, density: 0.5, radius: [0.2, 0.4], depthRatio: 0.16 },
        { frequency: 26, density: 0.4, radius: [0.15, 0.35], depthRatio: 0.14 },
      ],
    },
    surface: {
      baseColor: `${TEX}/dust_color.jpg`,
      baseNormal: `${TEX}/dust_normal.jpg`,
      rockColor: `${TEX}/rock_color.jpg`,
      rockNormal: `${TEX}/rock_normal.jpg`,
      baseTint: new Color3(0.5, 0.47, 0.42),
      snowLine: null,
      lowTint: new Color3(0.72, 0.7, 0.68),
      highTint: new Color3(0.86, 0.85, 0.84),
      iceCapLat: null,
    },
  },
  {
    id: "cinder",
    name: "Cinder",
    kind: "planet",
    radius: 1500,
    mu: G(1500, 7.4),
    orbit: { parent: "vesper", radius: 480000, phase: 0.9, inclination: 0.03, node: 1.2 },
    spin: { period: 1800, tilt: 0.4, tiltAzimuth: 2.0 },
    terrain: {
      seed: 4242,
      radius: 1500,
      relief: 80,
      waterLevel: -9,
      shore: defaultShores,
      continentFreq: 2.8,
      mountains: 1.4,
      microRelief: 3,
      plainsBelow: -0.25,
      craters: [{ frequency: 5, density: 0.25, radius: [0.2, 0.35], depthRatio: 0.22 }],
    },
    surface: {
      baseColor: `${TEX}/dust_color.jpg`,
      baseNormal: `${TEX}/dust_normal.jpg`,
      rockColor: `${TEX}/rock_color.jpg`,
      rockNormal: `${TEX}/rock_normal.jpg`,
      baseTint: new Color3(0.55, 0.3, 0.2),
      snowLine: null,
      lowTint: new Color3(0.45, 0.28, 0.22),
      highTint: new Color3(0.7, 0.5, 0.4),
      iceCapLat: null,
    },
    atmosphere: {
      height: 700,
      rayleighScale: 260,
      mieScale: 140,
      rayleighColor: new Color3(0.9, 0.45, 0.2),
      rayleighStrength: 0.9,
      mieColor: new Color3(1.0, 0.62, 0.35),
      mieStrength: 3.0,
      mieG: 0.7,
      drag: 1.6,
    },
  },
];

export function bodyDef(id: string): BodyDef {
  const b = VESPER_DRIFT.find((d) => d.id === id);
  if (!b) throw new Error(`Unknown body ${id}`);
  return b;
}
