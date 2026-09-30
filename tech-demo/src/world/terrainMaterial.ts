/**
 * Ground material for planet terrain: PBR + a triplanar texture blend.
 *
 * Terrain chunks are built in the body-fixed frame, so the vertex `position`
 * attribute is the body-local point (planet centred). This plugin textures
 * in that frame with triplanar projection: no UVs, no seams between cube
 * faces or LOD levels, no pole pinching, and the pattern stays glued to the
 * ground as the planet spins or the floating origin moves.
 *
 * Two texture sets are blended per fragment: a soft base (grass on Vael,
 * dust on the moons) and exposed rock, chosen by slope, altitude and a
 * noise mask; beaches/seabed read as rock; snow above the snow line. The
 * same mask blends the two normal maps (whiteout-blended triplanar normals).
 * The vertex colour (biome tint from the chunk builder) multiplies the
 * result.
 *
 * NOTE: `getCustomCode` runs from the MaterialPluginBase constructor before
 * subclass fields exist, so the configuration lives in a material-keyed
 * registry populated by `attachTerrain` before construction.
 */
import { Color3, Material, MaterialPluginBase, Scene, Texture, UniformBuffer } from "@babylonjs/core";
import { glslNum } from "../common/shaderChunks";
import { PluginRegistry } from "../common/materialPlugin";
import {
  TERRAIN_MORPH_COLOR_KIND,
  TERRAIN_MORPH_KIND,
  TERRAIN_MORPH_NORMAL_KIND,
} from "../terrain/chunkBuilder";
import {
  configureTiledTexture,
  loadWithFallback,
  makeFallbackTexture,
  makeFlatNormal,
} from "../common/textures";

export interface TerrainLook {
  baseColor: string;
  baseNormal: string;
  rockColor: string;
  rockNormal: string;
  /** Texture repeat size in meters (base / rock). */
  baseTile: number;
  rockTile: number;
  /** Slope window (1 - n.radial) over which rock takes over. */
  slopeLo: number;
  slopeHi: number;
  /** Normalized-height window where altitude alone forces rock. */
  altLo: number;
  altHi: number;
  altWeight: number;
  /** Normalized height where snow starts (null = no snow). */
  snowStart: number | null;
  snowFade: number;
  /** Noise amplitude on the blend mask. */
  noiseAmp: number;
  /** Normal map strength (1 = as authored). */
  normalStrength: number;
  baseTint?: Color3;
}

export const defaultTerrainLook: TerrainLook = {
  baseColor: "/textures/terrain/grass_color.jpg",
  baseNormal: "/textures/terrain/grass_normal.jpg",
  rockColor: "/textures/terrain/rock_color.jpg",
  rockNormal: "/textures/terrain/rock_normal.jpg",
  baseTile: 5,
  rockTile: 9,
  slopeLo: 0.12,
  slopeHi: 0.32,
  altLo: 0.55,
  altHi: 1.1,
  altWeight: 0.9,
  snowStart: 1.05,
  snowFade: 0.3,
  noiseAmp: 0.24,
  normalStrength: 0.9,
  baseTint: new Color3(0.36, 0.5, 0.24),
};

export interface TerrainTextures {
  baseColor: Texture;
  baseNormal: Texture;
  rockColor: Texture;
  rockNormal: Texture;
  fallbacks: string[];
}

export interface TerrainHandle {
  look: TerrainLook;
  textures: TerrainTextures;
  /** Debug view: 0 normal, 1 rock-blend mask, 2 slope, 3 normalized height. */
  setDebug(mode: number): void;
}

interface TerrainConfig {
  look: TerrainLook;
  textures: TerrainTextures;
  radius: number;
  /** Meters per normalized height unit. */
  relief: number;
  /** Sea level (m above the mean radius), or null on dry worlds. */
  seaLevel: number | null;
}

const TERRAIN = new PluginRegistry<TerrainConfig>();

export { configureTiledTexture as configureGroundTexture, makeFallbackTexture, makeFlatNormal };

