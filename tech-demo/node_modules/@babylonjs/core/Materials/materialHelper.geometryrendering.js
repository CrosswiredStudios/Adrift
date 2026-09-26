
import { Matrix } from "../Maths/math.vector.pure.js";
/** @internal */
export function _GetGeometryRenderingObjectId(mesh, provider, maxObjectId = 0xffffff) {
    const objectId = provider(mesh);
    if (!Number.isInteger(objectId) || objectId < 0 || objectId > maxObjectId) {
        throw new Error(`Invalid geometry object ID ${objectId} for mesh "${mesh.name}". Object IDs must be integers between 0 and 0x${maxObjectId.toString(16).toUpperCase()}.`);
    }
    return objectId;
}
/** @internal */
export function _GetGeometryRenderingMeshBlendTag(mesh, provider) {
    const tag = provider(mesh);
    if (!Number.isInteger(tag) || tag < 0 || tag > 0xff || (tag !== 0 && (tag & 0x3f) === 0)) {
        throw new Error(`Invalid geometry mesh-blending tag ${tag} for mesh "${mesh.name}". Tags must be 0 or contain a group ID between 1 and 63.`);
    }
    return tag;
}
/**
 * Type of clear operation to perform on a geometry texture.
 */
export var GeometryRenderingTextureClearType;
(function (GeometryRenderingTextureClearType) {
    /**
     * Clear the texture with zero.
     */
    GeometryRenderingTextureClearType[GeometryRenderingTextureClearType["Zero"] = 0] = "Zero";
    /**
     * Clear the texture with one.
     */
    GeometryRenderingTextureClearType[GeometryRenderingTextureClearType["One"] = 1] = "One";
    /**
     * Clear the texture with the maximum view Z value.
     */
    GeometryRenderingTextureClearType[GeometryRenderingTextureClearType["MaxViewZ"] = 2] = "MaxViewZ";
    /**
     * Do not clear the texture.
     */
    GeometryRenderingTextureClearType[GeometryRenderingTextureClearType["NoClear"] = 3] = "NoClear";
})(GeometryRenderingTextureClearType || (GeometryRenderingTextureClearType = {}));
/**
 * Helper class to manage geometry rendering.
 */
