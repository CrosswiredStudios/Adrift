import { type AbstractEngine } from "../Engines/abstractEngine.pure.js";
import { type AbstractMesh } from "../Meshes/abstractMesh.pure.js";
import { InstancedMesh } from "../Meshes/instancedMesh.pure.js";
import { Mesh } from "../Meshes/mesh.pure.js";
import { type SubMesh } from "../Meshes/subMesh.pure.js";
import { type Scene } from "../scene.pure.js";
import { type Nullable } from "../types.js";
import { MaterialPluginBase } from "./materialPluginBase.pure.js";
import { type MaterialDefines } from "./materialDefines.js";
import { PBRBaseMaterial } from "./PBR/pbrBaseMaterial.pure.js";
import { ShaderLanguage } from "./shaderLanguage.js";
import { StandardMaterial } from "./standardMaterial.pure.js";
import { type UniformBuffer } from "./uniformBuffer.js";
/**
 * The material families supported by {@link DitheredTileFadeMaterialPlugin}.
 */
export type DitheredTileFadeSupportedMaterial = StandardMaterial | PBRBaseMaterial;
/**
 * The mesh types that can store independent dithered tile fade bounds.
 */
export type DitheredTileFadeMesh = Mesh | InstancedMesh;
/**
 * Defines a normalized interval in the 8x8 Bayer threshold domain.
 */
export interface IDitheredTileFadeBounds {
    /**
     * The inclusive lower bound.
     */
    lowerBound: number;
    /**
     * The exclusive upper bound.
     */
    upperBound: number;
}
/**
 * Applies an opaque, screen-space dithered fade for tile LOD meshes that share a Standard or PBR material.
 *
 * The plugin keeps depth writing and the material's alpha mode unchanged. It affects the material color and integrated
 * prepass outputs, but not standalone depth, shadow, picking, outline, or custom passes. Tile renderers using those passes
 * must provide equivalent pass-specific coverage or exclude fading tiles from them.
 *
 * Per-mesh bounds are runtime state. Material cloning and serialization do not copy them; use {@link copyToMaterial} to
 * copy the enabled state to a cloned material and then configure bounds for the cloned tile meshes.
 * @see https://playground.babylonjs.com/#HI17VI#0
 */
