import {
  Color3,
  DynamicTexture,
  Material,
  MaterialPluginBase,
  Scene,
  Texture,
  UniformBuffer,
} from "@babylonjs/core";
import { glslNum } from "../common/shaderChunks";
import { PluginRegistry } from "../common/materialPlugin";
import {
  configureTiledTexture,
  loadWithFallback,
  makeFallbackTexture,
  makeFlatNormal,
} from "../common/textures";

/**
 * Ground texturing for the planet surface: a per-fragment blend between two
 * tileable texture sets (base = vegetation or loose regolith, rock = exposed
 * stone) driven by terrain slope, altitude and a low-frequency noise mask.
 * The same mask picks which normal map perturbs the lighting.
 *
 * Implemented as a MaterialPlugin on the ground PBRMaterial so all existing
 * lighting, vertex tinting and the wet-sand plugin keep working. The priority
 * is below WetSand (210) so the textures are applied first and the swash
 * darkening / foam is layered on top.
 *
 * NOTE: `getCustomCode` runs from the MaterialPluginBase constructor before
 * subclass fields exist, so the configuration lives in a material-keyed
 * registry populated by `attachTerrain` before construction (same pattern as
 * the wet-sand plugin).
 */
export interface TerrainLook {
  /** Albedo + normal maps for the soft pair (grass on Vael, dust on Tethys). */
  baseColor: string;
  baseNormal: string;
  /** Albedo + normal maps for exposed stone (also used on beaches/seabed). */
  rockColor: string;
  rockNormal: string;
  /** Texture repeats around the longitude (u) and pole to pole (v). */
  tilesU: number;
  tilesV: number;
  /** Slope window (1 - dot(normal, radial)) over which rock takes over. */
  slopeLo: number;
  slopeHi: number;
  /** Normalized-height window where altitude alone forces rock (mountains). */
  altLo: number;
  altHi: number;
  /** How much the altitude term contributes to the rock blend. */
  altWeight: number;
  /** Normalized height where snow starts (null = airless body, no snow). */
  snowStart: number | null;
  /** Fade band above the snow line. */
  snowFade: number;
  /** Noise amplitude added to the blend mask so boundaries read organically. */
  noiseAmp: number;
  /** Strength of the blended normal maps (1 = as authored). */
  normalStrength: number;
  /** Hint colour for the procedural fallback texture of the base pair. */
  baseTint?: Color3;
}

export const defaultTerrainLook: TerrainLook = {
  baseColor: "/textures/terrain/grass_color.jpg",
  baseNormal: "/textures/terrain/grass_normal.jpg",
  rockColor: "/textures/terrain/rock_color.jpg",
  rockNormal: "/textures/terrain/rock_normal.jpg",
  tilesU: 96,
  tilesV: 48,
  slopeLo: 0.08,
  slopeHi: 0.32,
  altLo: 0.5,
  altHi: 1.05,
  altWeight: 0.9,
  snowStart: 0.95,
  snowFade: 0.35,
  noiseAmp: 0.24,
  normalStrength: 0.85,
  baseTint: new Color3(0.36, 0.5, 0.24),
};

/** The four textures the plugin binds, with any fallback substitutions applied. */
export interface TerrainTextures {
  baseColor: Texture;
  baseNormal: Texture;
  rockColor: Texture;
  rockNormal: Texture;
  /** Names of the textures that failed to load and were replaced procedurally. */
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
  relief: number;
  waterLevel: number;
}

const TERRAIN = new PluginRegistry<TerrainConfig>();

export { configureTiledTexture as configureGroundTexture, makeFallbackTexture, makeFlatNormal };

function loadOne(
  scene: Scene,
  name: string,
  url: string,
  isNormal: boolean,
  tint: Color3,
  seed: number,
  fallbacks: string[],
  assign: (t: Texture) => void,
): Texture {
  return loadWithFallback(scene, name, url, { isNormal, tint, seed, fallbacks }, assign);
}

