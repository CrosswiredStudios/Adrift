/**
 * Scene-wide render targets shared by several effects:
 *
 *  - depth: one DepthRenderer storing camera-space z in a float target. It
 *    contains every opaque (and alpha-tested) mesh except background layers
 *    (starfield, sun corona), so clouds, haze and the ocean waterline all see
 *    the ship, trees and terrain. 0 means "nothing drawn here" (sky).
 *    The depth pass itself depth-tests with a *logarithmic* depth buffer
 *    (see patchDepthShaders): Babylon's depth shader uses a plain
 *    perspective depth, and with near 5 cm / far 2000 km that resolves
 *    only metres at a kilometre, so the stored depth of the shore and
 *    distant terrain flickered frame to frame while flying.
 *  - refraction: half-res colour of the terrain under the host body's
 *    ocean, sampled by the water shader for refraction.
 */
import {
  Camera,
  Color4,
  Constants,
  DepthRenderer,
  RenderTargetTexture,
  Scene,
  ShaderStore,
  Texture,
  AbstractMesh,
} from "@babylonjs/core";
import "@babylonjs/core/Shaders/depth.vertex";
import "@babylonjs/core/Shaders/depth.fragment";

/**
 * Give Babylon's depth-renderer shaders a logarithmic depth test (same
 * formula as the main pass). The log constant is derived from the
 * `depthValues` uniform the depth renderer already binds (y = near + far),
 * so no new uniforms are needed. Returns false (and leaves the shaders
 * alone) if a Babylon update changed the sources.
 */
export function patchDepthShaders(): boolean {
  const store = ShaderStore.ShadersStore;
  const vs = store["depthVertexShader"];
  const fs = store["depthPixelShader"];
  if (!vs || !fs || vs.includes("vLogDepthW")) return !!vs && vs.includes("vLogDepthW");
  const vAnchor = "gl_Position=viewProjection*worldPos;";
  const vDecl = "varying float vDepthMetric;";
  const fMain = "void main(void)\n{";
  if (!vs.includes(vAnchor) || !vs.includes(vDecl) || !fs.includes(vDecl) || !fs.includes(fMain)) {
    console.warn("Adrift: depth shader layout changed; depth pass keeps linear depth");
    return false;
  }
  store["depthVertexShader"] = vs
    .replace(vDecl, `${vDecl}\nvarying float vLogDepthW;`)
    .replace(
      vAnchor,
      `${vAnchor}\nvLogDepthW=1.0+gl_Position.w;` +
        `gl_Position.z=log2(max(0.000001,vLogDepthW))*(2.0/log2(depthValues.y+1.0));`,
    );
  store["depthPixelShader"] = fs
    .replace(vDecl, `${vDecl}\nvarying float vLogDepthW;\nuniform vec2 depthValues;`)
    .replace(fMain, `${fMain}\ngl_FragDepthEXT=log2(vLogDepthW)/log2(depthValues.y+1.0);`);
  return true;
}

export interface SceneTargets {
  depthRenderer: DepthRenderer;
  depth(): Texture;
  /** Render pass of the depth map (for per-pass materials, see terrainDepth). */
  depthRenderPassId: number;
  refraction: RenderTargetTexture;
  /** Which meshes the refraction target renders (host body's terrain). */
  setRefractionFilter(filter: (m: AbstractMesh) => boolean): void;
  setRefractionEnabled(on: boolean): void;
}

/** Tag a mesh so it stays out of the scene depth (background layers). */
export function markNoDepth(mesh: AbstractMesh): void {
  mesh.metadata = { ...(mesh.metadata ?? {}), noDepth: true };
}

export function clearNoDepth(mesh: AbstractMesh): void {
  if (mesh.metadata?.noDepth) mesh.metadata = { ...mesh.metadata, noDepth: false };
}

export function createSceneTargets(scene: Scene, camera: Camera): SceneTargets {
  patchDepthShaders();
  const depthRenderer = scene.enableDepthRenderer(
    camera,
    false,
    true,
    Constants.TEXTURE_NEAREST_SAMPLINGMODE,
    true,
  );
  depthRenderer.useOnlyInActiveCamera = true;
  const map = depthRenderer.getDepthMap();
  map.renderListPredicate = (m) => !m.metadata?.noDepth && m.isEnabled() && m.isVisible;

  const engine = scene.getEngine();
  const size = (): { width: number; height: number } => ({
    width: Math.max(256, Math.floor(engine.getRenderWidth() / 2)),
    height: Math.max(128, Math.floor(engine.getRenderHeight() / 2)),
  });
  const refraction = new RenderTargetTexture("ocean-refraction", size(), scene, false);
  refraction.clearColor = new Color4(0, 0, 0, 0);
  refraction.wrapU = Texture.CLAMP_ADDRESSMODE;
  refraction.wrapV = Texture.CLAMP_ADDRESSMODE;
  refraction.activeCamera = camera;
  let filter: (m: AbstractMesh) => boolean = () => false;
  refraction.renderListPredicate = (m) => filter(m) && m.isEnabled();
  scene.customRenderTargets.push(refraction);
  engine.onResizeObservable.add(() => {
    refraction.resize(size());
    // The depth map is created at the canvas size of the moment (it can be
    // the 300x150 default before layout) and doesn't follow resizes by itself.
    map.resize({ width: engine.getRenderWidth(), height: engine.getRenderHeight() });
  });

  return {
    depthRenderer,
    depth: () => map,
    depthRenderPassId: map.renderPassId,
    refraction,
    setRefractionFilter: (f) => {
      filter = f;
    },
    setRefractionEnabled: (on) => {
      refraction.refreshRate = on ? 1 : 0;
    },
  };
}
