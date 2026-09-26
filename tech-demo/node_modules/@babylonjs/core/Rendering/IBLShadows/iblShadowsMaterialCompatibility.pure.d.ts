/** This file must only contain pure code and pure imports */
import { type Material } from "../../Materials/material.pure.js";
/**
 * Determines whether a material can receive IBL shadows by hosting an `IBLShadowsPluginMaterial`.
 *
 * Shared by both the legacy `IblShadowsRenderPipeline` and the Frame Graph
 * `FrameGraphIblShadowsRendererTask` so the two code paths cannot drift out of sync.
 * @param material The material to test.
 * @returns True if the material supports the IBL shadows plugin.
 * @internal
 */
export declare function IsIBLShadowsReceiverCompatible(material: Material): boolean;
