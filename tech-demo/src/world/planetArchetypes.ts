import { Color3, Vector3 } from "@babylonjs/core";
import { PlanetOptions } from "./planets";

/**
 * Planet archetype registry (OCP: new planets/biomes register here instead
 * of editing world.ts). Each archetype is a named factory for PlanetOptions;
 * buildWorld composes the registered archetypes into a scene.
 */
export type PlanetArchetype = (position: Vector3) => PlanetOptions;

const REGISTRY = new Map<string, PlanetArchetype>();

export function registerPlanetArchetype(name: string, archetype: PlanetArchetype): void {
  REGISTRY.set(name, archetype);
}

export function planetArchetype(name: string): PlanetArchetype {
  const archetype = REGISTRY.get(name);
  if (!archetype) throw new Error(`Unknown planet archetype: ${name}`);
  return archetype;
}

export function planetArchetypeNames(): string[] {
  return [...REGISTRY.keys()];
}

/** Temperate wooded world (Vael Prime defaults). */
export function temperateArchetype(position: Vector3): PlanetOptions {
  return {
    name: "Vael Prime",
    position,
    radius: 600,
    color: new Color3(0.3, 0.5, 0.28),
    atmosphereHeight: 520,
    atmosphereColor: new Color3(0.35, 0.6, 1),
    skyColor: new Color3(0.5, 0.75, 1),
    mu: 90000,
    seed: 1337,
    relief: 0.045,
    waterLevel: -0.05,
    cloudCoverage: 0.5,
    terrain: {
      baseColor: "/textures/terrain/grass_color.jpg",
      baseNormal: "/textures/terrain/grass_normal.jpg",
    },
    vegetation: {},
  };
}

/** Airless rocky moon (Tethys defaults). */
export function barrenArchetype(position: Vector3): PlanetOptions {
  return {
    name: "Tethys",
    position,
    radius: 160,
    color: new Color3(0.55, 0.55, 0.58),
    atmosphereHeight: 4,
    atmosphereColor: new Color3(0.4, 0.4, 0.45),
    skyColor: new Color3(0, 0, 0),
    mu: 8000,
    seed: 777,
    atmosphere: false,
    relief: 0.05,
    terrain: {
      baseColor: "/textures/terrain/dust_color.jpg",
      baseNormal: "/textures/terrain/dust_normal.jpg",
      baseTint: new Color3(0.5, 0.47, 0.42),
      snowStart: null,
    },
  };
}

registerPlanetArchetype("temperate", temperateArchetype);
registerPlanetArchetype("barren", barrenArchetype);
