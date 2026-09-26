import { type Nullable } from "../types.js";
import { EffectWrapper } from "../Materials/effectRenderer.pure.js";
import { type AbstractEngine } from "../Engines/abstractEngine.pure.js";
import { type EffectWrapperCreationOptions } from "../Materials/effectRenderer.js";
import { type Camera } from "../Cameras/camera.pure.js";
/**
 * Quality level used by mesh blending.
 *
 * Each value selects a separate compile-time shader variant. Medium is the default.
 */
export declare enum MeshBlendQuality {
    /** Three search directions with the lowest refinement and exact-boundary sample counts, using sRGB color interpolation. */
    Low = 0,
    /** Three search directions with balanced refinement and exact-boundary sample counts, using OKLab color interpolation. */
    Medium = 1,
    /** Three search directions with OKLab interpolation, full rotation, close-neighbor fallback, tiny-object protection, and multi-target blending. */
    High = 2,
    /** Eight search directions with OKLab interpolation and the largest radial and exact-boundary sample counts. */
    Cinematic = 3
}
/**
 * Debug visualization produced by mesh blending.
 */
export declare enum MeshBlendDebugMode {
    /** Render the blended scene color. */
    Off = 0,
    /** Visualize the packed group and radius-class tag. */
    PackedTag = 1,
    /** Visualize the refined candidate direction and normalized boundary distance. */
    CandidateDirectionDistance = 2,
    /** Visualize the selected radius class and the resulting seam fade. */
    SeamFade = 3,
    /** Visualize why a candidate was accepted or rejected by contact validation. */
    RejectionReason = 4,
    /** Visualize the approximate amount of shader work performed by each pixel. */
    StageWork = 5,
    /** Visualize target continuation success, fallback use, and rejection. */
    Continuation = 6,
    /** Visualize the effective-radius reduction applied to thin projected objects. */
    TinyObject = 7,
    /** Visualize primary-only and secondary-target selections at multi-mesh junctions. */
    MultiTarget = 8,
    /** Visualize the farther, boundary-plus-one, boundary-plus-two, and constructed target-color samples. */
    TargetColor = 9,
    /** Visualize the fade attenuation applied by the base-color shadow-transfer heuristic. Neutral when no base-color texture is provided. */
    ShadowAttenuation = 10,
    /** Visualize the active color-interpolation mode after target-color construction. */
    ColorInterpolation = 11,
    /** Visualize the reconstructed world position. */
    WorldPosition = 12
}
/**
 * Depth representation consumed by mesh blending.
 */
export declare enum MeshBlendDepthType {
    /** Signed camera-space Z written by the geometry renderer's view-depth output. */
    View = 0,
    /** Hardware depth in the normalized screen-depth range. */
    Screen = 1
}
/**
 * Radius values associated with one mesh-blending radius class.
 */
export interface IMeshBlendRadiusDefinition {
    /** Authored blend radius in Babylon world units. */
    worldRadius: number;
    /** Minimum search radius in physical render-target pixels. */
    minimumProjectedRadius: number;
}
/**
 * The four radius definitions indexed by the packed mesh-blending radius class.
 */
export type MeshBlendRadiusDefinitions = readonly [IMeshBlendRadiusDefinition, IMeshBlendRadiusDefinition, IMeshBlendRadiusDefinition, IMeshBlendRadiusDefinition];
/**
 * Checks whether a thin mesh-blending wrapper is already exclusively owned.
 * @param wrapper Wrapper to check.
 * @returns Whether the wrapper already has an owner.
 * @internal
 */
export declare function _IsMeshBlendingEffectWrapperOwned(wrapper: ThinMeshBlendingPostProcess): boolean;
/**
 * Claims exclusive ownership of a thin mesh-blending wrapper.
 * @param wrapper Wrapper to claim.
 * @param owner Owner claiming the wrapper.
 * @internal
 */
export declare function _ClaimMeshBlendingEffectWrapper(wrapper: ThinMeshBlendingPostProcess, owner: object): void;
/**
 * Releases exclusive ownership of a thin mesh-blending wrapper.
 * @param wrapper Wrapper to release.
 * @param owner Owner releasing the wrapper.
 * @internal
 */
export declare function _ReleaseMeshBlendingEffectWrapper(wrapper: ThinMeshBlendingPostProcess, owner: object): void;
/**
 * Configurable mesh-blending values shared by the classic and frame-graph wrappers.
 */
