import { Constants } from "@babylonjs/core/Engines/constants";
import { Camera, DynamicTexture, Mesh, Scene, ShaderMaterial, Vector3 } from "@babylonjs/core";
import { clamp01, smoothstep } from "../common/math";
import { fbm3 } from "../common/noise";
import { CloudVolume, CloudVolumePartial, createCloudVolume } from "./cloudVolume";

/**
 * Night-lights + cloud shells for one planet (SRP: sky extras live here,
 * ground + ocean assembly lives in planetSurface.ts). Extracted verbatim
 * from buildPlanetSurface so the visuals are byte-identical.
 */

export interface NightLightsInput {
  seed: number;
  radius: number;
}

export interface NightLights {
  material: ShaderMaterial;
  /** Parents the overlay shell to the ground mesh. */
  attachTo(ground: Mesh): void;
  update(sunDir: Vector3): void;
}

/**
 * Night-side city lights: emissive speckle texture masked to land, shown on
 * the dark side. ShaderMaterial (not StandardMaterial): the emissive-texture
 * define silently stayed unsampled, which rendered a flat warm layer over
 * the whole ocean.
 */
export function buildNightLights(scene: Scene, name: string, input: NightLightsInput): NightLights {
  const size = 512;
  const tex = new DynamicTexture(`${name}-night`, { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size, size);
  let s = input.seed;
  const rand = (): number => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < 2600; i++) {
    const x = rand() * size,
      y = rand() * size;
    const warm = rand();
    ctx.fillStyle = warm > 0.7 ? "rgba(255,190,120,0.9)" : "rgba(255,230,170,0.75)";
    const r = rand() * 1.6 + 0.4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  tex.update();
  tex.hasAlpha = false;
  const nightMat = new ShaderMaterial(
    `${name}-night-mat`,
    scene,
    {
      vertexSource: `
          precision highp float;
          attribute vec3 position;
          attribute vec3 normal;
          attribute vec2 uv;
          uniform mat4 worldViewProjection;
          varying vec2 vUv;
          varying vec3 vN;
          void main() {
            vUv = uv;
            vN = normalize(normal);
            gl_Position = worldViewProjection * vec4(position, 1.0);
          }`,
      fragmentSource: `
          precision highp float;
          varying vec2 vUv;
          varying vec3 vN;
          uniform sampler2D uNightTex;
          uniform vec3 uSunToward;
          uniform float uGlow;
          void main() {
            vec3 up = normalize(vN);
            float day = smoothstep(-0.12, 0.22, dot(up, uSunToward));
            vec3 c = texture2D(uNightTex, vUv).rgb * uGlow * (1.0 - day);
            gl_FragColor = vec4(c, 1.0);
          }`,
    },
    {
      attributes: ["position", "normal", "uv"],
      uniforms: ["worldViewProjection", "uSunToward", "uGlow"],
      samplers: ["uNightTex"],
      needAlphaBlending: true,
      needAlphaTesting: false,
    },
  );
  nightMat.alphaMode = Constants.ALPHA_ADD; // black texels add nothing over the sea
  nightMat.setTexture("uNightTex", tex);
  nightMat.setFloat("uGlow", 1.0);
  nightMat.setVector3("uSunToward", new Vector3(0, 1, 0));
  return {
    material: nightMat,
    attachTo: (ground: Mesh) => {
      // Night lights overlay: slightly larger transparent shell with emissive speckle.
      const night = Mesh.CreateSphere(`${name}-night-shell`, 64, input.radius * 2 * 1.002, scene);
      night.material = nightMat;
      night.parent = ground;
      night.isPickable = false;
    },
    update: (sunDir: Vector3) => {
      // Additive city glow, driven per fragment by the sun's angle (dark side only).
      nightMat.setVector3("uSunToward", sunDir.scale(-1));
    },
  };
}

export interface CloudsInput {
  radius: number;
  relief: number;
  segments: number;
  coverage: number;
  /** Seed for the density field (defaults to 1337). */
  seed?: number;
  /** Slab thickness in world units (defaults to ~2.3% of radius). */
  thickness?: number;
  /** Cloud base altitude above the mean radius (defaults to thickness * 0.9). */
  baseHeight?: number;
}

/** Cloud quality tiers, ordered best-first. H cycles them; default is ultra. */
export type CloudTier = "ultra" | "high" | "balanced" | "lite";

export const CLOUD_TIERS: CloudTier[] = ["ultra", "high", "balanced", "lite"];

/** Raymarch step counts per tier: [viewSteps, lightSteps]. */
export const CLOUD_TIER_STEPS: Record<CloudTier, [number, number]> = {
  ultra: [64, 10],
  high: [48, 8],
  balanced: [28, 6],
  lite: [0, 0],
};

/** Post-process render scale per tier (lite disables the deck). */
export const CLOUD_TIER_SCALE: Record<CloudTier, number> = {
  ultra: 0.6,
  high: 0.5,
  balanced: 0.35,
  lite: 0.35,
};

/** CPU mirror of the cloud density slab (also drives view obstruction). */
export interface CloudField {
  seed: number;
  coverage: number;
  innerR: number;
  outerR: number;
}

export interface Clouds {
  /** Legacy shell mesh (kept for the smoke test + hide-deck helpers). Hidden. */
  mesh: Mesh;
  field: CloudField;
  bounds: { innerR: number; outerR: number };
  tier: CloudTier;
  /** True while the volume pass pair is attached to the camera. */
  readonly enabled: boolean;
  setTier(tier: CloudTier): void;
  /** 0..1 cloud density at a world point (0 outside the slab). */
  sample(point: Vector3, time: number): number;
  /** World-space center the density field is evaluated around. */
  center(): Vector3;
  /** Move the deck (CPU field + GPU slab) to a new planet center. */
  setCenter(center: Vector3): void;
  update(dt: number, sunDir: Vector3): void;
}

/**
 * Deterministic cloud density in 0..1. Domain-warped FBM over the shell
 * direction (matches the shader's pattern), gated by a vertical slab profile
 * so density is zero outside [innerR, outerR]. Coverage remaps the FBM the
 * same way the shader's smoothstep does.
 */
export function cloudDensityAtPoint(
  field: CloudField,
  center: Vector3,
  point: Vector3,
  time: number,
): number {
  const toPoint = point.subtract(center);
  const r = toPoint.length();
  if (r < field.innerR || r > field.outerR) return 0;
  const dir = toPoint.scale(1 / Math.max(r, 1e-6));
  const drift = time * 0.004;
  // Match the shader: p = dir * 6 + drift, warped by a second FBM sample.
  const warp = fbm3(dir.x * 6 * 1.7 + drift, dir.y * 6 * 1.7, dir.z * 6 * 1.7, 5, field.seed + 17);
  const d =
    fbm3(
      dir.x * 6 + warp * 0.8 + drift,
      dir.y * 6 + warp * 0.8,
      dir.z * 6 + warp * 0.8 + drift * 0.5,
      5,
      field.seed,
    ) *
      0.5 +
    0.5;
  const lo = 1 - field.coverage - 0.25;
  const hi = 1 - field.coverage + 0.35;
  const cover = smoothstep(lo, hi, d);
  // Vertical slab profile: fade at both faces so fly-through has soft edges.
  const t = (r - field.innerR) / Math.max(field.outerR - field.innerR, 1e-6);
  const profile = Math.sin(Math.PI * clamp01(t)) ** 0.7;
  return clamp01(cover * profile);
}

/**
 * Volumetric cloud deck, playground-style (#MAONNT#13): a weather-map shaped
 * slab raymarched as a camera post-process with depth-aware compositing,
 * Beer-law light marching, and a spatial denoise pass. The slab is
 * planet-relative (base altitude + thickness above the mean radius), so orbit,
 * horizon, and fly-through views all accumulate real optical depth along each
 * view ray. A CPU density mirror drives the in-cloud view-obstruction veil.
 *
 * The legacy `${name}-clouds` shell mesh is kept (hidden) so existing
 * hide-deck test helpers and the smoke test keep resolving.
 */
export function buildClouds(
  scene: Scene,
  name: string,
  input: CloudsInput,
  camera?: Camera,
  volumePatch?: CloudVolumePartial,
): Clouds {
  const seed = input.seed ?? 1337;
  const thickness = input.thickness ?? Math.max(14, input.radius * 0.023);
  const baseHeight = input.baseHeight ?? thickness * 0.9;
  const innerR = input.radius + baseHeight;
  const outerR = innerR + thickness;
  const field: CloudField = { seed, coverage: input.coverage, innerR, outerR };
  // Hidden placeholder: tests hide the deck via setEnabled on this mesh.
  const clouds = Mesh.CreateSphere(`${name}-clouds`, 8, 1, scene);
  clouds.isVisible = false;
  clouds.isPickable = false;
  clouds.setEnabled(false);

  const cam = camera ?? scene.activeCamera;
  let volume: CloudVolume | null = null;
  if (cam) {
    volume = createCloudVolume(scene, cam, {
      center: new Vector3(0, 0, 0),
      radius: input.radius,
      baseHeight,
      thickness,
      coverage: input.coverage,
      seed,
      ...volumePatch,
    });
  }

  let cloudTime = 0;
  let tier: CloudTier = "ultra";
  const applyTier = (next: CloudTier): void => {
    tier = next;
    const [view, light] = CLOUD_TIER_STEPS[next];
    volume?.setOptions({ marchSteps: view, lightSteps: light, renderScale: CLOUD_TIER_SCALE[next] });
    volume?.setEnabled(next !== "lite");
  };
  applyTier("ultra");
  return {
    mesh: clouds,
    field,
    bounds: { innerR, outerR },
    get tier() {
      return tier;
    },
    get enabled() {
      return volume?.enabled ?? false;
    },
    setTier: (next: CloudTier) => {
      applyTier(next);
    },
    sample: (point: Vector3, time: number) => {
      return cloudDensityAtPoint(field, clouds.position.clone(), point, time);
    },
    /** World-space center the density field is evaluated around. */
    center: () => clouds.position.clone(),
    setCenter: (center: Vector3) => {
      clouds.position.copyFrom(center);
      volume?.setCenter(center);
    },
    update: (dt: number, sunDir: Vector3) => {
      cloudTime += dt;
      volume?.setSunDirection(sunDir.scale(-1));
      volume?.update(dt);
    },
  };
}
