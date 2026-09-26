import { describe, expect, it } from "vitest";
import { Color3, Vector3 } from "@babylonjs/core";
import { planetArchetype, planetArchetypeNames, registerPlanetArchetype } from "./planetArchetypes";

describe("planet archetype registry", () => {
  it("ships temperate + barren archetypes", () => {
    expect(planetArchetypeNames()).toContain("temperate");
    expect(planetArchetypeNames()).toContain("barren");
    const temperate = planetArchetype("temperate")(new Vector3(0, 0, 0));
    expect(temperate.name).toBe("Vael Prime");
    expect(temperate.vegetation).toBeDefined();
    const barren = planetArchetype("barren")(new Vector3(1, 2, 3));
    expect(barren.atmosphere).toBe(false);
    expect(barren.vegetation).toBeUndefined();
    expect(barren.position.equals(new Vector3(1, 2, 3))).toBe(true);
  });

  it("accepts new archetypes without editing world.ts", () => {
    registerPlanetArchetype("test-ice", (position) => ({
      name: "Test Ice",
      position,
      radius: 100,
      color: new Color3(0.8, 0.85, 0.9),
      atmosphereHeight: 10,
      atmosphereColor: new Color3(0.6, 0.7, 0.9),
      skyColor: new Color3(0.5, 0.6, 0.8),
      mu: 1000,
    }));
    const ice = planetArchetype("test-ice")(new Vector3(9, 9, 9));
    expect(ice.name).toBe("Test Ice");
    expect(ice.radius).toBe(100);
  });

  it("throws on unknown archetypes", () => {
    expect(() => planetArchetype("nope")).toThrow("Unknown planet archetype: nope");
  });
});
