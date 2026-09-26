/** This file must only contain pure code and pure imports */
import { __esDecorate, __runInitializers } from "../../../../tslib.es6.js";
import { editableInPropertyPage } from "../../../../Decorators/nodeDecorator.js";
import { FrameGraphMeshBlendingTask } from "../../../Tasks/PostProcesses/meshBlendingTask.js";
import { RegisterClass } from "../../../../Misc/typeStore.js";
import { CreateDefaultMeshBlendRadiusDefinitions, MeshBlendDebugMode, MeshBlendDepthType, MeshBlendQuality, ThinMeshBlendingPostProcess, } from "../../../../PostProcesses/thinMeshBlendingPostProcess.js";
import { NodeRenderGraphBlockConnectionPointTypes } from "../../Types/nodeRenderGraphTypes.js";
import { NodeRenderGraphBasePostProcessBlock } from "./basePostProcessBlock.js";

/**
 * Block that blends colors across seams between objects.
 */
let NodeRenderGraphMeshBlendingPostProcessBlock = (() => {
    var _a;
    let _classSuper = NodeRenderGraphBasePostProcessBlock;
    let _instanceExtraInitializers = [];
    let _get_quality_decorators;
    let _get_smallWorldRadius_decorators;
    let _get_smallMinimumProjectedRadius_decorators;
    let _get_mediumWorldRadius_decorators;
    let _get_mediumMinimumProjectedRadius_decorators;
    let _get_largeWorldRadius_decorators;
    let _get_largeMinimumProjectedRadius_decorators;
    let _get_extraLargeWorldRadius_decorators;
    let _get_extraLargeMinimumProjectedRadius_decorators;
    let _get_slopeFactor_decorators;
    let _get_debugMode_decorators;
    return _a = class NodeRenderGraphMeshBlendingPostProcessBlock extends _classSuper {
            /**
             * Gets the frame graph task associated with this block.
             */
            get task() {
                return this._frameGraphTask;
            }
            _setRadiusValue(radiusClass, property, value) {
                const radiusClasses = this._frameGraphTask.postProcess.radiusClasses.map((definition) => ({ ...definition }));
                radiusClasses[radiusClass][property] = value;
                this._frameGraphTask.configure({ radiusClasses });
            }
            /** Mesh blending always uses exact texel loads from SceneColor. */
            get sourceSamplingMode() {
                return 1;
            }
            set sourceSamplingMode(_value) {
                if (this._frameGraphTask) {
                    this._frameGraphTask.sourceSamplingMode = 1;
                }
            }
            /**
             * Creates a mesh-blending post-process block.
             * @param name The block name.
             * @param frameGraph The hosting frame graph.
             * @param scene The hosting scene.
             */
            constructor(name, frameGraph, scene) {
                super(name, frameGraph, scene);
                this._frameGraphTask = __runInitializers(this, _instanceExtraInitializers);
                this.registerInput("camera", NodeRenderGraphBlockConnectionPointTypes.Camera);
                this.registerInput("geomDepth", NodeRenderGraphBlockConnectionPointTypes.AutoDetect);
                this.registerInput("geomAlbedo", NodeRenderGraphBlockConnectionPointTypes.TextureAlbedo, true);
                this.registerInput("geomMeshBlendTag", NodeRenderGraphBlockConnectionPointTypes.TextureMeshBlendTag);
                this.geomDepth.addExcludedConnectionPointFromAllowedTypes(NodeRenderGraphBlockConnectionPointTypes.TextureScreenDepth | NodeRenderGraphBlockConnectionPointTypes.TextureViewDepth);
                this._finalizeInputOutputRegistering();
                this._frameGraphTask = new FrameGraphMeshBlendingTask(this.name, frameGraph, new ThinMeshBlendingPostProcess(name, scene.getEngine()));
            }
            /** Gets or sets the compile-time mesh-blending quality variant. */
            get quality() {
                return this._frameGraphTask.quality;
            }
            set quality(value) {
                this._frameGraphTask.quality = value;
            }
            /** Gets or sets the small-class authored world radius. */
            get smallWorldRadius() {
                return this._frameGraphTask.postProcess.radiusClasses[0].worldRadius;
            }
            set smallWorldRadius(value) {
                this._setRadiusValue(0, "worldRadius", value);
            }
            /** Gets or sets the small-class minimum projected radius in physical pixels. */
            get smallMinimumProjectedRadius() {
                return this._frameGraphTask.postProcess.radiusClasses[0].minimumProjectedRadius;
            }
            set smallMinimumProjectedRadius(value) {
                this._setRadiusValue(0, "minimumProjectedRadius", value);
            }
            /** Gets or sets the medium-class authored world radius. */
            get mediumWorldRadius() {
                return this._frameGraphTask.postProcess.radiusClasses[1].worldRadius;
            }
            set mediumWorldRadius(value) {
                this._setRadiusValue(1, "worldRadius", value);
            }
            /** Gets or sets the medium-class minimum projected radius in physical pixels. */
            get mediumMinimumProjectedRadius() {
                return this._frameGraphTask.postProcess.radiusClasses[1].minimumProjectedRadius;
            }
            set mediumMinimumProjectedRadius(value) {
                this._setRadiusValue(1, "minimumProjectedRadius", value);
            }
            /** Gets or sets the large-class authored world radius. */
            get largeWorldRadius() {
                return this._frameGraphTask.postProcess.radiusClasses[2].worldRadius;
            }
            set largeWorldRadius(value) {
                this._setRadiusValue(2, "worldRadius", value);
            }
            /** Gets or sets the large-class minimum projected radius in physical pixels. */
            get largeMinimumProjectedRadius() {
                return this._frameGraphTask.postProcess.radiusClasses[2].minimumProjectedRadius;
            }
            set largeMinimumProjectedRadius(value) {
                this._setRadiusValue(2, "minimumProjectedRadius", value);
            }
            /** Gets or sets the extra-large-class authored world radius. */
            get extraLargeWorldRadius() {
                return this._frameGraphTask.postProcess.radiusClasses[3].worldRadius;
            }
            set extraLargeWorldRadius(value) {
                this._setRadiusValue(3, "worldRadius", value);
            }
            /** Gets or sets the extra-large-class minimum projected radius in physical pixels. */
            get extraLargeMinimumProjectedRadius() {
                return this._frameGraphTask.postProcess.radiusClasses[3].minimumProjectedRadius;
            }
            set extraLargeMinimumProjectedRadius(value) {
                this._setRadiusValue(3, "minimumProjectedRadius", value);
            }
            /** Gets or sets the contact-slope narrowing factor. A value of 1 disables narrowing. */
            get slopeFactor() {
                return this._frameGraphTask.postProcess.slopeFactor;
            }
            set slopeFactor(value) {
                this._frameGraphTask.postProcess.slopeFactor = value;
            }
            /** Gets or sets the compiled debug visualization. */
            get debugMode() {
                return this._frameGraphTask.debugMode;
            }
            set debugMode(value) {
                this._frameGraphTask.debugMode = value;
            }
            /**
             * Gets the camera used for world-radius projection and depth reconstruction.
             */
            get camera() {
                return this._inputs[2];
            }
            /**
             * Gets the view-depth or screen-depth input.
             */
            get geomDepth() {
                return this._inputs[3];
            }
            /**
             * Gets the optional linear geometry base-color/albedo input used for shadow estimation.
             */
            get geomAlbedo() {
                return this._inputs[4];
            }
            /**
             * Gets the packed mesh-blending tag input.
             */
            get geomMeshBlendTag() {
                return this._inputs[5];
            }
            getClassName() {
                return "NodeRenderGraphMeshBlendingPostProcessBlock";
            }
            _buildBlock(state) {
                super._buildBlock(state);
                this._frameGraphTask.camera = this.camera.connectedPoint?.value;
                this._frameGraphTask.depthTexture = this.geomDepth.connectedPoint?.value;
                this._frameGraphTask.depthType =
                    this.geomDepth.connectedPoint?.type === NodeRenderGraphBlockConnectionPointTypes.TextureScreenDepth ? MeshBlendDepthType.Screen : MeshBlendDepthType.View;
                this._frameGraphTask.baseColorTexture = this.geomAlbedo.connectedPoint?.value;
                this._frameGraphTask.meshBlendTagTexture = this.geomMeshBlendTag.connectedPoint?.value;
            }
            _dumpPropertiesCode() {
                const codes = [];
                codes.push(`${this._codeVariableName}.quality = ${this.quality};`);
                codes.push(`${this._codeVariableName}.smallWorldRadius = ${this.smallWorldRadius};`);
                codes.push(`${this._codeVariableName}.smallMinimumProjectedRadius = ${this.smallMinimumProjectedRadius};`);
                codes.push(`${this._codeVariableName}.mediumWorldRadius = ${this.mediumWorldRadius};`);
                codes.push(`${this._codeVariableName}.mediumMinimumProjectedRadius = ${this.mediumMinimumProjectedRadius};`);
                codes.push(`${this._codeVariableName}.largeWorldRadius = ${this.largeWorldRadius};`);
                codes.push(`${this._codeVariableName}.largeMinimumProjectedRadius = ${this.largeMinimumProjectedRadius};`);
                codes.push(`${this._codeVariableName}.extraLargeWorldRadius = ${this.extraLargeWorldRadius};`);
                codes.push(`${this._codeVariableName}.extraLargeMinimumProjectedRadius = ${this.extraLargeMinimumProjectedRadius};`);
                codes.push(`${this._codeVariableName}.slopeFactor = ${this.slopeFactor};`);
                codes.push(`${this._codeVariableName}.debugMode = ${this.debugMode};`);
                return super._dumpPropertiesCode() + codes.join("\n");
            }
            serialize() {
                const serializationObject = super.serialize();
                serializationObject.quality = this.quality;
                serializationObject.radiusClasses = this._frameGraphTask.postProcess.radiusClasses.map((definition) => ({ ...definition }));
                serializationObject.slopeFactor = this.slopeFactor;
                serializationObject.debugMode = this.debugMode;
                return serializationObject;
            }
            _deserialize(serializationObject) {
                super._deserialize(serializationObject);
                const defaults = CreateDefaultMeshBlendRadiusDefinitions();
                const radiusClasses = serializationObject.radiusClasses ?? defaults;
                const resolvedRadiusClasses = [
                    {
                        worldRadius: radiusClasses[0]?.worldRadius ?? defaults[0].worldRadius,
                        minimumProjectedRadius: radiusClasses[0]?.minimumProjectedRadius ?? defaults[0].minimumProjectedRadius,
                    },
                    {
                        worldRadius: radiusClasses[1]?.worldRadius ?? defaults[1].worldRadius,
                        minimumProjectedRadius: radiusClasses[1]?.minimumProjectedRadius ?? defaults[1].minimumProjectedRadius,
                    },
                    {
                        worldRadius: radiusClasses[2]?.worldRadius ?? defaults[2].worldRadius,
                        minimumProjectedRadius: radiusClasses[2]?.minimumProjectedRadius ?? defaults[2].minimumProjectedRadius,
                    },
                    {
                        worldRadius: radiusClasses[3]?.worldRadius ?? defaults[3].worldRadius,
                        minimumProjectedRadius: radiusClasses[3]?.minimumProjectedRadius ?? defaults[3].minimumProjectedRadius,
                    },
                ];
                this._frameGraphTask.configure({
                    quality: serializationObject.quality ?? MeshBlendQuality.Medium,
                    radiusClasses: resolvedRadiusClasses,
                    slopeFactor: serializationObject.slopeFactor ?? 2,
                    debugMode: serializationObject.debugMode ?? MeshBlendDebugMode.Off,
                });
            }
        },
        (() => {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _get_quality_decorators = [editableInPropertyPage("Quality", 5 /* PropertyTypeForEdition.List */, "MESH BLENDING", {
                    options: [
                        { label: "Low", value: MeshBlendQuality.Low },
                        { label: "Medium", value: MeshBlendQuality.Medium },
                        { label: "High", value: MeshBlendQuality.High },
                        { label: "Cinematic", value: MeshBlendQuality.Cinematic },
                    ],
                })];
            _get_smallWorldRadius_decorators = [editableInPropertyPage("Small world radius", 1 /* PropertyTypeForEdition.Float */, "RADIUS CLASSES", { min: 0 })];
            _get_smallMinimumProjectedRadius_decorators = [editableInPropertyPage("Small minimum pixels", 1 /* PropertyTypeForEdition.Float */, "RADIUS CLASSES", { min: 0 })];
            _get_mediumWorldRadius_decorators = [editableInPropertyPage("Medium world radius", 1 /* PropertyTypeForEdition.Float */, "RADIUS CLASSES", { min: 0 })];
            _get_mediumMinimumProjectedRadius_decorators = [editableInPropertyPage("Medium minimum pixels", 1 /* PropertyTypeForEdition.Float */, "RADIUS CLASSES", { min: 0 })];
            _get_largeWorldRadius_decorators = [editableInPropertyPage("Large world radius", 1 /* PropertyTypeForEdition.Float */, "RADIUS CLASSES", { min: 0 })];
            _get_largeMinimumProjectedRadius_decorators = [editableInPropertyPage("Large minimum pixels", 1 /* PropertyTypeForEdition.Float */, "RADIUS CLASSES", { min: 0 })];
            _get_extraLargeWorldRadius_decorators = [editableInPropertyPage("Extra large world radius", 1 /* PropertyTypeForEdition.Float */, "RADIUS CLASSES", { min: 0 })];
            _get_extraLargeMinimumProjectedRadius_decorators = [editableInPropertyPage("Extra large minimum pixels", 1 /* PropertyTypeForEdition.Float */, "RADIUS CLASSES", { min: 0 })];
            _get_slopeFactor_decorators = [editableInPropertyPage("Slope factor", 1 /* PropertyTypeForEdition.Float */, "CONTACT VALIDATION", { min: 1 })];
            _get_debugMode_decorators = [editableInPropertyPage("Debug mode", 5 /* PropertyTypeForEdition.List */, "DEBUG", {
                    options: [
                        { label: "Off", value: MeshBlendDebugMode.Off },
                        { label: "Packed tag", value: MeshBlendDebugMode.PackedTag },
                        { label: "Candidate direction / distance", value: MeshBlendDebugMode.CandidateDirectionDistance },
                        { label: "Seam / fade", value: MeshBlendDebugMode.SeamFade },
                        { label: "Rejection reason", value: MeshBlendDebugMode.RejectionReason },
                        { label: "Approximate stage / work", value: MeshBlendDebugMode.StageWork },
                        { label: "Target continuation", value: MeshBlendDebugMode.Continuation },
                        { label: "Tiny-object radius", value: MeshBlendDebugMode.TinyObject },
                        { label: "Multi-target selection", value: MeshBlendDebugMode.MultiTarget },
                        { label: "Target-color samples", value: MeshBlendDebugMode.TargetColor },
                        { label: "Shadow attenuation", value: MeshBlendDebugMode.ShadowAttenuation },
                        { label: "Color interpolation", value: MeshBlendDebugMode.ColorInterpolation },
                        { label: "World position", value: MeshBlendDebugMode.WorldPosition },
                    ],
                })];
            __esDecorate(_a, null, _get_quality_decorators, { kind: "getter", name: "quality", static: false, private: false, access: { has: obj => "quality" in obj, get: obj => obj.quality }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _get_smallWorldRadius_decorators, { kind: "getter", name: "smallWorldRadius", static: false, private: false, access: { has: obj => "smallWorldRadius" in obj, get: obj => obj.smallWorldRadius }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _get_smallMinimumProjectedRadius_decorators, { kind: "getter", name: "smallMinimumProjectedRadius", static: false, private: false, access: { has: obj => "smallMinimumProjectedRadius" in obj, get: obj => obj.smallMinimumProjectedRadius }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _get_mediumWorldRadius_decorators, { kind: "getter", name: "mediumWorldRadius", static: false, private: false, access: { has: obj => "mediumWorldRadius" in obj, get: obj => obj.mediumWorldRadius }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _get_mediumMinimumProjectedRadius_decorators, { kind: "getter", name: "mediumMinimumProjectedRadius", static: false, private: false, access: { has: obj => "mediumMinimumProjectedRadius" in obj, get: obj => obj.mediumMinimumProjectedRadius }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _get_largeWorldRadius_decorators, { kind: "getter", name: "largeWorldRadius", static: false, private: false, access: { has: obj => "largeWorldRadius" in obj, get: obj => obj.largeWorldRadius }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _get_largeMinimumProjectedRadius_decorators, { kind: "getter", name: "largeMinimumProjectedRadius", static: false, private: false, access: { has: obj => "largeMinimumProjectedRadius" in obj, get: obj => obj.largeMinimumProjectedRadius }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _get_extraLargeWorldRadius_decorators, { kind: "getter", name: "extraLargeWorldRadius", static: false, private: false, access: { has: obj => "extraLargeWorldRadius" in obj, get: obj => obj.extraLargeWorldRadius }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _get_extraLargeMinimumProjectedRadius_decorators, { kind: "getter", name: "extraLargeMinimumProjectedRadius", static: false, private: false, access: { has: obj => "extraLargeMinimumProjectedRadius" in obj, get: obj => obj.extraLargeMinimumProjectedRadius }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _get_slopeFactor_decorators, { kind: "getter", name: "slopeFactor", static: false, private: false, access: { has: obj => "slopeFactor" in obj, get: obj => obj.slopeFactor }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(_a, null, _get_debugMode_decorators, { kind: "getter", name: "debugMode", static: false, private: false, access: { has: obj => "debugMode" in obj, get: obj => obj.debugMode }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(_a, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        })(),
        _a;
})();
export { NodeRenderGraphMeshBlendingPostProcessBlock };
let _Registered = false;
/**
 * Registers the mesh-blending post-process block.
 */
export function RegisterMeshBlendingPostProcessBlock() {
    if (_Registered) {
        return;
    }
    _Registered = true;
    RegisterClass("BABYLON.NodeRenderGraphMeshBlendingPostProcessBlock", NodeRenderGraphMeshBlendingPostProcessBlock);
}
//# sourceMappingURL=meshBlendingPostProcessBlock.pure.js.map