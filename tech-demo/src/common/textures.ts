/**
 * Shared texture-loading helpers. One home for the load-with-procedural-
 * fallback pattern used by ground and foliage materials: missing CC0 files
 * fall back to seeded stand-ins and are reported in `fallbacks`.
 */
import { Color3, DynamicTexture, Scene, Texture } from "@babylonjs/core";
import { fbm } from "../terrain/noise";
import { clamp01 } from "./math";

export function configureTiledTexture(tex: Texture): void {
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  tex.hasAlpha = false;
}

/** Flat tangent-space normal (no perturbation) for missing normal maps. */
export function makeFlatNormal(scene: Scene, name: string): Texture {
  const tex = new DynamicTexture(name, { width: 4, height: 4 }, scene, true);
  const ctx = tex.getContext();
  ctx.fillStyle = "rgb(128,128,255)";
  ctx.fillRect(0, 0, 4, 4);
  tex.update();
  configureTiledTexture(tex);
  return tex;
}

/** Procedural stand-in (seeded FBM mottle) for missing albedo maps. */
export function makeFallbackTexture(scene: Scene, name: string, tint: Color3, seed: number): Texture {
  const size = 256;
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const coarse = fbm(x * 0.045, y * 0.045, seed * 0.37, 4, seed) * 0.5 + 0.5;
      const fine = fbm(x * 0.31, y * 0.31, seed * 0.11, 2, seed + 5) * 0.5 + 0.5;
      const v = clamp01(coarse * 0.7 + fine * 0.3);
      const shade = 0.55 + v * 0.6;
      d[o] = Math.round(Math.min(1, tint.r * shade) * 255);
      d[o + 1] = Math.round(Math.min(1, tint.g * shade) * 255);
      d[o + 2] = Math.round(Math.min(1, tint.b * shade) * 255);
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update();
  configureTiledTexture(tex);
  return tex;
}

export interface FallbackLoad {
  /** Live texture (replaced procedurally on load failure). */
  texture: Texture;
  /** Names that failed and were replaced. Shared array across a set. */
  fallbacks: string[];
  /** Reassign target used by the onError closure. */
  reassign: (t: Texture) => void;
}

/**
 * Load one texture with procedural fallback on error. The caller keeps the
 * returned handle and applies `reassign` when swapping (mirrors the existing
 * terrain/vegetation pattern so call sites stay small).
 */
export function loadWithFallback(
  scene: Scene,
  name: string,
  url: string,
  opts: { isNormal: boolean; tint: Color3; seed: number; fallbacks: string[] },
  assign: (t: Texture) => void,
): Texture {
  const tex = new Texture(url, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE, null, () => {
    opts.fallbacks.push(name);
    assign(
      opts.isNormal
        ? makeFlatNormal(scene, `${name}-fallback`)
        : makeFallbackTexture(scene, `${name}-fallback`, opts.tint, opts.seed),
    );
  });
  tex.name = name;
  configureTiledTexture(tex);
  return tex;
}
