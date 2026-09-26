import { EffectWrapper } from "../Materials/effectRenderer.pure.js";
import { EngineStore } from "../Engines/engineStore.js";

import { Matrix } from "../Maths/math.vector.pure.js";
import { _IsMeshBlendingSupported } from "../Meshes/meshBlendingTag.js";
import { _CreateMeshBlendBlueNoiseTexture } from "./meshBlendingBlueNoise.js";
/**
 * Quality level used by mesh blending.
 *
 * Each value selects a separate compile-time shader variant. Medium is the default.
 */
export var MeshBlendQuality;
(function (MeshBlendQuality) {
    /** Three search directions with the lowest refinement and exact-boundary sample counts, using sRGB color interpolation. */
    MeshBlendQuality[MeshBlendQuality["Low"] = 0] = "Low";
    /** Three search directions with balanced refinement and exact-boundary sample counts, using OKLab color interpolation. */
    MeshBlendQuality[MeshBlendQuality["Medium"] = 1] = "Medium";
    /** Three search directions with OKLab interpolation, full rotation, close-neighbor fallback, tiny-object protection, and multi-target blending. */
    MeshBlendQuality[MeshBlendQuality["High"] = 2] = "High";
    /** Eight search directions with OKLab interpolation and the largest radial and exact-boundary sample counts. */
    MeshBlendQuality[MeshBlendQuality["Cinematic"] = 3] = "Cinematic";
})(MeshBlendQuality || (MeshBlendQuality = {}));
/**
 * Debug visualization produced by mesh blending.
 */
export var MeshBlendDebugMode;
(function (MeshBlendDebugMode) {
    /** Render the blended scene color. */
    MeshBlendDebugMode[MeshBlendDebugMode["Off"] = 0] = "Off";
    /** Visualize the packed group and radius-class tag. */
    MeshBlendDebugMode[MeshBlendDebugMode["PackedTag"] = 1] = "PackedTag";
    /** Visualize the refined candidate direction and normalized boundary distance. */
    MeshBlendDebugMode[MeshBlendDebugMode["CandidateDirectionDistance"] = 2] = "CandidateDirectionDistance";
    /** Visualize the selected radius class and the resulting seam fade. */
    MeshBlendDebugMode[MeshBlendDebugMode["SeamFade"] = 3] = "SeamFade";
    /** Visualize why a candidate was accepted or rejected by contact validation. */
    MeshBlendDebugMode[MeshBlendDebugMode["RejectionReason"] = 4] = "RejectionReason";
    /** Visualize the approximate amount of shader work performed by each pixel. */
    MeshBlendDebugMode[MeshBlendDebugMode["StageWork"] = 5] = "StageWork";
    /** Visualize target continuation success, fallback use, and rejection. */
    MeshBlendDebugMode[MeshBlendDebugMode["Continuation"] = 6] = "Continuation";
    /** Visualize the effective-radius reduction applied to thin projected objects. */
    MeshBlendDebugMode[MeshBlendDebugMode["TinyObject"] = 7] = "TinyObject";
    /** Visualize primary-only and secondary-target selections at multi-mesh junctions. */
    MeshBlendDebugMode[MeshBlendDebugMode["MultiTarget"] = 8] = "MultiTarget";
    /** Visualize the farther, boundary-plus-one, boundary-plus-two, and constructed target-color samples. */
    MeshBlendDebugMode[MeshBlendDebugMode["TargetColor"] = 9] = "TargetColor";
    /** Visualize the fade attenuation applied by the base-color shadow-transfer heuristic. Neutral when no base-color texture is provided. */
    MeshBlendDebugMode[MeshBlendDebugMode["ShadowAttenuation"] = 10] = "ShadowAttenuation";
    /** Visualize the active color-interpolation mode after target-color construction. */
    MeshBlendDebugMode[MeshBlendDebugMode["ColorInterpolation"] = 11] = "ColorInterpolation";
    /** Visualize the reconstructed world position. */
    MeshBlendDebugMode[MeshBlendDebugMode["WorldPosition"] = 12] = "WorldPosition";
})(MeshBlendDebugMode || (MeshBlendDebugMode = {}));
/**
 * Depth representation consumed by mesh blending.
 */
