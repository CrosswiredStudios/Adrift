/** This file must only contain pure code and pure imports */
import { __esDecorate, __runInitializers } from "../../../../tslib.es6.js";
import { NodeMaterialBlock } from "../../nodeMaterialBlock.js";
import { NodeMaterialBlockConnectionPointTypes } from "../../Enums/nodeMaterialBlockConnectionPointTypes.js";
import { NodeMaterialBlockTargets } from "../../Enums/nodeMaterialBlockTargets.js";
import { editableInPropertyPage } from "../../../../Decorators/nodeDecorator.js";
import { BindLogDepth } from "../../../materialHelper.functions.js";
import { RegisterClass } from "../../../../Misc/typeStore.js";
/**
 * Color spaces supported by the fragment output block
 */
export var FragmentOutputBlockColorSpace;
(function (FragmentOutputBlockColorSpace) {
    /** Unspecified */
    FragmentOutputBlockColorSpace[FragmentOutputBlockColorSpace["NoColorSpace"] = 0] = "NoColorSpace";
    /** Gamma */
    FragmentOutputBlockColorSpace[FragmentOutputBlockColorSpace["Gamma"] = 1] = "Gamma";
    /** Linear */
    FragmentOutputBlockColorSpace[FragmentOutputBlockColorSpace["Linear"] = 2] = "Linear";
})(FragmentOutputBlockColorSpace || (FragmentOutputBlockColorSpace = {}));
/**
 * Block used to output the final color
 */
