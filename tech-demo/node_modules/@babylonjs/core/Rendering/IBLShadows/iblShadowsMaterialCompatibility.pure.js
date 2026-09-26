/** This file must only contain pure code and pure imports */
import { PBRBaseMaterial } from "../../Materials/PBR/pbrBaseMaterial.pure.js";
import { StandardMaterial } from "../../Materials/standardMaterial.pure.js";
import { OpenPBRMaterial } from "../../Materials/PBR/openpbrMaterial.pure.js";
/**
 * Determines whether a material can receive IBL shadows by hosting an `IBLShadowsPluginMaterial`.
 *
 * Shared by both the legacy `IblShadowsRenderPipeline` and the Frame Graph
 * `FrameGraphIblShadowsRendererTask` so the two code paths cannot drift out of sync.
 * @param material The material to test.
 * @returns True if the material supports the IBL shadows plugin.
 * @internal
 */
export function IsIBLShadowsReceiverCompatible(material) {
    return (material instanceof PBRBaseMaterial ||
        material instanceof StandardMaterial ||
        material instanceof OpenPBRMaterial ||
        // ShadowOnlyMaterial lives in the separate `materials` package (which `core` cannot import),
        // so it is identified by class name rather than `instanceof`.
        material.getClassName() === "ShadowOnlyMaterial");
}
//# sourceMappingURL=iblShadowsMaterialCompatibility.pure.js.map