export class MaterialHelperGeometryRendering {
    /**
     * Creates a new geometry rendering configuration.
     * @param renderPassId Render pass id the configuration is created for.
     * @returns The created configuration.
     */
    static CreateConfiguration(renderPassId) {
        MaterialHelperGeometryRendering._Configurations[renderPassId] = {
            defines: {},
            previousWorldMatrices: {},
            previousViewProjection: Matrix.Zero(),
            currentViewProjection: Matrix.Zero(),
            previousBones: {},
            lastUpdateFrameId: -1,
            excludedSkinnedMesh: [],
            reverseCulling: false,
            objectIdIsRedFormat: false,
        };
        return MaterialHelperGeometryRendering._Configurations[renderPassId];
    }
    /**
     * Deletes a geometry rendering configuration.
     * @param renderPassId The render pass id of the configuration to delete.
     */
    static DeleteConfiguration(renderPassId) {
        delete MaterialHelperGeometryRendering._Configurations[renderPassId];
    }
    /**
     * Gets a geometry rendering configuration.
     * @param renderPassId The render pass id of the configuration to get.
     * @returns The configuration.
     */
    static GetConfiguration(renderPassId) {
        return MaterialHelperGeometryRendering._Configurations[renderPassId];
    }
    /** @internal */
    static _PrepareConfiguration(renderPassId, attachments, colorAttachments) {
        const configuration = MaterialHelperGeometryRendering._Configurations[renderPassId];
        configuration._attachments = attachments;
        configuration._colorAttachments = colorAttachments;
        configuration._mrtCount = attachments.length;
        let defines = "#define PREPASS\n";
        for (const description of MaterialHelperGeometryRendering.GeometryTextureDescriptions) {
            const index = configuration.defines[description.defineIndex];
            if (index !== undefined) {
                defines += `#define ${description.define}\n#define ${description.defineIndex} ${index}\n`;
            }
        }
        if (configuration.objectIdIsRedFormat) {
            defines += "#define PREPASS_OBJECT_ID_R8\n";
        }
        configuration._defines = defines + `#define SCENE_MRT_COUNT ${attachments.length}\n`;
    }
    /** @internal */
    static _PrepareStringDefines(renderPassId, defines) {
        const configuration = MaterialHelperGeometryRendering._Configurations[renderPassId];
        if (!configuration?._defines) {
            return false;
        }
        defines.push(configuration._defines);
        return true;
    }
    /** @internal */
    static _BindAttachmentsForEffect(engine, effect) {
        const configuration = MaterialHelperGeometryRendering._Configurations[engine.currentRenderPassId];
        if (!configuration?._attachments) {
            return true;
        }
        engine.bindAttachments(effect._multiTarget ? configuration._attachments : configuration._colorAttachments);
        return effect._multiTarget || configuration.defines["PREPASS_COLOR_INDEX"] !== undefined;
    }
    /** @internal */
    static _RestoreAttachments(engine) {
        const configuration = MaterialHelperGeometryRendering._Configurations[engine.currentRenderPassId];
        if (configuration?._colorAttachments) {
            engine.bindAttachments(configuration._colorAttachments);
        }
    }
    /** @internal */
    static _BindColorAttachments(engine) {
        const configuration = MaterialHelperGeometryRendering._Configurations[engine.currentRenderPassId];
        if (!configuration?._colorAttachments) {
            return true;
        }
        engine.bindAttachments(configuration._colorAttachments);
        return configuration.defines["PREPASS_COLOR_INDEX"] !== undefined;
    }
    /** @internal */
    static _IsColorAttachmentEnabled(engine) {
        const configuration = MaterialHelperGeometryRendering._Configurations[engine.currentRenderPassId];
        return !configuration?._colorAttachments || configuration.defines["PREPASS_COLOR_INDEX"] !== undefined;
    }
    /** @internal */
    static _BindZeroAlphaDiscard(engine, effect) {
        const configuration = MaterialHelperGeometryRendering._Configurations[engine.currentRenderPassId];
        if (!configuration) {
            return;
        }
        const alphaMode = engine.getAlphaMode();
        const discard = configuration.defines["PREPASS_COLOR_INDEX"] === undefined ||
            alphaMode === 2 ||
            alphaMode === 1 ||
            alphaMode === 17;
        effect.setFloat("geometryZeroAlphaDiscard", discard ? 1 : 0);
    }
    /**
     * Adds uniforms and samplers for geometry rendering.
     * @param uniforms The array of uniforms to add to.
     * @param _samplers The array of samplers to add to.
     */
    static AddUniformsAndSamplers(uniforms, _samplers) {
        uniforms.push("previousWorld", "previousViewProjection", "mPreviousBones", "objectId", "meshBlendTag");
    }
    /**
     * Marks a list of meshes as dirty for geometry rendering.
     * @param renderPassId The render pass id the meshes are marked as dirty for.
     * @param meshes The list of meshes to mark as dirty.
     */
    static MarkAsDirty(renderPassId, meshes) {
        for (const mesh of meshes) {
            if (!mesh.subMeshes) {
                continue;
            }
            for (const subMesh of mesh.subMeshes) {
                subMesh._removeDrawWrapper(renderPassId);
            }
        }
    }
    /**
     * Prepares defines for geometry rendering.
     * @param renderPassId The render pass id the defines are prepared for.
     * @param mesh The mesh the defines are prepared for.
     * @param defines The defines to update according to the geometry rendering configuration.
     */
    static PrepareDefines(renderPassId, mesh, defines) {
        if (!defines._arePrePassDirty) {
            return;
        }
        const configuration = MaterialHelperGeometryRendering._Configurations[renderPassId];
        if (!configuration) {
            return;
        }
        defines["PREPASS"] = true;
        let numMRT = 0;
        for (let i = 0; i < MaterialHelperGeometryRendering.GeometryTextureDescriptions.length; i++) {
            const geometryTextureDescription = MaterialHelperGeometryRendering.GeometryTextureDescriptions[i];
            const defineName = geometryTextureDescription.define;
            const defineIndex = geometryTextureDescription.defineIndex;
            const index = configuration.defines[defineIndex];
            if (index !== undefined) {
                defines[defineName] = true;
                defines[defineIndex] = index;
                numMRT++;
            }
            else {
                defines[defineName] = false;
                delete defines[defineIndex];
            }
        }
        defines["PREPASS_OBJECT_ID_R8"] = configuration.objectIdIsRedFormat;
        defines["SCENE_MRT_COUNT"] = configuration._mrtCount ?? numMRT;
        defines["BONES_VELOCITY_ENABLED"] =
            mesh.useBones && mesh.computeBonesUsingShaders && mesh.skeleton && !mesh.skeleton.isUsingTextureForMatrices && configuration.excludedSkinnedMesh.indexOf(mesh) === -1;
    }
    /**
     * Binds geometry rendering data for a mesh.
     * @param renderPassId The render pass id the geometry rendering data is bound for.
     * @param effect The effect to bind the geometry rendering data to.
     * @param mesh The mesh to bind the geometry rendering data for.
     * @param world The world matrix of the mesh.
     * @param material The material of the mesh.
     */
    static Bind(renderPassId, effect, mesh, world, material) {
        const configuration = MaterialHelperGeometryRendering._Configurations[renderPassId];
        if (!configuration) {
            return;
        }
        const scene = mesh.getScene();
        const engine = scene.getEngine();
        if (configuration.reverseCulling) {
            engine.setStateCullFaceType(scene._mirroredCameraPosition ? material.cullBackFaces : !material.cullBackFaces);
        }
        if (configuration.defines["PREPASS_OBJECT_ID_INDEX"] !== undefined) {
            const maxObjectId = configuration.objectIdIsRedFormat ? 0xff : 0xffffff;
            let objectId = mesh.uniqueId;
            if (configuration.objectIdProvider) {
                objectId = _GetGeometryRenderingObjectId(mesh, configuration.objectIdProvider, maxObjectId);
            }
            else if (objectId > maxObjectId) {
                throw new Error(`Invalid geometry object ID ${objectId} for mesh "${mesh.name}". Object IDs must be integers between 0 and 0x${maxObjectId.toString(16).toUpperCase()}.`);
            }
            effect.setFloat("objectId", objectId);
        }
        if (configuration.defines["PREPASS_MESH_BLEND_TAG_INDEX"] !== undefined) {
            const meshBlendTag = configuration.meshBlendTagProvider ? _GetGeometryRenderingMeshBlendTag(mesh, configuration.meshBlendTagProvider) : mesh.meshBlendingTag;
            effect.setInt("meshBlendTag", meshBlendTag);
        }
        if (configuration.defines["PREPASS_VELOCITY_INDEX"] !== undefined || configuration.defines["PREPASS_VELOCITY_LINEAR_INDEX"] !== undefined) {
            const currentWorldMatrices = (configuration._currentWorldMatrices ?? (configuration._currentWorldMatrices = {}));
            const worldMatrixFrameIds = (configuration._worldMatrixFrameIds ?? (configuration._worldMatrixFrameIds = {}));
            if (!currentWorldMatrices[mesh.uniqueId]) {
                currentWorldMatrices[mesh.uniqueId] = world.clone();
                configuration.previousWorldMatrices[mesh.uniqueId] = world.clone();
            }
            if (worldMatrixFrameIds[mesh.uniqueId] !== engine.frameId) {
                configuration.previousWorldMatrices[mesh.uniqueId].copyFrom(currentWorldMatrices[mesh.uniqueId]);
                worldMatrixFrameIds[mesh.uniqueId] = engine.frameId;
            }
            currentWorldMatrices[mesh.uniqueId].copyFrom(world);
            if (configuration.lastUpdateFrameId === -1) {
                configuration.lastUpdateFrameId = engine.frameId;
                configuration.previousViewProjection.copyFrom(scene.getTransformMatrix());
                configuration.currentViewProjection.copyFrom(scene.getTransformMatrix());
            }
            else if (configuration.currentViewProjection.updateFlag !== scene.getTransformMatrix().updateFlag) {
                // First update of the prepass configuration for this rendering pass
                configuration.lastUpdateFrameId = engine.frameId;
                configuration.previousViewProjection.copyFrom(configuration.currentViewProjection);
                configuration.currentViewProjection.copyFrom(scene.getTransformMatrix());
            }
            else if (configuration.lastUpdateFrameId !== engine.frameId) {
                // The scene transformation did not change from the previous frame (so no camera motion), we must update previousViewProjection accordingly
                configuration.lastUpdateFrameId = engine.frameId;
                configuration.previousViewProjection.copyFrom(configuration.currentViewProjection);
            }
            effect.setMatrix("previousWorld", configuration.previousWorldMatrices[mesh.uniqueId]);
            effect.setMatrix("previousViewProjection", configuration.previousViewProjection);
            if (mesh.useBones && mesh.computeBonesUsingShaders && mesh.skeleton) {
                const skeleton = mesh.skeleton;
                if (!skeleton.isUsingTextureForMatrices || effect.getUniformIndex("boneTextureInfo") === -1) {
                    const matrices = skeleton.getTransformMatrices(mesh);
                    if (matrices) {
                        if (!configuration.previousBones[mesh.uniqueId]) {
                            configuration.previousBones[mesh.uniqueId] = matrices.slice();
                        }
                        effect.setMatrices("mPreviousBones", configuration.previousBones[mesh.uniqueId]);
                        configuration.previousBones[mesh.uniqueId].set(matrices);
                    }
                }
            }
        }
    }
}
/**
 * Descriptions of the geometry textures.
 */
