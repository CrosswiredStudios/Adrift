import { type FrameGraphTextureHandle, type Scene, type FrameGraph, type AbstractMesh, type ObjectRendererOptions, type FrameGraphRenderContext, type FrameGraphRenderPass, type ObjectRenderer, type GeometryRenderingMeshBlendTagProvider } from "../../../index.js";
import { type GeometryRenderingObjectIdProvider } from "../../../Materials/materialHelper.geometryrendering.js";
import { FrameGraphObjectRendererTask } from "./objectRendererTask.js";
/**
 * Description of a texture used by the geometry renderer task.
 */
export interface IFrameGraphGeometryRendererTextureDescription {
    /**
     * The type of the texture.
     * The value should be one of the Constants.PREPASS_XXX_TEXTURE_TYPE values.
     */
    type: number;
    /**
     * The type of the texture.
     */
    textureType: number;
    /**
     * The format of the texture.
     */
    textureFormat: number;
}
/**
 * Task used to render geometry to a set of textures.
 */
export declare class FrameGraphGeometryRendererTask extends FrameGraphObjectRendererTask {
    /**
     * The size of the output textures (default is 100% of the back buffer texture size).
     */
    size: {
        width: number;
        height: number;
    };
    /**
     * Whether the size is a percentage of the back buffer size (default is true).
     */
    sizeIsPercentage: boolean;
    /**
     * The number of samples to use for the output textures (default is 1).
     */
    samples: number;
    private _reverseCulling;
    /**
     * Whether to reverse culling (default is false).
     */
    get reverseCulling(): boolean;
    set reverseCulling(value: boolean);
    /**
     * Indicates if a mesh shouldn't be rendered when its material has depth write disabled (default is true).
     */
    dontRenderWhenMaterialDepthWriteIsDisabled: boolean;
    private _disableDepthPrePass;
    /**
     * Indicates whether the depth pre-pass is disabled (default is true).
     * Materials that require depth pre-pass (Material.needDepthPrePass == true) don't work with the geometry renderer, that's why this setting is true by default.
     * However, if the geometry renderer doesn't generate any geometry textures but only renders to the main target texture, then depth pre-pass can be enabled.
     */
    get disableDepthPrePass(): boolean;
    set disableDepthPrePass(value: boolean);
    /**
     * The list of texture descriptions used by the geometry renderer task.
     */
    textureDescriptions: IFrameGraphGeometryRendererTextureDescription[];
    private _objectIdProvider?;
    private _meshBlendTagProvider?;
    /**
     * Provides the object ID written for each rendered mesh.
     *
     * IDs must be integers between 0 and 0xFFFFFF for RGBA textures, or between 0 and 0xFF for RED textures.
     * ID 0 is reserved for background or excluded meshes.
     * By default, meshes use their unique ID.
     * Instances use the ID of their source mesh. Default IDs are only stable for the lifetime of the current scene and should not be persisted.
     * When using a RED texture, provide a custom ID if mesh unique IDs can exceed 0xFF.
     * The provider runs in the render hot path and may be called multiple times for the same mesh in a frame.
     * @see https://playground.babylonjs.com/?version=preview#00T6WJ#0
     */
    get objectIdProvider(): GeometryRenderingObjectIdProvider | undefined;
    set objectIdProvider(value: GeometryRenderingObjectIdProvider | undefined);
    /**
     * Provides the packed mesh-blending tag written for each rendered mesh.
     *
     * Tags must be 0 or contain a group ID between 1 and 63 in their low six bits. Tag 0 disables mesh blending.
     * By default, meshes use their `meshBlendingTag` property. Instances and thin instances use the source mesh tag.
     * The provider runs in the render hot path and receives the source mesh for instanced draws.
     * It should avoid allocations and return a consistent value for a mesh during a render.
     */
    get meshBlendTagProvider(): GeometryRenderingMeshBlendTagProvider | undefined;
    set meshBlendTagProvider(value: GeometryRenderingMeshBlendTagProvider | undefined);
    /**
     * The irradiance output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     */
    readonly geometryIrradianceTexture: FrameGraphTextureHandle;
    /**
     * The depth (in view space) output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     */
    readonly geometryViewDepthTexture: FrameGraphTextureHandle;
    /**
     * The normalized depth (in view space) output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     * The normalization is (d - near) / (far - near), where d is the depth value in view space and near and far are the near and far planes of the camera.
     */
    readonly geometryNormViewDepthTexture: FrameGraphTextureHandle;
    /**
     * The depth (in screen space) output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     */
    readonly geometryScreenDepthTexture: FrameGraphTextureHandle;
    /**
     * The normal (in view space) output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     */
    readonly geometryViewNormalTexture: FrameGraphTextureHandle;
    /**
     * The normal (in world space, encoded from [-1, 1] to [0, 1]) output texture.
     * Will point to a valid texture only if that texture has been requested in textureDescriptions!
     */
    readonly geometryWorldNormalTexture: FrameGraphTextureHandle;
    /**
     * The position (in local space) output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     */
    readonly geometryLocalPositionTexture: FrameGraphTextureHandle;
    /**
     * The position (in world space) output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     */
    readonly geometryWorldPositionTexture: FrameGraphTextureHandle;
    /**
     * The albedo output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     */
    readonly geometryAlbedoTexture: FrameGraphTextureHandle;
    /**
     * The reflectivity output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     */
    readonly geometryReflectivityTexture: FrameGraphTextureHandle;
    /**
     * The velocity output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     * Built-in CPU/GPU particles write neutral velocity (0.5, 0.5); their motion is not represented.
     */
    readonly geometryVelocityTexture: FrameGraphTextureHandle;
    /**
     * The linear velocity output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     * Built-in CPU/GPU particles write neutral velocity (0, 0); their motion is not represented.
     */
    readonly geometryLinearVelocityTexture: FrameGraphTextureHandle;
    /**
     * The object ID output texture. Will point to a valid texture only if that texture has been requested in textureDescriptions!
     * RGBA unsigned byte textures store 24-bit IDs, while RED unsigned byte textures store 8-bit IDs.
     * Decode RED values with `round(value * 255.0)`.
     */
    readonly geometryObjectIdTexture: FrameGraphTextureHandle;
    /**
     * The packed, single-sample R8UI mesh-blending tag output texture for WebGL2 and WebGPU.
     *
     * Opaque, alpha-tested, and caller-selected transparent meshes are supported.
     */
    readonly geometryMeshBlendTagTexture: FrameGraphTextureHandle;
    /**
     * Gets or sets the name of the task.
     */
    get name(): string;
    set name(value: string);
    private _clearAttachmentsLayout;
    private _allAttachmentsLayout;
    private _colorAttachmentsLayout;
    /**
     * Constructs a new geometry renderer task.
     * @param name The name of the task.
     * @param frameGraph The frame graph the task belongs to.
     * @param scene The scene the frame graph is associated with.
     * @param options The options of the object renderer.
     * @param existingObjectRenderer An existing object renderer to use (optional). If provided, the options parameter will be ignored.
     */
    constructor(name: string, frameGraph: FrameGraph, scene: Scene, options?: ObjectRendererOptions, existingObjectRenderer?: ObjectRenderer);
    /**
     * Gets the list of excluded meshes from the velocity texture.
     */
    get excludedSkinnedMeshFromVelocityTexture(): AbstractMesh[];
    /**
     * Excludes the given skinned mesh from computing bones velocities.
     * Computing bones velocities can have a cost. The cost can be saved by calling this function and by passing the skinned mesh to ignore.
     * @param skinnedMesh The mesh containing the skeleton to ignore when computing the velocity map.
     */
    excludeSkinnedMeshFromVelocityTexture(skinnedMesh: AbstractMesh): void;
    /**
     * Removes the given skinned mesh from the excluded meshes to integrate bones velocities while rendering the velocity map.
     * @param skinnedMesh The mesh containing the skeleton that has been ignored previously.
     * @see excludeSkinnedMesh to exclude a skinned mesh from bones velocity computation.
     */
    removeExcludedSkinnedMeshFromVelocityTexture(skinnedMesh: AbstractMesh): void;
    getClassName(): string;
    /**
     * Records the geometry renderer task into the frame graph.
     * @param skipCreationOfDisabledPasses defines whether disabled passes should be skipped
     * @param additionalExecute defines an optional callback executed by the pass
     * @returns the recorded render pass
     */
    record(skipCreationOfDisabledPasses?: boolean, additionalExecute?: (context: FrameGraphRenderContext) => void): FrameGraphRenderPass;
    dispose(): void;
    protected _resolveDanglingHandles(_targetTextures: FrameGraphTextureHandle[]): void;
    protected _checkParameters(): void;
    protected _checkTextureCompatibility(targetTextures: FrameGraphTextureHandle[]): boolean;
    protected _getTargetHandles(): FrameGraphTextureHandle[];
    protected _prepareRendering(context: FrameGraphRenderContext, depthEnabled: boolean): number[];
    private _getTargetTextureCount;
    private _buildClearAttachmentsLayout;
    private _registerForRenderPassId;
}
