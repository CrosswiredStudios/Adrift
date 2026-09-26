import { Color3 } from "@babylonjs/core";

/**
 * Vegetation look: per-biome tuning for the instanced flora (SRP: biome
 * tuning lives here; loading + placement + instancing consume it).
 * Extracted verbatim from vegetation.ts so existing looks are identical.
 */
export interface VegetationLook {
  /** Bark maps for the trunks (albedo + normal). */
  barkColor: string;
  barkNormal: string;
  /** Broadleaf canopy cutouts (dense beech leaves). */
  canopyColor: string;
  canopyOpacity: string;
  /** Conifer canopy cutouts (fir needle branches). */
  needleColor: string;
  needleOpacity: string;
  /** Shrub / weed cutouts. */
  plantsColor: string;
  plantsOpacity: string;
  /** Grass tufts. */
  firColor: string;
  firOpacity: string;
  /** Tree instance cap (split between the two species by `broadleafRatio`). */
  trees: number;
  broadleafRatio: number;
  shrubs: number;
  grass: number;
  /** Normalized height above which the layer stops growing (tree line). */
  treeLine: number;
  shrubLine: number;
  grassLine: number;
  /** Reject |dir.y| above this (polar caps / ice). */
  treePolar: number;
  shrubPolar: number;
  grassPolar: number;
  /** Reject terrain gradient (normalized height per radian) above this. */
  treeSlope: number;
  shrubSlope: number;
  grassSlope: number;
  /** Required height above sea level (normalized) - keeps off the beach/wash. */
  treeShore: number;
  shrubShore: number;
  grassShore: number;
  /** Forest clumping: fbm frequency + accept window on the 0..1 mask. */
  forestScale: number;
  forestLo: number;
  forestHi: number;
  /** Trees above this normalized height always become conifers. */
  coniferAlt: number;
  /** Base heights (world units) for the shared geometry. */
  treeHeight: number;
  coniferHeight: number;
  shrubHeight: number;
  grassHeight: number;
  /** Per-instance uniform scale ranges. */
  treeScale: [number, number];
  shrubScale: [number, number];
  grassScale: [number, number];
  /** Instance tints multiplied with the texture. */
  broadleafTint: Color3;
  coniferTint: Color3;
  shrubTint: Color3;
  grassTint: Color3;
  /** Subtle wind sway on the cutout materials. */
  sway: boolean;
  swayAmp: number;
  swayFreq: number;
}

/** Vael-flavoured defaults: temperate, wooded lowlands, conifers up the hills. */
export const defaultVegetationLook: VegetationLook = {
  barkColor: "/textures/vegetation/bark_color.jpg",
  barkNormal: "/textures/vegetation/bark_normal.jpg",
  canopyColor: "/textures/vegetation/canopy_color.jpg",
  canopyOpacity: "/textures/vegetation/canopy_opacity.jpg",
  needleColor: "/textures/vegetation/needles_color.jpg",
  needleOpacity: "/textures/vegetation/needles_opacity.jpg",
  plantsColor: "/textures/vegetation/plants_color.jpg",
  plantsOpacity: "/textures/vegetation/plants_opacity.jpg",
  firColor: "/textures/vegetation/grass_color.jpg",
  firOpacity: "/textures/vegetation/grass_opacity.jpg",
  trees: 3200,
  broadleafRatio: 0.72,
  shrubs: 2600,
  grass: 1600,
  treeLine: 0.45,
  shrubLine: 0.62,
  grassLine: 0.52,
  treePolar: 0.78,
  shrubPolar: 0.88,
  grassPolar: 0.85,
  treeSlope: 2.7,
  shrubSlope: 3.2,
  grassSlope: 3.6,
  treeShore: 0.02,
  shrubShore: 0.012,
  grassShore: 0.008,
  forestScale: 2.6,
  forestLo: 0.36,
  forestHi: 0.6,
  coniferAlt: 0.28,
  treeHeight: 8.5,
  coniferHeight: 10,
  shrubHeight: 2.2,
  grassHeight: 1.5,
  treeScale: [0.7, 1.35],
  shrubScale: [0.75, 1.5],
  grassScale: [0.7, 1.6],
  broadleafTint: new Color3(1.0, 1.18, 0.85),
  coniferTint: new Color3(0.95, 1.12, 0.85),
  shrubTint: new Color3(1.0, 1.18, 0.85),
  grassTint: new Color3(0.95, 1.05, 0.7),
  sway: true,
  swayAmp: 0.14,
  swayFreq: 1.1,
};
