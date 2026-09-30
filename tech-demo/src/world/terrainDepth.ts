/**
 * Depth-pass material for terrain chunks.
 *
 * The scene depth map (render/sceneTargets) is drawn with Babylon's own
 * depth shader, which knows nothing about material plugins, so terrain went
 * into it *unwarped*: without the geomorph and without the distant-shallows
 * sink that the colour pass applies. Everything that reads the depth map
 * (ocean depth fade and shoreline, haze, clouds) then saw a surface that
 * differed from the visible one by up to metres, and that difference jumped
 * whenever a chunk switched LOD, which showed as shimmer along shores and
 * haze edges while flying around a planet.
 *
 * This material repeats the colour pass's vertex warp (terrainWarpGLSL) and
 * writes what the depth renderer writes (camera-space z, with the same
 * logarithmic depth test as patchDepthShaders). It is assigned to each chunk
 * for the depth map's render pass only.
 */
import { ShaderMaterial, ShaderStore, type Scene } from "@babylonjs/core";
import { TERRAIN_MORPH_KIND } from "../terrain/chunkBuilder";
import { terrainWarpGLSL } from "./terrainMaterial";

export function createTerrainDepthMaterial(
  scene: Scene,
  bodyId: string,
  radius: number,
  seaLevel: number | null,
): ShaderMaterial {
  const name = `terrainDepth_${bodyId.replace(/[^A-Za-z0-9_]/g, "_")}`;
  ShaderStore.ShadersStore[`${name}VertexShader`] = `
    precision highp float;
    attribute vec3 position;
    attribute vec4 ${TERRAIN_MORPH_KIND};
    uniform mat4 world;
    uniform mat4 view;
    uniform mat4 viewProjection;
    uniform vec2 depthValues;
    varying vec4 vViewPos;
    varying float vLogDepthW;
    void main(void) {
      vec3 positionUpdated = position;
      ${terrainWarpGLSL(radius, seaLevel)}
      vec4 worldPos = world * vec4(positionUpdated, 1.0);
      gl_Position = viewProjection * worldPos;
      vViewPos = view * worldPos;
      vLogDepthW = 1.0 + gl_Position.w;
      gl_Position.z = log2(max(0.000001, vLogDepthW)) * (2.0 / log2(depthValues.y + 1.0));
    }`;
  ShaderStore.ShadersStore[`${name}PixelShader`] = `
    precision highp float;
    uniform vec2 depthValues;
    varying vec4 vViewPos;
    varying float vLogDepthW;
    void main(void) {
      gl_FragDepthEXT = log2(vLogDepthW) / log2(depthValues.y + 1.0);
      gl_FragColor = vec4(vViewPos.z, 0.0, 0.0, 1.0);
    }`;
  const mat = new ShaderMaterial(
    `${bodyId}-terrain-depth`,
    scene,
    { vertex: name, fragment: name },
    {
      attributes: ["position", TERRAIN_MORPH_KIND],
      uniforms: ["world", "view", "viewProjection", "depthValues"],
    },
  );
  mat.backFaceCulling = true;
  return mat;
}