/** Loads the four ground textures, substituting procedural stand-ins on failure. */
export function loadTerrainTextures(scene: Scene, name: string, look: TerrainLook): TerrainTextures {
  const fallbacks: string[] = [];
  const tint = look.baseTint ?? new Color3(0.4, 0.45, 0.3);
  const out = { fallbacks } as TerrainTextures;
  const load = (
    key: keyof Omit<TerrainTextures, "fallbacks">,
    url: string,
    isNormal: boolean,
    t: Color3,
    seed: number,
  ) => {
    out[key] = loadWithFallback(
      scene,
      `${name}-${key}`,
      url,
      { isNormal, tint: t, seed, fallbacks },
      (tex) => {
        out[key] = tex;
      },
    );
  };
  load("baseColor", look.baseColor, false, tint, 17);
  load("baseNormal", look.baseNormal, true, tint, 23);
  load("rockColor", look.rockColor, false, new Color3(0.42, 0.4, 0.37), 31);
  load("rockNormal", look.rockNormal, true, tint, 37);
  return out;
}

/**
 * Vertex warp shared by the colour pass and the depth pass (terrainDepth):
 * geomorph toward the parent chunk's surface with distance (the camera is
 * always at the render origin) and, on ocean worlds, sink distant shallows
 * under the sea. Operates on `positionUpdated` with the `world` matrix and
 * the geomorph attribute; declares `tMorphK` (the morph factor).
 */
export function terrainWarpGLSL(radius: number, seaLevel: number | null): string {
  return `
          float tMorphK = 0.0;
          if (${TERRAIN_MORPH_KIND}.w > 0.0) {
            float tMorphD = length((world * vec4(positionUpdated, 1.0)).xyz);
            tMorphK = smoothstep(0.55 * ${TERRAIN_MORPH_KIND}.w, 0.9 * ${TERRAIN_MORPH_KIND}.w, tMorphD);
          }
          positionUpdated += ${TERRAIN_MORPH_KIND}.xyz * tMorphK;${
            seaLevel !== null
              ? `
          // Far away, coarse chunks interpolate the seabed/shore between widely
          // spaced vertices and can poke up through the (smooth) sea surface.
          // Sink ground that is within a distance-scaled band of sea level so
          // it stays under the water; high ground is untouched.
          {
            float tSeaR = ${glslNum(radius + seaLevel)};
            float tR = length(positionUpdated);
            float tDist = length((world * vec4(positionUpdated, 1.0)).xyz);
            float tBand = clamp(tDist * 0.012 - 2.0, 0.0, 40.0);
            if (tBand > 0.0) {
              float tSink = tBand * (1.0 - smoothstep(tSeaR, tSeaR + tBand, tR));
              positionUpdated *= (tR - tSink) / tR;
            }
          }`
              : ""
          }`;
}

class TerrainPlugin extends MaterialPluginBase {
  public uTerrainDebug = 0;

  constructor(material: Material) {
    // The 6th argument activates the plugin: custom code is only injected
    // for active plugins.
    super(material, "TerrainTextures", 205, { TERRAIN_TEXTURES: true }, true, true);
  }

  public override getClassName(): string {
    return "TerrainTextures";
  }

  public override getAttributes(attributes: string[]): void {
    attributes.push(TERRAIN_MORPH_KIND, TERRAIN_MORPH_NORMAL_KIND, TERRAIN_MORPH_COLOR_KIND);
  }

  public override getSamplers(samplers: string[]): void {
    samplers.push("uTerrainBase", "uTerrainRock", "uTerrainBaseN", "uTerrainRockN");
  }