export var MeshBlendDepthType;
(function (MeshBlendDepthType) {
    /** Signed camera-space Z written by the geometry renderer's view-depth output. */
    MeshBlendDepthType[MeshBlendDepthType["View"] = 0] = "View";
    /** Hardware depth in the normalized screen-depth range. */
    MeshBlendDepthType[MeshBlendDepthType["Screen"] = 1] = "Screen";
})(MeshBlendDepthType || (MeshBlendDepthType = {}));
const _MeshBlendingEffectWrapperOwners = new WeakMap();
/**
 * Checks whether a thin mesh-blending wrapper is already exclusively owned.
 * @param wrapper Wrapper to check.
 * @returns Whether the wrapper already has an owner.
 * @internal
 */
export function _IsMeshBlendingEffectWrapperOwned(wrapper) {
    return _MeshBlendingEffectWrapperOwners.has(wrapper);
}
/**
 * Claims exclusive ownership of a thin mesh-blending wrapper.
 * @param wrapper Wrapper to claim.
 * @param owner Owner claiming the wrapper.
 * @internal
 */
export function _ClaimMeshBlendingEffectWrapper(wrapper, owner) {
    if (_MeshBlendingEffectWrapperOwners.has(wrapper)) {
        throw new Error("ThinMeshBlendingPostProcess is already attached to another owner");
    }
    _MeshBlendingEffectWrapperOwners.set(wrapper, owner);
}
/**
 * Releases exclusive ownership of a thin mesh-blending wrapper.
 * @param wrapper Wrapper to release.
 * @param owner Owner releasing the wrapper.
 * @internal
 */
export function _ReleaseMeshBlendingEffectWrapper(wrapper, owner) {
    if (_MeshBlendingEffectWrapperOwners.get(wrapper) === owner) {
        _MeshBlendingEffectWrapperOwners.delete(wrapper);
    }
}
function _ValidateWorldRadius(value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError("Mesh-blending world radii must be finite non-negative numbers.");
    }
}
function _ValidateMinimumProjectedRadius(value) {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError("Mesh-blending minimum projected radii must be finite non-negative numbers.");
    }
}
function _CreateValidatedRadiusDefinition(worldRadius, minimumProjectedRadius) {
    let validatedWorldRadius = 0;
    let validatedMinimumProjectedRadius = 0;
    const definition = {};
    Object.defineProperties(definition, {
        worldRadius: {
            enumerable: true,
            get: () => validatedWorldRadius,
            set: (value) => {
                _ValidateWorldRadius(value);
                validatedWorldRadius = value;
            },
        },
        minimumProjectedRadius: {
            enumerable: true,
            get: () => validatedMinimumProjectedRadius,
            set: (value) => {
                _ValidateMinimumProjectedRadius(value);
                validatedMinimumProjectedRadius = value;
            },
        },
    });
    definition.worldRadius = worldRadius;
    definition.minimumProjectedRadius = minimumProjectedRadius;
    return definition;
}
/**
 * Creates a new set of default mesh-blending radius definitions.
 * @returns Four independently mutable radius definitions ordered from small to extra large.
 */
export function CreateDefaultMeshBlendRadiusDefinitions() {
    return Object.freeze([
        _CreateValidatedRadiusDefinition(0.06, 1.5),
        _CreateValidatedRadiusDefinition(0.1, 3),
        _CreateValidatedRadiusDefinition(0.2, 3),
        _CreateValidatedRadiusDefinition(0.3, 5),
    ]);
}
function _MeshBlendLinearToSrgbChannel(value) {
    return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}
function _MeshBlendSrgbToLinearChannel(value) {
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}
/**
 * Converts linear sRGB to Babylon mesh-blending OKLab coordinates.
 * @param color Linear sRGB color. HDR components are preserved.
 * @returns OKLab coordinates.
 * @see https://bottosson.github.io/posts/oklab/
 * @internal
 */
export function _LinearSrgbToMeshBlendOklab(color) {
    const long = 0.4122214708 * color[0] + 0.5363325363 * color[1] + 0.0514459929 * color[2];
    const medium = 0.2119034982 * color[0] + 0.6806995451 * color[1] + 0.1073969566 * color[2];
    const short = 0.0883024619 * color[0] + 0.2817188376 * color[1] + 0.6299787005 * color[2];
    const longRoot = Math.cbrt(long);
    const mediumRoot = Math.cbrt(medium);
    const shortRoot = Math.cbrt(short);
    return [
        0.2104542553 * longRoot + 0.793617785 * mediumRoot - 0.0040720468 * shortRoot,
        1.9779984951 * longRoot - 2.428592205 * mediumRoot + 0.4505937099 * shortRoot,
        0.0259040371 * longRoot + 0.7827717662 * mediumRoot - 0.808675766 * shortRoot,
    ];
}
/**
 * Converts Babylon mesh-blending OKLab coordinates to linear sRGB.
 * @param color OKLab coordinates.
 * @returns Linear sRGB color without gamut or HDR clamping.
 * @see https://bottosson.github.io/posts/oklab/
 * @internal
 */
