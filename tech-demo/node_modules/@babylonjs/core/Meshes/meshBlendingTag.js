/**
 * Checks whether an engine supports the render-target and shader features required by mesh blending.
 * @param engine Engine to check.
 * @returns True for WebGL2 and WebGPU engines, and false for Native and WebGL1 engines.
 * @internal
 */
export function _IsMeshBlendingSupported(engine) {
    return engine.shaderPlatformName !== "NATIVE" && (engine.isWebGPU || engine.webGLVersion === 2);
}
/**
 * Radius class stored in a packed mesh-blending tag.
 *
 * The selected class combines an authored world radius with a minimum projected radius. At a seam,
 * the smaller class from the two participating surfaces is used.
 */
export var MeshBlendingRadiusClass;
(function (MeshBlendingRadiusClass) {
    /** Small blend radius. */
    MeshBlendingRadiusClass[MeshBlendingRadiusClass["Small"] = 0] = "Small";
    /** Medium blend radius. */
    MeshBlendingRadiusClass[MeshBlendingRadiusClass["Medium"] = 1] = "Medium";
    /** Large blend radius. */
    MeshBlendingRadiusClass[MeshBlendingRadiusClass["Large"] = 2] = "Large";
    /** Extra-large blend radius. */
    MeshBlendingRadiusClass[MeshBlendingRadiusClass["ExtraLarge"] = 3] = "ExtraLarge";
})(MeshBlendingRadiusClass || (MeshBlendingRadiusClass = {}));
/**
 * Packs a mesh-blending group and radius class into one byte.
 * @param groupId Logical blend group. Use 0 to disable mesh blending, otherwise use a value from 1 to 63.
 * @param radiusClass Radius class from 0 to 3.
 * @returns The packed mesh-blending tag.
 * @see https://playground.babylonjs.com/?version=preview#XVZTSI#3
 */
export function PackMeshBlendingTag(groupId, radiusClass) {
    if (!Number.isInteger(groupId) || groupId < 0 || groupId > 63) {
        throw new RangeError("Mesh-blending group ID must be an integer between 0 and 63.");
    }
    if (groupId === 0) {
        return 0;
    }
    if (!Number.isInteger(radiusClass) || radiusClass < MeshBlendingRadiusClass.Small || radiusClass > MeshBlendingRadiusClass.ExtraLarge) {
        throw new RangeError("Mesh-blending radius class must be an integer between 0 and 3.");
    }
    return (radiusClass << 6) | groupId;
}
/**
 * Decodes a packed mesh-blending tag.
 * @param tag Packed mesh-blending tag.
 * @returns The decoded group and radius class.
 */
export function UnpackMeshBlendingTag(tag) {
    if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) {
        throw new RangeError("Mesh-blending tag must be an integer between 0 and 255.");
    }
    const groupId = tag & 0x3f;
    if (tag !== 0 && groupId === 0) {
        throw new RangeError("A nonzero mesh-blending tag must contain a group ID between 1 and 63.");
    }
    return {
        groupId,
        radiusClass: tag >> 6,
    };
}
//# sourceMappingURL=meshBlendingTag.js.map