export declare class DitheredTileFadeMaterialPlugin extends MaterialPluginBase {
    /**
     * The name used to register the plugin on a material.
     */
    static readonly Name = "DitheredTileFade";
    private _meshBounds;
    private _instancedBufferSources;
    private _thinInstanceFadeBuffers;
    private _generation;
    private _isEnabled;
    private _shaderIncludeReady;
    private _shaderIncludeError;
    /**
     * Gets whether configured fades are applied. Disabling the plugin makes every mesh fully visible without discarding its stored bounds.
     */
    get isEnabled(): boolean;
    /**
     * Sets whether configured fades are applied. This uniform-only change does not recompile the material.
     */
    set isEnabled(value: boolean);
    /**
     * Creates and attaches a dithered fade plugin.
     * @param material The Standard or PBR material that the plugin will extend.
     * @throws If the material is unsupported or already has a dithered tile fade plugin. Use {@link GetOrCreate} when reuse is intended.
     */
    constructor(material: DitheredTileFadeSupportedMaterial);
    /**
     * Gets the plugin already attached to a material, or creates and attaches one.
     * @param material The Standard or PBR material to extend.
     * @returns The material's dithered fade plugin.
     * @throws If the material is unsupported or another plugin uses the reserved plugin name.
     */
    static GetOrCreate(material: DitheredTileFadeSupportedMaterial): DitheredTileFadeMaterialPlugin;
    /**
     * Checks whether the plugin supports a shader language.
     * @param shaderLanguage The shader language to check.
     * @returns True for GLSL and WGSL.
     */
    isCompatible(shaderLanguage: ShaderLanguage): boolean;
    /**
     * Sets both normalized Bayer interval bounds for a mesh.
     * @param mesh The tile mesh or hardware instance whose draw calls use the bounds.
     * @param lowerBound The inclusive lower bound in the range [0, 1].
     * @param upperBound The exclusive upper bound in the range [0, 1].
     * @remarks Bounds are independent. A lower bound greater than or equal to the upper bound intentionally produces an empty interval.
     */
    setFadeBounds(mesh: DitheredTileFadeMesh, lowerBound: number, upperBound: number): void;
    /**
     * Sets the normalized inclusive lower Bayer interval bound for a mesh.
     * @param mesh The tile mesh or hardware instance whose draw calls use the bound.
     * @param lowerBound The inclusive lower bound in the range [0, 1].
     */
    setFadeLowerBound(mesh: DitheredTileFadeMesh, lowerBound: number): void;
    /**
     * Sets the normalized exclusive upper Bayer interval bound for a mesh.
     * @param mesh The tile mesh or hardware instance whose draw calls use the bound.
     * @param upperBound The exclusive upper bound in the range [0, 1].
     */
    setFadeUpperBound(mesh: DitheredTileFadeMesh, upperBound: number): void;
    /**
     * Copies a mesh's current bounds without allocating.
     * @param mesh The mesh whose bounds are queried.
     * @param result The object that receives the bounds.
     * @returns True when the mesh has explicit bounds. Otherwise false is returned with the source mesh's bounds for a hardware instance, or [0, 1].
     */
    getFadeBoundsToRef(mesh: DitheredTileFadeMesh, result: IDitheredTileFadeBounds): boolean;
    /**
     * Removes a mesh's explicit bounds. A hardware instance inherits its source mesh's bounds; a source mesh uses [0, 1].
     * @param mesh The mesh to reset.
     */
    resetFade(mesh: DitheredTileFadeMesh): void;
    /**
     * Sets normalized Bayer interval bounds for one thin instance.
     * @param mesh The source mesh containing the thin instance.
     * @param index The thin instance index.
     * @param lowerBound The inclusive lower bound in the range [0, 1].
     * @param upperBound The exclusive upper bound in the range [0, 1].
     * @param refresh Whether to immediately upload the updated attribute buffer.
     */
    setThinInstanceFadeBounds(mesh: Mesh, index: number, lowerBound: number, upperBound: number, refresh?: boolean): void;
    /**
     * Sets normalized Bayer interval bounds for all thin instances from packed lower/upper pairs.
     * @param mesh The source mesh containing the thin instances.
     * @param bounds Packed lower/upper pairs, with two values per thin instance.
     */
    setThinInstanceFadeBoundsBuffer(mesh: Mesh, bounds: Float32Array): void;
    /**
     * Uploads thin-instance fade changes after one or more setters used `refresh = false`.
     * @param mesh The source mesh whose fade attribute buffer changed.
     */
    commitThinInstanceFadeBounds(mesh: Mesh): void;
    /**
     * Removes one thin instance's explicit bounds so it inherits the source mesh's bounds.
     * @param mesh The source mesh containing the thin instance.
     * @param index The thin instance index.
     * @param refresh Whether to immediately upload the updated attribute buffer.
     */
    resetThinInstanceFade(mesh: Mesh, index: number, refresh?: boolean): void;
    /**
     * Removes all explicit mesh bounds while keeping the plugin enabled.
     */
    reset(): void;
    /**
     * Copies material-level configuration to another supported material.
     *
     * Per-mesh bounds are intentionally not copied because they belong to the source tile meshes.
     * @param material The destination material, including a material clone.
     * @returns The destination material's dithered tile fade plugin.
     */
    copyToMaterial(material: DitheredTileFadeSupportedMaterial): DitheredTileFadeMaterialPlugin;
    /** @internal */
    isReadyForSubMesh(_defines: MaterialDefines, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): boolean;
    /**
     * Uploads the current mesh's bounds for every draw, including shared and frozen materials.
     * @param _uniformBuffer The material uniform buffer.
     * @param _scene The scene being rendered.
     * @param _engine The engine being used.
     * @param subMesh The submesh being bound.
     */
    hardBindForSubMesh(_uniformBuffer: UniformBuffer, _scene: Scene, _engine: AbstractEngine, subMesh: SubMesh): void;
    /**
     * Registers the per-instance fade attribute when a mesh is rendered as a hardware or thin instance batch.
     * @param attributes The attributes used to compile the material.
     * @param _scene The scene containing the mesh.
     * @param mesh The mesh being compiled.
     */
    getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void;
    /**
     * Gets the uniforms used by the plugin.
     * @returns The external uniform names.
     */
    getUniforms(): {
        externalUniforms: string[];
    };
    /**
     * Gets the shader code injected by the plugin.
     * @param shaderType The shader stage being customized.
     * @param shaderLanguage The material shader language.
     * @returns Fragment customizations, or null for the vertex stage.
     */
    getCustomCode(shaderType: string, shaderLanguage?: ShaderLanguage): Nullable<{
        [pointName: string]: string;
    }>;
    /**
     * Gets the class name.
     * @returns The class name.
     */
    getClassName(): string;
    /**
     * Releases all weakly held runtime fade state and disables fading.
     *
     * The plugin remains attached to its material and can be reused through {@link GetOrCreate}.
     */
    dispose(): void;
    private static _ValidateNewPlugin;
    private static _ValidateMaterial;
    private _validateMesh;
    private _validateThinInstanceIndex;
    private _getInstanceAttributeName;
    private _ensureInstancedBuffer;
    private _ensureThinInstanceBuffer;
    private _updateInstancedFadeBounds;
    private _validateBound;
    private _loadShaderIncludeAsync;
}
