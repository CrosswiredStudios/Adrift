import { type Camera } from "../Cameras/camera.pure.js";
import { type BaseTexture } from "../Materials/Textures/baseTexture.pure.js";
import { type Scene } from "../scene.pure.js";
import { type Nullable } from "../types.js";
import { PostProcess, type PostProcessOptions } from "./postProcess.pure.js";
import { type IMeshBlendConfiguration, type MeshBlendDebugMode, MeshBlendDepthType, type MeshBlendQuality, type MeshBlendRadiusDefinitions, ThinMeshBlendingPostProcess } from "./thinMeshBlendingPostProcess.js";
/**
 * Options used to create a mesh-blending post process.
 */
export interface IMeshBlendingPostProcessOptions extends PostProcessOptions, IMeshBlendConfiguration {
    /** Optional caller-owned thin mesh-blending effect wrapper. A wrapper can be attached to only one classic post process at a time. */
    effectWrapper?: ThinMeshBlendingPostProcess;
    /**
     * The packed R8UI mesh-blending tag texture.
     */
    meshBlendTagTexture: BaseTexture;
    /**
     * The view-depth or screen-depth texture aligned with the packed tag texture.
     */
    depthTexture: BaseTexture;
    /**
     * Optional linear base-color/albedo geometry texture aligned with SceneColor.
     *
     * When omitted, shadow estimation is compiled out.
     */
    baseColorTexture?: BaseTexture;
}
/**
 * Visually blends SceneColor across validated contacts between opaque or alpha-tested meshes.
 *
 * This WebGL2 and WebGPU effect does not change geometry, collision queries, depth, normals, or shadow geometry.
 * Transparent rendering is caller-controlled. Applications assign explicit group IDs from 1 through 63;
 * group 0 disables blending, and surfaces with the same nonzero group are treated as one logical object.
 *
 * The classic wrapper consumes caller-owned geometry textures and does not enable, configure, or dispose
 * a GeometryBufferRenderer. The tag, depth, and SceneColor inputs are required; optional base color enables
 * shadow estimation. All provided geometry inputs must have the same physical dimensions and sample count and
 * are single-sampled. Overlapping transparent surfaces can make SceneColor inconsistent with the single-layer
 * geometry inputs; compositing transparent content after this effect remains the recommended configuration.
 *
 * Four configurable radius classes combine world-space radii with physical-pixel minimums, for both
 * perspective and orthographic cameras. Quality variants trade search work for seam quality. Stable search
 * noise is internal and frame invariant. This implementation does not use temporal accumulation or require TAA.
 *
 * The classic wrapper is runtime-only because its geometry textures are caller-owned resources. It cannot
 * be serialized, parsed, or cloned; use the FrameGraph/NRGE path when a serializable graph is required.
 * @see https://meshblend.lervik.com/
 * @see https://www.jacktollenaar.top/articles/meshblending.html
 * @see https://www.jacktollenaar.top/articles/meshblending2.html
 * @see https://bottosson.github.io/posts/oklab/
 * @see https://playground.babylonjs.com/?version=preview#XVZTSI#3
 * @see https://playground.babylonjs.com/?version=preview#O05LI8#6
 */
export declare class MeshBlendingPostProcess extends PostProcess {
    protected _effectWrapper: ThinMeshBlendingPostProcess;
    private _meshBlendTagTexture;
    private _depthTexture;
    private _baseColorTexture;
    private readonly _ownsEffectWrapper;
    /**
     * Gets the compile-time quality variant.
     */
    get quality(): MeshBlendQuality;
    set quality(value: MeshBlendQuality);
    /**
     * The packed R8UI mesh-blending tag texture used by the effect.
     */
    get meshBlendTagTexture(): BaseTexture;
    set meshBlendTagTexture(value: BaseTexture);
    /**
     * The depth texture used for position reconstruction and contact validation.
     */
    get depthTexture(): BaseTexture;
    set depthTexture(value: BaseTexture);
    /**
     * The optional linear base-color/albedo geometry texture used by the shadow-transfer heuristic.
     *
     * Setting null compiles shadow estimation out.
     */
    get baseColorTexture(): Nullable<BaseTexture>;
    set baseColorTexture(value: Nullable<BaseTexture>);
    /**
     * Gets the representation stored in the depth texture.
     */
    get depthType(): MeshBlendDepthType;
    set depthType(value: MeshBlendDepthType);
    /**
     * Gets the four configurable radius definitions indexed by packed radius class.
     */
    get radiusClasses(): MeshBlendRadiusDefinitions;
    /**
     * Gets the compiled debug visualization.
     */
    get debugMode(): MeshBlendDebugMode;
    set debugMode(value: MeshBlendDebugMode);
    /** Contact-slope narrowing factor. A value of 1 disables narrowing. */
    get slopeFactor(): number;
    set slopeFactor(value: number);
    /**
     * Applies shared mesh-blending configuration.
     * @param options Values to apply. Omitted values retain their current settings.
     */
    configure(options?: IMeshBlendConfiguration): void;
    /**
     * Creates a mesh-blending post process.
     * @param name The name of the post process.
     * @param scene The scene containing the camera.
     * @param camera The camera to attach the post process to.
     * @param options The post-process and input-texture options.
     */
    constructor(name: string, scene: Scene, camera: Camera, options: IMeshBlendingPostProcessOptions);
    getClassName(): string;
    dispose(camera?: Camera): void;
    /**
     * Classic mesh blending cannot be serialized because its geometry inputs are caller-owned runtime textures.
     * @throws Always throws because the classic wrapper is runtime-only.
     */
    serialize(): never;
    /**
     * Classic mesh blending cannot be cloned because its geometry inputs are caller-owned runtime textures.
     * @returns Null.
     */
    clone(): null;
    private static _ValidateInputs;
    private static _ValidateInputTextureDimensions;
    private static _ValidateMeshBlendTagTexture;
    private static _ValidateDepthTexture;
    private static _ValidateBaseColorTexture;
    private static _Validate2DTexture;
    private _validateInputDimensions;
}
