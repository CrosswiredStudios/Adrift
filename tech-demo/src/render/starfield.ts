/**
 * Procedural starfield dome. Huge inverted sphere with hash-based point
 * stars (a sampled texture would need an impractically large map and brings
 * seam/pole artifacts). Brightness is driven by the atmosphere sky factor
 * each frame so stars return at night.
 */
import { Mesh, Scene, ShaderMaterial } from "@babylonjs/core";
import { markNoDepth } from "./sceneTargets";

const STAR_VERTEX = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec3 vDir;
#include<logDepthDeclaration>
void main() {
  vDir = position;
  gl_Position = worldViewProjection * vec4(position, 1.0);
  #include<logDepthVertex>
}`;

const STAR_FRAGMENT = `
precision highp float;
varying vec3 vDir;
uniform float brightness;
#include<logDepthDeclaration>

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// One layer of point stars: at most one star per hash cell, tight core + soft halo.
vec3 starLayer(vec3 dir, float cellScale, float density, float corePower) {
  vec3 p = dir * cellScale;
  vec3 cell = floor(p);
  if (hash13(cell) >= density) return vec3(0.0);
  vec3 jitter = vec3(hash13(cell + 17.0), hash13(cell + 43.0), hash13(cell + 89.0));
  float d = length(p - (cell + 0.2 + jitter * 0.6));
  float core = exp(-d * d * corePower);
  float halo = exp(-d * d * corePower * 0.12) * 0.12;
  float bright = 0.4 + 0.6 * hash13(cell + 131.0);
  vec3 tint = mix(vec3(0.75, 0.84, 1.0), vec3(1.0, 0.87, 0.68), hash13(cell + 197.0));
  return mix(vec3(1.0), tint, 0.55) * (core + halo) * bright;
}

void main() {
  #include<logDepthFragment>
  vec3 dir = normalize(vDir);
  vec3 col = starLayer(dir, 190.0, 0.0022, 55.0) * 1.5;
  col += starLayer(dir * 1.9, 210.0, 0.0045, 90.0) * 0.5;
  // Faint galactic band so deep space is not a flat black.
  float band = exp(-abs(dot(dir, normalize(vec3(0.35, 0.22, -0.91)))) * 8.0);
  col += band * vec3(0.10, 0.13, 0.21) * 0.35;
  gl_FragColor = vec4(col * brightness, 1.0);
}`;

export interface Starfield {
  mesh: Mesh;
  setBrightness(b: number): void;
}

export function makeStars(scene: Scene, farPlane: number): Starfield {
  // The dome follows the camera (infiniteDistance), sits just inside the far
  // plane and never writes depth, so it can't hide anything in front of it.
  const mesh = Mesh.CreateSphere("stars", 24, farPlane * 1.8, scene);
  const mat = new ShaderMaterial(
    "stars-mat",
    scene,
    { vertexSource: STAR_VERTEX, fragmentSource: STAR_FRAGMENT },
    { attributes: ["position"], uniforms: ["worldViewProjection", "brightness"] },
  );
  mat.backFaceCulling = false;
  mat.disableDepthWrite = true;
  mat.useLogarithmicDepth = true;
  mat.setFloat("brightness", 1);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.infiniteDistance = true; // dome follows the camera; keep position at origin
  mesh.applyFog = false;
  markNoDepth(mesh);
  return {
    mesh,
    setBrightness: (b: number) => mat.setFloat("brightness", b),
  };
}
