import { Scene, Mesh, ShaderMaterial, Vector3, Color3 } from "@babylonjs/core";
import { smoothstep } from "../common/math";

export interface AtmosphereOptions {
  /** Planet radius in world units. */
  radius: number;
  /** Atmosphere shell thickness in world units: how tall the transition band is. */
  height: number;
  /** Colour the air scatters (blue for N-O2, orange/red for dusty CO2 skies). */
  skyTint: Color3;
  /** Sky tint strength: higher = deeper, more saturated sky colour. */
  skyStrength: number;
  /** Haze/aerosol tint that whitens the sky toward the sun and horizon. */
  hazeTint: Color3;
  /** Haze strength: keep low for saturated skies, raise it for dusty worlds. */
  hazeStrength: number;
  /** Haze anisotropy g in [0,1): higher = tighter forward lobe. */
  hazeAnisotropy: number;
  /** Colour of the star's light as it scatters and glints through the air. */
  sunTint: Color3;
  /** Sun glare intensity for the ground-view sky. */
  sunIntensity: number;
}

export interface AtmosphereResult {
  /** Outer shell seen from space (front faces). */
  outer: Mesh;
  /** Inner sky dome seen from inside (back faces). */
  inner: Mesh;
  outerMat: ShaderMaterial;
  innerMat: ShaderMaterial;
  /** 0..1: how much the sky layer covers the view (1 = thick sky, 0 = clear space). */
  skyFactor: number;
  /**
   * @param cameraAltitude altitude above the mean radius
   * @param sunDir direction the star light travels
   * @param daylight 0..1 sunlight at the camera's spot on the planet (0 = night side)
   * @param sunViewToward unit vector from the camera toward the star body: draws the
   *   disc/halo on the visible sun so the glare hands off to the real body cleanly
   *   (defaults to the light axis when omitted)
   */
  update: (cameraAltitude: number, sunDir: Vector3, daylight: number, sunViewToward?: Vector3) => void;
}

const OUTER_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
uniform mat4 worldViewProjection;
uniform mat4 world;
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vPosW = wp.xyz;
  vNormalW = normalize(mat3(world) * normal);
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const OUTER_FRAGMENT = `
precision highp float;
varying vec3 vNormalW;
varying vec3 vPosW;
uniform vec3 cameraPosition;
uniform vec3 sunDirection;
uniform vec3 skyTint;
uniform float skyStrength;
uniform vec3 hazeTint;
uniform float hazeStrength;
uniform float hazeG;
uniform vec3 sunTint;
uniform float density;

float phaseRayleigh(float mu) { return 0.75 * (1.0 + mu * mu); }
float phaseMie(float mu, float g) {
  float g2 = g * g;
  float num = (1.0 - g2) * (1.0 + mu * mu);
  float den = (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5);
  return 1.5 * num / den;
}

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  vec3 L = normalize(-sunDirection);
  float mu = dot(V, L);

  // Limb factor: grazing view angles accumulate more atmosphere. The shell sits at
  // the top of the atmosphere, so a per-fragment height falloff would be constant
  // (h == 1) and useless here - the view angle and sun term shape the glow, and the
  // JS side cross-fades the whole shell by camera altitude. The exponent is chosen
  // so a TALL shell still reads as a thin halo around the planet instead of a
  // translucent bubble filling the view.
  float limb = pow(1.0 - abs(dot(N, V)), 5.0);

  // Sunlight gate: the shell only glows where the star is actually lighting it, so
  // the night side of the planet never shows an atmosphere. The ramp is deliberately
  // wide: a tall shell seen from orbit otherwise ends in a visible straight terminator.
  float sunAmt = dot(N, L);
  float day = smoothstep(-0.24, 0.34, sunAmt);
  float twilight = exp(-abs(sunAmt + 0.05) * 6.0);

  vec3 ray = skyTint * phaseRayleigh(mu) * skyStrength;
  vec3 mie = hazeTint * phaseMie(mu, hazeG) * hazeStrength;
  // Warm the twilight band like a sunset.
  vec3 sunset = mix(vec3(1.0), vec3(1.0, 0.45, 0.2), 0.75) * twilight * 0.6;

  vec3 col = (ray * 1.35 + mie * 0.4) * limb * (day + sunset * day + twilight * 0.3) * sunTint;
  float alpha = clamp(limb * (day * 1.25 + twilight * 0.3), 0.0, 1.0) * density;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(col * density, alpha);
}`;

