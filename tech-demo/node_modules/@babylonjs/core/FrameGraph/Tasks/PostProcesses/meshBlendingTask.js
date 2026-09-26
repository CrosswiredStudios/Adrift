
import { MeshBlendDepthType, ThinMeshBlendingPostProcess, _ClaimMeshBlendingEffectWrapper, _IsMeshBlendingEffectWrapperOwned, _ReleaseMeshBlendingEffectWrapper, } from "../../../PostProcesses/thinMeshBlendingPostProcess.js";
import { FrameGraphPostProcessTask } from "./postProcessTask.js";
import { _IsMeshBlendingSupported } from "../../../Meshes/meshBlendingTag.js";
function _Is2DTexture(creationOptions) {
    return (creationOptions.options.targetTypes?.[0] ?? 3553) === 3553;
}
function _GetTextureType(creationOptions) {
    return creationOptions.options.types?.[0] ?? 0;
}
function _GetTextureFormat(creationOptions) {
    return creationOptions.options.formats?.[0] ?? 5;
}
/**
 * Frame-graph task which visually blends SceneColor across validated contacts between opaque or alpha-tested meshes.
 *
 * This WebGL2 and WebGPU task uses the same effect and configuration as MeshBlendingPostProcess. It does not modify
 * geometry, collision queries, depth, normals, or shadows. All source and geometry textures must have matching
 * physical dimensions and sample counts. Transparent rendering is caller-controlled; overlapping transparent
 * surfaces can make SceneColor inconsistent with the single-layer geometry inputs. On WebGL2, rendering transparent
 * meshes into the integer tag attachment requires per-target blend parameters.
 * @see https://playground.babylonjs.com/?version=preview#O05LI8#6
 */