/** Loads the four ground textures, substituting procedural stand-ins on failure. */
export function loadTerrainTextures(scene: Scene, name: string, look: TerrainLook): TerrainTextures {
  const fallbacks: string[] = [];
  const tint = look.baseTint ?? defaultTerrainLook.baseTint ?? new Color3(0.4, 0.45, 0.3);
  const out = {} as TerrainTextures;
  out.fallbacks = fallbacks;
  out.baseColor = loadOne(scene, `${name}-base-color`, look.baseColor, false, tint, 17, fallbacks, (t) => {
    out.baseColor = t;
  });
  out.baseNormal = loadOne(scene, `${name}-base-normal`, look.baseNormal, true, tint, 23, fallbacks, (t) => {
    out.baseNormal = t;
  });
  out.rockColor = loadOne(
    scene,
    `${name}-rock-color`,
    look.rockColor,
    false,
    new Color3(0.42, 0.4, 0.37),
    31,
    fallbacks,
    (t) => {
      out.rockColor = t;
    },
  );
  out.rockNormal = loadOne(scene, `${name}-rock-normal`, look.rockNormal, true, tint, 37, fallbacks, (t) => {
    out.rockNormal = t;
  });
  return out;
}

class TerrainPlugin extends MaterialPluginBase {
  /** Debug view selector (see TerrainHandle.setDebug). Updated through the UBO. */
  public uTerrainDebug = 0;

  constructor(material: Material) {
    // NOTE: the 6th argument ACTIVATES the plugin. Custom shader code is only
    // injected for active plugins (`getCustomCode` runs during registration but
    // `_injectCustomCode` iterates `_activePlugins` only), so without it the
    // plugin compiles cleanly yet contributes nothing to the render.
    super(material, "TerrainTextures", 205, { TERRAIN_TEXTURES: true }, true, true);
  }

  public getClassName(): string {
    return "TerrainTextures";
  }

  public getSamplers(samplers: string[]): void {
    samplers.push("uTerrainBase", "uTerrainRock", "uTerrainBaseN", "uTerrainRockN");
  }

  public getAttributes(attributes: string[]): void {
    attributes.push("terrainUv");
  }

