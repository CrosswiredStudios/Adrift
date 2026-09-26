
import { PostProcess } from "./postProcess.pure.js";
import { MeshBlendDepthType, ThinMeshBlendingPostProcess, _ClaimMeshBlendingEffectWrapper, _IsMeshBlendingEffectWrapperOwned, _ReleaseMeshBlendingEffectWrapper, _ValidateMeshBlendConfiguration, } from "./thinMeshBlendingPostProcess.js";
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
export class MeshBlendingPostProcess extends PostProcess {
    /**
     * Gets the compile-time quality variant.
     */
    get quality() {
        return this._effectWrapper.quality;
    }
    set quality(value) {
        this._effectWrapper.quality = value;
    }
    /**
     * The packed R8UI mesh-blending tag texture used by the effect.
     */
    get meshBlendTagTexture() {
        return this._meshBlendTagTexture;
    }
    set meshBlendTagTexture(value) {
        MeshBlendingPostProcess._ValidateMeshBlendTagTexture(value);
        MeshBlendingPostProcess._ValidateInputTextureDimensions(value, this._depthTexture, this._baseColorTexture);
        this._meshBlendTagTexture = value;
        this._validateInputDimensions();
    }
    /**
     * The depth texture used for position reconstruction and contact validation.
     */
    get depthTexture() {
        return this._depthTexture;
    }
    set depthTexture(value) {
        MeshBlendingPostProcess._ValidateDepthTexture(value, this.depthType);
        MeshBlendingPostProcess._ValidateInputTextureDimensions(this._meshBlendTagTexture, value, this._baseColorTexture);
        this._depthTexture = value;
        this._validateInputDimensions();
    }
    /**
     * The optional linear base-color/albedo geometry texture used by the shadow-transfer heuristic.
     *
     * Setting null compiles shadow estimation out.
     */
    get baseColorTexture() {
        return this._baseColorTexture;
    }
    set baseColorTexture(value) {
        if (value) {
            MeshBlendingPostProcess._ValidateBaseColorTexture(value);
        }
        MeshBlendingPostProcess._ValidateInputTextureDimensions(this._meshBlendTagTexture, this._depthTexture, value);
        this._baseColorTexture = value;
        this._effectWrapper.hasBaseColorTexture = !!value;
        this._validateInputDimensions();
    }
    /**
     * Gets the representation stored in the depth texture.
     */
    get depthType() {
        return this._effectWrapper.depthType;
    }
    set depthType(value) {
        if (this._depthTexture) {
            MeshBlendingPostProcess._ValidateDepthTexture(this._depthTexture, value);
        }
        this._effectWrapper.depthType = value;
    }
    /**
     * Gets the four configurable radius definitions indexed by packed radius class.
     */
    get radiusClasses() {
        return this._effectWrapper.radiusClasses;
    }
    /**
     * Gets the compiled debug visualization.
     */
    get debugMode() {
        return this._effectWrapper.debugMode;
    }
    set debugMode(value) {
        this._effectWrapper.debugMode = value;
    }
    /** Contact-slope narrowing factor. A value of 1 disables narrowing. */
    get slopeFactor() {
        return this._effectWrapper.slopeFactor;
    }
    set slopeFactor(value) {
        this._effectWrapper.slopeFactor = value;
    }
    /**
     * Applies shared mesh-blending configuration.
     * @param options Values to apply. Omitted values retain their current settings.
     */
    configure(options) {
        if (options?.depthType !== undefined) {
            MeshBlendingPostProcess._ValidateDepthTexture(this._depthTexture, options.depthType);
        }
        this._effectWrapper.configure(options);
    }
    /**
     * Creates a mesh-blending post process.
     * @param name The name of the post process.
     * @param scene The scene containing the camera.
     * @param camera The camera to attach the post process to.
     * @param options The post-process and input-texture options.
     */
    constructor(name, scene, camera, options) {
        const sceneEngine = scene.getEngine();
        if (camera.getScene() !== scene) {
            throw new Error("MeshBlendingPostProcess: scene and camera must belong to the same scene");
        }
        if (options.engine !== undefined && options.engine !== sceneEngine) {
            throw new Error("MeshBlendingPostProcess: options.engine must match the scene engine");
        }
        if (options.effectWrapper !== undefined && !(options.effectWrapper instanceof ThinMeshBlendingPostProcess)) {
            throw new TypeError("MeshBlendingPostProcess: effectWrapper must be a ThinMeshBlendingPostProcess");
        }
        if (options.effectWrapper !== undefined && options.effectWrapper.options.engine !== sceneEngine) {
            throw new Error("MeshBlendingPostProcess: effectWrapper must use the scene engine");
        }
        if (options.effectWrapper !== undefined && _IsMeshBlendingEffectWrapperOwned(options.effectWrapper)) {
            throw new Error("MeshBlendingPostProcess: effectWrapper is already attached to another classic mesh-blending post process");
        }
        const depthType = options.depthType ?? options.effectWrapper?.depthType ?? MeshBlendDepthType.View;
        MeshBlendingPostProcess._ValidateInputs(options, depthType);
        const ownsEffectWrapper = options.effectWrapper === undefined;
        const effectWrapper = options.effectWrapper ?? new ThinMeshBlendingPostProcess(name, sceneEngine, options);
        effectWrapper.hasBaseColorTexture = !!options.baseColorTexture;
        super(name, ThinMeshBlendingPostProcess.FragmentUrl, {
            ...options,
            camera,
            engine: sceneEngine,
            effectWrapper,
            uniforms: ThinMeshBlendingPostProcess.Uniforms,
            samplers: ThinMeshBlendingPostProcess.Samplers,
            textureType: options.textureType ?? 0,
        });
        this._ownsEffectWrapper = ownsEffectWrapper;
        _ClaimMeshBlendingEffectWrapper(effectWrapper, this);
        this._meshBlendTagTexture = options.meshBlendTagTexture;
        this._depthTexture = options.depthTexture;
        this._baseColorTexture = options.baseColorTexture ?? null;
        this._effectWrapper.configure(options);
        this._effectWrapper.camera = camera;
        this.doNotSerialize = true;
        this._validateInputDimensions();
        this.onApply = (effect) => {
            this._validateInputDimensions(this.width, this.height, this.inputTexture.samples);
            this._effectWrapper.camera = this.getCamera();
            effect.setTexture("meshBlendTagSampler", this._meshBlendTagTexture);
            effect.setTexture("meshBlendDepthSampler", this._depthTexture);
            if (this._baseColorTexture) {
                effect.setTexture("meshBlendBaseColorSampler", this._baseColorTexture);
            }
        };
    }
    getClassName() {
        return "MeshBlendingPostProcess";
    }
    dispose(camera) {
        super.dispose(camera);
        _ReleaseMeshBlendingEffectWrapper(this._effectWrapper, this);
        if (this._ownsEffectWrapper) {
            this._effectWrapper.dispose();
        }
    }
    /**
     * Classic mesh blending cannot be serialized because its geometry inputs are caller-owned runtime textures.
     * @throws Always throws because the classic wrapper is runtime-only.
     */
    serialize() {
        throw new Error("MeshBlendingPostProcess cannot be serialized; use the FrameGraph/NRGE path for serializable mesh blending");
    }
    /**
     * Classic mesh blending cannot be cloned because its geometry inputs are caller-owned runtime textures.
     * @returns Null.
     */
    clone() {
        return null;
    }
    static _ValidateInputs(options, depthType) {
        _ValidateMeshBlendConfiguration(options);
        MeshBlendingPostProcess._ValidateMeshBlendTagTexture(options.meshBlendTagTexture);
        MeshBlendingPostProcess._ValidateDepthTexture(options.depthTexture, depthType);
        if (options.baseColorTexture) {
            MeshBlendingPostProcess._ValidateBaseColorTexture(options.baseColorTexture);
        }
        MeshBlendingPostProcess._ValidateInputTextureDimensions(options.meshBlendTagTexture, options.depthTexture, options.baseColorTexture);
    }
    static _ValidateInputTextureDimensions(meshBlendTagTexture, depthTexture, baseColorTexture) {
        const tagInternalTexture = meshBlendTagTexture.getInternalTexture();
        const depthInternalTexture = depthTexture.getInternalTexture();
        const baseColorInternalTexture = baseColorTexture?.getInternalTexture();
        if (!tagInternalTexture || !depthInternalTexture) {
            return;
        }
        if (tagInternalTexture.width !== depthInternalTexture.width ||
            tagInternalTexture.height !== depthInternalTexture.height ||
            (baseColorInternalTexture !== null &&
                baseColorInternalTexture !== undefined &&
                (tagInternalTexture.width !== baseColorInternalTexture.width || tagInternalTexture.height !== baseColorInternalTexture.height))) {
            throw new Error("MeshBlendingPostProcess: meshBlendTagTexture, depthTexture, and baseColorTexture when provided must have matching physical dimensions");
        }
        const inputSamples = tagInternalTexture.samples || 1;
        if ((depthInternalTexture.samples || 1) !== inputSamples ||
            (baseColorInternalTexture !== null && baseColorInternalTexture !== undefined && (baseColorInternalTexture.samples || 1) !== inputSamples)) {
            throw new Error("MeshBlendingPostProcess: meshBlendTagTexture, depthTexture, and baseColorTexture when provided must have matching sample counts");
        }
    }
    static _ValidateMeshBlendTagTexture(texture) {
        const internalTexture = texture.getInternalTexture();
        if (!internalTexture) {
            return;
        }
        MeshBlendingPostProcess._Validate2DTexture(internalTexture, "meshBlendTagTexture");
        if (internalTexture.type !== 0 || internalTexture.format !== 8) {
            throw new Error("MeshBlendingPostProcess: meshBlendTagTexture must use TEXTURETYPE_UNSIGNED_BYTE with TEXTUREFORMAT_RED_INTEGER");
        }
        if (internalTexture.generateMipMaps || internalTexture.samplingMode !== 1 || internalTexture.samples > 1) {
            throw new Error("MeshBlendingPostProcess: meshBlendTagTexture must use nearest sampling without mipmaps and must be single-sampled");
        }
    }
    static _ValidateDepthTexture(texture, depthType) {
        const internalTexture = texture.getInternalTexture();
        if (!internalTexture) {
            return;
        }
        MeshBlendingPostProcess._Validate2DTexture(internalTexture, "depthTexture");
        const validFormat = internalTexture.format === 6 ||
            internalTexture.format === 7 ||
            internalTexture.format === 5;
        const validType = internalTexture.type === 1 ||
            internalTexture.type === 2 ||
            (depthType === MeshBlendDepthType.Screen && internalTexture.type === 0);
        if (!validFormat || !validType) {
            throw new Error(`MeshBlendingPostProcess: ${depthType === MeshBlendDepthType.View ? "view" : "screen"} depthTexture must use a floating-point color format${depthType === MeshBlendDepthType.Screen ? " or normalized unsigned bytes" : ""}`);
        }
        if (internalTexture.generateMipMaps || internalTexture.samples > 1) {
            throw new Error("MeshBlendingPostProcess: depthTexture must not use mipmaps and must be single-sampled");
        }
    }
    static _ValidateBaseColorTexture(texture) {
        const internalTexture = texture.getInternalTexture();
        if (!internalTexture) {
            return;
        }
        MeshBlendingPostProcess._Validate2DTexture(internalTexture, "baseColorTexture");
        const validFormat = internalTexture.format === 4 || internalTexture.format === 5;
        const validType = internalTexture.type === 0 ||
            internalTexture.type === 2 ||
            internalTexture.type === 1;
        if (!validFormat || !validType) {
            throw new Error("MeshBlendingPostProcess: baseColorTexture must use a non-integer RGB or RGBA color format");
        }
        if (internalTexture.generateMipMaps || internalTexture.samples > 1) {
            throw new Error("MeshBlendingPostProcess: baseColorTexture must not use mipmaps and must be single-sampled");
        }
    }
    static _Validate2DTexture(internalTexture, name) {
        if (internalTexture.isCube || internalTexture.is3D || internalTexture.is2DArray) {
            throw new Error(`MeshBlendingPostProcess: ${name} must be a 2D texture`);
        }
    }
    _validateInputDimensions(renderWidth, renderHeight, renderSamples) {
        MeshBlendingPostProcess._ValidateMeshBlendTagTexture(this._meshBlendTagTexture);
        MeshBlendingPostProcess._ValidateDepthTexture(this._depthTexture, this.depthType);
        if (this._baseColorTexture) {
            MeshBlendingPostProcess._ValidateBaseColorTexture(this._baseColorTexture);
        }
        const tagTexture = this._meshBlendTagTexture?.getInternalTexture();
        const depthTexture = this._depthTexture?.getInternalTexture();
        const baseColorTexture = this._baseColorTexture?.getInternalTexture();
        if (!tagTexture || !depthTexture) {
            return;
        }
        MeshBlendingPostProcess._ValidateInputTextureDimensions(this._meshBlendTagTexture, this._depthTexture, this._baseColorTexture);
        const inputSamples = tagTexture.samples || 1;
        if (renderWidth !== undefined && renderHeight !== undefined && renderWidth > 0 && renderHeight > 0) {
            if (tagTexture.width !== renderWidth ||
                tagTexture.height !== renderHeight ||
                (baseColorTexture !== null && baseColorTexture !== undefined && (baseColorTexture.width !== renderWidth || baseColorTexture.height !== renderHeight))) {
                throw new Error("MeshBlendingPostProcess: SceneColor, meshBlendTagTexture, depthTexture, and baseColorTexture when provided must have matching physical dimensions");
            }
            if ((renderSamples || 1) !== inputSamples) {
                throw new Error("MeshBlendingPostProcess: SceneColor, meshBlendTagTexture, depthTexture, and baseColorTexture when provided must have matching sample counts");
            }
        }
    }
}
//# sourceMappingURL=meshBlendingPostProcess.js.map