let FragmentOutputBlock = (() => {
    var _a;
    let _classSuper = NodeMaterialBlock;
    let _instanceExtraInitializers = [];
    let _useLogarithmicDepth_decorators;
    let _useLogarithmicDepth_initializers = [];
    let _useLogarithmicDepth_extraInitializers = [];
    let _get_colorSpace_decorators;
    return _a = class FragmentOutputBlock extends _classSuper {
            /**
             * Create a new FragmentOutputBlock
             * @param name defines the block name
             */
            constructor(name) {
                super(name, NodeMaterialBlockTargets.Fragment, true, true);
                this._linearDefineName = __runInitializers(this, _instanceExtraInitializers);
                /** Gets or sets a boolean indicating if content needs to be converted to gamma space */
                this.convertToGammaSpace = false;
                /** Gets or sets a boolean indicating if content needs to be converted to linear space */
                this.convertToLinearSpace = false;
                /** Gets or sets a boolean indicating if logarithmic depth should be used */
                this.useLogarithmicDepth = __runInitializers(this, _useLogarithmicDepth_initializers, false);
                __runInitializers(this, _useLogarithmicDepth_extraInitializers);
                this.registerInput("rgba", NodeMaterialBlockConnectionPointTypes.Color4, true);
                this.registerInput("rgb", NodeMaterialBlockConnectionPointTypes.Color3, true);
                this.registerInput("a", NodeMaterialBlockConnectionPointTypes.Float, true);
                this.registerInput("glow", NodeMaterialBlockConnectionPointTypes.Color3, true);
                this.rgb.acceptedConnectionPointTypes.push(NodeMaterialBlockConnectionPointTypes.Vector3);
                this.rgb.acceptedConnectionPointTypes.push(NodeMaterialBlockConnectionPointTypes.Float);
                this.additionalColor.acceptedConnectionPointTypes.push(NodeMaterialBlockConnectionPointTypes.Vector3);
                this.additionalColor.acceptedConnectionPointTypes.push(NodeMaterialBlockConnectionPointTypes.Float);
            }
            /**
             * Gets or sets the color space used for the block
             */
            get colorSpace() {
                if (this.convertToGammaSpace) {
                    return FragmentOutputBlockColorSpace.Gamma;
                }
                if (this.convertToLinearSpace) {
                    return FragmentOutputBlockColorSpace.Linear;
                }
                return FragmentOutputBlockColorSpace.NoColorSpace;
            }
            set colorSpace(value) {
                this.convertToGammaSpace = value === FragmentOutputBlockColorSpace.Gamma;
                this.convertToLinearSpace = value === FragmentOutputBlockColorSpace.Linear;
            }
            /**
             * Gets the current class name
             * @returns the class name
             */
            getClassName() {
                return "FragmentOutputBlock";
            }
            /**
             * Initialize the block and prepare the context for build
             * @param state defines the state that will be used for the build
             */
            initialize(state) {
                state._excludeVariableName("logarithmicDepthConstant");
                state._excludeVariableName("vFragmentDepth");
                state._excludeVariableName("objectId");
                state._excludeVariableName("meshBlendTag");
                // eslint-disable-next-line @typescript-eslint/no-floating-promises
                this._initShaderSourceAsync(state.shaderLanguage);
            }
            async _initShaderSourceAsync(shaderLanguage) {
                this._codeIsReady = false;
                if (shaderLanguage === 1 /* ShaderLanguage.WGSL */) {
                    await Promise.all([import("../../../../ShadersWGSL/ShadersInclude/helperFunctions.js"), import("../../../../ShadersWGSL/ShadersInclude/objectIdFunctions.js")]);
                }
                else {
                    await Promise.all([import("../../../../Shaders/ShadersInclude/helperFunctions.js"), import("../../../../Shaders/ShadersInclude/objectIdFunctions.js")]);
                }
                this._codeIsReady = true;
                this.onCodeIsReadyObservable.notifyObservers(this);
            }
            /**
             * Gets the rgba input component
             */
            get rgba() {
                return this._inputs[0];
            }
            /**
             * Gets the rgb input component
             */
            get rgb() {
                return this._inputs[1];
            }
            /**
             * Gets the a input component
             */
            get a() {
                return this._inputs[2];
            }
            /**
             * Gets the additionalColor input component (named glow in the UI for now)
             */
            get additionalColor() {
                return this._inputs[3];
            }
            /**
             * Gets the glow input component
             */
            get glow() {
                return this._inputs[3];
            }
            _getOutputString(state) {
                return state.shaderLanguage === 1 /* ShaderLanguage.WGSL */ ? "fragmentOutputsColor" : "gl_FragColor";
            }
            _writePrePassOutput(state, define, indexDefine, value) {
                if (state.shaderLanguage !== 1 /* ShaderLanguage.WGSL */) {
                    return `#ifdef ${define}\r\nWRITE_GEOMETRY_FRAGMENT_OUTPUT(${indexDefine}, ${value});\r\n#endif\r\n`;
                }
                let code = "";
                for (let index = 0; index < 8; index++) {
                    code += `#if defined(${define}) && ${indexDefine} == ${index}\r\nfragmentOutputs.fragData${index} = ${value};\r\n#endif\r\n`;
                }
                return code;
            }
            /**
             * Prepare the list of defines
             * @param defines - the material defines
             * @param nodeMaterial - the node material
             */
            prepareDefines(defines, nodeMaterial) {
                defines.setValue(this._linearDefineName, this.convertToLinearSpace, true);
                defines.setValue(this._gammaDefineName, this.convertToGammaSpace, true);
                if (this._additionalColorDefineName !== undefined) {
                    defines.setValue(this._additionalColorDefineName, !!this.additionalColor.connectedPoint && nodeMaterial._useAdditionalColor, true);
                }
            }
            /**
             * Bind data to effect
             * @param effect - the effect to bind to
             * @param nodeMaterial - the node material
             * @param mesh - the mesh to bind for
             */
            bind(effect, nodeMaterial, mesh) {
                if ((this.useLogarithmicDepth || nodeMaterial.useLogarithmicDepth) && mesh) {
                    BindLogDepth(undefined, effect, mesh.getScene());
                }
            }
            _buildBlock(state) {
                super._buildBlock(state);
                const rgba = this.rgba;
                const rgb = this.rgb;
                const a = this.a;
                const additionalColor = this.additionalColor;
                const isWebGPU = state.shaderLanguage === 1 /* ShaderLanguage.WGSL */;
                state.sharedData.hints.needAlphaBlending = rgba.isConnected || a.isConnected;
                state.sharedData.blocksWithDefines.push(this);
                if (this.useLogarithmicDepth || state.sharedData.nodeMaterial.useLogarithmicDepth) {
                    state._emitUniformFromString("logarithmicDepthConstant", NodeMaterialBlockConnectionPointTypes.Float);
                    state._emitVaryingFromString("vFragmentDepth", NodeMaterialBlockConnectionPointTypes.Float);
                    state.sharedData.bindableBlocks.push(this);
                }
                if (additionalColor.connectedPoint) {
                    state._excludeVariableName("useAdditionalColor");
                    state._emitUniformFromString("useAdditionalColor", NodeMaterialBlockConnectionPointTypes.Float);
                    this._additionalColorDefineName = state._getFreeDefineName("USEADDITIONALCOLOR");
                }
                this._linearDefineName = state._getFreeDefineName("CONVERTTOLINEAR");
                this._gammaDefineName = state._getFreeDefineName("CONVERTTOGAMMA");
                const comments = `//${this.name}`;
                state._emitFunctionFromInclude("helperFunctions", comments);
                state._emitFunctionFromInclude("objectIdFunctions", comments, { define: "PREPASS_OBJECT_ID" });
                state._emitUniformFromString("objectId", NodeMaterialBlockConnectionPointTypes.Float, "PREPASS_OBJECT_ID");
                state._emitUniformFromString("meshBlendTag", NodeMaterialBlockConnectionPointTypes.Int, "PREPASS_MESH_BLEND_TAG");
                const outputString = this._getOutputString(state);
                if (state.shaderLanguage === 1 /* ShaderLanguage.WGSL */) {
                    state.compilationString += `var ${outputString} : vec4<f32>;\r\n`;
                }
                const vec4 = state._getShaderType(NodeMaterialBlockConnectionPointTypes.Vector4);
                if (additionalColor.connectedPoint) {
                    let aValue = "1.0";
                    if (a.connectedPoint) {
                        aValue = a.associatedVariableName;
                    }
                    state.compilationString += `#ifdef ${this._additionalColorDefineName}\n`;
                    if (additionalColor.connectedPoint.type === NodeMaterialBlockConnectionPointTypes.Float) {
                        state.compilationString += `${outputString}  = ${vec4}(${additionalColor.associatedVariableName}, ${additionalColor.associatedVariableName}, ${additionalColor.associatedVariableName}, ${aValue});\n`;
                    }
                    else {
                        state.compilationString += `${outputString}  = ${vec4}(${additionalColor.associatedVariableName}, ${aValue});\n`;
                    }
                    state.compilationString += `#else\n`;
                }
                if (rgba.connectedPoint) {
                    if (a.isConnected) {
                        state.compilationString += `${outputString} = ${vec4}(${rgba.associatedVariableName}.rgb, ${a.associatedVariableName});\n`;
                    }
                    else {
                        state.compilationString += `${outputString}  = ${rgba.associatedVariableName};\n`;
                    }
                }
                else if (rgb.connectedPoint) {
                    let aValue = "1.0";
                    if (a.connectedPoint) {
                        aValue = a.associatedVariableName;
                    }
                    if (rgb.connectedPoint.type === NodeMaterialBlockConnectionPointTypes.Float) {
                        state.compilationString += `${outputString}  = ${vec4}(${rgb.associatedVariableName}, ${rgb.associatedVariableName}, ${rgb.associatedVariableName}, ${aValue});\n`;
                    }
                    else {
                        state.compilationString += `${outputString}  = ${vec4}(${rgb.associatedVariableName}, ${aValue});\n`;
                    }
                }
                else {
                    state.sharedData.checks.notConnectedNonOptionalInputs.push(rgba);
                }
                if (additionalColor.connectedPoint) {
                    state.compilationString += `#endif\n`;
                }
                state.compilationString += `#ifdef ${this._linearDefineName}\n`;
                state.compilationString += `${outputString}  = toLinearSpace${state.shaderLanguage === 1 /* ShaderLanguage.WGSL */ ? "Vec4" : ""}(${outputString});\n`;
                state.compilationString += `#endif\n`;
                state.compilationString += `#ifdef ${this._gammaDefineName}\n`;
                state.compilationString += `${outputString}  = toGammaSpace(${outputString});\n`;
                state.compilationString += `#endif\n`;
                if (state.shaderLanguage === 1 /* ShaderLanguage.WGSL */) {
                    state.compilationString += `#if !defined(PREPASS)\r\n`;
                    state.compilationString += `fragmentOutputs.color = ${outputString};\r\n`;
                    state.compilationString += `#endif\r\n`;
                }
                if (this.useLogarithmicDepth || state.sharedData.nodeMaterial.useLogarithmicDepth) {
                    const fragDepth = isWebGPU ? "input.vFragmentDepth" : "vFragmentDepth";
                    const uniformP = isWebGPU ? "uniforms." : "";
                    const output = isWebGPU ? "fragmentOutputs.fragDepth" : "gl_FragDepthEXT";
                    state.compilationString += `${output} = log2(${fragDepth}) * ${uniformP}logarithmicDepthConstant * 0.5;\n`;
                }
                const uniformPrefix = isWebGPU ? "uniforms." : "";
                state.compilationString += `#if defined(PREPASS)\r\n`;
                state.compilationString += this._writePrePassOutput(state, "PREPASS_COLOR", "PREPASS_COLOR_INDEX", outputString);
                state.compilationString += this._writePrePassOutput(state, "PREPASS_OBJECT_ID", "PREPASS_OBJECT_ID_INDEX", `encodeObjectId(${uniformPrefix}objectId)`);
                if (isWebGPU) {
                    state.compilationString += this._writePrePassOutput(state, "PREPASS_MESH_BLEND_TAG", "PREPASS_MESH_BLEND_TAG_INDEX", `vec4u(u32(${uniformPrefix}meshBlendTag), 0u, 0u, 0u)`);
                }
                else {
                    state.compilationString += `#ifdef PREPASS_MESH_BLEND_TAG\r\n`;
                    state.compilationString += `meshBlendTagOutput = uvec4(uint(${uniformPrefix}meshBlendTag), 0u, 0u, 0u);\r\n`;
                    state.compilationString += `#endif\r\n`;
                }
                state.compilationString += `#endif\r\n`;
                return this;
            }
            _dumpPropertiesCode() {
                let codeString = super._dumpPropertiesCode();
                codeString += `${this._codeVariableName}.convertToGammaSpace = ${this.convertToGammaSpace};\n`;
                codeString += `${this._codeVariableName}.convertToLinearSpace = ${this.convertToLinearSpace};\n`;
                codeString += `${this._codeVariableName}.useLogarithmicDepth = ${this.useLogarithmicDepth};\n`;
                return codeString;
            }
            /**
             * Serializes the block
             * @returns the serialized object
             */
            serialize() {
                const serializationObject = super.serialize();
                serializationObject.convertToGammaSpace = this.convertToGammaSpace;
                serializationObject.convertToLinearSpace = this.convertToLinearSpace;
                serializationObject.useLogarithmicDepth = this.useLogarithmicDepth;
                return serializationObject;
            }
            /**
             * Deserializes the block
             * @param serializationObject - the serialization object
             * @param scene - the scene
             * @param rootUrl - the root url
             */
            _deserialize(serializationObject, scene, rootUrl) {
                super._deserialize(serializationObject, scene, rootUrl);
                this.convertToGammaSpace = !!serializationObject.convertToGammaSpace;
                this.convertToLinearSpace = !!serializationObject.convertToLinearSpace;
                this.useLogarithmicDepth = serializationObject.useLogarithmicDepth ?? false;
            }
        },
        (() => {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _useLogarithmicDepth_decorators = [editableInPropertyPage("Use logarithmic depth", 0 /* PropertyTypeForEdition.Boolean */, "PROPERTIES", { embedded: true })];
            _get_colorSpace_decorators = [editableInPropertyPage("Color space", 5 /* PropertyTypeForEdition.List */, "ADVANCED", {
                    notifiers: { rebuild: true },
                    embedded: true,
                    options: [
                        { label: "No color space", value: FragmentOutputBlockColorSpace.NoColorSpace },
                        { label: "To Gamma", value: FragmentOutputBlockColorSpace.Gamma },
                        { label: "To Linear", value: FragmentOutputBlockColorSpace.Linear },
                    ],
                })];
            __esDecorate(_a, null, _get_colorSpace_decorators, { kind: "getter", name: "colorSpace", static: false, private: false, access: { has: obj => "colorSpace" in obj, get: obj => obj.colorSpace }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(null, null, _useLogarithmicDepth_decorators, { kind: "field", name: "useLogarithmicDepth", static: false, private: false, access: { has: obj => "useLogarithmicDepth" in obj, get: obj => obj.useLogarithmicDepth, set: (obj, value) => { obj.useLogarithmicDepth = value; } }, metadata: _metadata }, _useLogarithmicDepth_initializers, _useLogarithmicDepth_extraInitializers);
            if (_metadata) Object.defineProperty(_a, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        })(),
        _a;
})();
export { FragmentOutputBlock };
let _Registered = false;
/**
 * Register side effects for fragmentOutputBlock.
 * Safe to call multiple times; only the first call has an effect.
 */
export function RegisterFragmentOutputBlock() {
    if (_Registered) {
        return;
    }
    _Registered = true;
    RegisterClass("BABYLON.FragmentOutputBlock", FragmentOutputBlock);
}
//# sourceMappingURL=fragmentOutputBlock.pure.js.map