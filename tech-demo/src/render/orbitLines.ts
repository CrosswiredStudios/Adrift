/**
 * Orbit lines: a faint ring along every body's orbit, drawn in the world
 * (not as a 2D overlay) so planets and moons hide the parts behind them.
 *
 * Each ring is built once in its parent-centred inertial frame (orbits are
 * fixed circles on rails) and moved with the parent every frame. The arc
 * just behind the body is brighter, like a wake, so the direction of motion
 * reads at a glance. Rings fade in above the atmosphere and can be toggled.
 */
import {
  Color3,
  Constants,
  Material,
  Mesh,
  Scene,
  ShaderMaterial,
  Vector3,
  VertexData,
} from "@babylonjs/core";
import type { CelestialBody } from "../sim/celestial";
import { markNoDepth } from "./sceneTargets";

const SEGMENTS = 512;

const VERTEX = `
precision highp float;
attribute vec3 position;
attribute float angle;
uniform mat4 worldViewProjection;
varying float vAngle;
#include<logDepthDeclaration>
void main() {
  vAngle = angle;
  gl_Position = worldViewProjection * vec4(position, 1.0);
  #include<logDepthVertex>
}`;

const FRAGMENT = `
precision highp float;
varying float vAngle;
uniform vec3 color;
uniform float alpha;
uniform float bodyAngle;
#include<logDepthDeclaration>
void main() {
  #include<logDepthFragment>
  // How far behind the body this point of the ring is (0..2pi).
  float behind = mod(bodyAngle - vAngle, 6.2831853);
  float wake = exp(-behind * 2.5);
  gl_FragColor = vec4(color, alpha * (0.3 + 0.7 * wake));
}`;

export interface OrbitLineStyle {
  color: [number, number, number];
  /** Peak opacity (additive). */
  alpha: number;
}

interface Ring {
  body: CelestialBody;
  mesh: Mesh;
  mat: ShaderMaterial;
  alpha: number;
}

export class OrbitLines {
  /** Player toggle. */
  enabled = true;
  private readonly rings: Ring[] = [];

  constructor(scene: Scene, bodies: { body: CelestialBody; style: OrbitLineStyle }[]) {
    for (const { body, style } of bodies) {
      if (!body.parent || !body.spec.orbit) continue;
      const positions: number[] = [];
      const angles: number[] = [];
      const indices: number[] = [];
      const p = new Vector3();
      for (let i = 0; i < SEGMENTS; i++) {
        const a = (i / SEGMENTS) * Math.PI * 2;
        body.orbitPoint(a, p);
        positions.push(p.x, p.y, p.z);
        angles.push(a);
        indices.push(i, (i + 1) % SEGMENTS);
      }
      const mesh = new Mesh(`orbit-${body.id}`, scene);
      const vd = new VertexData();
      vd.positions = positions;
      vd.indices = indices;
      vd.applyToMesh(mesh);
      mesh.setVerticesData("angle", angles, false, 1);
      const mat = new ShaderMaterial(
        `orbit-${body.id}-mat`,
        scene,
        { vertexSource: VERTEX, fragmentSource: FRAGMENT },
        {
          attributes: ["position", "angle"],
          uniforms: ["worldViewProjection", "color", "alpha", "bodyAngle"],
          needAlphaBlending: true,
        },
      );
      mat.fillMode = Material.LineListDrawMode;
      mat.alphaMode = Constants.ALPHA_ADD;
      mat.disableDepthWrite = true;
      mat.backFaceCulling = false;
      mat.useLogarithmicDepth = true;
      mat.setColor3("color", new Color3(...style.color));
      mat.setFloat("alpha", 0);
      mat.setFloat("bodyAngle", 0);
      mesh.material = mat;
      mesh.isPickable = false;
      mesh.applyFog = false;
      mesh.alwaysSelectAsActiveMesh = true;
      mesh.setEnabled(false);
      markNoDepth(mesh);
      this.rings.push({ body, mesh, mat, alpha: style.alpha });
    }
  }

  get meshes(): Mesh[] {
    return this.rings.map((r) => r.mesh);
  }

  /**
   * Place the rings for this frame.
   * @param parentRel parent centre relative to the camera (render space), by body id
   * @param t render time (s)
   * @param fade 0..1 visibility from the camera's situation (altitude, sky)
   */
  update(parentRel: (bodyId: string) => Vector3, t: number, fade: number): void {
    const on = this.enabled && fade > 0.001;
    for (const r of this.rings) {
      r.mesh.setEnabled(on);
      if (!on) continue;
      r.mesh.position.copyFrom(parentRel(r.body.parent!.id));
      r.mat.setFloat("alpha", r.alpha * fade);
      const a = r.body.orbitAngle(t) % (Math.PI * 2);
      r.mat.setFloat("bodyAngle", a < 0 ? a + Math.PI * 2 : a);
    }
  }
}
