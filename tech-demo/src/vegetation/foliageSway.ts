import { Material, MaterialPluginBase, UniformBuffer } from "@babylonjs/core";
import { glslNum } from "../common/shaderChunks";
import { PluginRegistry } from "../common/materialPlugin";

/**
 * Wind sway for the foliage cutout materials (SRP: sway effect lives here;
 * material assembly lives in vegetation.ts). Extracted verbatim from
 * vegetation.ts so the vertex shader is byte-identical.
 */

export interface SwayConfig {
  amp: number;
  freq: number;
}

const SWAY = new PluginRegistry<SwayConfig>();

/**
 * Tiny vertex bend applied to the cutout materials (before the thin-instance
 * transform, so the offset is in plant-local space). The phase is derived from
 * the instance translation carried in the thin-instance matrix attributes
 * (world3.xyz), so every plant sways out of step.
 *
 * NOTE: `getCustomCode` runs from the MaterialPluginBase constructor before
 * subclass fields exist, so the config lives in a material-keyed registry
 * populated by `attachSway` before construction (wet-sand precedent).
 */
export class FoliageSwayPlugin extends MaterialPluginBase {
  /** Simulation clock, mirrored into the effect uniform each frame. */
  public uSwayTime = 0;

  constructor(material: Material) {
    super(material, "FoliageSway", 215, { FOLIAGE_SWAY: true }, true, true);
  }

  public getClassName(): string {
    return "FoliageSway";
  }

  public bindForSubMesh(
    _uniformBuffer: UniformBuffer,
    _scene: unknown,
    _engine: unknown,
    _subMesh: unknown,
  ): void {
    const cfg = SWAY.get(this._material);
    if (!cfg) return;
    this._material.getEffect()?.setFloat("uSwayTime", this.uSwayTime);
  }

  public getCustomCode(shaderType: string): { [point: string]: string } | null {
    const cfg = SWAY.get(this._material);
    if (!cfg) return null;
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: `uniform float uSwayTime;`,
        CUSTOM_VERTEX_UPDATE_POSITION: `
          // Per-instance phase from the thin-instance translation.
          #ifdef INSTANCES
            float vegPhase = world3.x * 0.37 + world3.y * 0.21 + world3.z * 0.53;
          #else
            float vegPhase = 0.0;
          #endif
          #ifdef UV1
            float vegWeight = uv.y * uv.y; // bend the tops, pin the bases
          #else
            float vegWeight = 0.0;
          #endif
          float vegSway = sin(uSwayTime * ${glslNum(cfg.freq)} + vegPhase) * ${glslNum(cfg.amp)} * vegWeight;
          positionUpdated.x += vegSway;
          positionUpdated.z += vegSway * 0.55;`,
      };
    }
    return null;
  }
}

export function attachSway(material: Material, cfg: SwayConfig): FoliageSwayPlugin {
  SWAY.attach(material, cfg);
  return new FoliageSwayPlugin(material);
}
