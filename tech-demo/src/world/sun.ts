import { Color3, Mesh, Scene, ShaderMaterial, Vector3 } from "@babylonjs/core";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Body } from "./planets";
import { defaultShores } from "../common/heightField";
import { FAST_NOISE_GLSL } from "../common/shaderChunks";

export interface SunOptions {
  name: string;
  /** World position of the star's centre. */
  position: Vector3;
  radius: number;
  /** Gravity strength (mu): the flight model pulls with GRAV_MU * mu / r^2. */
  mu: number;
}

export interface SunResult {
  /** Registerable body: airless, no terrain, surface radius = the exact sphere. */
  body: Body;
  core: Mesh;
  corona: Mesh;
  /** Advance the surface shader (granulation scroll) by dt seconds. */
  update: (dt: number) => void;
}

const SUN_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec3 vPosW;
varying vec3 vNormalW;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vPosW = wp.xyz;
  vNormalW = normalize(mat3(world) * normal);
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

// The visible star: a real HDR body (core values well above 1 so the ACES curve
// keeps a hot centre and the bloom pass flares), limb-darkened toward a warm
// chromosphere rim, with slow convection mottling in the surface noise. The
// rotation matrix spins the noise domain so the pattern drifts like a turning
// star instead of sliding like a texture.
const SUN_FRAGMENT = `
precision highp float;
varying vec3 vPosW;
varying vec3 vNormalW;
uniform vec3 cameraPosition;
uniform float uTime;
${FAST_NOISE_GLSL}

mat3 rotateY(float a) {
  return mat3(vec3(cos(a), 0.0, -sin(a)), vec3(0.0, 1.0, 0.0), vec3(sin(a), 0.0, cos(a)));
}

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  float ndv = clamp(dot(N, V), 0.0, 1.0);

  // Granulation: two noise scales turning at slightly different rates.
  float gran = waterFbm(rotateY(uTime * 0.010) * N * 3.4, 3);
  float cells = waterFbm(rotateY(uTime * 0.017) * N * 9.0, 4);
  float mottle = 0.90 + gran * 0.14 + cells * 0.07;

  // Limb darkening: white-hot toward the centre, deep amber at the limb.
  float limb = pow(ndv, 0.42);
  vec3 core = mix(vec3(2.3, 1.5, 0.5), vec3(3.6, 3.3, 2.7), pow(ndv, 1.6));
  vec3 col = core * limb * mottle;

  // Chromosphere: the hot hairline that survives at the silhouette.
  col += vec3(1.0, 0.5, 0.18) * pow(1.0 - ndv, 4.0) * 1.8;

  gl_FragColor = vec4(col, 1.0);
}`;

// Corona: a camera-facing billboard with a smooth radial falloff. A fresnel
// shell would silhouette as a hard ring (its brightness always peaks at its own
// edge); a billboard's glow peaks at the star centre, where the opaque core
// covers it, and fades to nothing well before the quad's edge - so the halo is
// soft from any distance.
const CORONA_VERTEX = `
precision highp float;
attribute vec3 position;
uniform mat4 worldViewProjection;
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const CORONA_FRAGMENT = `
precision highp float;
varying vec2 vLocal;
uniform vec3 uTint;
uniform float uStrength;
uniform float uHalf;
void main() {
  float r = length(vLocal) / uHalf;
  float glow = exp(-r * r * 5.7);
  gl_FragColor = vec4(uTint * glow * uStrength, 1.0);
}`;

/**
 * Builds the star as a real, visible body: limb-darkened core + additive corona.
 * The returned `body` slots straight into the scene's body list (flight gravity,
 * HUD distance, landing all use the plain sphere), replacing the old sky sprite.
 */
export function createSun(scene: Scene, opts: SunOptions): SunResult {
  const core = Mesh.CreateSphere(`${opts.name}-core`, 64, opts.radius * 2, scene);
  const coreMat = new ShaderMaterial(
    `${opts.name}-core-mat`,
    scene,
    { vertexSource: SUN_VERTEX, fragmentSource: SUN_FRAGMENT },
    {
      attributes: ["position", "normal"],
      uniforms: ["world", "worldViewProjection", "cameraPosition", "uTime"],
    },
  );
  core.material = coreMat;
  core.isPickable = false;
  core.position.copyFrom(opts.position);

  const coronaSize = opts.radius * 6.4; // half-size 3.2 radii: ~24 deg of soft aura
  const corona = Mesh.CreatePlane(`${opts.name}-corona`, coronaSize, scene);
  const coronaMat = new ShaderMaterial(
    `${opts.name}-corona-mat`,
    scene,
    { vertexSource: CORONA_VERTEX, fragmentSource: CORONA_FRAGMENT },
    {
      attributes: ["position"],
      uniforms: ["worldViewProjection", "uTint", "uStrength", "uHalf"],
      needAlphaBlending: true,
      needAlphaTesting: false,
    },
  );
  coronaMat.alphaMode = Constants.ALPHA_ADD;
  coronaMat.disableDepthWrite = true;
  coronaMat.backFaceCulling = false;
  coronaMat.setColor3("uTint", new Color3(1.0, 0.72, 0.4));
  coronaMat.setFloat("uStrength", 0.6);
  coronaMat.setFloat("uHalf", coronaSize * 0.5);
  corona.billboardMode = Mesh.BILLBOARDMODE_ALL;
  corona.material = coronaMat;
  corona.isPickable = false;
  corona.position.copyFrom(opts.position);

  // IWorldBody implementation (DIP): the star is a plain sphere — zero relief
  // collapses surfaceRadius() to the exact radius, and a waterLevel below the
  // noise floor keeps the floating/splash paths from ever triggering.
  const body: Body = {
    name: opts.name,
    mesh: core,
    radius: opts.radius,
    atmosphereHeight: 0,
    atmosphereColor: new Color3(0, 0, 0),
    skyColor: new Color3(0, 0, 0),
    mu: opts.mu,
    seed: 0,
    relief: 0,
    waterLevel: -10,
    shore: { ...defaultShores },
    center: opts.position.clone(),
    skyTint: undefined,
    atmosphereAt: () => 0,
    surfaceAltitudeAt: (point: Vector3) => point.subtract(opts.position).length() - opts.radius,
    surfaceRadiusAt: () => opts.radius,
    isOverWaterAt: () => false,
    waterSurfaceRadiusAt: () => opts.radius,
  };

  let time = 0;
  const update = (dt: number): void => {
    time += dt;
    coreMat.setFloat("uTime", time);
  };

  return { body, core, corona, update };
}