export function _MeshBlendOklabToLinearSrgb(color) {
    const longRoot = color[0] + 0.3963377774 * color[1] + 0.2158037573 * color[2];
    const mediumRoot = color[0] - 0.1055613458 * color[1] - 0.0638541728 * color[2];
    const shortRoot = color[0] - 0.0894841775 * color[1] - 1.291485548 * color[2];
    const long = longRoot * longRoot * longRoot;
    const medium = mediumRoot * mediumRoot * mediumRoot;
    const short = shortRoot * shortRoot * shortRoot;
    return [
        4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
        -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
        -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
    ];
}
/**
 * Interpolates two linear SceneColor values using the selected mesh-blending quality policy.
 * @param current Current linear SceneColor.
 * @param target Target linear SceneColor.
 * @param amount Interpolation amount.
 * @param quality Mesh-blending quality that selects sRGB or OKLab interpolation.
 * @returns Interpolated linear SceneColor without HDR clamping.
 * @internal
 */
export function _InterpolateMeshBlendColor(current, target, amount, quality) {
    const settings = _GetMeshBlendQualitySettings(quality);
    let currentColor;
    let targetColor;
    if (settings.colorInterpolation === "sRGB") {
        currentColor = [_MeshBlendLinearToSrgbChannel(current[0]), _MeshBlendLinearToSrgbChannel(current[1]), _MeshBlendLinearToSrgbChannel(current[2])];
        targetColor = [_MeshBlendLinearToSrgbChannel(target[0]), _MeshBlendLinearToSrgbChannel(target[1]), _MeshBlendLinearToSrgbChannel(target[2])];
        return [
            _MeshBlendSrgbToLinearChannel(currentColor[0] + (targetColor[0] - currentColor[0]) * amount),
            _MeshBlendSrgbToLinearChannel(currentColor[1] + (targetColor[1] - currentColor[1]) * amount),
            _MeshBlendSrgbToLinearChannel(currentColor[2] + (targetColor[2] - currentColor[2]) * amount),
        ];
    }
    currentColor = _LinearSrgbToMeshBlendOklab(current);
    targetColor = _LinearSrgbToMeshBlendOklab(target);
    return _MeshBlendOklabToLinearSrgb([
        currentColor[0] + (targetColor[0] - currentColor[0]) * amount,
        currentColor[1] + (targetColor[1] - currentColor[1]) * amount,
        currentColor[2] + (targetColor[2] - currentColor[2]) * amount,
    ]);
}
const _MeshBlendQualitySettings = [
    {
        directionCount: 3,
        radialSampleCount: 2,
        directionRefinementSampleCount: 1,
        directionRefinementStepCount: 2,
        exactEdgeSampleCount: 5,
        radiusScale: 0.5,
        fullRandomRotation: false,
        searchJitterFactor: 0.5,
        immediateFourNeighborFallback: false,
        tinyObjectSafeguard: false,
        multiTargetSecondaryBlend: false,
        colorInterpolation: "sRGB",
    },
    {
        directionCount: 3,
        radialSampleCount: 3,
        directionRefinementSampleCount: 2,
        directionRefinementStepCount: 4,
        exactEdgeSampleCount: 8,
        radiusScale: 0.9,
        fullRandomRotation: false,
        searchJitterFactor: 0.5,
        immediateFourNeighborFallback: false,
        tinyObjectSafeguard: false,
        multiTargetSecondaryBlend: false,
        colorInterpolation: "OKLab",
    },
    {
        directionCount: 3,
        radialSampleCount: 3,
        directionRefinementSampleCount: 3,
        directionRefinementStepCount: 5,
        exactEdgeSampleCount: 10,
        radiusScale: 1,
        fullRandomRotation: true,
        searchJitterFactor: 0.5,
        immediateFourNeighborFallback: true,
        tinyObjectSafeguard: true,
        multiTargetSecondaryBlend: true,
        colorInterpolation: "OKLab",
    },
    {
        directionCount: 8,
        radialSampleCount: 6,
        directionRefinementSampleCount: 4,
        directionRefinementStepCount: 5,
        exactEdgeSampleCount: 50,
        radiusScale: 0.95,
        fullRandomRotation: true,
        searchJitterFactor: 1,
        immediateFourNeighborFallback: true,
        tinyObjectSafeguard: true,
        multiTargetSecondaryBlend: true,
        colorInterpolation: "OKLab",
    },
];
/**
 * Gets the complete quality settings used to compile a mesh-blending shader variant.
 * @param quality Quality to inspect.
 * @returns The immutable settings for the quality.
 * @internal
 */
