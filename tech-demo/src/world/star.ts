/**
 * The visible star: a limb-darkened HDR sphere with slow convection
 * mottling plus a soft additive corona billboard. Its position is set every
 * frame from the rails (render space); the actual lighting comes from the
 * scene's directional light, aimed along the star's direction.
 */
import { Color3, Mesh, Scene, ShaderMaterial, TransformNode } from "@babylonjs/core";
import { Constants } from "@babylonjs/core/Engines/constants";
import { FAST_NOISE_GLSL } from "../common/shaderChunks";
import { markNoDepth } from "../render/sceneTargets";

const STAR_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 vPosW;
varying vec3 vNormalW;
varying vec3 vLocalN;
#include<logDepthDeclaration>
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vPosW = wp.xyz;
  vNormalW = normalize(mat3(world) * normal);
  vLocalN = normalize(normal);
  gl_Position = worldViewProjection * vec4(position, 1.0);
  #include<logDepthVertex>
}`;

const STAR_FRAGMENT = `
precision highp float;
varying vec3 vPosW;
varying vec3 vNormalW;
varying vec3 vLocalN;
uniform vec3 cameraPosition;
uniform float uTime;
uniform vec3 uTint;
#include<logDepthDeclaration>
${FAST_NOISE_GLSL}
mat3 rotateY(float a) {
  return mat3(vec3(cos(a), 0.0, -sin(a)), vec3(0.0, 1.0, 0.0), vec3(sin(a), 0.0, cos(a)));
}
void main() {
  #include<logDepthFragment>
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float gran = waterFbm(rotateY(uTime * 0.010) * vLocalN * 3.4, 3);
  float cells = waterFbm(rotateY(uTime * 0.017) * vLocalN * 9.0, 4);
  float mottle = 0.90 + gran * 0.14 + cells * 0.07;
  float limb = pow(ndv, 0.42);
  vec3 core = mix(vec3(2.3, 1.5, 0.5), vec3(3.6, 3.3, 2.7), pow(ndv, 1.6)) * uTint;
  vec3 col = core * limb * mottle * 4.0;
  col += vec3(1.0, 0.5, 0.18) * pow(1.0 - ndv, 4.0) * 1.8;
  gl_FragColor = vec4(col, 1.0);
}`;

const CORONA_VERTEX = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec2 vLocal;
#include<logDepthDeclaration>
void main() {
  vLocal = position.xy;
  gl_Position = worldViewProjection * vec4(position, 1.0);
  #include<logDepthVertex>
}`;

const CORONA_FRAGMENT = `
precision highp float;
varying vec2 vLocal;
uniform vec3 uTint;
uniform float uStrength;
uniform float uHalf;
#include<logDepthDeclaration>
void main() {
  #include<logDepthFragment>
  float r = length(vLocal) / uHalf;
  float glow = exp(-r * r * 5.7);
  gl_FragColor = vec4(uTint * glow * uStrength, 1.0);
}`;

export interface StarVisual {
  root: TransformNode;
  core: Mesh;
  corona: Mesh;
  setTime(t: number): void;
}

export function createStarVisual(scene: Scene, name: string, radius: number, tint: Color3): StarVisual {
  const root = new TransformNode(`${name}-root`, scene);
  const core = Mesh.CreateSphere(`${name}-core`, 64, radius * 2, scene);
  const coreMat = new ShaderMaterial(
    `${name}-core-mat`,
    scene,
    { vertexSource: STAR_VERTEX, fragmentSource: STAR_FRAGMENT },
    {
      attributes: ["position", "normal"],
      uniforms: ["world", "worldViewProjection", "cameraPosition", "uTime", "uTint"],
    },
  );
  coreMat.useLogarithmicDepth = true;
  coreMat.setColor3("uTint", tint);
  core.material = coreMat;
  core.isPickable = false;
  core.parent = root;

  const coronaSize = radius * 6.4;
  const corona = Mesh.CreatePlane(`${name}-corona`, coronaSize, scene);
  const coronaMat = new ShaderMaterial(
    `${name}-corona-mat`,
    scene,
    { vertexSource: CORONA_VERTEX, fragmentSource: CORONA_FRAGMENT },
    {
      attributes: ["position"],
      uniforms: ["worldViewProjection", "uTint", "uStrength", "uHalf"],
      needAlphaBlending: true,
      needAlphaTesting: false,
    },
  );
  coronaMat.useLogarithmicDepth = true;
  coronaMat.alphaMode = Constants.ALPHA_ADD;
  coronaMat.disableDepthWrite = true;
  coronaMat.backFaceCulling = false;
  coronaMat.setColor3("uTint", new Color3(1.0, 0.72, 0.4));
  coronaMat.setFloat("uStrength", 0.9);
  coronaMat.setFloat("uHalf", coronaSize * 0.5);
  corona.billboardMode = Mesh.BILLBOARDMODE_ALL;
  corona.material = coronaMat;
  corona.isPickable = false;
  corona.parent = root;
  markNoDepth(corona);
  return {
    root,
    core,
    corona,
    setTime: (t: number) => coreMat.setFloat("uTime", t),
  };
}
