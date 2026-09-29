/**
 * Wet-sand band + swash lace on the ground material.
 *
 * Uses the ocean's own swash field (shared `swashGLSL`), evaluated in the
 * body-fixed frame like the water shader, so the wet sand always agrees
 * with the waterline the ocean is drawing: the band advances with the
 * run-up, lingers as a damp strip, and white lace is left on the backwash.
 * The ground height comes straight from the fragment position (chunks are
 * built in body-local coordinates), so no height texture is needed.
 *
 * NOTE: `getCustomCode` is called from the MaterialPluginBase constructor
 * before subclass fields exist, so the configuration is held in a
 * material-keyed registry populated by `attachWetSand` before construction.
 */
import { Material, MaterialPluginBase, UniformBuffer } from "@babylonjs/core";
import { SwashParams, swashGLSL } from "../ocean/oceanWaves";
import { FAST_NOISE_GLSL, glslNum } from "../common/shaderChunks";
import { PluginRegistry } from "../common/materialPlugin";

export interface WetSandConfig {
  swash: SwashParams;
  /** Sea level above the mean radius (m). */
  seaLevel: number;
  radius: number;
}
const WET_SAND = new PluginRegistry<WetSandConfig>();

export class WetSandPlugin extends MaterialPluginBase {
  /** Ocean clock (sim time), copied into the material UBO. */
  public uWetTime = 0;

  constructor(material: Material) {
    super(material, "WetSand", 210, { WET_SAND: true }, true, true);
  }

  public override getClassName(): string {
    return "WetSand";
  }

  public override getUniforms(): { ubo: { name: string; size: number; type: string }[]; fragment: string } {
    return { ubo: [{ name: "uWetTime", size: 1, type: "float" }], fragment: "" };
  }

  public override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat("uWetTime", this.uWetTime);
  }

  public setTime(t: number): void {
    this.uWetTime = t;
  }

  public override getCustomCode(shaderType: string): { [point: string]: string } | null {
    const cfg = WET_SAND.get(this._material);
    if (!cfg) return null;
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `varying vec3 vWetLocal;\nvarying float vWetGrade;`,
        CUSTOM_VERTEX_MAIN_END: `
          vWetLocal = position;
          vec3 wetDir = normalize(position);
          float wetNr = max(dot(normalize(normal), wetDir), 1e-3);
          vWetGrade = sqrt(max(1.0 - wetNr * wetNr, 0.0)) / wetNr; // tan(slope)`,
      };
    }
    if (shaderType === "fragment") {
      const R = glslNum(cfg.radius);
      const sea = glslNum(cfg.seaLevel);
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: `
          varying vec3 vWetLocal;
          varying float vWetGrade;
          ${FAST_NOISE_GLSL}
          ${swashGLSL(cfg.swash)}`,
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
          // Height above sea level (m) right at this fragment.
          float wetAbove = length(vWetLocal) - ${R} - ${sea};
          if (wetAbove < 4.0) {
            float wetShallow = clamp(1.0 + wetAbove / 3.0, 0.0, 1.0);
            // Run-up height of the swash here, converted to a horizontal
            // reach through the local grade: on flat beaches the sheet
            // travels far, on steep ones it barely moves.
            float wetRise = swashRise(vWetLocal, uWetTime, wetShallow);
            float wetGrade = max(vWetGrade, 0.02);
            float wetEdge = wetRise;
            float wetWin = 0.12 + 0.2 * wetGrade;
            float wet = smoothstep(wetEdge + 0.3 * wetWin, wetEdge - 0.7 * wetWin, wetAbove);
            float damp = smoothstep(wetEdge + 3.0 * wetWin, wetEdge, wetAbove) * 0.55;
            float moisture = clamp(max(wet, damp), 0.0, 1.0);
            surfaceAlbedo *= mix(1.0, 0.58, moisture);
            float wetPhase = swashPhaseA(vWetLocal, uWetTime, wetShallow);
            float backwash = smoothstep(0.2, -0.6, cos(wetPhase));
            float laceNoise = waterNoise(vWetLocal * 6.0 + vec3(0.0, uWetTime * 0.08, 0.0));
            float lace = backwash * (1.0 - smoothstep(0.0, 2.0 * wetWin, max(wetAbove - wetEdge, 0.0)))
                       * smoothstep(0.45, 0.75, laceNoise);
            surfaceAlbedo = mix(surfaceAlbedo, vec3(0.96, 0.97, 0.98), clamp(lace, 0.0, 0.85));
          }`,
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
