import { Color3, Mesh, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { Body, makePlanet, surfaceRadius } from "../world/planets";
import { planetArchetype } from "../world/planetArchetypes";
import { SunResult, createSun } from "../world/sun";

/**
 * World composition root (SRP: planet/star/pad construction lives here;
 * the frame loop + debug API live in main.ts). Builds the demo system —
 * Vael Prime, Tethys, Sol — and the launch pad, returning everything the
 * loop needs. New planets/biomes plug in here without touching main.ts.
 */
export interface World {
  vael: Body;
  tethys: Body;
  sol: SunResult;
  bodies: Body[];
  /** Unit direction from Vael's center to the launch pad. */
  padDir: Vector3;
  pad: Mesh;
}

export function buildWorld(scene: Scene, sunDir: Vector3): World {
  // Planets come from the archetype registry (see planetArchetypes.ts): new
  // biomes register there instead of editing this composition root.
  const vael = makePlanet(scene, planetArchetype("temperate")(new Vector3(0, 0, 0)));
  const tethys = makePlanet(scene, planetArchetype("barren")(new Vector3(6000, 800, -2500)));
  // The star itself: a real body sitting exactly on the light axis (-sunDir from the
  // origin), so the terminator phase, the on-planet glare and the visible disc all
  // agree. Radius 2,400 at 36,000 u reads ~7.6 degrees wide - a giant sun from the
  // ground and from deep space alike. Weak gravity well (mu 120k ~ 0.7 u/s^2 at the
  // surface); no heat or damage gameplay yet.
  const sol = createSun(scene, {
    name: "Sol",
    position: sunDir.scale(-36000),
    radius: 2400,
    mu: 120000,
  });
  const bodies: Body[] = [vael, tethys, sol.body];

  // Launch pad sits on the visible terrain: sample the same height function the
  // ground mesh uses, then rest the ship at flight-model contact height with
  // zero motion so the demo starts perfectly still.
  const padDir = new Vector3(0.35, 0.9, 0.25).normalize();
  const padR = surfaceRadius(vael, padDir);
  const pad = Mesh.CreateBox("pad", 8, scene);
  pad.position.copyFrom(vael.center).addInPlace(padDir.scale(padR - 2.8)); // top ~1.2 above ground
  const padMat = new StandardMaterial("pad-mat", scene);
  padMat.emissiveColor = new Color3(0.2, 0.8, 1);
  pad.material = padMat;

  return { vael, tethys, sol, bodies, padDir, pad };
}
