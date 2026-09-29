/**
 * Placed props (launch pad, escape pod, ruins, monoliths, debris): meshes in
 * the owning body's frame plus matching box colliders for the physics and
 * interaction points for the game layer. Everything is dropped onto the
 * exact terrain height field at load time.
 */
import {
  Color3,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { POIS, headingVector, poiDirection, type PoiDef } from "../data/pois";
import { terrainRadius, type TerrainShape } from "../terrain/heightField";
import type { StaticCollider } from "../sim/shipSim";
import { quatFromAxes } from "../sim/shipSim";

export interface Interactable {
  poi: PoiDef;
  bodyId: string;
  /** Body-frame position of the interaction point. */
  position: Vector3;
  radius: number;
}

export interface PlacedPoi {
  poi: PoiDef;
  /** Body-frame ground point and frame. */
  origin: Vector3;
  up: Vector3;
  forward: Vector3;
}

interface PropBuild {
  colliders: StaticCollider[];
  interactables: Interactable[];
}

/** Ground point + local frame for a POI (lowest ground under a footprint). */
export function placePoi(poi: PoiDef, shape: TerrainShape, footprint = 0): PlacedPoi {
  const d = poiDirection(poi, shape.radius);
  const up = new Vector3(d[0], d[1], d[2]);
  const h = headingVector(d, poi.heading ?? 0);
  const forward = new Vector3(h[0], h[1], h[2]);
  let r = terrainRadius(shape, d[0], d[1], d[2]);
  if (footprint > 0) {
    // Sit on the highest point of the footprint so nothing floats; the
    // base is sunk to cover the low side.
    const right = Vector3.Cross(up, forward);
    for (const [a, b] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const p = up
        .scale(shape.radius)
        .addInPlace(right.scale(a * footprint))
        .addInPlace(forward.scale(b * footprint))
        .normalize();
      r = Math.max(r, terrainRadius(shape, p.x, p.y, p.z));
    }
  }
  return { poi, origin: up.scale(r), up, forward };
}

/** Oriented box collider in a POI's local frame (center offset: x right, y up, z forward). */
function box(pl: PlacedPoi, center: Vector3, half: Vector3, yaw = 0): StaticCollider {
  const right = Vector3.Cross(pl.up, pl.forward);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const ax = right.scale(c).addInPlace(pl.forward.scale(-s));
  const az = pl.forward.scale(c).addInPlace(right.scale(s));
  return {
    center: pl.origin
      .add(right.scale(center.x))
      .addInPlace(pl.up.scale(center.y))
      .addInPlace(pl.forward.scale(center.z)),
    axes: [ax, pl.up.clone(), az],
    halfExtents: half,
  };
}

/** Node oriented to a POI frame (local Y = up, local Z = forward). */
function frameNode(scene: Scene, name: string, pl: PlacedPoi, parent: TransformNode): TransformNode {
  const node = new TransformNode(name, scene);
  node.parent = parent;
  node.position.copyFrom(pl.origin);
  const right = Vector3.Cross(pl.up, pl.forward);
  node.rotationQuaternion = quatFromAxes(right, pl.up, pl.forward, new Quaternion());
  return node;
}

const MATERIALS = new WeakMap<Scene, ReturnType<typeof createMaterials>>();

/** Prop materials are shared by every body in a scene. */
function materials(scene: Scene): ReturnType<typeof createMaterials> {
  let m = MATERIALS.get(scene);
  if (!m) {
    m = createMaterials(scene);
    MATERIALS.set(scene, m);
  }
  return m;
}

function createMaterials(scene: Scene) {
  const stone = new PBRMaterial("ruin-stone", scene);
  stone.albedoColor = new Color3(0.46, 0.44, 0.41);
  stone.metallic = 0;
  stone.roughness = 0.95;
  const darkStone = new PBRMaterial("ruin-dark", scene);
  darkStone.albedoColor = new Color3(0.16, 0.16, 0.18);
  darkStone.metallic = 0.1;
  darkStone.roughness = 0.6;
  const glyph = new StandardMaterial("ruin-glyph", scene);
  glyph.emissiveColor = new Color3(0.3, 0.95, 0.85);
  glyph.disableLighting = true;
  const hull = new PBRMaterial("pod-hull", scene);
  hull.albedoColor = new Color3(0.82, 0.8, 0.76);
  hull.metallic = 0.7;
  hull.roughness = 0.45;
  const scorch = new PBRMaterial("pod-scorch", scene);
  scorch.albedoColor = new Color3(0.08, 0.07, 0.06);
  scorch.roughness = 0.9;
  const pad = new PBRMaterial("pad-deck", scene);
  pad.albedoColor = new Color3(0.28, 0.3, 0.33);
  pad.metallic = 0.6;
  pad.roughness = 0.5;
  const padLight = new StandardMaterial("pad-lights", scene);
  padLight.emissiveColor = new Color3(0.2, 0.8, 1);
  padLight.disableLighting = true;
  return { stone, darkStone, glyph, hull, scorch, pad, padLight };
}

type Mats = ReturnType<typeof materials>;

function part(mesh: Mesh, parent: TransformNode, mat: PBRMaterial | StandardMaterial, pos: Vector3): Mesh {
  mesh.parent = parent;
  mesh.position.copyFrom(pos);
  mesh.material = mat;
  mesh.isPickable = false;
  return mesh;
}

function buildPad(scene: Scene, pl: PlacedPoi, root: TransformNode, m: Mats, out: PropBuild): void {
  const node = frameNode(scene, `${pl.poi.id}`, pl, root);
  // Deck top 0.4 m above the highest ground under it; the base sinks 2 m.
  part(
    MeshBuilder.CreateBox("pad", { width: 11, height: 2.4, depth: 11 }, scene),
    node,
    m.pad,
    new Vector3(0, -0.8, 0),
  );
  for (const [x, z] of [
    [5.2, 5.2],
    [-5.2, 5.2],
    [5.2, -5.2],
    [-5.2, -5.2],
  ]) {
    part(
      MeshBuilder.CreateBox("pad-light", { width: 0.5, height: 0.12, depth: 0.5 }, scene),
      node,
      m.padLight,
      new Vector3(x, 0.45, z),
    );
  }
  part(
    MeshBuilder.CreateTorus("pad-ring", { diameter: 7, thickness: 0.12, tessellation: 48 }, scene),
    node,
    m.padLight,
    new Vector3(0, 0.42, 0),
  );
  out.colliders.push(box(pl, new Vector3(0, -0.8, 0), new Vector3(5.5, 1.2, 5.5)));
}

function buildPod(scene: Scene, pl: PlacedPoi, root: TransformNode, m: Mats, out: PropBuild): void {
  const node = frameNode(scene, `${pl.poi.id}`, pl, root);
  const tilt = new TransformNode("pod-tilt", scene);
  tilt.parent = node;
  tilt.rotation.set(0.35, 0, 0.18);
  const body = part(
    MeshBuilder.CreateCapsule("pod-body", { radius: 1.25, height: 4.2, tessellation: 20 }, scene),
    tilt,
    m.hull,
    new Vector3(0, 0.9, 0),
  );
  body.rotation.x = Math.PI / 2;
  part(
    MeshBuilder.CreateCylinder("pod-hatch", { diameter: 1.4, height: 0.2, tessellation: 20 }, scene),
    tilt,
    m.darkStone,
    new Vector3(1.2, 1.1, 0.3),
  ).rotation.z = Math.PI / 2;
  part(
    MeshBuilder.CreateCylinder(
      "pod-nozzle",
      { diameterTop: 0.9, diameterBottom: 1.5, height: 0.8, tessellation: 16 },
      scene,
    ),
    tilt,
    m.scorch,
    new Vector3(0, 0.9, -2.4),
  ).rotation.x = Math.PI / 2;
  const beacon = part(
    MeshBuilder.CreateSphere("pod-beacon", { diameter: 0.25 }, scene),
    tilt,
    m.padLight,
    new Vector3(0, 2.1, 0.8),
  );
  beacon.metadata = { beacon: true };
  // Scorched gouge behind the pod.
  part(
    MeshBuilder.CreateBox("pod-gouge", { width: 2.6, height: 0.1, depth: 9 }, scene),
    node,
    m.scorch,
    new Vector3(0, -0.02, -5),
  );
  out.colliders.push(box(pl, new Vector3(0, 0.9, 0), new Vector3(1.3, 1.3, 2.3)));
  out.interactables.push({
    poi: pl.poi,
    bodyId: pl.poi.body,
    position: pl.origin.add(pl.up.scale(1.2)),
    radius: 3.5,
  });
}

function buildRuin(
  scene: Scene,
  pl: PlacedPoi,
  root: TransformNode,
  m: Mats,
  out: PropBuild,
  seed: number,
): void {
  const node = frameNode(scene, `${pl.poi.id}`, pl, root);
  let s = seed;
  const rnd = (): number => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  // A ring of broken pillars around a low dais with a glowing glyph stone.
  part(
    MeshBuilder.CreateCylinder("ruin-dais", { diameter: 9, height: 1.2, tessellation: 12 }, scene),
    node,
    m.stone,
    new Vector3(0, -0.2, 0),
  );
  out.colliders.push(box(pl, new Vector3(0, -0.2, 0), new Vector3(3.4, 0.6, 3.4)));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const h = 1.5 + rnd() * 4;
    const x = Math.cos(a) * 7;
    const z = Math.sin(a) * 7;
    if (rnd() < 0.2) continue; // fallen
    const p = part(
      MeshBuilder.CreateBox("ruin-pillar", { width: 0.9, height: h, depth: 0.9 }, scene),
      node,
      m.stone,
      new Vector3(x, h / 2 - 0.3, z),
    );
    p.rotation.y = a;
    p.rotation.z = (rnd() - 0.5) * 0.12;
    out.colliders.push(box(pl, new Vector3(x, h / 2 - 0.3, z), new Vector3(0.45, h / 2, 0.45), a));
  }
  // Lintel over two pillars.
  part(
    MeshBuilder.CreateBox("ruin-lintel", { width: 6, height: 0.7, depth: 1 }, scene),
    node,
    m.stone,
    new Vector3(0, 4.6, 7.2),
  );
  const stone = part(
    MeshBuilder.CreateBox("ruin-stele", { width: 1.6, height: 2.6, depth: 0.5 }, scene),
    node,
    m.darkStone,
    new Vector3(0, 1.7, 0),
  );
  stone.rotation.y = 0.3;
  const glyph = part(
    MeshBuilder.CreateTorus("ruin-glyph", { diameter: 1.1, thickness: 0.07, tessellation: 40 }, scene),
    node,
    m.glyph,
    new Vector3(0, 1.9, 0),
  );
  glyph.rotation.x = Math.PI / 2;
  glyph.rotation.y = 0.3;
  glyph.metadata = { glyph: true };
  out.colliders.push(box(pl, new Vector3(0, 1.7, 0), new Vector3(0.8, 1.3, 0.3), 0.3));
  out.interactables.push({
    poi: pl.poi,
    bodyId: pl.poi.body,
    position: pl.origin.add(pl.up.scale(1.8)),
    radius: 3.5,
  });
}