export interface IMeshBlendConfiguration {
    /** Compile-time quality variant. */
    quality?: MeshBlendQuality;
    /** Radius definitions indexed by packed radius class. Exactly four definitions are required. */
    radiusClasses?: readonly [IMeshBlendRadiusDefinition, IMeshBlendRadiusDefinition, IMeshBlendRadiusDefinition, IMeshBlendRadiusDefinition];
    /** Contact-slope narrowing factor. A value of 1 disables narrowing. */
    slopeFactor?: number;
    /** Representation stored in the depth texture. */
    depthType?: MeshBlendDepthType;
    /** Debug visualization to compile into the shader. Off renders the final blended result. */
    debugMode?: MeshBlendDebugMode;
}
/**
 * Options used to create a thin mesh-blending post process.
 */
export interface IThinMeshBlendingPostProcessOptions extends EffectWrapperCreationOptions, IMeshBlendConfiguration {
}
/**
 * Creates a new set of default mesh-blending radius definitions.
 * @returns Four independently mutable radius definitions ordered from small to extra large.
 */
export declare function CreateDefaultMeshBlendRadiusDefinitions(): MeshBlendRadiusDefinitions;
interface IMeshBlendQualitySettings {
    directionCount: number;
    radialSampleCount: number;
    directionRefinementSampleCount: number;
    directionRefinementStepCount: number;
    exactEdgeSampleCount: number;
    radiusScale: number;
    fullRandomRotation: boolean;
    searchJitterFactor: number;
    immediateFourNeighborFallback: boolean;
    tinyObjectSafeguard: boolean;
    multiTargetSecondaryBlend: boolean;
    colorInterpolation: "sRGB" | "OKLab";
}
type MeshBlendColorTuple = readonly [number, number, number];
/**
 * Converts linear sRGB to Babylon mesh-blending OKLab coordinates.
 * @param color Linear sRGB color. HDR components are preserved.
 * @returns OKLab coordinates.
 * @see https://bottosson.github.io/posts/oklab/
 * @internal
 */
export declare function _LinearSrgbToMeshBlendOklab(color: MeshBlendColorTuple): [number, number, number];
/**
 * Converts Babylon mesh-blending OKLab coordinates to linear sRGB.
 * @param color OKLab coordinates.
 * @returns Linear sRGB color without gamut or HDR clamping.
 * @see https://bottosson.github.io/posts/oklab/
 * @internal
 */
export declare function _MeshBlendOklabToLinearSrgb(color: MeshBlendColorTuple): [number, number, number];
/**
 * Interpolates two linear SceneColor values using the selected mesh-blending quality policy.
 * @param current Current linear SceneColor.
 * @param target Target linear SceneColor.
 * @param amount Interpolation amount.
 * @param quality Mesh-blending quality that selects sRGB or OKLab interpolation.
 * @returns Interpolated linear SceneColor without HDR clamping.
 * @internal
 */
export declare function _InterpolateMeshBlendColor(current: MeshBlendColorTuple, target: MeshBlendColorTuple, amount: number, quality: MeshBlendQuality): [number, number, number];
/**
 * Gets the complete quality settings used to compile a mesh-blending shader variant.
 * @param quality Quality to inspect.
 * @returns The immutable settings for the quality.
 * @internal
 */
export declare function _GetMeshBlendQualitySettings(quality: MeshBlendQuality): Readonly<IMeshBlendQualitySettings>;
/**
 * Gets the radius scale used by a mesh-blending quality level.
 * @param quality Quality to convert.
 * @returns The radius scale applied after projection and the minimum-pixel floor.
 * @internal
 */
export declare function _GetMeshBlendQualityRadiusScale(quality: MeshBlendQuality): number;
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
export declare function _ProjectMeshBlendWorldRadiusToPixels(worldRadius: number, viewDepth: number, renderTargetHeight: number, projectionYScale: number, isOrthographic: boolean): number;
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
export declare function _CalculateMeshBlendSearchRadius(definition: IMeshBlendRadiusDefinition, viewDepth: number, renderTargetHeight: number, projectionYScale: number, isOrthographic: boolean, quality: MeshBlendQuality): number;
/**
 * Calculates the mesh-blending fade for a candidate boundary.
 * @param distancePixels Distance from the current pixel center to the target pixel center.
 * @param searchRadiusPixels Effective search radius in physical pixels.
 * @returns Blend weight in the range 0 through 0.5.
 * @internal
 */
