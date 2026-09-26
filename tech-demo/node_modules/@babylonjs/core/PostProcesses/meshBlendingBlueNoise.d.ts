import { type AbstractEngine } from "../Engines/abstractEngine.pure.js";
import { RawTexture } from "../Materials/Textures/rawTexture.js";
/**
 * Gets the deterministic RG8 blue-noise data used by mesh blending.
 * @returns The shared blue-noise byte data.
 * @internal
 */
export declare function _GetMeshBlendBlueNoiseData(): Uint8Array;
/**
 * Creates the deterministic, spatially stable RG8 blue-noise texture used by mesh blending.
 * @param engine Engine that owns the texture.
 * @returns The blue-noise texture.
 * @internal
 */
export declare function _CreateMeshBlendBlueNoiseTexture(engine: AbstractEngine): RawTexture;