function buildMonolith(scene: Scene, pl: PlacedPoi, root: TransformNode, m: Mats, out: PropBuild): void {
  const node = frameNode(scene, `${pl.poi.id}`, pl, root);
  part(
    MeshBuilder.CreateBox("monolith", { width: 3, height: 14, depth: 1.2 }, scene),
    node,
    m.darkStone,
    new Vector3(0, 6.5, 0),
  );
  for (let i = 0; i < 3; i++) {
    const g = part(
      MeshBuilder.CreateTorus(
        "monolith-glyph",
        { diameter: 1.8 - i * 0.45, thickness: 0.08, tessellation: 48 },
        scene,
      ),
      node,
      m.glyph,
      new Vector3(0, 9 - i * 0.2, 0.62),
    );
    g.rotation.x = Math.PI / 2;
    g.metadata = { glyph: true };
  }
  out.colliders.push(box(pl, new Vector3(0, 6.5, 0), new Vector3(1.5, 7, 0.6)));
  out.interactables.push({
    poi: pl.poi,
    bodyId: pl.poi.body,
    position: pl.origin.add(pl.up.scale(1.6)).add(pl.forward.scale(1.2)),
    radius: 4,
  });
}

function buildDebris(scene: Scene, pl: PlacedPoi, root: TransformNode, m: Mats, out: PropBuild): void {
  const node = frameNode(scene, `${pl.poi.id}`, pl, root);
  const pieces: [Vector3, Vector3, number][] = [
    [new Vector3(0, 1.2, 0), new Vector3(5, 3, 14), 0.2],
    [new Vector3(9, 0.8, 6), new Vector3(3, 2, 6), 1.1],
    [new Vector3(-8, 0.5, -4), new Vector3(6, 1.2, 3), -0.6],
  ];
  for (const [p, size, yaw] of pieces) {
    const b = part(
      MeshBuilder.CreateBox("debris", { width: size.x, height: size.y, depth: size.z }, scene),
      node,
      m.hull,
      p,
    );
    b.rotation.set(0.15, yaw, -0.1);
    out.colliders.push(box(pl, p, size.scale(0.5), yaw));
  }
  part(
    MeshBuilder.CreateSphere("debris-core", { diameter: 0.4 }, scene),
    node,
    m.padLight,
    new Vector3(0, 3, 2),
  );
  out.interactables.push({
    poi: pl.poi,
    bodyId: pl.poi.body,
    position: pl.origin.add(pl.up.scale(1.5)),
    radius: 6,
  });
}

