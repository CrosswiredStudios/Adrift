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
            vec3 wetDry = surfaceAlbedo;
            surfaceAlbedo *= mix(1.0, 0.58, moisture);
            // Backwash lace: thin bubble filaments stranded on the sand the
            // sheet just uncovered. Only on exposed sand (never under the
            // waterline, where it read as white blotches on the sea floor),
            // fine-scaled, and tinted from the sand itself so dark sand gets
            // a grey residue rather than paint-white patches.
            float wetExposed = wetAbove - wetEdge;
            float wetPhase = swashPhaseA(vWetLocal, uWetTime, wetShallow);
            float backwash = smoothstep(0.2, -0.6, cos(wetPhase));
            float laceBand = smoothstep(0.03, 0.1, wetExposed)
                           * (1.0 - smoothstep(0.4 * wetWin, 2.0 * wetWin, wetExposed));
            float laceDist = length(vEyePosition.xyz - vPositionW);
            float laceFade = 1.0 - smoothstep(20.0, 55.0, laceDist);
            float lace = 0.0;
            if (backwash * laceBand * laceFade > 0.001) {
              vec3 laceDrift = vec3(0.0, uWetTime * 0.05, 0.0);
              float laceCover = smoothstep(0.35, 0.7, waterNoise(vWetLocal * 2.5 + laceDrift));
              float laceRidge = 1.0 - abs(waterNoise(vWetLocal * 11.0 - laceDrift) * 2.0 - 1.0);
              float laceLines = smoothstep(0.8, 0.96, laceRidge);
              lace = backwash * laceBand * laceFade * laceCover * laceLines;
            }
            vec3 laceCol = min(wetDry * 1.45 + vec3(0.12), vec3(0.92));
            surfaceAlbedo = mix(surfaceAlbedo, laceCol, clamp(lace, 0.0, 0.6));
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
