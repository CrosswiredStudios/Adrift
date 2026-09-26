import {
  Scene, Mesh, VertexData, Vector3, Color3, Color4,
  PBRMaterial, ShaderMaterial, StandardMaterial, MaterialPluginBase, Material,
  DynamicTexture, ParticleSystem, Texture, RawTexture, UniformBuffer,
} from "@babylonjs/core";
import { Constants } from "@babylonjs/core/Engines/constants";
import { fbm3 } from "./noise";
import { createOcean, OceanResult } from "./ocean";
import { WaveSettings, SwashParams, swashGLSL } from "./oceanWaves";
import { SkyPalette, FAST_NOISE_GLSL, glslNum } from "./shaderChunks";
import {
  attachTerrain, loadTerrainTextures, TerrainHandle, TerrainLook,
} from "./terrainMaterial";

/**
 * Coastal cross-section shaping. The raw FBM terrain meets the sea at whatever
 * slope it happens to have (mostly cliffs); these parameters carve a gentle
 * beach band above sea level, a shallow shelf below it and deeper basins
 * further out, so waves can shoal, break and run up.
 */
export interface ShoresOptions {
  /** Normalized height band above sea level pulled toward the waterline. */
  beachBand: number;
  /** Slope multiplier right at the waterline (0.35 = ~3x gentler than raw). */
  beachSlope: number;
  /** Normalized depth band below sea level flattened into a shallow shelf. */
  shelfBand: number;
  shelfSlope: number;
  /** Extra depth multiplier applied to the deep basins. */
  deepGain: number;
}

export const defaultShores: ShoresOptions = {
  beachBand: 0.03, beachSlope: 0.5, shelfBand: 0.075, shelfSlope: 0.5, deepGain: 1.2,
};

/** Ocean look, overridable per planet. */
export interface OceanLook {
  shallowColor: Color3;
  deepColor: Color3;
  foamColor: Color3;
  /** Alpha of the water at the shore (deep water is opaque). */
  shallowAlpha: number;
  /** Depth (world units) over which shallow water turns deep. */
  depthFade: number;
}

export interface SurfaceOptions {
  radius: number;
  seed: number;
  /** Max terrain relief as fraction of radius. */
  relief: number;
  segments: number;
  groundAlbedo: Color3;
  waterLevel: number; // normalized height [-1,1] below which is ocean
  waterColor: Color3;
  iceCaps: boolean;
  nightLights: boolean;
  clouds: boolean;
  cloudCoverage: number;
  /** Coastal shaping (see ShoresOptions). */
  shore: ShoresOptions;
  /** Ocean look overrides. */
  ocean?: Partial<OceanLook>;
  /** Wave settings (sea state / wind). Defaults to a mild sea. */
  waves?: WaveSettings;
  /** Atmosphere palette used for water reflections. */
  sky?: SkyPalette;
  /** Ground texture blend (undefined = plain vertex-coloured ground). */
  terrain?: TerrainLook;
  /** World position of the planet centre (the ocean meshes stay at the origin). */
  position?: Vector3;
}

export interface SurfaceResult {
  ground: Mesh;
  water: Mesh | null;
  clouds: Mesh | null;
  ocean: OceanResult | null;
  /** Ground texture blend handle (null when no terrain look was configured). */
  terrain: TerrainHandle | null;
  update: (dt: number, sunDir: Vector3, isHost?: boolean) => void;
}

const defaultOptions: SurfaceOptions = {
  radius: 600, seed: 1337, relief: 0.02, segments: 128,
  groundAlbedo: new Color3(0.25, 0.45, 0.3),
  waterLevel: -0.05, waterColor: new Color3(0.05, 0.2, 0.35),
  iceCaps: true, nightLights: true, clouds: true, cloudCoverage: 0.45,
  shore: defaultShores,
};

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Normalized terrain height (same formula the ground mesh is displaced by).
 * Shared by the mesh builder, the ocean shader's baked height field and
 * CPU-side flight collision (see planets.ts `surfaceRadius`) so the visible
 * surface, the water and the flight model never disagree.
 *
 * Landforms are continent + detail FBM, plus a ridged term that only grows
 * where the continents term is high, so crests cluster into mountain ranges
 * with craggy flanks instead of speckling every landmass uniformly.
 */