const INNER_VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec3 normal;
uniform mat4 worldViewProjection;
uniform mat4 world;
varying vec3 vDirW;
varying vec3 vPosW;
void main() {
  vec4 wp = world * vec4(position, 1.0);
  vPosW = wp.xyz;
  vDirW = normalize(wp.xyz - vec3(world[3][0], world[3][1], world[3][2]));
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const INNER_FRAGMENT = `
precision highp float;
varying vec3 vDirW;
varying vec3 vPosW;
uniform vec3 cameraPosition;
uniform vec3 sunDirection;
uniform vec3 sunViewToward;
uniform vec3 skyTint;
uniform float skyStrength;
uniform vec3 hazeTint;
uniform float hazeStrength;
uniform float hazeG;
uniform vec3 sunTint;
uniform float sunIntensity;
uniform float density;
uniform float daylight;

float phaseRayleigh(float mu) { return 0.75 * (1.0 + mu * mu); }
float phaseMie(float mu, float g) {
  float g2 = g * g;
  float num = (1.0 - g2) * (1.0 + mu * mu);
  float den = (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5);
  return 1.5 * num / den;
}

void main() {
  vec3 N = normalize(vDirW);
  vec3 V = normalize(cameraPosition - vPosW);
  vec3 L = normalize(-sunDirection);
  float mu = dot(N, L);

  // Airmass: rays that graze the dome cross far more air than steep ones. (The old
  // dir.y test never rose near the horizon for a low camera - every ground-level ray
  // hits the dome high on the globe - so the sky had no horizon thickening.)
  float airmass = pow(1.0 - abs(dot(N, V)), 1.4);
  float depth = mix(0.7, 1.6, airmass);

  // Sunlight gate: sky only where the star lights the air, so the night side stays
  // dark instead of glowing (the star is the light source for everything here).
  float sunAmt = dot(N, L);
  float day = smoothstep(-0.15, 0.25, sunAmt);
  float twilight = exp(-abs(sunAmt + 0.06) * 5.0);

  vec3 ray = skyTint * phaseRayleigh(mu) * skyStrength;
  vec3 mie = hazeTint * phaseMie(mu, hazeG) * hazeStrength;
  // Keep the scattered light under 1.0 in linear space: pushing blue over 1.0 makes
  // ACES roll it off toward white, which is what washed the sky out before.
  vec3 col = (ray * 0.6 + mie * 0.3) * depth * sunTint;

  // Sun disc + halo: glare through the air, tinted by the star's light, only where
  // the sun is actually up. Drawn about the direction to the real star body (not the
  // scene light axis) with the same apparent width, so the disc sits exactly on the
  // body behind the dome and cross-fades into it as the atmosphere thins out.
  float muView = dot(N, sunViewToward);
  float disc = smoothstep(0.9996, 0.99985, muView);
  float halo = pow(clamp(muView, 0.0, 1.0), 26.0) * 0.4 + pow(clamp(muView, 0.0, 1.0), 350.0) * 1.1;
  col += sunTint * (disc * 4.0 + halo) * sunIntensity * day;

  // Sunset warming near terminator at low view angles.
  col = mix(col, col * vec3(1.25, 0.6, 0.35) + vec3(0.25, 0.08, 0.02), twilight * airmass * 0.85);

  // Fade to transparent black looking straight up out of the atmosphere. The camera
  // daylight gate keeps the night side free of sky: without it, the dome's lit far
  // side (over the day hemisphere) still floods the view when standing in the dark.
  vec3 night = vec3(0.004, 0.006, 0.012);
  col = mix(night, col, clamp(day * 1.1 + twilight * 0.5, 0.0, 1.0));
  float skyAlpha = clamp(depth * (day + twilight * 0.25), 0.0, 1.0) * density * daylight;
  gl_FragColor = vec4(col * density * daylight, clamp(skyAlpha + disc * day, 0.0, 1.0));
}`;

export function createAtmosphere(scene: Scene, name: string, opts: AtmosphereOptions): AtmosphereResult {
  const atmoR = opts.radius + opts.height;
  // The sky dome sits just inside the outer shell so the two spheres are never
  // coincident (avoids z-order ties when the camera crosses them while fading).
  const skyR = atmoR - Math.min(8, opts.height * 0.1);

  const outer = Mesh.CreateSphere(`${name}-atmo-outer`, 96, atmoR * 2, scene);
  const outerMat = new ShaderMaterial(
    `${name}-atmo-outer-mat`,
    scene,
    { vertexSource: OUTER_VERTEX, fragmentSource: OUTER_FRAGMENT },
    {
      attributes: ["position", "normal"],
      uniforms: [
        "world",
        "worldViewProjection",
        "cameraPosition",
        "sunDirection",
        "skyTint",
        "skyStrength",
        "hazeTint",
        "hazeStrength",
        "hazeG",
        "sunTint",
        "density",
      ],
      needAlphaBlending: true,
      needAlphaTesting: false,
    },
  );
  outerMat.backFaceCulling = true;
  outer.material = outerMat;
  outer.isPickable = false;

  const inner = Mesh.CreateSphere(`${name}-sky-inner`, 64, skyR * 2, scene);
  const innerMat = new ShaderMaterial(
    `${name}-sky-inner-mat`,
    scene,
    { vertexSource: INNER_VERTEX, fragmentSource: INNER_FRAGMENT },
    {
      attributes: ["position", "normal"],
      uniforms: [
        "world",
        "worldViewProjection",
        "cameraPosition",
        "sunDirection",
        "sunViewToward",
        "skyTint",
        "skyStrength",
        "hazeTint",
        "hazeStrength",
        "hazeG",
        "sunTint",
        "sunIntensity",
        "density",
        "daylight",
      ],
      needAlphaBlending: true,
      needAlphaTesting: false,
    },
  );
  innerMat.backFaceCulling = false;
  inner.material = innerMat;
  inner.isPickable = false;

  const applyStatics = (mat: ShaderMaterial): void => {
    mat.setColor3("skyTint", opts.skyTint);
    mat.setFloat("skyStrength", opts.skyStrength);
    mat.setColor3("hazeTint", opts.hazeTint);
    mat.setFloat("hazeStrength", opts.hazeStrength);
    mat.setFloat("hazeG", opts.hazeAnisotropy);
    mat.setColor3("sunTint", opts.sunTint);
  };
  applyStatics(outerMat);
  applyStatics(innerMat);
  innerMat.setFloat("sunIntensity", opts.sunIntensity);
  innerMat.setVector3("sunViewToward", new Vector3(0, 1, 0)); // overwritten every tick

  let skyFactor = 1;
  const update = (cameraAltitude: number, sunDir: Vector3, daylight = 1, sunViewToward?: Vector3): void => {
    // Unclamped altitude ratio: below 1 = inside the shell, above 1 = in space.
    const t = Math.max(0, cameraAltitude / Math.max(opts.height, 1));
    // Sky dome: full near the surface, gone just above the shell. The dome is only
    // enabled while the camera is under it - from outside it would render as a
    // double-sided haze ball over the planet.
    const innerDensity = 1 - smoothstep(0.55, 1.05, t);
    // Outer limb: fades in as the camera crosses the shell (it is back-face culled
    // while inside, so the ramp only shapes the hand-off), then stays at full
    // strength at any distance - it is the planet's limb glow seen from other worlds.
    const outerDensity = smoothstep(0.98, 1.2, t);
    for (const [mat, d] of [
      [outerMat, outerDensity],
      [innerMat, innerDensity],
    ] as const) {
      mat.setFloat("density", d);
      mat.setVector3("sunDirection", sunDir);
      const cam = scene.activeCamera;
      if (cam) mat.setVector3("cameraPosition", cam.position);
    }
    innerMat.setFloat("daylight", daylight);
    innerMat.setVector3("sunViewToward", sunViewToward ?? sunDir.scale(-1));
    inner.setEnabled(innerDensity > 0.01);
    skyFactor = innerDensity;
  };

  return {
    outer,
    inner,
    outerMat,
    innerMat,
    update,
    get skyFactor() {
      return skyFactor;
    },
  };
}