export function _GetMeshBlendQualitySettings(quality) {
    const settings = _MeshBlendQualitySettings[quality];
    if (!settings || !Number.isInteger(quality)) {
        throw new RangeError("Mesh-blending quality must be Low, Medium, High, or Cinematic.");
    }
    return settings;
}
/**
 * Gets the radius scale used by a mesh-blending quality level.
 * @param quality Quality to convert.
 * @returns The radius scale applied after projection and the minimum-pixel floor.
 * @internal
 */
export function _GetMeshBlendQualityRadiusScale(quality) {
    return _GetMeshBlendQualitySettings(quality).radiusScale;
}
/**
 * Projects a world-space mesh-blending radius to physical render-target pixels.
 * @param worldRadius Radius in Babylon world units.
 * @param viewDepth Positive distance from the camera.
 * @param renderTargetHeight Physical render-target height.
 * @param projectionYScale Absolute Y scale from the projection matrix.
 * @param isOrthographic Whether the projection is orthographic.
 * @returns The projected radius in physical pixels.
 * @internal
 */
export function _ProjectMeshBlendWorldRadiusToPixels(worldRadius, viewDepth, renderTargetHeight, projectionYScale, isOrthographic) {
    const projectionScale = 0.5 * renderTargetHeight * Math.abs(projectionYScale);
    return worldRadius * (isOrthographic ? projectionScale : projectionScale / Math.max(Math.abs(viewDepth), 1e-5));
}
/**
 * Calculates the final mesh-blending search radius.
 * @param definition Radius-class definition.
 * @param viewDepth Positive distance from the camera.
 * @param renderTargetHeight Physical render-target height.
 * @param projectionYScale Absolute Y scale from the projection matrix.
 * @param isOrthographic Whether the projection is orthographic.
 * @param quality Quality whose radius scale is applied.
 * @returns The final radius in physical pixels.
 * @internal
 */
export function _CalculateMeshBlendSearchRadius(definition, viewDepth, renderTargetHeight, projectionYScale, isOrthographic, quality) {
    const projectedRadius = _ProjectMeshBlendWorldRadiusToPixels(definition.worldRadius, viewDepth, renderTargetHeight, projectionYScale, isOrthographic);
    const scaledRadius = Math.max(projectedRadius, definition.minimumProjectedRadius) * _GetMeshBlendQualityRadiusScale(quality);
    return scaledRadius > 0 ? Math.max(1, scaledRadius) : 0;
}
/**
 * Calculates the mesh-blending fade for a candidate boundary.
 * @param distancePixels Distance from the current pixel center to the target pixel center.
 * @param searchRadiusPixels Effective search radius in physical pixels.
 * @returns Blend weight in the range 0 through 0.5.
 * @internal
 */
export function _CalculateMeshBlendFade(distancePixels, searchRadiusPixels) {
    const boundaryDistance = Math.max(distancePixels - 0.5, 0);
    const normalizedDistance = Math.min(Math.max(boundaryDistance / Math.max(searchRadiusPixels, 0.00001), 0), 1);
    const inverseDistance = 1 - normalizedDistance;
    const fade = inverseDistance * inverseDistance + (inverseDistance - inverseDistance * inverseDistance) * Math.min(Math.max(inverseDistance - 0.75, 0), 1);
    return fade * 0.5;
}
/**
 * Converts a physical-pixel radius back to the represented world-space radius.
 * @param radiusPixels Radius in physical render-target pixels.
 * @param viewDepth Positive distance from the camera.
 * @param renderTargetHeight Physical render-target height.
 * @param projectionYScale Absolute Y scale from the projection matrix.
 * @param isOrthographic Whether the projection is orthographic.
 * @returns The represented radius in Babylon world units.
 * @internal
 */
export function _CalculateMeshBlendEffectiveWorldRadius(radiusPixels, viewDepth, renderTargetHeight, projectionYScale, isOrthographic) {
    const projectionScale = Math.max(0.5 * renderTargetHeight * Math.abs(projectionYScale), 1e-5);
    return radiusPixels * (isOrthographic ? 1 / projectionScale : Math.max(Math.abs(viewDepth), 1e-5) / projectionScale);
}
/**
 * Calculates the contact-slope radius multiplier.
 * @param oppositeFacing Cosine-domain alignment of the two surface spans.
 * @param slopeFactor User-configurable narrowing factor.
 * @returns A multiplier in the range [0.25, 1].
 * @internal
 */
