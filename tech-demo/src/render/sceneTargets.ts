/**
 * Scene-wide render targets shared by several effects:
 *
 *  - depth: one DepthRenderer storing camera-space z in a float target. It
 *    contains every opaque (and alpha-tested) mesh except background layers
 *    (starfield, sun corona), so clouds, haze and the ocean waterline all see
 *    the ship, trees and terrain. 0 means "nothing drawn here" (sky).
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
  Texture,
  AbstractMesh,
} from "@babylonjs/core";

export interface SceneTargets {
  depthRenderer: DepthRenderer;
  depth(): Texture;
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
    refraction,
    setRefractionFilter: (f) => {
      filter = f;
    },
    setRefractionEnabled: (on) => {
      refraction.refreshRate = on ? 1 : 0;
    },
  };
}
