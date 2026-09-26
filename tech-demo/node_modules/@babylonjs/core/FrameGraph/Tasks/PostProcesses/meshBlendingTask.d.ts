import { type Camera } from "../../../Cameras/camera.pure.js";
import { type FrameGraph } from "../../frameGraph.js";
import { type FrameGraphRenderPass } from "../../Passes/renderPass.js";
import { type FrameGraphTextureHandle } from "../../frameGraphTypes.js";
import { type IMeshBlendConfiguration, type MeshBlendDebugMode, MeshBlendDepthType, type MeshBlendQuality, type MeshBlendRadiusDefinitions, ThinMeshBlendingPostProcess } from "../../../PostProcesses/thinMeshBlendingPostProcess.js";
import { FrameGraphPostProcessTask } from "./postProcessTask.js";
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
export declare class FrameGraphMeshBlendingTask extends FrameGraphPostProcessTask {
    /**
     * The packed R8UI mesh-blending tag texture used to locate seams.
     */
    meshBlendTagTexture: FrameGraphTextureHandle;
    /**
     * The view-depth or screen-depth texture aligned with the packed tag texture.
     */
    depthTexture: FrameGraphTextureHandle;
    /**
     * Optional linear base-color/albedo geometry texture aligned with SceneColor.
     *
     * When omitted, shadow estimation is compiled out.
     */
    baseColorTexture?: FrameGraphTextureHandle;
    /**
     * Camera used to project radii and reconstruct view-space positions.
     */
    camera: Camera;
    /**
     * The thin post process containing the shared quality variant and blend configuration.
     */
    readonly postProcess: ThinMeshBlendingPostProcess;
    /** Gets or sets the compile-time mesh-blending quality variant. */
    get quality(): MeshBlendQuality;
    set quality(value: MeshBlendQuality);
    /** Gets the four configurable radius definitions indexed by packed radius class. */
    get radiusClasses(): MeshBlendRadiusDefinitions;
    /** Gets or sets the contact-slope narrowing factor. A value of 1 disables narrowing. */
    get slopeFactor(): number;
    set slopeFactor(value: number);
    /** Gets or sets the representation stored in depthTexture. */
    get depthType(): MeshBlendDepthType;
    set depthType(value: MeshBlendDepthType);
    /** Gets or sets the compiled debug visualization. */
    get debugMode(): MeshBlendDebugMode;
    set debugMode(value: MeshBlendDebugMode);
    /**
     * Constructs a mesh-blending task.
     * @param name The name of the task.
     * @param frameGraph The frame graph this task belongs to.
     * @param thinPostProcess The thin post process to use. A new one is created when omitted.
     */
    constructor(name: string, frameGraph: FrameGraph, thinPostProcess?: ThinMeshBlendingPostProcess);
    dispose(): void;
    /**
     * Applies the same configuration accepted by the classic MeshBlendingPostProcess wrapper.
     * @param options Values to apply. Omitted values retain their current settings.
     */
    configure(options?: IMeshBlendConfiguration): void;
    getClassName(): string;
    record(skipCreationOfDisabledPasses?: boolean): FrameGraphRenderPass;
}