export function terrainHeightNormalized(
  nx: number, ny: number, nz: number, seed: number, waterLevel: number,
  shore: ShoresOptions = defaultShores
): number {
  const continents = fbm3(nx * 2.2 + 7, ny * 2.2, nz * 2.2, 5, seed);
  const detail = fbm3(nx * 9, ny * 9 + 3, nz * 9, 4, seed + 500);
  const rangeMask = smoothstep(0.05, 0.45, continents);
  const ridged = 1 - Math.abs(fbm3(nx * 5 + 11, ny * 5, nz * 5, 4, seed + 900));
  // Coarse crags on the range flanks (~145 world units wavelength on Vael at
  // 26 cycles per unit sphere — still resolvable by the 192-segment grid).
  const crag = fbm3(nx * 26 + 31, ny * 26, nz * 26, 3, seed + 1200);
  // Fine roughness everywhere (unmasked): keeps coastal plains from sitting
  // flat to within wave height of the waterline, where the sea would sheet
  // foam over ground that reads as land. ~94 world units wavelength on Vael,
  // roughly half a unit of relief — enough to ragged the waterline into a
  // land/water mosaic.
  const roughness = fbm3(nx * 40 + 53, ny * 40, nz * 40, 3, seed + 2300);
  const h = continents * 0.85 + detail * 0.16
    + ((ridged - 0.45) * 1.1 + crag * 0.12) * rangeMask
    + roughness * 0.02;

  // Coastal shaping (C1-continuous through the waterline so normals stay smooth).
  const over = h - waterLevel;
  if (over >= 0) {
    // Beach: slope ramps from `beachSlope` at the waterline to 1 inland.
    return waterLevel + over
      - (1 - shore.beachSlope) * shore.beachBand * (1 - Math.exp(-over / shore.beachBand));
  }
  // Shelf: gentle right below the waterline, then basins deepen with distance.
  const under = -over;
  const shelf = under - (1 - shore.shelfSlope) * shore.shelfBand * (1 - Math.exp(-under / shore.shelfBand));
  const basin = 1 + shore.deepGain * (1 - Math.exp(-under / (shore.shelfBand * 3)));
  return waterLevel - shelf * basin;
}

/**
 * Bake the SHAPED terrain height into an RG (16-bit fixed point) lat-long
 * texture for the ocean shaders, which use it for water depth, shore direction,
 * shoaling/breaking and the surf-zone mask. Encoding is linear, so bilinear
 * filtering reconstructs the 16-bit value exactly.
 */
