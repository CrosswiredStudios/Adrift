/**
 * Shared per-scene ocean GPU helpers. Two planets share one depth renderer
 * + half-res refraction target; the WeakMap owns them per scene so bodies
 * never double-allocate. Extracted from ocean.ts (Phase 2 split).
 */
import { Color4, RenderTargetTexture, Scene, Texture } from "@babylonjs/core";
import type { DepthRenderer } from "@babylonjs/core";

export interface OceanShared {
  depth: DepthRenderer;
  refr: RenderTargetTexture;
}

const SHARED = new WeakMap<Scene, OceanShared>();

export function getOceanShared(scene: Scene): OceanShared {
  let shared = SHARED.get(scene);
  if (!shared) {
    const depth = scene.enableDepthRenderer();
    const engine = scene.getEngine();
    const size = (): { width: number; height: number } => ({
      width: Math.max(256, Math.floor(engine.getRenderWidth() / 2)),
      height: Math.max(128, Math.floor(engine.getRenderHeight() / 2)),
    });
    const refr = new RenderTargetTexture("ocean-refr", size(), scene, false);
    refr.clearColor = new Color4(0, 0, 0, 0);
    refr.wrapU = Texture.CLAMP_ADDRESSMODE;
    refr.wrapV = Texture.CLAMP_ADDRESSMODE;
    scene.customRenderTargets.push(refr);
    shared = { depth, refr };
    SHARED.set(scene, shared);
    engine.onResizeObservable.add(() => {
      const rt = refr as unknown as { resize?: (s: { width: number; height: number }) => void };
      rt.resize?.(size());
    });
  }
  return shared;
}