MaterialHelperGeometryRendering.GeometryTextureDescriptions = [
    {
        type: 0,
        name: "IrradianceLegacy",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_IRRADIANCE_LEGACY",
        defineIndex: "PREPASS_IRRADIANCE_LEGACY_INDEX",
    },
    {
        type: 1,
        name: "WorldPosition",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_POSITION",
        defineIndex: "PREPASS_POSITION_INDEX",
    },
    {
        type: 2,
        name: "Velocity",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_VELOCITY",
        defineIndex: "PREPASS_VELOCITY_INDEX",
    },
    {
        type: 3,
        name: "Reflectivity",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_REFLECTIVITY",
        defineIndex: "PREPASS_REFLECTIVITY_INDEX",
    },
    {
        type: 5,
        name: "ViewDepth",
        clearType: 2 /* GeometryRenderingTextureClearType.MaxViewZ */,
        define: "PREPASS_DEPTH",
        defineIndex: "PREPASS_DEPTH_INDEX",
    },
    {
        type: 6,
        name: "ViewNormal",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_NORMAL",
        defineIndex: "PREPASS_NORMAL_INDEX",
    },
    {
        type: 7,
        name: "AlbedoSqrt",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_ALBEDO_SQRT",
        defineIndex: "PREPASS_ALBEDO_SQRT_INDEX",
    },
    {
        type: 8,
        name: "WorldNormal",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_WORLD_NORMAL",
        defineIndex: "PREPASS_WORLD_NORMAL_INDEX",
    },
    {
        type: 9,
        name: "LocalPosition",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_LOCAL_POSITION",
        defineIndex: "PREPASS_LOCAL_POSITION_INDEX",
    },
    {
        type: 10,
        name: "ScreenDepth",
        clearType: 1 /* GeometryRenderingTextureClearType.One */,
        define: "PREPASS_SCREENSPACE_DEPTH",
        defineIndex: "PREPASS_SCREENSPACE_DEPTH_INDEX",
    },
    {
        type: 11,
        name: "LinearVelocity",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_VELOCITY_LINEAR",
        defineIndex: "PREPASS_VELOCITY_LINEAR_INDEX",
    },
    {
        type: 12,
        name: "Albedo",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_ALBEDO",
        defineIndex: "PREPASS_ALBEDO_INDEX",
    },
    {
        type: 13,
        name: "NormalizedViewDepth",
        clearType: 1 /* GeometryRenderingTextureClearType.One */,
        define: "PREPASS_NORMALIZED_VIEW_DEPTH",
        defineIndex: "PREPASS_NORMALIZED_VIEW_DEPTH_INDEX",
    },
    {
        type: 4,
        name: "Color",
        clearType: 3 /* GeometryRenderingTextureClearType.NoClear */,
        define: "PREPASS_COLOR",
        defineIndex: "PREPASS_COLOR_INDEX",
    },
    {
        type: 14,
        name: "Irradiance",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_IRRADIANCE",
        defineIndex: "PREPASS_IRRADIANCE_INDEX",
    },
    {
        type: 15,
        name: "ObjectId",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_OBJECT_ID",
        defineIndex: "PREPASS_OBJECT_ID_INDEX",
    },
    {
        type: 16,
        name: "MeshBlendTag",
        clearType: 0 /* GeometryRenderingTextureClearType.Zero */,
        define: "PREPASS_MESH_BLEND_TAG",
        defineIndex: "PREPASS_MESH_BLEND_TAG_INDEX",
    },
];
MaterialHelperGeometryRendering._Configurations = {};
//# sourceMappingURL=materialHelper.geometryrendering.js.map