export class FrameGraphMeshBlendingTask extends FrameGraphPostProcessTask {
    /** Gets or sets the compile-time mesh-blending quality variant. */
    get quality() {
        return this.postProcess.quality;
    }
    set quality(value) {
        this.postProcess.quality = value;
    }
    /** Gets the four configurable radius definitions indexed by packed radius class. */
    get radiusClasses() {
        return this.postProcess.radiusClasses;
    }
    /** Gets or sets the contact-slope narrowing factor. A value of 1 disables narrowing. */
    get slopeFactor() {
        return this.postProcess.slopeFactor;
    }
    set slopeFactor(value) {
        this.postProcess.slopeFactor = value;
    }
    /** Gets or sets the representation stored in depthTexture. */
    get depthType() {
        return this.postProcess.depthType;
    }
    set depthType(value) {
        this.postProcess.depthType = value;
    }
    /** Gets or sets the compiled debug visualization. */
    get debugMode() {
        return this.postProcess.debugMode;
    }
    set debugMode(value) {
        this.postProcess.debugMode = value;
    }
    /**
     * Constructs a mesh-blending task.
     * @param name The name of the task.
     * @param frameGraph The frame graph this task belongs to.
     * @param thinPostProcess The thin post process to use. A new one is created when omitted.
     */
    constructor(name, frameGraph, thinPostProcess) {
        if (thinPostProcess && thinPostProcess.options.engine !== frameGraph.engine) {
            throw new Error(`FrameGraphMeshBlendingTask "${name}": thinPostProcess must use the frame graph engine`);
        }
        if (thinPostProcess && _IsMeshBlendingEffectWrapperOwned(thinPostProcess)) {
            throw new Error(`FrameGraphMeshBlendingTask "${name}": thinPostProcess is already attached to another owner`);
        }
        super(name, frameGraph, thinPostProcess || new ThinMeshBlendingPostProcess(name, frameGraph.engine));
        _ClaimMeshBlendingEffectWrapper(this.postProcess, this);
        this.sourceSamplingMode = 1;
    }
    dispose() {
        _ReleaseMeshBlendingEffectWrapper(this.postProcess, this);
        super.dispose();
    }
    /**
     * Applies the same configuration accepted by the classic MeshBlendingPostProcess wrapper.
     * @param options Values to apply. Omitted values retain their current settings.
     */
    configure(options) {
        this.postProcess.configure(options);
    }
    getClassName() {
        return "FrameGraphMeshBlendingTask";
    }
    record(skipCreationOfDisabledPasses = false) {
        this.sourceSamplingMode = 1;
        if (this.sourceTexture === undefined || this.meshBlendTagTexture === undefined || this.depthTexture === undefined || this.camera === undefined) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": sourceTexture, meshBlendTagTexture, depthTexture and camera are required`);
        }
        const engine = this._frameGraph.engine;
        if (!_IsMeshBlendingSupported(engine)) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": mesh blending requires WebGL2 or WebGPU`);
        }
        if (this.depthType !== MeshBlendDepthType.View && this.depthType !== MeshBlendDepthType.Screen) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": depthType must be View or Screen`);
        }
        const meshBlendTagCreationOptions = this._frameGraph.textureManager.getTextureCreationOptions(this.meshBlendTagTexture);
        const meshBlendTagType = _GetTextureType(meshBlendTagCreationOptions);
        const meshBlendTagFormat = _GetTextureFormat(meshBlendTagCreationOptions);
        const meshBlendTagSamples = meshBlendTagCreationOptions.options.samples ?? 1;
        if (meshBlendTagType !== 0 || meshBlendTagFormat !== 8) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": meshBlendTagTexture must use TEXTURETYPE_UNSIGNED_BYTE with TEXTUREFORMAT_RED_INTEGER`);
        }
        if (!_Is2DTexture(meshBlendTagCreationOptions)) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": meshBlendTagTexture must be a 2D texture`);
        }
        if (meshBlendTagSamples !== 1) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": meshBlendTagTexture must be single-sampled`);
        }
        if (meshBlendTagCreationOptions.options.createMipMaps) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": meshBlendTagTexture must not use mipmaps`);
        }
        const depthCreationOptions = this._frameGraph.textureManager.getTextureCreationOptions(this.depthTexture);
        const depthType = _GetTextureType(depthCreationOptions);
        const depthFormat = _GetTextureFormat(depthCreationOptions);
        const depthSamples = depthCreationOptions.options.samples ?? 1;
        const validDepthFormat = depthFormat === 6 || depthFormat === 7 || depthFormat === 5;
        const validDepthType = depthType === 1 ||
            depthType === 2 ||
            (this.depthType === MeshBlendDepthType.Screen && depthType === 0);
        if (!validDepthFormat || !validDepthType) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": ${this.depthType === MeshBlendDepthType.View ? "view" : "screen"} depthTexture has an incompatible type or format`);
        }
        if (!_Is2DTexture(depthCreationOptions)) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": depthTexture must be a 2D texture`);
        }
        if (depthSamples !== 1) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": depthTexture must be single-sampled`);
        }
        if (depthCreationOptions.options.createMipMaps) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": depthTexture must not use mipmaps`);
        }
        let baseColorSamples;
        if (this.baseColorTexture !== undefined) {
            const baseColorCreationOptions = this._frameGraph.textureManager.getTextureCreationOptions(this.baseColorTexture);
            const baseColorType = _GetTextureType(baseColorCreationOptions);
            const baseColorFormat = _GetTextureFormat(baseColorCreationOptions);
            baseColorSamples = baseColorCreationOptions.options.samples ?? 1;
            const validBaseColorFormat = baseColorFormat === 4 || baseColorFormat === 5;
            const validBaseColorType = baseColorType === 0 || baseColorType === 2 || baseColorType === 1;
            if (!validBaseColorFormat || !validBaseColorType) {
                throw new Error(`FrameGraphMeshBlendingTask "${this.name}": baseColorTexture must use a non-integer RGB or RGBA color format`);
            }
            if (!_Is2DTexture(baseColorCreationOptions)) {
                throw new Error(`FrameGraphMeshBlendingTask "${this.name}": baseColorTexture must be a 2D texture`);
            }
            if (baseColorCreationOptions.options.createMipMaps) {
                throw new Error(`FrameGraphMeshBlendingTask "${this.name}": baseColorTexture must not use mipmaps`);
            }
        }
        const sourceCreationOptions = this._frameGraph.textureManager.getTextureCreationOptions(this.sourceTexture);
        const sourceType = _GetTextureType(sourceCreationOptions);
        const sourceFormat = _GetTextureFormat(sourceCreationOptions);
        const sourceSamples = sourceCreationOptions.options.samples ?? 1;
        const validSourceFormat = sourceFormat === 4 || sourceFormat === 5;
        const validSourceType = sourceType === 0 || sourceType === 2 || sourceType === 1;
        if (!validSourceFormat || !validSourceType) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": sourceTexture must use a non-integer RGB or RGBA color format`);
        }
        if (!_Is2DTexture(sourceCreationOptions)) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": sourceTexture must be a 2D texture`);
        }
        if (sourceSamples !== meshBlendTagSamples || sourceSamples !== depthSamples || (baseColorSamples !== undefined && sourceSamples !== baseColorSamples)) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": sourceTexture, meshBlendTagTexture, depthTexture and baseColorTexture when provided must have matching sample counts`);
        }
        const sourceSize = this._frameGraph.textureManager.getTextureDescription(this.sourceTexture).size;
        const meshBlendTagSize = this._frameGraph.textureManager.getTextureDescription(this.meshBlendTagTexture).size;
        const depthSize = this._frameGraph.textureManager.getTextureDescription(this.depthTexture).size;
        const baseColorSize = this.baseColorTexture === undefined ? undefined : this._frameGraph.textureManager.getTextureDescription(this.baseColorTexture).size;
        if (sourceSize.width !== meshBlendTagSize.width ||
            sourceSize.height !== meshBlendTagSize.height ||
            sourceSize.width !== depthSize.width ||
            sourceSize.height !== depthSize.height ||
            (baseColorSize !== undefined && (sourceSize.width !== baseColorSize.width || sourceSize.height !== baseColorSize.height))) {
            throw new Error(`FrameGraphMeshBlendingTask "${this.name}": sourceTexture, meshBlendTagTexture, depthTexture and baseColorTexture when provided must have matching dimensions`);
        }
        if (this.targetTexture !== undefined) {
            const targetCreationOptions = this._frameGraph.textureManager.getTextureCreationOptions(this.targetTexture);
            const targetType = _GetTextureType(targetCreationOptions);
            const targetFormat = _GetTextureFormat(targetCreationOptions);
            const targetSamples = targetCreationOptions.options.samples ?? 1;
            const validTargetFormat = targetFormat === 4 || targetFormat === 5;
            const validTargetType = targetType === 0 || targetType === 2 || targetType === 1;
            if (!validTargetFormat || !validTargetType) {
                throw new Error(`FrameGraphMeshBlendingTask "${this.name}": targetTexture must use a non-integer RGB or RGBA color format`);
            }
            if (!_Is2DTexture(targetCreationOptions)) {
                throw new Error(`FrameGraphMeshBlendingTask "${this.name}": targetTexture must be a 2D texture`);
            }
            if (targetSamples !== sourceSamples) {
                throw new Error(`FrameGraphMeshBlendingTask "${this.name}": targetTexture and sourceTexture must have matching sample counts`);
            }
            const targetSize = this._frameGraph.textureManager.getTextureDescription(this.targetTexture).size;
            if (targetSize.width !== sourceSize.width || targetSize.height !== sourceSize.height) {
                throw new Error(`FrameGraphMeshBlendingTask "${this.name}": targetTexture and sourceTexture must have matching dimensions`);
            }
        }
        this.postProcess.camera = this.camera;
        this.postProcess.hasBaseColorTexture = this.baseColorTexture !== undefined;
        const pass = super.record(skipCreationOfDisabledPasses, (context) => {
            context.setTextureSamplingMode(this.meshBlendTagTexture, 1);
            context.setTextureSamplingMode(this.depthTexture, 1);
            if (this.baseColorTexture !== undefined) {
                context.setTextureSamplingMode(this.baseColorTexture, 1);
            }
        }, (context) => {
            context.bindTextureHandle(this._postProcessDrawWrapper.effect, "meshBlendTagSampler", this.meshBlendTagTexture);
            context.bindTextureHandle(this._postProcessDrawWrapper.effect, "meshBlendDepthSampler", this.depthTexture);
            if (this.baseColorTexture !== undefined) {
                context.bindTextureHandle(this._postProcessDrawWrapper.effect, "meshBlendBaseColorSampler", this.baseColorTexture);
            }
        });
        pass.addDependencies([this.meshBlendTagTexture, this.depthTexture]);
        if (this.baseColorTexture !== undefined) {
            pass.addDependencies(this.baseColorTexture);
        }
        return pass;
    }
}
//# sourceMappingURL=meshBlendingTask.js.map