// Do not edit.
import { ShaderStore } from "../../Engines/shaderStore.js";
const name = "meshBlendTagFragmentOutput";
const shader = `#if SCENE_MRT_COUNT>{X}
#if defined(PREPASS_MESH_BLEND_TAG) && PREPASS_MESH_BLEND_TAG_INDEX=={X}
fragmentOutputs.fragData{X}=meshBlendTagOutput;
#else
fragmentOutputs.fragData{X}=fragData[{X}];
#endif
#endif
`;
// Sideeffect
if (!ShaderStore.IncludesShadersStoreWGSL[name]) {
    ShaderStore.IncludesShadersStoreWGSL[name] = shader;
}
/** @internal */
export const meshBlendTagFragmentOutputWGSL = { name, shader };
//# sourceMappingURL=meshBlendTagFragmentOutput.js.map