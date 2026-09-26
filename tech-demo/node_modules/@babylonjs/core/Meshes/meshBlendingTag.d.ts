import { type AbstractEngine } from "../Engines/abstractEngine.pure.js";
/**
 * Checks whether an engine supports the render-target and shader features required by mesh blending.
 * @param engine Engine to check.
 * @returns True for WebGL2 and WebGPU engines, and false for Native and WebGL1 engines.
 * @internal
 */
export declare function _IsMeshBlendingSupported(engine: AbstractEngine): boolean;
/**
 * Radius class stored in a packed mesh-blending tag.
 *
 * The selected class combines an authored world radius with a minimum projected radius. At a seam,
 * the smaller class from the two participating surfaces is used.
 */
export declare enum MeshBlendingRadiusClass {
    /** Small blend radius. */
    Small = 0,
    /** Medium blend radius. */
    Medium = 1,
    /** Large blend radius. */
    Large = 2,
    /** Extra-large blend radius. */
    ExtraLarge = 3
}
/**
 * Decoded values stored in a packed mesh-blending tag.
 */
export interface IMeshBlendingTag {
    /** Logical blend group. Group 0 disables mesh blending. */
    groupId: number;
    /** Radius class used to select the blend radius. */
    radiusClass: MeshBlendingRadiusClass;
}
/**
 * Packs a mesh-blending group and radius class into one byte.
 * @param groupId Logical blend group. Use 0 to disable mesh blending, otherwise use a value from 1 to 63.
 * @param radiusClass Radius class from 0 to 3.
 * @returns The packed mesh-blending tag.
 * @see https://playground.babylonjs.com/?version=preview#XVZTSI#3
 */
export declare function PackMeshBlendingTag(groupId: number, radiusClass: MeshBlendingRadiusClass): number;
/**
 * Decodes a packed mesh-blending tag.
 * @param tag Packed mesh-blending tag.
 * @returns The decoded group and radius class.
 */
export declare function UnpackMeshBlendingTag(tag: number): IMeshBlendingTag;