export function _CalculateMeshBlendSlopeScale(oppositeFacing, slopeFactor) {
    if (slopeFactor <= 1) {
        return 1;
    }
    return 0.25 + 0.75 * Math.pow(Math.max(0, Math.min(oppositeFacing, 1)), slopeFactor - 1);
}
/**
 * Gets the compile-time shader define for a mesh-blending quality.
 * @param quality Quality to convert.
 * @returns The quality define.
 * @internal
 */
export function _GetMeshBlendQualityDefine(quality) {
    switch (quality) {
        case MeshBlendQuality.Low:
            return "#define MESH_BLEND_QUALITY_LOW";
        case MeshBlendQuality.Medium:
            return "#define MESH_BLEND_QUALITY_MEDIUM";
        case MeshBlendQuality.High:
            return "#define MESH_BLEND_QUALITY_HIGH";
        case MeshBlendQuality.Cinematic:
            return "#define MESH_BLEND_QUALITY_CINEMATIC";
        default:
            throw new RangeError("Mesh-blending quality must be Low, Medium, High, or Cinematic.");
    }
}
/**
 * Gets all compile-time defines for a mesh-blending quality variant.
 * @param quality Quality to convert.
 * @returns Newline-separated shader defines containing all quality-specific constants and feature switches.
 * @internal
 */
export function _GetMeshBlendQualityDefines(quality) {
    const settings = _GetMeshBlendQualitySettings(quality);
    const defines = [
        _GetMeshBlendQualityDefine(quality),
        `#define MESH_BLEND_DIRECTION_COUNT ${settings.directionCount}`,
        `#define MESH_BLEND_RADIAL_SAMPLE_COUNT ${settings.radialSampleCount}`,
        `#define MESH_BLEND_DIRECTION_REFINEMENT_SAMPLE_COUNT ${settings.directionRefinementSampleCount}`,
        `#define MESH_BLEND_DIRECTION_REFINEMENT_STEP_COUNT ${settings.directionRefinementStepCount}`,
        `#define MESH_BLEND_EXACT_EDGE_SAMPLE_COUNT ${settings.exactEdgeSampleCount}`,
        `#define MESH_BLEND_RADIUS_SCALE ${settings.radiusScale.toFixed(2)}`,
        `#define MESH_BLEND_JITTER_FACTOR ${settings.searchJitterFactor.toFixed(2)}`,
    ];
    if (settings.fullRandomRotation) {
        defines.push("#define MESH_BLEND_FULL_RANDOM_ROTATION");
    }
    if (settings.immediateFourNeighborFallback) {
        defines.push("#define MESH_BLEND_FOUR_NEIGHBOR_FALLBACK");
    }
    if (settings.tinyObjectSafeguard) {
        defines.push("#define MESH_BLEND_TINY_OBJECT_SAFEGUARD");
    }
    if (settings.multiTargetSecondaryBlend) {
        defines.push("#define MESH_BLEND_MULTI_TARGET_SECONDARY_BLEND");
    }
    defines.push(settings.colorInterpolation === "sRGB" ? "#define MESH_BLEND_COLOR_INTERPOLATION_SRGB" : "#define MESH_BLEND_COLOR_INTERPOLATION_OKLAB");
    return defines.join("\n");
}
function _ValidateDebugMode(value) {
    if (value < MeshBlendDebugMode.Off || value > MeshBlendDebugMode.WorldPosition || !Number.isInteger(value)) {
        throw new RangeError("Mesh-blending debug mode must be Off, PackedTag, CandidateDirectionDistance, SeamFade, RejectionReason, StageWork, Continuation, TinyObject, MultiTarget, TargetColor, ShadowAttenuation, ColorInterpolation, or WorldPosition.");
    }
}
function _ValidateDepthType(value) {
    if (value !== MeshBlendDepthType.View && value !== MeshBlendDepthType.Screen) {
        throw new RangeError("Mesh-blending depthType must be View or Screen.");
    }
}
function _NormalizeDefines(defines) {
    return Array.isArray(defines) ? defines.join("\n") : (defines ?? "");
}
function _BuildMeshBlendDefines(quality, debugMode, depthType, hasBaseColorTexture, customDefines = "") {
    _ValidateDebugMode(debugMode);
    _ValidateDepthType(depthType);
    const defines = customDefines ? [customDefines, _GetMeshBlendQualityDefines(quality)] : [_GetMeshBlendQualityDefines(quality)];
    if (debugMode !== MeshBlendDebugMode.Off) {
        defines.push("#define MESH_BLEND_DEBUG_ENABLED");
    }
    if (debugMode === MeshBlendDebugMode.PackedTag) {
        defines.push("#define MESH_BLEND_DEBUG_PACKED_TAG");
    }
    else if (debugMode === MeshBlendDebugMode.CandidateDirectionDistance) {
        defines.push("#define MESH_BLEND_DEBUG_CANDIDATE_DIRECTION_DISTANCE");
    }
    else if (debugMode === MeshBlendDebugMode.SeamFade) {
        defines.push("#define MESH_BLEND_DEBUG_SEAM_FADE");
    }
    else if (debugMode === MeshBlendDebugMode.RejectionReason) {
        defines.push("#define MESH_BLEND_DEBUG_REJECTION_REASON");
    }
    else if (debugMode === MeshBlendDebugMode.StageWork) {
        defines.push("#define MESH_BLEND_DEBUG_STAGE_WORK");
    }
    else if (debugMode === MeshBlendDebugMode.Continuation) {
        defines.push("#define MESH_BLEND_DEBUG_CONTINUATION");
    }
    else if (debugMode === MeshBlendDebugMode.TinyObject) {
        defines.push("#define MESH_BLEND_DEBUG_TINY_OBJECT");
    }
    else if (debugMode === MeshBlendDebugMode.MultiTarget) {
        defines.push("#define MESH_BLEND_DEBUG_MULTI_TARGET");
    }
    else if (debugMode === MeshBlendDebugMode.TargetColor) {
        defines.push("#define MESH_BLEND_DEBUG_TARGET_COLOR");
    }
    else if (debugMode === MeshBlendDebugMode.ShadowAttenuation) {
        defines.push("#define MESH_BLEND_DEBUG_SHADOW_ATTENUATION");
    }
    else if (debugMode === MeshBlendDebugMode.ColorInterpolation) {
        defines.push("#define MESH_BLEND_DEBUG_COLOR_INTERPOLATION");
    }
    else if (debugMode === MeshBlendDebugMode.WorldPosition) {
        defines.push("#define MESH_BLEND_DEBUG_WORLD_POSITION");
    }
    if (depthType === MeshBlendDepthType.Screen) {
        defines.push("#define MESH_BLEND_DEPTH_SCREEN");
    }
    if (hasBaseColorTexture) {
        defines.push("#define MESH_BLEND_SHADOW_ESTIMATION");
    }
    return defines.join("\n");
}
function _ValidateRadiusDefinition(definition) {
    _ValidateWorldRadius(definition.worldRadius);
    _ValidateMinimumProjectedRadius(definition.minimumProjectedRadius);
}
/**
 * Validates mesh-blending configuration without mutating an effect.
 * @param options Configuration to validate.
 * @internal
 */
