import { Mesh, Scene, StandardMaterial, Color3, Vector3 } from "@babylonjs/core";

export interface Body {
  name: string;
  mesh: Mesh;
  radius: number;
  atmosphereHeight: number;
  atmosphereColor: Color3;
  skyColor: Color3;
  mu: number;
}

export function bodyAltitude(body: Body, point: Vector3): number {
  return point.subtract(body.mesh.position).length() - body.radius;
}

export function atmosphereFactor(body: Body, point: Vector3): number {
  const alt = bodyAltitude(body, point);
  if (alt <= 0) return 1;
  if (alt >= body.atmosphereHeight) return 0;
  return 1 - alt / body.atmosphereHeight;
}

export function makePlanet(scene: Scene, opts: {
  name: string; position: Vector3; radius: number; color: Color3;
  atmosphereHeight: number; atmosphereColor: Color3; skyColor: Color3; mu: number;
}): Body {
  const mesh = Mesh.CreateSphere(opts.name, 48, opts.radius * 2, scene);
  mesh.position.copyFrom(opts.position);
  const mat = new StandardMaterial(`${opts.name}-mat`, scene);
  mat.diffuseColor = opts.color;
  mesh.material = mat;

  const shell = Mesh.CreateSphere(`${opts.name}-atmo`, 48, (opts.radius + opts.atmosphereHeight) * 2, scene);
  shell.parent = mesh;
  const shellMat = new StandardMaterial(`${opts.name}-atmo-mat`, scene);
  shellMat.diffuseColor = opts.atmosphereColor;
  shellMat.emissiveColor = opts.atmosphereColor;
  shellMat.alpha = 0.18;
  shellMat.backFaceCulling = false;
  shell.material = shellMat;

  return { ...opts, mesh };
}