/** Build every POI on a body; returns its colliders and interaction points. */
export function buildProps(
  scene: Scene,
  bodyId: string,
  shape: TerrainShape,
  root: TransformNode,
  pois: PoiDef[] = POIS,
): PropBuild & { placed: Map<string, PlacedPoi> } {
  const out: PropBuild = { colliders: [], interactables: [] };
  const placed = new Map<string, PlacedPoi>();
  const mats = materials(scene);
  pois.forEach((poi, i) => {
    if (poi.body !== bodyId) return;
    const footprint =
      poi.kind === "pad" ? 5.5 : poi.kind === "ruin" ? 3.5 : poi.kind === "monolith" ? 1.5 : 0;
    const pl = placePoi(poi, shape, footprint);
    placed.set(poi.id, pl);
    switch (poi.kind) {
      case "pad":
        buildPad(scene, pl, root, mats, out);
        break;
      case "pod":
        buildPod(scene, pl, root, mats, out);
        break;
      case "ruin":
        buildRuin(scene, pl, root, mats, out, 1000 + i * 77);
        break;
      case "monolith":
        buildMonolith(scene, pl, root, mats, out);
        break;
      case "debris":
        buildDebris(scene, pl, root, mats, out);
        break;
      case "start":
        break;
    }
  });
  return { ...out, placed };
}