  public getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return {
      ubo: [{ name: "uTerrainDebug", size: 1, type: "float" }],
      fragment: "",
    };
  }

  public bindForSubMesh(
    uniformBuffer: UniformBuffer,
    _scene: unknown,
    _engine: unknown,
    _subMesh: unknown,
  ): void {
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

  public getCustomCode(shaderType: string): { [point: string]: string } | null {
    const cfg = TERRAIN.get(this._material);
    if (!cfg) return null;
    const { look } = cfg;

    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `
          attribute vec2 terrainUv;
          varying vec2 vTerrainUv;
          varying vec3 vTerrainLocal;
          varying float vTerrainSlope;
          varying float vTerrainGrade;
          varying float vTerrainH;`,
        CUSTOM_VERTEX_MAIN_END: `
          vTerrainUv = terrainUv;
          vTerrainLocal = position;
          vec3 terrainRadialDir = normalize(position);
          vec3 terrainNormal = normalize(normal);
          vTerrainSlope = 1.0 - dot(terrainNormal, terrainRadialDir);
          // tan of the surface angle: lets the shader measure shore bands in
          // world units instead of height windows (flat ground would otherwise
          // smear them over hundreds of units inland).
          float terrainNr = max(dot(terrainNormal, terrainRadialDir), 1e-3);
          vTerrainGrade = sqrt(max(1.0 - terrainNr * terrainNr, 0.0)) / terrainNr;
          // The ground mesh is planet-centred in local space, so the radial
          // displacement is exactly the shaped normalized height.
          vTerrainH = (length(position) - ${glslNum(cfg.radius)}) / ${glslNum(cfg.radius * cfg.relief)};`,
      };
    }

    if (shaderType === "fragment") {
      const snowCode =
        look.snowStart !== null
          ? `
          float terrainLat = abs(normalize(vTerrainLocal).y);
          float terrainSnow = max(
            smoothstep(${glslNum(look.snowStart)}, ${glslNum(look.snowStart + look.snowFade)}, vTerrainH),
            smoothstep(0.82, 0.92, terrainLat));
          terrainAlbedo = mix(terrainAlbedo, vec3(0.92, 0.94, 0.99), terrainSnow);`
          : ``;

      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `
          // Samplers registered via getSamplers must be declared in the shader;
          // this definition point is the only injection that reliably lands.
          uniform sampler2D uTerrainBase;
          uniform sampler2D uTerrainRock;
          uniform sampler2D uTerrainBaseN;
          uniform sampler2D uTerrainRockN;
          varying vec2 vTerrainUv;
          varying vec3 vTerrainLocal;
          varying float vTerrainSlope;
          varying float vTerrainGrade;
          varying float vTerrainH;
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
          mat3 terrainCotangentFrame(vec3 n, vec3 p, vec2 uv) {
            vec3 dp1 = dFdx(p); vec3 dp2 = dFdy(p);
            vec2 duv1 = dFdx(uv); vec2 duv2 = dFdy(uv);
            vec3 dp2perp = cross(dp2, n);
            vec3 dp1perp = cross(n, dp1);
            vec3 tangent = dp2perp * duv1.x + dp1perp * duv2.x;
            vec3 bitangent = dp2perp * duv1.y + dp1perp * duv2.y;
            float det = max(dot(tangent, tangent), dot(bitangent, bitangent));
            float invmax = det == 0.0 ? 0.0 : inversesqrt(det);
            return mat3(tangent * invmax, bitangent * invmax, n);
          }`,
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
          // --- Ground texture blend: base (grass/dust) vs rock ---
          vec3 terrainNoisePos = vTerrainLocal * 0.008;
          float terrainNoiseV = terrainNoise(terrainNoisePos) * 0.68 + terrainNoise(terrainNoisePos * 4.7) * 0.32;
          float terrainSlopeF = smoothstep(${glslNum(look.slopeLo)}, ${glslNum(look.slopeHi)},
                                            vTerrainSlope + (terrainNoiseV - 0.5) * ${glslNum(look.noiseAmp)});
          float terrainAltF = smoothstep(${glslNum(look.altLo)}, ${glslNum(look.altHi)},
                                         vTerrainH + (terrainNoiseV - 0.5) * ${glslNum(look.noiseAmp)});
          // Beaches and seabed read as stone rather than vegetation. The window
          // is capped by the local grade (h units per world unit) so a flat
          // coastal plain cannot grow a beach band hundreds of units wide.
          float terrainHPerWorld = vTerrainGrade / ${glslNum(cfg.radius * cfg.relief)};
          float terrainBeachWin = min(0.05, 20.0 * terrainHPerWorld);
          float terrainBeachWinBelow = min(0.02, 8.0 * terrainHPerWorld);
          float terrainBeachF = 1.0 - smoothstep(${glslNum(cfg.waterLevel)} - terrainBeachWinBelow, ${glslNum(cfg.waterLevel)} + terrainBeachWin, vTerrainH);
          float terrainRockF = clamp(max(max(terrainSlopeF, terrainAltF * ${glslNum(look.altWeight)}), terrainBeachF), 0.0, 1.0);

          vec3 terrainColorBase = pow(texture2D(uTerrainBase, vTerrainUv).rgb, vec3(2.2));
          vec3 terrainColorRock = pow(texture2D(uTerrainRock, vTerrainUv).rgb, vec3(2.2));
          vec3 terrainAlbedo = mix(terrainColorBase, terrainColorRock, terrainRockF);${snowCode}
          surfaceAlbedo *= terrainAlbedo;

          // Blended normal maps on the same mask (frame derived from screen-space
          // derivatives, matching Babylon's OpenGL-style tangent convention).
          vec3 terrainNBase = texture2D(uTerrainBaseN, vTerrainUv).xyz * 2.0 - 1.0;
          vec3 terrainNRock = texture2D(uTerrainRockN, vTerrainUv).xyz * 2.0 - 1.0;
          vec3 terrainN = mix(terrainNBase, terrainNRock, terrainRockF);
          mat3 terrainFrame = terrainCotangentFrame(normalW, vTerrainLocal, vTerrainUv);
          normalW = normalize(terrainFrame * vec3(terrainN.xy * ${glslNum(look.normalStrength)}, terrainN.z));

          // Debug views for tests/screenshots (0 = off).
          if (uTerrainDebug > 0.5) {
            if (uTerrainDebug < 1.5) surfaceAlbedo = vec3(terrainRockF);
            else if (uTerrainDebug < 2.5) surfaceAlbedo = vec3(clamp(vTerrainSlope, 0.0, 1.0));
            else surfaceAlbedo = vec3(clamp(vTerrainH * 0.5 + 0.5, 0.0, 1.0));
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
