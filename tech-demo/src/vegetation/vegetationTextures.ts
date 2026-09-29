import { Color3, DynamicTexture, RawTexture, Scene, Texture } from "@babylonjs/core";
import { fbm } from "../terrain/noise";
import { clamp01 } from "../common/math";
import { mulberry32 } from "../common/rng";
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
  /** Procedural grass tuft (colour + alpha in one RGBA map). */
  grass: Texture;
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
      const v = fbm(x * 0.055, y * 0.055, seed * 0.17, 4, seed) * 0.5 + 0.5;
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
  out.grass = makeGrassTuft(scene, `${name}-veg-grass`, 11);
  asOpacity(out.canopyOpacity);
  asOpacity(out.needleOpacity);
  asOpacity(out.plantsOpacity);
  return out;
}

const whenReady = (t: Texture): Promise<void> =>
  new Promise((resolve) => {
    if (t.isReady()) resolve();
    else t.onLoadObservable.addOnce(() => resolve());
  });

/**
 * Bake a luminance opacity map into the alpha channel of a colour map.
 *
 * Alpha-tested materials with a separate opacity texture render fine, but
 * Babylon's depth renderer alpha-tests with the *albedo* alpha only, so the
 * cards would land in the scene depth as solid quads. With the opacity in
 * albedo alpha, foliage can be part of the scene depth (correct haze, clouds
 * and waterline around trees). Resolves to null if the maps can't be merged
 * (different sizes, unreadable), in which case the caller keeps the split maps.
 */
export async function mergeOpacityIntoAlbedo(
  scene: Scene,
  name: string,
  color: Texture,
  opacity: Texture,
): Promise<Texture | null> {
  await Promise.all([whenReady(color), whenReady(opacity)]);
  const cs = color.getSize();
  const os = opacity.getSize();
  if (cs.width !== os.width || cs.height !== os.height || cs.width === 0) return null;
  const [c, o] = await Promise.all([color.readPixels(), opacity.readPixels()]);
  if (!(c instanceof Uint8Array) || !(o instanceof Uint8Array)) return null;
  const out = new Uint8Array(c.length);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = c[i];
    out[i + 1] = c[i + 1];
    out[i + 2] = c[i + 2];
    out[i + 3] = o[i];
  }
  const tex = RawTexture.CreateRGBATexture(
    out,
    cs.width,
    cs.height,
    scene,
    true,
    false,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  tex.name = name;
  tex.gammaSpace = color.gammaSpace;
  tex.anisotropicFilteringLevel = color.anisotropicFilteringLevel;
  tex.wrapU = color.wrapU;
  tex.wrapV = color.wrapV;
  return tex;
}

/**
 * Grass tuft card: a few dozen tapered, slightly curved blades rising from
 * the bottom edge, drawn procedurally with colour and alpha in one RGBA map
 * (so the depth pass alpha-tests it too). Darker at the base for a cheap
 * ambient-occlusion look.
 */
export function makeGrassTuft(scene: Scene, name: string, seed: number): Texture {
  const W = 256;
  const H = 256;
  const tex = new DynamicTexture(name, { width: W, height: H }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  tex.hasAlpha = true;
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, W, H);
  // Texture rows are uploaded bottom-up relative to the canvas: draw
  // flipped so the blade roots end up on the card's bottom edge.
  ctx.save();
  ctx.translate(0, H);
  ctx.scale(1, -1);
  const rng = mulberry32(seed);
  const blades = 46;
  for (let i = 0; i < blades; i++) {
    const x0 = W * (0.08 + 0.84 * rng());
    const h = H * (0.45 + 0.53 * rng());
    const lean = (rng() - 0.5) * W * 0.35;
    const w = 3 + rng() * 5;
    const tipX = x0 + lean;
    const tipY = H - h;
    const ctrlX = x0 + lean * 0.25;
    const ctrlY = H - h * 0.55;
    const light = 0.75 + 0.5 * rng();
    const grad = ctx.createLinearGradient(0, H, 0, tipY);
    const base = (k: number, a = 1): string =>
      `rgba(${Math.round(52 * k * light)}, ${Math.round(88 * k * light)}, ${Math.round(30 * k * light)}, ${a})`;
    grad.addColorStop(0, base(0.45));
    grad.addColorStop(0.35, base(0.9));
    grad.addColorStop(
      1,
      `rgba(${Math.round(150 * light)}, ${Math.round(160 * light)}, ${Math.round(70 * light)}, 1)`,
    );
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x0 - w, H);
    ctx.quadraticCurveTo(ctrlX - w * 0.6, ctrlY, tipX, tipY);
    ctx.quadraticCurveTo(ctrlX + w * 0.6, ctrlY, x0 + w, H);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  tex.update(false);
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}