  public override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return { ubo: [{ name: "uTerrainDebug", size: 1, type: "float" }], fragment: "" };
  }

  public override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const cfg = TERRAIN.get(this._material);
    if (!cfg) return;
    const effect = this._material.getEffect();
    if (effect) {
      effect.setTexture("uTerrainBase", cfg.textures.baseColor);
      effect.setTexture("uTerrainRock", cfg.textures.rockColor);
      effect.setTexture("uTerrainBaseN", cfg.textures.baseNormal);
      effect.setTexture("uTerrainRockN", cfg.textures.rockNormal);
    }
    uniformBuffer.updateFloat("uTerrainDebug", this.uTerrainDebug);
  }

  public override getCustomCode(shaderType: string): { [point: string]: string } | null {
    const cfg = TERRAIN.get(this._material);
    if (!cfg) return null;
    const { look } = cfg;
    const R = glslNum(cfg.radius);
    const relief = glslNum(cfg.relief);

    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `
          attribute vec4 ${TERRAIN_MORPH_KIND};
          attribute vec3 ${TERRAIN_MORPH_NORMAL_KIND};
          attribute vec3 ${TERRAIN_MORPH_COLOR_KIND};
          varying vec3 vTerrainLocal;
          varying vec3 vTerrainNormalL;
          varying vec3 vTerrainAxisX;
          varying vec3 vTerrainAxisY;
          varying vec3 vTerrainAxisZ;`,
        // Geomorph toward the parent chunk's surface with distance (the
        // camera is always at the render origin).
        CUSTOM_VERTEX_UPDATE_POSITION: terrainWarpGLSL(cfg.radius, cfg.seaLevel),
        CUSTOM_VERTEX_UPDATE_NORMAL: `
          normalUpdated = normalize(normalUpdated + ${TERRAIN_MORPH_NORMAL_KIND} * tMorphK);`,
        CUSTOM_VERTEX_MAIN_END: `
          // Biome tint morphs with the shape (see chunkBuilder).
          #ifdef VERTEXCOLOR
          vColor.rgb += ${TERRAIN_MORPH_COLOR_KIND} * tMorphK;
          #endif
          vTerrainLocal = positionUpdated;
          vTerrainNormalL = normalize(normalUpdated);
          // Body -> world rotation (chunks are unscaled children of the body root).
          vTerrainAxisX = normalize(mat3(finalWorld) * vec3(1.0, 0.0, 0.0));
          vTerrainAxisY = normalize(mat3(finalWorld) * vec3(0.0, 1.0, 0.0));
          vTerrainAxisZ = normalize(mat3(finalWorld) * vec3(0.0, 0.0, 1.0));`,
      };
    }

    if (shaderType === "fragment") {
      const snowCode =
        look.snowStart !== null
          ? `
          float tSnow = smoothstep(${glslNum(look.snowStart)}, ${glslNum(look.snowStart + look.snowFade)},
                                   tH + (tNoise - 0.5) * 0.2);
          tSnow *= 1.0 - smoothstep(0.35, 0.6, tSlope);
          tAlbedo = mix(tAlbedo, vec3(0.92, 0.94, 0.99), tSnow);`
          : ``;
      const beachCode =
        cfg.seaLevel !== null
          ? `
          // Beaches and the seabed read as stone, over a band measured in meters.
          float tAbove = length(vTerrainLocal) - ${R} - ${glslNum(cfg.seaLevel)};
          float tBeachF = 1.0 - smoothstep(-0.5, 2.0 + (tNoise - 0.5) * 1.5, tAbove);
          tRockF = max(tRockF, tBeachF * 0.85);`
          : ``;

      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `
          uniform sampler2D uTerrainBase;
          uniform sampler2D uTerrainRock;
          uniform sampler2D uTerrainBaseN;
          uniform sampler2D uTerrainRockN;
          varying vec3 vTerrainLocal;
          varying vec3 vTerrainNormalL;
          varying vec3 vTerrainAxisX;
          varying vec3 vTerrainAxisY;
          varying vec3 vTerrainAxisZ;
          float terrainHash(vec3 p) {
            p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
            p *= 17.0;
            return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
          }
          float terrainNoise(vec3 p) {
            vec3 i = floor(p); vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(mix(terrainHash(i), terrainHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                           mix(terrainHash(i + vec3(0.0, 1.0, 0.0)), terrainHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                       mix(mix(terrainHash(i + vec3(0.0, 0.0, 1.0)), terrainHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                           mix(terrainHash(i + vec3(0.0, 1.0, 1.0)), terrainHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
          }
          vec3 triWeights(vec3 n) {
            vec3 w = pow(abs(n), vec3(4.0));
            return w / max(w.x + w.y + w.z, 1e-5);
          }
          vec3 triColor(sampler2D s, vec3 p, vec3 w, float tile) {
            vec3 q = p / tile;
            return texture2D(s, q.zy).rgb * w.x + texture2D(s, q.xz).rgb * w.y + texture2D(s, q.xy).rgb * w.z;
          }
          // Whiteout-blended triplanar normal (local frame).
          vec3 triNormal(sampler2D s, vec3 p, vec3 n, vec3 w, float tile, float strength) {
            vec3 q = p / tile;
            vec3 tx = texture2D(s, q.zy).xyz * 2.0 - 1.0;
            vec3 ty = texture2D(s, q.xz).xyz * 2.0 - 1.0;
            vec3 tz = texture2D(s, q.xy).xyz * 2.0 - 1.0;
            tx.xy *= strength; ty.xy *= strength; tz.xy *= strength;
            vec3 nx = vec3(tx.xy + n.zy, abs(tx.z) * n.x);
            vec3 ny = vec3(ty.xy + n.xz, abs(ty.z) * n.y);
            vec3 nz = vec3(tz.xy + n.xy, abs(tz.z) * n.z);
            return normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
          }`,
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
          vec3 tN = normalize(vTerrainNormalL);
          vec3 tRadial = normalize(vTerrainLocal);
          float tSlope = 1.0 - dot(tN, tRadial);
          float tH = (length(vTerrainLocal) - ${R}) / ${relief};
          vec3 tW = triWeights(tN);
          float tNoise = terrainNoise(vTerrainLocal * 0.02) * 0.68 + terrainNoise(vTerrainLocal * 0.09) * 0.32;
          float tSlopeF = smoothstep(${glslNum(look.slopeLo)}, ${glslNum(look.slopeHi)},
                                     tSlope + (tNoise - 0.5) * ${glslNum(look.noiseAmp)});
          float tAltF = smoothstep(${glslNum(look.altLo)}, ${glslNum(look.altHi)},
                                   tH + (tNoise - 0.5) * ${glslNum(look.noiseAmp)});
          float tRockF = clamp(max(tSlopeF, tAltF * ${glslNum(look.altWeight)}), 0.0, 1.0);${beachCode}

          vec3 tBase = pow(triColor(uTerrainBase, vTerrainLocal, tW, ${glslNum(look.baseTile)}), vec3(2.2));
          vec3 tRock = pow(triColor(uTerrainRock, vTerrainLocal, tW, ${glslNum(look.rockTile)}), vec3(2.2));
          // Macro variation breaks up tiling at a distance.
          tBase *= 0.85 + 0.3 * terrainNoise(vTerrainLocal * 0.013);
          vec3 tAlbedo = mix(tBase, tRock, tRockF);${snowCode}
          surfaceAlbedo *= tAlbedo;

          vec3 tNB = triNormal(uTerrainBaseN, vTerrainLocal, tN, tW, ${glslNum(look.baseTile)}, ${glslNum(look.normalStrength)});
          vec3 tNR = triNormal(uTerrainRockN, vTerrainLocal, tN, tW, ${glslNum(look.rockTile)}, ${glslNum(look.normalStrength)});
          vec3 tNL = normalize(mix(tNB, tNR, tRockF));
          // Local -> world with the body rotation; keep the geometric facing.
          vec3 tNW = normalize(vTerrainAxisX * tNL.x + vTerrainAxisY * tNL.y + vTerrainAxisZ * tNL.z);
          normalW = dot(tNW, normalW) > 0.0 ? tNW : normalW;

          if (uTerrainDebug > 0.5) {
            if (uTerrainDebug < 1.5) surfaceAlbedo = vec3(tRockF);
            else if (uTerrainDebug < 2.5) surfaceAlbedo = vec3(clamp(tSlope * 3.0, 0.0, 1.0));
            else surfaceAlbedo = vec3(clamp(tH * 0.5 + 0.5, 0.0, 1.0));
          }`,
      };
    }
    return null;
  }
}

/** Attaches the terrain texture blend to a ground material. */
export function attachTerrain(material: Material, cfg: TerrainConfig): TerrainHandle {
  TERRAIN.attach(material, cfg);
  const plugin = new TerrainPlugin(material);
  return {
    look: cfg.look,
    textures: cfg.textures,
    setDebug: (mode: number) => {
      plugin.uTerrainDebug = mode;
    },
  };
}
