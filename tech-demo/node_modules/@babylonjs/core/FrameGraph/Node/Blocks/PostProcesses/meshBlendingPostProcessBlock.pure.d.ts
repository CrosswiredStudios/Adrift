/** This file must only contain pure code and pure imports */
import { FrameGraphMeshBlendingTask } from "../../../Tasks/PostProcesses/meshBlendingTask.js";
import { type FrameGraph } from "../../../frameGraph.js";
import { MeshBlendDebugMode, MeshBlendQuality } from "../../../../PostProcesses/thinMeshBlendingPostProcess.js";
import { type Scene } from "../../../../scene.pure.js";
import { type NodeRenderGraphBuildState } from "../../nodeRenderGraphBuildState.js";
import { type NodeRenderGraphConnectionPoint } from "../../nodeRenderGraphBlockConnectionPoint.js";
import { NodeRenderGraphBasePostProcessBlock } from "./basePostProcessBlock.js";
/**
 * Block that blends colors across seams between objects.
 */
export declare class NodeRenderGraphMeshBlendingPostProcessBlock extends NodeRenderGraphBasePostProcessBlock {
    protected _frameGraphTask: FrameGraphMeshBlendingTask;
    /**
     * Gets the frame graph task associated with this block.
     */
    get task(): FrameGraphMeshBlendingTask;
    private _setRadiusValue;
    /** Mesh blending always uses exact texel loads from SceneColor. */
    get sourceSamplingMode(): number;
    set sourceSamplingMode(_value: number);
    /**
     * Creates a mesh-blending post-process block.
     * @param name The block name.
     * @param frameGraph The hosting frame graph.
     * @param scene The hosting scene.
     */
    constructor(name: string, frameGraph: FrameGraph, scene: Scene);
    /** Gets or sets the compile-time mesh-blending quality variant. */
    get quality(): MeshBlendQuality;
    set quality(value: MeshBlendQuality);
    /** Gets or sets the small-class authored world radius. */
    get smallWorldRadius(): number;
    set smallWorldRadius(value: number);
    /** Gets or sets the small-class minimum projected radius in physical pixels. */
    get smallMinimumProjectedRadius(): number;
    set smallMinimumProjectedRadius(value: number);
    /** Gets or sets the medium-class authored world radius. */
    get mediumWorldRadius(): number;
    set mediumWorldRadius(value: number);
    /** Gets or sets the medium-class minimum projected radius in physical pixels. */
    get mediumMinimumProjectedRadius(): number;
    set mediumMinimumProjectedRadius(value: number);
    /** Gets or sets the large-class authored world radius. */
    get largeWorldRadius(): number;
    set largeWorldRadius(value: number);
    /** Gets or sets the large-class minimum projected radius in physical pixels. */
    get largeMinimumProjectedRadius(): number;
    set largeMinimumProjectedRadius(value: number);
    /** Gets or sets the extra-large-class authored world radius. */
    get extraLargeWorldRadius(): number;
    set extraLargeWorldRadius(value: number);
    /** Gets or sets the extra-large-class minimum projected radius in physical pixels. */
    get extraLargeMinimumProjectedRadius(): number;
    set extraLargeMinimumProjectedRadius(value: number);
    /** Gets or sets the contact-slope narrowing factor. A value of 1 disables narrowing. */
    get slopeFactor(): number;
    set slopeFactor(value: number);
    /** Gets or sets the compiled debug visualization. */
    get debugMode(): MeshBlendDebugMode;
    set debugMode(value: MeshBlendDebugMode);
    /**
     * Gets the camera used for world-radius projection and depth reconstruction.
     */
    get camera(): NodeRenderGraphConnectionPoint;
    /**
     * Gets the view-depth or screen-depth input.
     */
    get geomDepth(): NodeRenderGraphConnectionPoint;
    /**
     * Gets the optional linear geometry base-color/albedo input used for shadow estimation.
     */
    get geomAlbedo(): NodeRenderGraphConnectionPoint;
    /**
     * Gets the packed mesh-blending tag input.
     */
    get geomMeshBlendTag(): NodeRenderGraphConnectionPoint;
    getClassName(): string;
    protected _buildBlock(state: NodeRenderGraphBuildState): void;
    protected _dumpPropertiesCode(): string;
    serialize(): any;
    _deserialize(serializationObject: any): void;
}
/**
 * Registers the mesh-blending post-process block.
 */
export declare function RegisterMeshBlendingPostProcessBlock(): void;