export function _ValidateMeshBlendConfiguration(options) {
    if (!options) {
        return;
    }
    if (options.quality !== undefined) {
        _GetMeshBlendQualitySettings(options.quality);
    }
    if (options.debugMode !== undefined) {
        _ValidateDebugMode(options.debugMode);
    }
    if (options.depthType !== undefined) {
        _ValidateDepthType(options.depthType);
    }
    if (options.radiusClasses) {
        if (options.radiusClasses.length !== 4) {
            throw new RangeError("Mesh-blending radiusClasses must contain exactly four radius definitions.");
        }
        for (const definition of options.radiusClasses) {
            _ValidateRadiusDefinition(definition);
        }
    }
    if (options.slopeFactor !== undefined && (!Number.isFinite(options.slopeFactor) || options.slopeFactor < 1)) {
        throw new RangeError("Mesh-blending slopeFactor must be a finite number greater than or equal to 1.");
    }
}
function _CopyRadiusDefinitions(target, source) {
    if (!source || source.length !== 4) {
        throw new RangeError("Mesh blending requires exactly four radius definitions.");
    }
    for (const definition of source) {
        _ValidateRadiusDefinition(definition);
    }
    for (let index = 0; index < 4; index++) {
        target[index].worldRadius = source[index].worldRadius;
        target[index].minimumProjectedRadius = source[index].minimumProjectedRadius;
    }
}
/**
 * Shared WebGL2 and WebGPU effect wrapper used to visually blend SceneColor across validated contacts between opaque or alpha-tested meshes.
 *
 * The effect does not modify geometry, depth, normals, collisions, or shadows. Transparent rendering is caller-controlled;
 * overlapping transparent surfaces can make SceneColor inconsistent with the single-layer geometry inputs. Meshes opt in
 * with a packed tag whose group is in the range 1..63; group 0 disables blending. Surfaces in the same nonzero group are
 * treated as one logical object and do not blend with one another. The four radius classes combine an authored world-space
 * radius with a minimum radius measured in physical render-target pixels.
 *
 * Perspective and orthographic cameras are supported. Search noise is spatially stable and never varies by frame.
 * Optional base-color input enables shadow estimation; without it, the related sampler and shader work are compiled out.
 * The effect does not require or implement TAA.
 */
