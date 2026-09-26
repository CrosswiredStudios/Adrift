import { Material, MaterialPluginBase, Texture, UniformBuffer } from "@babylonjs/core";
import { SwashParams, swashGLSL } from "../ocean/oceanWaves";
import { FAST_NOISE_GLSL, glslNum } from "../common/shaderChunks";
import { PluginRegistry } from "../common/materialPlugin";

/**
 * Wet-sand band + swash lace on the ground material (SRP: ground-shore
 * effect lives here, ground geometry + planet assembly live in
 * planetSurface.ts). Uses the ocean's own swash field (shared `swashGLSL`)
 * and the baked height field, so the wet sand always agrees with the
 * waterline the water shader is drawing: the band advances with the run-up,
 * lingers as a damp strip, and white lace is left behind on the backwash.
 *
 * NOTE: `getCustomCode` is called from the MaterialPluginBase constructor
 * before subclass fields exist, so the configuration is held in a
 * material-keyed registry populated by `attachWetSand` before construction.
 */
export interface WetSandConfig {
  heightMap: Texture;
  swash: SwashParams;
  waterLevel: number;
  relief: number;
  radius: number;
}
const WET_SAND = new PluginRegistry<WetSandConfig>();

export class WetSandPlugin extends MaterialPluginBase {
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
    uniformBuffer: UniformBuffer,
    _scene: unknown,
    _engine: unknown,
    _subMesh: unknown,
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
export function attachWetSand(material: Material, cfg: WetSandConfig): WetSandPlugin {
  WET_SAND.attach(material, cfg);
  return new WetSandPlugin(material);
}