export function bakeTerrainHeightTexture(
  scene: Scene, name: string, opts: SurfaceOptions, width = 512, height = 256
): RawTexture {
  const data = new Uint8Array(width * height * 4);
  for (let iy = 0; iy < height; iy++) {
    const v = iy / (height - 1);
    const theta = v * Math.PI;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let ix = 0; ix < width; ix++) {
      const u = ix / width;
      const phi = (u - 0.5) * Math.PI * 2; // matches the shader's atan2 convention
      const nx = sinT * Math.cos(phi), ny = cosT, nz = sinT * Math.sin(phi);
      const h = terrainHeightNormalized(nx, ny, nz, opts.seed, opts.waterLevel, opts.shore);
      const u16 = Math.max(0, Math.min(65535, Math.round(((h + 1.5) / 3) * 65535)));
      const o = (iy * width + ix) * 4;
      data[o] = (u16 >> 8) & 255;
      data[o + 1] = u16 & 255;
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  }
  const tex = RawTexture.CreateRGBATexture(data, width, height, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
  tex.name = `${name}-heightmap`;
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

/**
 * Wet-sand band + swash lace on the ground material. Uses the ocean's own swash
 * field (shared `swashGLSL`) and the baked height field, so the wet sand always
 * agrees with the waterline the water shader is drawing: the band advances with
 * the run-up, lingers as a damp strip, and white lace is left behind on the
 * backwash.
 *
 * NOTE: `getCustomCode` is called from the MaterialPluginBase constructor before
 * subclass fields exist, so the configuration is held in a material-keyed
 * registry populated by `attachWetSand` before construction.
 */
interface WetSandConfig {
  heightMap: Texture;
  swash: SwashParams;
  waterLevel: number;
  relief: number;
  radius: number;
}
const WET_SAND = new WeakMap<Material, WetSandConfig>();

class WetSandPlugin extends MaterialPluginBase {
  /** Simulation clock (same as the ocean's), copied into the material UBO. */
  public uWetTime = 0;

  constructor(material: Material) {
    // The 6th argument ACTIVATES the plugin: custom shader code is only
    // injected for active plugins, and without it the wet-sand band never
    // renders (the albedo edits simply never appear in the shader).
    super(material, "WetSand", 210, { WET_SAND: true }, true, true);
  }

  public getClassName(): string {
    return "WetSand";
  }

  public getSamplers(samplers: string[]): void {
    samplers.push("uWetHeightMap");
  }

  public getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [{ name: "uWetTime", size: 1, type: "float" }],
      fragment: "",
    };
  }

  public bindForSubMesh(
    uniformBuffer: UniformBuffer, _scene: unknown, _engine: unknown, _subMesh: unknown
  ): void {
    const cfg = WET_SAND.get(this._material);
    if (!cfg) return;
    this._material.getEffect()?.setTexture("uWetHeightMap", cfg.heightMap);
    // The swash clock lives in the plugin UBO; it must be pushed explicitly or
    // the run-up would sit at a frozen phase.
    uniformBuffer.updateFloat("uWetTime", this.uWetTime);
  }

  public setTime(t: number): void {
    this.uWetTime = t;
  }

  public getCustomCode(shaderType: string): { [point: string]: string } | null {
    const cfg = WET_SAND.get(this._material);
    if (!cfg) return null;
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `varying vec2 vWetUv;\nvarying vec3 vWetWorld;\nvarying float vWetGrade;`,
        CUSTOM_VERTEX_MAIN_END: `
          vWetWorld = (world * vec4(position, 1.0)).xyz;
          vec3 wetDir = normalize(position);
          vWetUv = vec2(atan(wetDir.z, wetDir.x) * 0.15915494 + 0.5,
                        acos(clamp(wetDir.y, -1.0, 1.0)) * 0.31830989);
          // tan of the ground angle: bounds every shore band to a few world
          // units instead of a height window that smears on flat coasts.
          vec3 wetNormal = normalize(normal);
          float wetNr = max(dot(wetNormal, wetDir), 1e-3);
          vWetGrade = sqrt(max(1.0 - wetNr * wetNr, 0.0)) / wetNr;`,
      };
    }
    if (shaderType === "fragment") {
      const wl = glslNum(cfg.waterLevel);
      const scale = glslNum(cfg.relief * cfg.radius);
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `
          uniform sampler2D uWetHeightMap;
          varying vec2 vWetUv;
          varying vec3 vWetWorld;
          varying float vWetGrade;
          ${FAST_NOISE_GLSL}
          ${swashGLSL(cfg.swash)}`,
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
          // --- Wet sand / swash sheet ---
          vec4 wetTex = texture2D(uWetHeightMap, vWetUv);
          float wetH = (wetTex.r * 255.0 * 256.0 + wetTex.g * 255.0) / 65535.0 * 3.0 - 1.5;
          float wetDepth = max((${wl} - wetH) * ${scale}, 0.0);
          float wetShallow = clamp(1.0 - wetDepth / 3.0, 0.0, 1.0);
          float wetEdge = ${wl} + swashRise(vWetWorld, uWetTime, wetShallow) / ${scale};
          // Bound every shore band by the local grade (h units per world unit)
          // so the wet/damp/lace windows stay a few units wide even where the
          // coast is nearly flat (height-only windows would smear for hundreds
          // of units, painting foam across dry ground).
          float wetHPerWorld = max(vWetGrade, 1e-4) / ${scale};
          float wetWin = min(0.0085, 3.0 * wetHPerWorld);
          float dampWin = min(0.026, 8.0 * wetHPerWorld);
          float laceWin = min(0.02, 6.0 * wetHPerWorld);
          float wet = smoothstep(wetEdge + 0.3 * wetWin, wetEdge - 0.7 * wetWin, wetH);
          float damp = smoothstep(wetEdge + dampWin, wetEdge - 0.3 * wetWin, wetH) * 0.55;
          float moisture = clamp(max(wet, damp), 0.0, 1.0);
          surfaceAlbedo *= mix(1.0, 0.58, moisture);
          // Foam lace left behind by the receding swash.
          float wetPhase = swashPhaseA(vWetWorld, uWetTime, wetShallow);
          float backwash = smoothstep(0.2, -0.6, cos(wetPhase));
          float laceNoise = waterNoise(vWetWorld * 6.0 + vec3(0.0, uWetTime * 0.08, 0.0));
          float lace = backwash * (1.0 - smoothstep(0.0, laceWin, max(wetH - wetEdge, 0.0)))
                     * smoothstep(0.45, 0.75, laceNoise);
          surfaceAlbedo = mix(surfaceAlbedo, vec3(0.96, 0.97, 0.98), clamp(lace, 0.0, 0.85));`,
      };
    }
    return null;
  }
}

/** Attaches the wet-sand band to a ground material (returns the plugin to clock it). */
function attachWetSand(material: Material, cfg: WetSandConfig): WetSandPlugin {
  WET_SAND.set(material, cfg);
  return new WetSandPlugin(material);
}

function buildGroundGeometry(opts: SurfaceOptions): {
  positions: number[]; normals: number[]; colors: number[]; indices: number[]; uvs: number[];
  terrainUvs: number[] | null;
} {
  const seg = opts.segments;
  const positions: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const heights: number[] = [];
  // Tiled texture UVs for the terrain shader (independent of the mesh `uv`
  // pair, which stays reserved for other effects).
  const terrainUvs: number[] | null = opts.terrain ? [] : null;
  const tilesU = opts.terrain?.tilesU ?? 0;
  const tilesV = opts.terrain?.tilesV ?? 0;

  // Latitude-longitude grid sphere with FBM displacement.
  for (let iy = 0; iy <= seg; iy++) {
    const v = iy / seg;
    const theta = v * Math.PI; // 0..PI pole to pole
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let ix = 0; ix <= seg; ix++) {
      const u = ix / seg;
      const phi = u * Math.PI * 2;
      const nx = sinT * Math.cos(phi), ny = cosT, nz = sinT * Math.sin(phi);
      const h = terrainHeightNormalized(nx, ny, nz, opts.seed, opts.waterLevel, opts.shore);
      heights.push(h);
      const r = opts.radius * (1 + h * opts.relief);
      positions.push(nx * r, ny * r, nz * r);
      uvs.push(u, 1 - v);
      if (terrainUvs) terrainUvs.push(u * tilesU, (1 - v) * tilesV);
    }
  }
  const row = seg + 1;
  for (let iy = 0; iy < seg; iy++) {
    for (let ix = 0; ix < seg; ix++) {
      const a = iy * row + ix, b = a + 1, c = a + row, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  // Normals via finite differences on the height field.
  const normals: number[] = new Array(positions.length).fill(0);
  const pos = (ix: number, iy: number): Vector3 => {
    const cx = Math.min(seg, Math.max(0, ix)), cy = Math.min(seg, Math.max(0, iy));
    const i = (cy * row + cx) * 3;
    return new Vector3(positions[i], positions[i + 1], positions[i + 2]);
  };
  for (let iy = 0; iy <= seg; iy++) {
    for (let ix = 0; ix <= seg; ix++) {
      const p = pos(ix, iy);
      const tx = pos(ix + 1, iy).subtract(pos(ix - 1, iy));
      const ty = pos(iy + 1 > seg ? iy : iy + 1, 0); // placeholder to keep loop simple
      void ty;
      const ty2 = pos(ix, iy + 1).subtract(pos(ix, iy - 1));
      // Note: Babylon's left-handed winding makes (tx x ty) the outward normal here;
      // the opposite order points every terrain normal into the planet (unlit ground).
      const n = Vector3.Cross(tx, ty2);
      if (n.lengthSquared() < 1e-10) n.copyFrom(p).normalize();
      else n.normalize();
      const i = (iy * row + ix) * 3;
      normals[i] = n.x; normals[i + 1] = n.y; normals[i + 2] = n.z;
    }
  }

  // Biome vertex colors. With a terrain look attached the ground textures
  // carry the base colour, so these become a multiplicative tint: a warm band
  // along the shore, mild moisture variation inland and the strong depth
  // colours under water. Rock shading and snow caps move to the terrain shader.
  const textured = !!opts.terrain;
  const sand = textured ? new Color3(1.04, 0.98, 0.86) : new Color3(0.76, 0.66, 0.45);
  const rock = new Color3(0.42, 0.36, 0.3);
  const grass = textured ? new Color3(1, 1, 1) : opts.groundAlbedo.clone();
  const forest = textured ? new Color3(0.78, 0.9, 0.72) : grass.scale(0.55);
  const snow = new Color3(0.9, 0.92, 0.95);
  const deep = new Color3(0.1, 0.22, 0.32);
  const shallow = new Color3(0.28, 0.72, 0.74);
  for (let iy = 0; iy <= seg; iy++) {
    const v = iy / seg;
    const lat = Math.abs(v - 0.5) * 2; // 0 equator, 1 poles
    for (let ix = 0; ix <= seg; ix++) {
      const h = heights[iy * row + ix];
      const c = new Color3(0, 0, 0);
      if (h < opts.waterLevel) {
        const t = Math.min(1, (opts.waterLevel - h) / 0.3);
        c.copyFrom(Color3.Lerp(shallow, deep, t));
      } else {
        const t = Math.min(1, (h - opts.waterLevel) / 0.6);
        const moist = fbm3(ix * 0.05, iy * 0.05, 3.7, 2, opts.seed + 77) * 0.5 + 0.5;
        const veg = Color3.Lerp(grass, forest, moist);
        c.copyFrom(Color3.Lerp(sand, veg, Math.min(1, t * 2.2)));
        if (!textured && t > 0.45) c.copyFrom(Color3.Lerp(c, rock, (t - 0.45) / 0.55));
        if (!textured && opts.iceCaps && (lat > 0.82 || t > 0.85)) {
          const ice = Math.min(1, Math.max((lat - 0.82) / 0.1, (t - 0.85) / 0.1));
          c.copyFrom(Color3.Lerp(c, snow, Math.min(1, ice)));
        }
      }
      colors.push(c.r, c.g, c.b, 1);
    }
  }
  return { positions, normals, colors, indices, uvs, terrainUvs };
}

/** Procedural ground + ocean + clouds + night lights for one planet. */
export function buildPlanetSurface(scene: Scene, name: string, partial: Partial<SurfaceOptions>): SurfaceResult {
  const opts: SurfaceOptions = { ...defaultOptions, ...partial };

  const geo = buildGroundGeometry(opts);
  const groundVD = new VertexData();
  groundVD.positions = geo.positions;
  groundVD.normals = geo.normals;
  groundVD.indices = geo.indices;
  groundVD.uvs = geo.uvs;
  groundVD.colors = geo.colors;
  const ground = new Mesh(`${name}-ground`, scene);
  groundVD.applyToMesh(ground, true);
  ground.hasVertexAlpha = false;
  if (opts.position) ground.position.copyFrom(opts.position);

  const groundMat = new PBRMaterial(`${name}-ground-mat`, scene);
  groundMat.albedoColor = new Color3(1, 1, 1); // multiplied by vertex colors
  ground.hasVertexAlpha = false;
  ground.useVertexColors = true;
  groundMat.metallic = 0.0;
  groundMat.roughness = 0.93;
  groundMat.environmentIntensity = 0.35;
  groundMat.directIntensity = 1.0;
  ground.material = groundMat;

  // Ground texture blend (base pair vs rock by slope + altitude + noise), with
  // the snow line gated by `iceCaps` so airless bodies stay bare.
  let terrain: TerrainHandle | null = null;
  if (opts.terrain) {
    const look: TerrainLook = {
      ...opts.terrain,
      snowStart: opts.iceCaps ? opts.terrain.snowStart : null,
    };
    const textures = loadTerrainTextures(scene, name, look);
    terrain = attachTerrain(groundMat, {
      look, textures, radius: opts.radius, relief: opts.relief, waterLevel: opts.waterLevel,
    });
    if (geo.terrainUvs) ground.setVerticesData("terrainUv", geo.terrainUvs, false, 2);
  }

  // Night-side city lights: emissive speckle texture masked to land, shown on dark side.
  // ShaderMaterial (not StandardMaterial): the emissive-texture define silently stayed
  // unsampled, which rendered a flat warm layer over the whole ocean.
  let nightMat: ShaderMaterial | null = null;
  if (opts.nightLights) {
    const size = 512;
    const tex = new DynamicTexture(`${name}-night`, { width: size, height: size }, scene, true);
    const ctx = tex.getContext();
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, size, size);
    let s = opts.seed;
    const rand = (): number => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    for (let i = 0; i < 2600; i++) {
      const x = rand() * size, y = rand() * size;
      const warm = rand();
      ctx.fillStyle = warm > 0.7 ? "rgba(255,190,120,0.9)" : "rgba(255,230,170,0.75)";
      const r = rand() * 1.6 + 0.4;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    tex.update();
    tex.hasAlpha = false;
    nightMat = new ShaderMaterial(
      `${name}-night-mat`, scene,
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
      }
    );
    nightMat.alphaMode = Constants.ALPHA_ADD; // black texels add nothing over the sea
    nightMat.setTexture("uNightTex", tex);
    nightMat.setFloat("uGlow", 1.0);
    nightMat.setVector3("uSunToward", new Vector3(0, 1, 0));
  }

  // Ocean: two-layer procedural water (see ocean.ts). The mesh name is kept
  // for the smoke test; the shader now handles depth colour, surf and run-up.
  const heightMap = bakeTerrainHeightTexture(scene, name, opts);
  const oceanLook: OceanLook = {
    shallowColor: new Color3(0.12, 0.5, 0.55),
    deepColor: new Color3(0.008, 0.055, 0.115),
    foamColor: new Color3(0.97, 0.985, 1.0),
    shallowAlpha: 0.62, depthFade: 4.5,
    ...(opts.ocean ?? {}),
  };
  const ocean = opts.waterLevel < 0 ? createOcean(scene, name, {
    radius: opts.radius,
    relief: opts.relief,
    waterLevel: opts.waterLevel,
    seed: opts.seed,
    segments: opts.segments,
    heightMap,
    ground,
    waves: opts.waves ?? { seaState: "mild" },
    sky: opts.sky ?? {
      skyTint: new Color3(0.35, 0.6, 1), skyStrength: 1.0,
      hazeTint: new Color3(1, 0.97, 0.92), hazeStrength: 0.25, hazeG: 0.85,
      sunTint: new Color3(1, 0.97, 0.92), sunGlow: 0.35,
    },
    shallowColor: oceanLook.shallowColor,
    deepColor: oceanLook.deepColor,
    foamColor: oceanLook.foamColor,
    shallowAlpha: oceanLook.shallowAlpha,
    depthFade: oceanLook.depthFade,
  }) : null;
  const water: Mesh | null = ocean ? ocean.shell : null;

  // Wet sand band on the ground, sharing the ocean's swash field + clock.
  const wetSand = ocean
    ? attachWetSand(groundMat, {
        heightMap,
        swash: ocean.waveSet.swash,
        waterLevel: opts.waterLevel,
        relief: opts.relief,
        radius: opts.radius,
      })
    : null;

  // Clouds: separate sphere with procedural FBM alpha shader, slow rotation.
  let clouds: Mesh | null = null;
  let cloudMat: ShaderMaterial | null = null;
  if (opts.clouds) {
    const cloudR = opts.radius * (1 + opts.relief * 1.6 + 0.004);
    clouds = Mesh.CreateSphere(`${name}-clouds`, Math.max(48, opts.segments >> 1), cloudR * 2, scene);
    cloudMat = new ShaderMaterial(
      `${name}-cloud-mat`,
      scene,
      {
        vertexSource: `
          precision highp float;
          attribute vec3 position;
          attribute vec3 normal;
          attribute vec2 uv;
          uniform mat4 worldViewProjection;
          uniform mat4 world;
          varying vec3 vNormalW;
          varying vec3 vPosW;
          varying vec2 vUv;
          void main() {
            vec4 wp = world * vec4(position, 1.0);
            vPosW = wp.xyz;
            vNormalW = normalize(mat3(world) * normal);
            vUv = uv;
            gl_Position = worldViewProjection * vec4(position, 1.0);
          }`,
        fragmentSource: `
          precision highp float;
          varying vec3 vNormalW;
          varying vec3 vPosW;
          varying vec2 vUv;
          uniform vec3 sunDirection;
          uniform vec3 cameraPosition;
          uniform float time;
          uniform float coverage;
          uniform vec3 planetCenter;
          float hash(vec3 p) {
            p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
            p *= 17.0;
            return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
          }
          float vnoise(vec3 p) {
            vec3 i = floor(p); vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float n000 = hash(i); float n100 = hash(i + vec3(1,0,0));
            float n010 = hash(i + vec3(0,1,0)); float n110 = hash(i + vec3(1,1,0));
            float n001 = hash(i + vec3(0,0,1)); float n101 = hash(i + vec3(1,0,1));
            float n011 = hash(i + vec3(0,1,1)); float n111 = hash(i + vec3(1,1,1));
            return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
                       mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
          }
          float fbm(vec3 p) {
            float s = 0.0; float a = 0.5;
            for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
            return s;
          }
          void main() {
            vec3 dir = normalize(vPosW - planetCenter);
            vec3 p = dir * 6.0 + vec3(time * 0.004, 0.0, time * 0.002);
            float d = fbm(p + fbm(p * 1.7) * 0.8);
            float alpha = smoothstep(1.0 - coverage - 0.25, 1.0 - coverage + 0.35, d);
            vec3 N = normalize(vNormalW);
            vec3 L = normalize(-sunDirection);
            float ndl = clamp(dot(N, L), 0.0, 1.0);
            float dayMix = smoothstep(-0.18, 0.3, dot(N, L));
            vec3 V = normalize(cameraPosition - vPosW);
            float silver = pow(clamp(dot(reflect(-L, N), V), 0.0, 1.0), 8.0);
            vec3 col = mix(vec3(0.05,0.06,0.09), vec3(1.02,1.0,0.98) * (0.25 + 0.95 * ndl), dayMix);
            col += vec3(1.0, 0.95, 0.9) * silver * 0.35 * dayMix;
            // Fade clouds seen edge-on (just above the deck, or from space): the shell
            // surface must never draw a hard line across the ground.
            float rim = abs(dot(N, V));
            alpha *= mix(0.06, 1.0, smoothstep(0.02, 0.62, rim));
            // ...and thin the deck out toward the night side, where a dark veil over
            // still-lit ground is what reads as a hard terminator edge.
            alpha *= mix(0.2, 1.0, dayMix);
            gl_FragColor = vec4(col, alpha * 0.92);
          }`,
      },
      {
        attributes: ["position", "normal", "uv"],
        uniforms: ["world", "worldViewProjection", "sunDirection", "cameraPosition", "time", "coverage", "planetCenter"],
        needAlphaBlending: true,
        needAlphaTesting: false,
      }
    );
    cloudMat.backFaceCulling = false;
    cloudMat.disableDepthWrite = false;
    cloudMat.setFloat("coverage", opts.cloudCoverage);
    cloudMat.setVector3("planetCenter", new Vector3(0, 0, 0));
    clouds.material = cloudMat;
  }

  let cloudTime = 0;
  const update = (dt: number, sunDir: Vector3, isHost = true): void => {
    ocean?.update(dt, sunDir, isHost);
    wetSand?.setTime(ocean?.elapsed() ?? 0);
    if (clouds && cloudMat) {
      clouds.rotation.y += dt * 0.004;
      cloudMat.setVector3("sunDirection", sunDir);
      const cam = scene.activeCamera;
      if (cam) cloudMat.setVector3("cameraPosition", cam.position);
      const t = (cloudMat as unknown as { _time?: number })._time ?? 0;
      (cloudMat as unknown as { _time?: number })._time = t + dt;
      cloudTime = t + dt;
      cloudMat.setFloat("time", cloudTime);
    }
    if (nightMat) {
      // Additive city glow, driven per fragment by the sun's angle (dark side only).
      nightMat.setVector3("uSunToward", sunDir.scale(-1));
    }
  };

  // Night lights overlay: slightly larger transparent shell with emissive speckle.
  if (nightMat) {
    const night = Mesh.CreateSphere(`${name}-night-shell`, 64, opts.radius * 2 * 1.002, scene);
    night.material = nightMat;
    night.parent = ground;
    night.isPickable = false;
  }

  void Color4;
  void ParticleSystem;
  void Texture;
  return { ground, water, clouds, ocean, terrain, update };
}