export declare function _CalculateMeshBlendFade(distancePixels: number, searchRadiusPixels: number): number;
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
export declare function _CalculateMeshBlendEffectiveWorldRadius(radiusPixels: number, viewDepth: number, renderTargetHeight: number, projectionYScale: number, isOrthographic: boolean): number;
/**
 * Calculates the contact-slope radius multiplier.
 * @param oppositeFacing Cosine-domain alignment of the two surface spans.
 * @param slopeFactor User-configurable narrowing factor.
 * @returns A multiplier in the range [0.25, 1].
 * @internal
 */
export declare function _CalculateMeshBlendSlopeScale(oppositeFacing: number, slopeFactor: number): number;
/**
 * Gets the compile-time shader define for a mesh-blending quality.
 * @param quality Quality to convert.
 * @returns The quality define.
 * @internal
 */
export declare function _GetMeshBlendQualityDefine(quality: MeshBlendQuality): string;
/**
 * Gets all compile-time defines for a mesh-blending quality variant.
 * @param quality Quality to convert.
 * @returns Newline-separated shader defines containing all quality-specific constants and feature switches.
 * @internal
 */
export declare function _GetMeshBlendQualityDefines(quality: MeshBlendQuality): string;
/**
 * Validates mesh-blending configuration without mutating an effect.
 * @param options Configuration to validate.
 * @internal
 */
export declare function _ValidateMeshBlendConfiguration(options?: IMeshBlendConfiguration): void;
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
export declare class ThinMeshBlendingPostProcess extends EffectWrapper {
    /**
     * The fragment shader URL.
     */
    static readonly FragmentUrl = "meshBlending";
    /**
     * The list of uniforms used by the effect.
     */
    static readonly Uniforms: string[];
    /**
     * The list of samplers used by the effect.
     */
    static readonly Samplers: string[];
    protected _gatherImports(useWebGPU: boolean, list: Promise<any>[]): void;
    /**
     * The four configurable radius definitions indexed by packed radius class.
     *
     * Both values are projected against the active camera and the physical depth-texture height.
     */
    readonly radiusClasses: MeshBlendRadiusDefinitions;
    /**
     * Camera used to project radii and reconstruct view-space positions.
     */
    camera: Nullable<Camera>;
    private _slopeFactor;
    /**
     * Contact-slope narrowing factor. A value of 1 disables narrowing.
     */
    get slopeFactor(): number;
    set slopeFactor(value: number);
    private readonly _stableBlueNoiseTexture;
    private readonly _customDefines;
    private _quality;
    private _debugMode;
    private _depthType;
    private _hasBaseColorTexture;
    private readonly _inverseProjection;
    private readonly _inverseView;
    private _cachedProjection;
    private _cachedView;
    private _projectionUpdateFlag;
    private _viewUpdateFlag;
    /**
     * Gets the compile-time quality variant.
     */
    get quality(): MeshBlendQuality;
    set quality(value: MeshBlendQuality);
    /**
     * Gets the compiled debug visualization.
     */
    get debugMode(): MeshBlendDebugMode;
    set debugMode(value: MeshBlendDebugMode);
    /**
     * Gets the representation stored in the bound depth texture.
     */
    get depthType(): MeshBlendDepthType;
    set depthType(value: MeshBlendDepthType);
    /**
     * Whether a base-color texture is bound and shadow estimation should be compiled.
     * @internal
     */
    get hasBaseColorTexture(): boolean;
    set hasBaseColorTexture(value: boolean);
    /**
     * Constructs a mesh-blending post process.
     * @param name Name of the effect.
     * @param engine Engine used to render the effect.
     * @param options Options used to configure the effect.
     */
    constructor(name: string, engine?: Nullable<AbstractEngine>, options?: IThinMeshBlendingPostProcessOptions);
    /**
     * Applies shared mesh-blending configuration.
     * @param options Values to apply. Omitted values retain their current settings.
     */
    configure(options?: IMeshBlendConfiguration): void;
    private _applyConfiguration;
    bind(noDefaultBindings?: boolean): void;
    private _updateInverseProjection;
    dispose(): void;
    private _updateEffectDefines;
}
export {};