export class ThinMeshBlendingPostProcess extends EffectWrapper {
    _gatherImports(useWebGPU, list) {
        if (useWebGPU) {
            this._webGPUReady = true;
            list.push(import("../ShadersWGSL/meshBlending.fragment.js"));
        }
        else {
            list.push(import("../Shaders/meshBlending.fragment.js"));
        }
    }
    /**
     * Contact-slope narrowing factor. A value of 1 disables narrowing.
     */
    get slopeFactor() {
        return this._slopeFactor;
    }
    set slopeFactor(value) {
        if (!Number.isFinite(value) || value < 1) {
            throw new RangeError("Mesh-blending slopeFactor must be a finite number greater than or equal to 1.");
        }
        this._slopeFactor = value;
    }
    /**
     * Gets the compile-time quality variant.
     */
    get quality() {
        return this._quality;
    }
    set quality(value) {
        if (this._quality === value) {
            return;
        }
        _GetMeshBlendQualitySettings(value);
        this._quality = value;
        this._updateEffectDefines();
    }
    /**
     * Gets the compiled debug visualization.
     */
    get debugMode() {
        return this._debugMode;
    }
    set debugMode(value) {
        if (this._debugMode === value) {
            return;
        }
        _ValidateDebugMode(value);
        this._debugMode = value;
        this._updateEffectDefines();
    }
    /**
     * Gets the representation stored in the bound depth texture.
     */
    get depthType() {
        return this._depthType;
    }
    set depthType(value) {
        _ValidateDepthType(value);
        if (this._depthType === value) {
            return;
        }
        this._depthType = value;
        this._updateEffectDefines();
    }
    /**
     * Whether a base-color texture is bound and shadow estimation should be compiled.
     * @internal
     */
    get hasBaseColorTexture() {
        return this._hasBaseColorTexture;
    }
    set hasBaseColorTexture(value) {
        if (this._hasBaseColorTexture === value) {
            return;
        }
        this._hasBaseColorTexture = value;
        this._updateEffectDefines();
    }
    /**
     * Constructs a mesh-blending post process.
     * @param name Name of the effect.
     * @param engine Engine used to render the effect.
     * @param options Options used to configure the effect.
     */
    constructor(name, engine = null, options) {
        const resolvedEngine = engine || EngineStore.LastCreatedEngine;
        if (!_IsMeshBlendingSupported(resolvedEngine)) {
            throw new Error("ThinMeshBlendingPostProcess requires WebGL2 or WebGPU");
        }
        const quality = options?.quality ?? MeshBlendQuality.Medium;
        const debugMode = options?.debugMode ?? MeshBlendDebugMode.Off;
        const depthType = options?.depthType ?? MeshBlendDepthType.View;
        const customDefines = _NormalizeDefines(options?.defines ?? null);
        _ValidateMeshBlendConfiguration(options);
        super({
            ...options,
            name,
            engine: resolvedEngine,
            useShaderStore: true,
            useAsPostProcess: true,
            fragmentShader: ThinMeshBlendingPostProcess.FragmentUrl,
            uniforms: ThinMeshBlendingPostProcess.Uniforms,
            samplers: ThinMeshBlendingPostProcess.Samplers,
            defines: _BuildMeshBlendDefines(quality, debugMode, depthType, false, customDefines),
        });
        /**
         * The four configurable radius definitions indexed by packed radius class.
         *
         * Both values are projected against the active camera and the physical depth-texture height.
         */
        this.radiusClasses = CreateDefaultMeshBlendRadiusDefinitions();
        /**
         * Camera used to project radii and reconstruct view-space positions.
         */
        this.camera = null;
        this._slopeFactor = 2;
        this._quality = MeshBlendQuality.Medium;
        this._debugMode = MeshBlendDebugMode.Off;
        this._depthType = MeshBlendDepthType.View;
        this._hasBaseColorTexture = false;
        this._inverseProjection = new Matrix();
        this._inverseView = new Matrix();
        this._cachedProjection = null;
        this._cachedView = null;
        this._projectionUpdateFlag = -1;
        this._viewUpdateFlag = -1;
        this._customDefines = customDefines;
        this._applyConfiguration(options);
        this._stableBlueNoiseTexture = _CreateMeshBlendBlueNoiseTexture(resolvedEngine);
    }
    /**
     * Applies shared mesh-blending configuration.
     * @param options Values to apply. Omitted values retain their current settings.
     */
    configure(options) {
        const definesChanged = this._applyConfiguration(options);
        if (definesChanged) {
            this._updateEffectDefines();
        }
    }
    _applyConfiguration(options) {
        if (!options) {
            return false;
        }
        _ValidateMeshBlendConfiguration(options);
        const previousQuality = this._quality;
        const previousDebugMode = this._debugMode;
        const previousDepthType = this._depthType;
        if (options.radiusClasses) {
            _CopyRadiusDefinitions(this.radiusClasses, options.radiusClasses);
        }
        if (options.slopeFactor !== undefined) {
            this.slopeFactor = options.slopeFactor;
        }
        if (options.depthType !== undefined) {
            _ValidateDepthType(options.depthType);
            this._depthType = options.depthType;
        }
        const quality = options.quality ?? this._quality;
        const debugMode = options.debugMode ?? this._debugMode;
        _GetMeshBlendQualitySettings(quality);
        _ValidateDebugMode(debugMode);
        this._quality = quality;
        this._debugMode = debugMode;
        return previousQuality !== quality || previousDebugMode !== debugMode || previousDepthType !== this._depthType;
    }
    bind(noDefaultBindings = false) {
        super.bind(noDefaultBindings);
        if (!this.camera) {
            throw new Error("ThinMeshBlendingPostProcess: camera is required before binding.");
        }
        const effect = this._drawWrapper.effect;
        const projection = this._updateInverseProjection();
        for (const definition of this.radiusClasses) {
            _ValidateRadiusDefinition(definition);
        }
        effect.setMatrix("projection", projection);
        effect.setMatrix("inverseProjection", this._inverseProjection);
        if (this._debugMode === MeshBlendDebugMode.WorldPosition) {
            const view = this.camera.getViewMatrix();
            if (this._cachedView !== view || this._viewUpdateFlag !== view.updateFlag) {
                view.invertToRef(this._inverseView);
                this._cachedView = view;
                this._viewUpdateFlag = view.updateFlag;
            }
            effect.setMatrix("inverseView", this._inverseView);
        }
        effect.setFloat4("blendWorldRadii", this.radiusClasses[0].worldRadius, this.radiusClasses[1].worldRadius, this.radiusClasses[2].worldRadius, this.radiusClasses[3].worldRadius);
        effect.setFloat4("minimumProjectedRadii", this.radiusClasses[0].minimumProjectedRadius, this.radiusClasses[1].minimumProjectedRadius, this.radiusClasses[2].minimumProjectedRadius, this.radiusClasses[3].minimumProjectedRadius);
        effect.setFloat("meshBlendIsOrthographic", this.camera.mode === 1 ? 1 : 0);
        effect.setFloat("slopeFactor", this._slopeFactor);
        effect.setTexture("meshBlendBlueNoiseSampler", this._stableBlueNoiseTexture);
    }
    _updateInverseProjection() {
        const projection = this.camera.getProjectionMatrix();
        if (this._cachedProjection !== projection || this._projectionUpdateFlag !== projection.updateFlag) {
            projection.invertToRef(this._inverseProjection);
            this._cachedProjection = projection;
            this._projectionUpdateFlag = projection.updateFlag;
        }
        return projection;
    }
    dispose() {
        this._stableBlueNoiseTexture.dispose();
        super.dispose();
    }
    _updateEffectDefines() {
        this.updateEffect(_BuildMeshBlendDefines(this._quality, this._debugMode, this._depthType, this._hasBaseColorTexture, this._customDefines));
    }
}
/**
 * The fragment shader URL.
 */
ThinMeshBlendingPostProcess.FragmentUrl = "meshBlending";
/**
 * The list of uniforms used by the effect.
 */
ThinMeshBlendingPostProcess.Uniforms = ["projection", "inverseProjection", "inverseView", "blendWorldRadii", "minimumProjectedRadii", "meshBlendIsOrthographic", "slopeFactor"];
/**
 * The list of samplers used by the effect.
 */
ThinMeshBlendingPostProcess.Samplers = ["meshBlendTagSampler", "meshBlendDepthSampler", "meshBlendBaseColorSampler", "meshBlendBlueNoiseSampler"];
//# sourceMappingURL=thinMeshBlendingPostProcess.js.map