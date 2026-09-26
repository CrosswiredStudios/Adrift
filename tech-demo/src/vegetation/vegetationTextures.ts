import { Color3, DynamicTexture, Scene, Texture } from "@babylonjs/core";
import { fbm3 } from "../common/noise";
import { clamp01 } from "../common/math";
import { makeFallbackTexture, makeFlatNormal } from "../common/textures";
import type { VegetationLook } from "./vegetationLook";

/**
 * Vegetation texture loading (SRP: map loading + procedural fallbacks live
 * here; placement + instancing live in vegetation.ts). Extracted verbatim
 * from loadVegetationTextures so the loaded maps are identical.
 */

export interface VegetationTextures {
  barkColor: Texture;
  barkNormal: Texture;
  canopyColor: Texture;
  canopyOpacity: Texture;
  needleColor: Texture;
  needleOpacity: Texture;
  plantsColor: Texture;
  plantsOpacity: Texture;
  firColor: Texture;
  firOpacity: Texture;
  /** Names of the maps that failed to load and were replaced procedurally. */
  fallbacks: string[];
}

/** Soft leafy blob mask (luminance = opacity) used when an opacity map is missing. */
function makeFallbackOpacity(scene: Scene, name: string, seed: number): Texture {
  const size = 128;
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      const v = fbm3(x * 0.055, y * 0.055, seed * 0.17, 4, seed) * 0.5 + 0.5;
      const dx = (x / size - 0.5) * 2,
        dy = (y / size - 0.5) * 2;
      const edge = 1 - Math.min(1, Math.hypot(dx, dy));
      const lum = clamp01(v * 1.05 + edge * 0.75 - 0.5);
      const g = Math.round(lum * 255);
      d[o] = g;
      d[o + 1] = g;
      d[o + 2] = g;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update();
  return tex;
}

function loadOne(
  scene: Scene,
  name: string,
  url: string,
  fallbacks: string[],
  makeFallback: () => Texture,
  assign: (t: Texture) => void,
): Texture {
  const tex = new Texture(url, scene, false, false, Texture.TRILINEAR_SAMPLINGMODE, null, () => {
    fallbacks.push(name);
    assign(makeFallback());
  });
  tex.name = name;
  tex.anisotropicFilteringLevel = 4;
  return tex;
}

/** Loads the ten vegetation maps, substituting procedural stand-ins on failure. */
export function loadVegetationTextures(scene: Scene, name: string, look: VegetationLook): VegetationTextures {
  const fallbacks: string[] = [];
  const green =
    (r: number, g: number, b: number, seed: number): (() => Texture) =>
    () =>
      makeFallbackTexture(scene, `${name}-veg-fb-${seed}`, new Color3(r, g, b), seed);
  const opacityFb =
    (seed: number): (() => Texture) =>
    () =>
      makeFallbackOpacity(scene, `${name}-veg-opacity-fb-${seed}`, seed);
  // The opacity maps are grayscale; the shader reads their luminance (and they
  // must not go through the sRGB conversion the albedo maps get).
  const asOpacity = (t: Texture): Texture => {
    t.getAlphaFromRGB = true;
    t.gammaSpace = false;
    return t;
  };

  const out = {} as VegetationTextures;
  out.fallbacks = fallbacks;
  out.barkColor = loadOne(
    scene,
    `${name}-veg-bark`,
    look.barkColor,
    fallbacks,
    green(0.32, 0.24, 0.16, 3),
    (t) => {
      out.barkColor = t;
    },
  );
  out.barkNormal = loadOne(
    scene,
    `${name}-veg-bark-n`,
    look.barkNormal,
    fallbacks,
    () => makeFlatNormal(scene, `${name}-veg-flat-n`),
    (t) => {
      out.barkNormal = t;
    },
  );
  out.canopyColor = loadOne(
    scene,
    `${name}-veg-canopy`,
    look.canopyColor,
    fallbacks,
    green(0.36, 0.52, 0.24, 17),
    (t) => {
      out.canopyColor = t;
    },
  );
  out.canopyOpacity = loadOne(
    scene,
    `${name}-veg-canopy-o`,
    look.canopyOpacity,
    fallbacks,
    opacityFb(19),
    (t) => {
      out.canopyOpacity = asOpacity(t);
    },
  );
  out.needleColor = loadOne(
    scene,
    `${name}-veg-needle`,
    look.needleColor,
    fallbacks,
    green(0.24, 0.42, 0.2, 23),
    (t) => {
      out.needleColor = t;
    },
  );
  out.needleOpacity = loadOne(
    scene,
    `${name}-veg-needle-o`,
    look.needleOpacity,
    fallbacks,
    opacityFb(29),
    (t) => {
      out.needleOpacity = asOpacity(t);
    },
  );
  out.plantsColor = loadOne(
    scene,
    `${name}-veg-plants`,
    look.plantsColor,
    fallbacks,
    green(0.3, 0.48, 0.2, 5),
    (t) => {
      out.plantsColor = t;
    },
  );
  out.plantsOpacity = loadOne(
    scene,
    `${name}-veg-plants-o`,
    look.plantsOpacity,
    fallbacks,
    opacityFb(7),
    (t) => {
      out.plantsOpacity = asOpacity(t);
    },
  );
  out.firColor = loadOne(
    scene,
    `${name}-veg-fir`,
    look.firColor,
    fallbacks,
    green(0.26, 0.44, 0.18, 11),
    (t) => {
      out.firColor = t;
    },
  );
  out.firOpacity = loadOne(scene, `${name}-veg-fir-o`, look.firOpacity, fallbacks, opacityFb(13), (t) => {
    out.firOpacity = asOpacity(t);
  });
  asOpacity(out.canopyOpacity);
  asOpacity(out.needleOpacity);
  asOpacity(out.plantsOpacity);
  asOpacity(out.firOpacity);
  return out;
}
