/**
 * Mixin to add prepass defines to your material defines
 * @internal
 */
export function PrepassDefinesMixin(base) {
    return class extends base {
        constructor() {
            super(...arguments);
            this.PREPASS = false;
            this.PREPASS_COLOR = false;
            this.PREPASS_COLOR_INDEX = -1;
            this.PREPASS_IRRADIANCE_LEGACY = false;
            this.PREPASS_IRRADIANCE_LEGACY_INDEX = -1;
            this.PREPASS_IRRADIANCE = false;
            this.PREPASS_IRRADIANCE_INDEX = -1;
            this.PREPASS_ALBEDO = false;
            this.PREPASS_ALBEDO_INDEX = -1;
            this.PREPASS_ALBEDO_SQRT = false;
            this.PREPASS_ALBEDO_SQRT_INDEX = -1;
            this.PREPASS_DEPTH = false;
            this.PREPASS_DEPTH_INDEX = -1;
            this.PREPASS_SCREENSPACE_DEPTH = false;
            this.PREPASS_SCREENSPACE_DEPTH_INDEX = -1;
            this.PREPASS_NORMALIZED_VIEW_DEPTH = false;
            this.PREPASS_NORMALIZED_VIEW_DEPTH_INDEX = -1;
            this.PREPASS_NORMAL = false;
            this.PREPASS_NORMAL_INDEX = -1;
            this.PREPASS_NORMAL_WORLDSPACE = false;
            this.PREPASS_WORLD_NORMAL = false;
            this.PREPASS_WORLD_NORMAL_INDEX = -1;
            this.PREPASS_POSITION = false;
            this.PREPASS_POSITION_INDEX = -1;
            this.PREPASS_LOCAL_POSITION = false;
            this.PREPASS_LOCAL_POSITION_INDEX = -1;
            this.PREPASS_VELOCITY = false;
            this.PREPASS_VELOCITY_INDEX = -1;
            this.PREPASS_VELOCITY_LINEAR = false;
            this.PREPASS_VELOCITY_LINEAR_INDEX = -1;
            this.PREPASS_REFLECTIVITY = false;
            this.PREPASS_REFLECTIVITY_INDEX = -1;
            this.PREPASS_OBJECT_ID = false;
            this.PREPASS_OBJECT_ID_INDEX = -1;
            this.PREPASS_OBJECT_ID_R8 = false;
            this.PREPASS_MESH_BLEND_TAG = false;
            this.PREPASS_MESH_BLEND_TAG_INDEX = -1;
            this.SCENE_MRT_COUNT = 0;
        }
    };
}
//# sourceMappingURL=prepass.defines.js.map