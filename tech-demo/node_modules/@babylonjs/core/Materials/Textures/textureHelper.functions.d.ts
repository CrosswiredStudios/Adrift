/**
 * Checks if a given format is a depth texture format
 * @param format Format to check
 * @returns True if the format is a depth texture format
 */
export declare function IsDepthTexture(format: number): boolean;
/**
 * Checks if a given format stores integer color components.
 * @param format Format to check
 * @returns True if the format is an integer color format
 * @internal
 */
export declare function IsIntegerTextureFormat(format: number): boolean;
/**
 * Checks whether an integer texture type stores unsigned values.
 * @param type Texture type to check
 * @returns True for unsigned scalar and packed integer texture types
 * @internal
 */
export declare function IsUnsignedIntegerTextureType(type: number): boolean;
/**
 * Gets the type of a depth texture for a given format
 * @param format Format of the texture
 * @returns The type of the depth texture
 */
export declare function GetTypeForDepthTexture(format: number): number;
/**
 * Checks if a given format has a stencil aspect
 * @param format Format to check
 * @returns True if the format has a stencil aspect
 */
export declare function HasStencilAspect(format: number): boolean;
