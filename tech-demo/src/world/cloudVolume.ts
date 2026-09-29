import { Constants } from "@babylonjs/core/Engines/constants";
import {
  Camera,
  Color3,
  Effect,
  PostProcess,
  RawTexture,
  RawTexture3D,
  Scene,
  Texture,
  Vector3,
} from "@babylonjs/core";
import type { DepthRenderer } from "@babylonjs/core";
import { mulberry32 } from "../common/rng";

/**
 * Screen-space volumetric clouds, ported from the Babylon playground demo
 * (#MAONNT#13): a weather-map shaped slab raymarched as a camera post-process
 * with depth-aware compositing, Beer-law light marching, and a spatial
 * YCoCg denoise pass. Loads the reference demo's pebbles.png weather map and
 * a 32^3 volume noise texture (sampler3D); procedural fallbacks from the
 * planet seed keep the deck deterministic and offline-safe on load failure.
 *
 * Why a post-process instead of the old shell mesh: the shell shaded one
 * surface point per pixel, so the deck was either invisible (alpha ~0 from
 * orbit) or a solid white sheet below it. Marching the slab in screen space
 * accumulates real optical depth along each view ray, which is what makes
 * the playground demo read as volume.
 */

export interface CloudVolumeOptions {
  /** Planet center in world space (the slab is planet-relative). */
  center: Vector3;
  /** Mean planet radius in world units. */
  radius: number;
  /** Cloud base altitude above the mean radius. */
  baseHeight: number;
  /** Slab thickness in world units. */
  thickness: number;
  /** 0..1 cloud coverage (higher = more overcast). */
  coverage: number;
  /** Density multiplier on the shaped field. */
  density: number;
  /** Beer-law absorption coefficient. */
  absorption: number;
  /** Post-process render scale (1 = full res). */
  renderScale: number;
  /** View raymarch steps. */
  marchSteps: number;
  /** Light march steps toward the sun. */
  lightSteps: number;
  /** World-space wind drift direction. */
  windDirection: Vector3;
  /** Wind drift speed. */
  windSpeed: number;
  /** World-space scale of the cloud field. */
  cloudScale: number;
  /** Detail erosion scale / strength. */
  detailScale: number;
  detailStrength: number;
  /** Sun tint for forward scattering. */
  sunColor: Color3;
  /** Ambient sky tint mixed into the cloud shading. */
  skyHorizonColor: Color3;
  /** Shadowed-core tint. */
  cloudShadowColor: Color3;
  /** Seed for the procedural weather + volume noise. */
  seed: number;
}

export type CloudVolumePartial = Partial<CloudVolumeOptions>;

const SHADER_NAME = "AdriftCloudVolume";
const DENOISE_SHADER_NAME = "AdriftCloudVolumeDenoise";

function registerShaders(): void {
  if (Effect.ShadersStore[`${SHADER_NAME}FragmentShader`]) return;
  Effect.ShadersStore[`${SHADER_NAME}FragmentShader`] = `
  precision highp float;
  precision highp sampler3D;

  varying vec2 vUV;

  uniform sampler2D textureSampler;
  uniform sampler2D depthSampler;
  uniform sampler2D weatherSampler;
  uniform sampler3D volumeNoiseSampler;
  uniform vec2 iResolution;
  uniform float iTime;
  uniform float cameraMinZ;
  uniform float cameraMaxZ;
  uniform float depthIsPacked;
  uniform float cloudBaseHeight;
  uniform float cloudThickness;
  uniform float coverage;
  uniform float density;
  uniform float absorption;
  uniform float depthFadeDistance;
  uniform float cloudScale;
  uniform float detailScale;
  uniform float detailStrength;
  uniform float windSpeed;
  uniform float tanHalfFov;
  uniform float aspectRatio;
  uniform float marchSteps;
  uniform float lightSteps;
  uniform vec3 cameraPosition;
  uniform vec3 cameraForward;
  uniform vec3 cameraRight;
  uniform vec3 cameraUp;
  uniform vec3 windDirection;
  uniform vec3 sunDirection;
  uniform vec3 sunColor;
  uniform vec3 skyHorizonColor;
  uniform vec3 cloudShadowColor;
  uniform vec3 planetCenter;
  uniform float planetRadius;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float interleavedGradientNoise(vec2 pixel) {
    return fract(52.9829189 * fract(0.06711056 * pixel.x + 0.00583715 * pixel.y));
  }

  float unpackDepth(vec4 color) {
    const vec4 bitShift = vec4(1.0 / (255.0 * 255.0 * 255.0), 1.0 / (255.0 * 255.0), 1.0 / 255.0, 1.0);
    return dot(color, bitShift);
  }

  float readSceneRayDistance(vec2 uv, vec3 rd) {
    vec4 depthSample = texture2D(depthSampler, uv);
    float depth = mix(depthSample.r, unpackDepth(depthSample), step(0.5, depthIsPacked));
    if (depth <= 0.000001 || depth >= 0.999999) {
      return 1.0e20;
    }
    float viewDepth = max(cameraMinZ, depth * cameraMaxZ);
    return viewDepth / max(dot(rd, cameraForward), 0.0001);
  }

  vec4 readSceneRayDistanceCross(vec2 uv, vec3 rd, vec2 texel) {
    return vec4(
      readSceneRayDistance(uv + vec2(-texel.x, 0.0), rd),
      readSceneRayDistance(uv + vec2(texel.x, 0.0), rd),
      readSceneRayDistance(uv + vec2(0.0, -texel.y), rd),
      readSceneRayDistance(uv + vec2(0.0, texel.y), rd)
    );
  }

  float sceneDepthVisibility(float t, float centerDistance, vec4 crossDistances, float fadeDistance) {
    float visibility = smoothstep(0.0, fadeDistance, centerDistance - t);
    visibility += smoothstep(0.0, fadeDistance, crossDistances.x - t);
    visibility += smoothstep(0.0, fadeDistance, crossDistances.y - t);
    visibility += smoothstep(0.0, fadeDistance, crossDistances.z - t);
    visibility += smoothstep(0.0, fadeDistance, crossDistances.w - t);
    return visibility * 0.2;
  }

  float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return texture(volumeNoiseSampler, (i + f + 0.5) / 32.0).x;
  }

  float fbm(vec3 p) {
    mat3 m = mat3(
       0.00,  0.80,  0.60,
      -0.80,  0.36, -0.48,
      -0.60, -0.48,  0.64
    );
    float value = 0.5000 * noise(p);
    p = m * p * 2.02;
    value += 0.2500 * noise(p);
    p = m * p * 2.03;
    value += 0.1250 * noise(p);
    return value;
  }

  float weatherMap(vec2 p) {
    return texture2D(weatherSampler, p).x;
  }

  float shaderToyMeterScale() {
    return 600.0 / max(cloudThickness, 0.001);
  }

  vec3 toShaderToyCloudPoint(vec3 p, float height01) {
    float meterScale = shaderToyMeterScale();
    vec3 rel = (p - planetCenter) / max(planetRadius, 1.0);
    return vec3(rel.x * meterScale, 800.0 + height01 * 600.0, rel.z * meterScale);
  }

  float cloudDensity(vec3 p) {
    vec3 rel = p - planetCenter;
    float r = length(rel);
    float baseR = planetRadius + cloudBaseHeight;
    float h = clamp((r - baseR) / max(cloudThickness, 0.001), 0.0, 1.0);
    if (r < baseR - cloudThickness * 2.0 || r > baseR + cloudThickness * 2.0) return 0.0;
    vec3 wp = toShaderToyCloudPoint(p, h);
    vec2 wind = normalize(windDirection.xz + vec2(0.0001));
    vec2 sideWind = vec2(-wind.y, wind.x);

    wp.xz += wind * iTime * windSpeed * 10.3;
    float largeWeather = clamp((weatherMap(-0.00005 * wp.zx) - 0.18) * 5.0, 0.0, 2.0);
    wp.xz += sideWind * iTime * windSpeed * 8.3;
    float weatherCutoff = mix(0.62, 0.18, coverage);
    float weather = largeWeather * max(0.0, weatherMap(0.0002 * wp.zx) - weatherCutoff) / max(0.08, 1.0 - weatherCutoff);
    weather *= smoothstep(0.0, 0.5, h) * smoothstep(1.0, 0.5, h);

    float cloudShape = pow(max(weather, 0.0), 0.3 + 1.5 * smoothstep(0.2, 0.5, h));
    if (cloudShape <= 0.0) {
      return 0.0;
    }

    wp.xz += sideWind * iTime * windSpeed * 12.3;
    vec3 shapeP = wp * (0.01 * cloudScale);
    float coarse = fbm(shapeP);
    float den = max(0.0, cloudShape - 0.7 * coarse);
    if (den <= 0.0) {
      return 0.0;
    }

    vec3 detailP = (wp + vec3(0.0, iTime * windSpeed * 15.2, 0.0)) * (0.05 * detailScale);
    den = max(0.0, den - detailStrength * fbm(detailP));
    return max(0.0, largeWeather * 0.2 * density * min(1.0, 5.0 * den));
  }

  // Spherical slab intersection around the planet: returns the [near, far]
  // segment of the view ray inside [baseR, baseR + thickness].
  bool intersectCloudSlab(vec3 ro, vec3 rd, out float tNear, out float tFar) {
    vec3 oc = ro - planetCenter;
    float baseR = planetRadius + cloudBaseHeight;
    float topR = baseR + cloudThickness;
    float b = dot(oc, rd);
    float cOuter = dot(oc, oc) - topR * topR;
    float hOuter = b * b - cOuter;
    if (hOuter < 0.0) { tNear = 0.0; tFar = 0.0; return false; }
    float sqOuter = sqrt(hOuter);
    float t0 = -b - sqOuter;
    float t1 = -b + sqOuter;
    float cInner = dot(oc, oc) - baseR * baseR;
    float hInner = b * b - cInner;
    if (hInner < 0.0) {
      // Ray never reaches the hollow core: the whole chord is slab.
      tNear = max(t0, 0.0);
      tFar = t1;
      return tFar > tNear;
    }
    float sqInner = sqrt(hInner);
    float i0 = -b - sqInner;
    float i1 = -b + sqInner;
    if (t1 <= max(t0, 0.0)) { tNear = 0.0; tFar = 0.0; return false; }
    if (i1 <= max(i0, 0.0) || i0 >= t1 || i1 <= max(t0, 0.0)) {
      tNear = max(t0, 0.0);
      tFar = t1;
      return tFar > tNear;
    }
    // Ray crosses the hollow core: march the nearer slab segment only (the
    // far side is hidden behind the planet from outside, and negligible
    // from inside next to the near wall).
    float a0 = max(t0, 0.0);
    float a1 = min(max(i0, 0.0), t1);
    float b0 = max(i1, 0.0);
    float b1 = t1;
    float lenA = a1 - a0;
    float lenB = b1 - b0;
    if (lenA >= lenB) { tNear = a0; tFar = a1; }
    else { tNear = b0; tFar = b1; }
    return tFar > tNear;
  }

  float sampleLight(vec3 p) {
    float steps = max(lightSteps, 1.0);
    float stepLen = cloudThickness / steps;
    float stepMeters = stepLen * shaderToyMeterScale();
    float opticalDepth = 0.0;
    p += sunDirection * stepLen * hash13(p * 0.037 + sunDirection * 11.7);
    for (int i = 0; i < 20; i++) {
      if (float(i) >= steps) {
        break;
      }
      opticalDepth += cloudDensity(p + sunDirection * stepLen * (float(i) + 0.5)) * stepMeters;
    }
    float beers = exp(-opticalDepth * absorption);
    return beers + 0.32 * exp(-opticalDepth * absorption * 0.18);
  }

  vec3 srgbToLinear(vec3 color) {
    return pow(max(color, vec3(0.0)), vec3(2.2));
  }

  vec3 tonemapACES(vec3 x) {
    float a = 2.51;
    float b = 0.03;
    float c = 2.43;
    float d = 0.59;
    float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  void main(void) {
    vec2 screen = vUV * 2.0 - 1.0;
    vec3 rd = normalize(
      cameraForward +
      cameraRight * screen.x * aspectRatio * tanHalfFov +
      cameraUp * screen.y * tanHalfFov
    );
    vec3 ro = cameraPosition;
    vec3 sceneColor = texture2D(textureSampler, vUV).rgb;
    vec3 skyAmbientColor = srgbToLinear(sceneColor);
    vec3 cloudScattering = vec3(0.0);
    float transmittance = 1.0;

    float tNear;
    float tFar;
    if (intersectCloudSlab(ro, rd, tNear, tFar)) {
      float steps = max(marchSteps, 1.0);
      vec2 depthTexel = 1.0 / max(iResolution, vec2(1.0));
      float sceneDistance = readSceneRayDistance(vUV, rd);
      vec4 sceneDistanceCross = readSceneRayDistanceCross(vUV, rd, depthTexel);
      float farthestSceneDistance = max(sceneDistance, max(max(sceneDistanceCross.x, sceneDistanceCross.y), max(sceneDistanceCross.z, sceneDistanceCross.w)));
      float maxDistance = min(min(tFar, 4000.0), farthestSceneDistance);
      float dt = max((maxDistance - tNear) / steps, 0.015);
      float depthFade = max(depthFadeDistance, dt * 2.0);
      float t = tNear + interleavedGradientNoise(vUV * iResolution) * dt;
      float mu = dot(sunDirection, rd);
      float meterScale = shaderToyMeterScale();

      for (int i = 0; i < 128; i++) {
        if (float(i) >= steps || t > maxDistance || transmittance < 0.035) {
          break;
        }

        vec3 p = ro + rd * t;
        float depthVisibility = sceneDepthVisibility(t, sceneDistance, sceneDistanceCross, depthFade);
        float d = cloudDensity(p) * depthVisibility;
        if (d > 0.003) {
          float light = sampleLight(p);
          float r = length(p - planetCenter);
          float height01 = clamp((r - (planetRadius + cloudBaseHeight)) / max(cloudThickness, 0.001), 0.0, 1.0);
          float forwardScatter = pow(max(mu, 0.0), 3.0);
          float backScatter = 0.35 * pow(max(-mu, 0.0), 1.5);
          vec3 skyTint = mix(skyHorizonColor, skyAmbientColor * 1.35, 0.72);
          vec3 ambient = (0.42 + 0.55 * height01) * mix(cloudShadowColor, skyTint, 0.58);
          vec3 radiance = ambient + sunColor * (1.2 * light + 1.7 * forwardScatter * light + backScatter);
          float sampleAlpha = 1.0 - exp(-d * dt * meterScale * absorption);
          cloudScattering += transmittance * radiance * sampleAlpha;
          transmittance *= exp(-d * dt * meterScale * absorption);
        }
        t += dt;
      }
    }

    vec3 cloudColor = pow(tonemapACES(max(cloudScattering, vec3(0.0)) * 1.28), vec3(0.4545));
    gl_FragColor = vec4(clamp(sceneColor * transmittance + cloudColor, 0.0, 1.0), 1.0 - transmittance);
  }
  `;
  Effect.ShadersStore[`${DENOISE_SHADER_NAME}FragmentShader`] = `
  precision highp float;

  varying vec2 vUV;

  uniform sampler2D textureSampler;
  uniform vec2 iResolution;

  vec3 RGBToYCoCg(vec3 rgb) {
    float y = dot(rgb, vec3(1.0, 2.0, 1.0)) * 0.25;
    float co = dot(rgb, vec3(2.0, 0.0, -2.0)) * 0.25 + (0.5 * 256.0 / 255.0);
    float cg = dot(rgb, vec3(-1.0, 2.0, -1.0)) * 0.25 + (0.5 * 256.0 / 255.0);
    return vec3(y, co, cg);
  }

  float denoiseWeight(vec3 centerYCoCg, float centerAlpha, vec4 sampleValue, float spatialWeight) {
    vec3 sampleYCoCg = RGBToYCoCg(sampleValue.rgb);
    float colorDistance = dot(abs(sampleYCoCg - centerYCoCg), vec3(2.2, 0.75, 0.75));
    float alphaDistance = abs(sampleValue.a - centerAlpha);
    float cloudMask = smoothstep(0.015, 0.18, max(centerAlpha, sampleValue.a));
    return spatialWeight * cloudMask * exp(-colorDistance * 18.0 - alphaDistance * 8.0);
  }

  float spatialKernelWeight(vec2 offset) {
    float radius2 = dot(offset, offset);
    return exp(-radius2 * 0.34);
  }

  vec4 sampleColor(vec2 offset) {
    return texture2D(textureSampler, vUV + offset / iResolution);
  }

  void accumulateSample(
    vec2 offset,
    float spatialWeight,
    vec3 centerYCoCg,
    float centerAlpha,
    inout vec3 colorSum,
    inout float weightSum
  ) {
    vec4 sampleValue = sampleColor(offset);
    float weight = denoiseWeight(centerYCoCg, centerAlpha, sampleValue, spatialWeight);
    colorSum += sampleValue.rgb * weight;
    weightSum += weight;
  }

  void main(void) {
    vec4 center = texture2D(textureSampler, vUV);
    if (center.a < 0.01) {
      gl_FragColor = vec4(center.rgb, 1.0);
      return;
    }

    vec3 centerYCoCg = RGBToYCoCg(center.rgb);
    vec3 colorSum = center.rgb * 1.4;
    float weightSum = 1.4;

    for (int y = -2; y <= 2; y++) {
      for (int x = -2; x <= 2; x++) {
        if (x == 0 && y == 0) {
          continue;
        }
        vec2 offset = vec2(float(x), float(y));
        accumulateSample(offset, spatialKernelWeight(offset), centerYCoCg, center.a, colorSum, weightSum);
      }
    }

    vec3 filtered = colorSum / max(weightSum, 0.0001);
    float strength = smoothstep(0.02, 0.35, center.a);
    gl_FragColor = vec4(mix(center.rgb, filtered, 0.68 * strength), 1.0);
  }
  `;
}

/** Procedural weather map: 128x128 R channel with soft blobs + coverage ramp. */
export function makeWeatherData(seed: number, size = 128): Uint8Array {
  const rand = mulberry32(seed);
  const blobs: { x: number; y: number; r: number; a: number }[] = [];
  for (let i = 0; i < 90; i++) {
    blobs.push({ x: rand(), y: rand(), r: 0.04 + rand() * 0.16, a: 0.35 + rand() * 0.65 });
  }
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let acc = 0;
      for (const b of blobs) {
        // Toroidal distance so the map tiles seamlessly.
        const dx = Math.min(Math.abs(u - b.x), 1 - Math.abs(u - b.x));
        const dy = Math.min(Math.abs(v - b.y), 1 - Math.abs(v - b.y));
        const d = Math.hypot(dx, dy) / b.r;
        if (d < 1) acc += b.a * (1 - d * d) * (1 - d * d);
      }
      data[y * size + x] = Math.max(0, Math.min(255, Math.round(acc * 160)));
    }
  }
  return data;
}

/** Procedural 32^3 single-channel value-noise volume (tiles seamlessly). */
export function makeVolumeNoiseData(seed: number, size = 32): Uint8Array {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const lattice = new Float32Array(size * size * size);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
  const at = (x: number, y: number, z: number): number =>
    lattice[((z % size) * size + (y % size)) * size + (x % size)];
  const data = new Uint8Array(size * size * size);
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Trilinear over the lattice with wrap = seamless tiling noise.
        const fx = 0.5;
        const fy = 0.5;
        const fz = 0.5;
        const c000 = at(x, y, z);
        const c100 = at(x + 1, y, z);
        const c010 = at(x, y + 1, z);
        const c110 = at(x + 1, y + 1, z);
        const c001 = at(x, y, z + 1);
        const c101 = at(x + 1, y, z + 1);
        const c011 = at(x, y + 1, z + 1);
        const c111 = at(x + 1, y + 1, z + 1);
        const v =
          c000 * (1 - fx) * (1 - fy) * (1 - fz) +
          c100 * fx * (1 - fy) * (1 - fz) +
          c010 * (1 - fx) * fy * (1 - fz) +
          c110 * fx * fy * (1 - fz) +
          c001 * (1 - fx) * (1 - fy) * fz +
          c101 * fx * (1 - fy) * fz +
          c011 * (1 - fx) * fy * fz +
          c111 * fx * fy * fz;
        data[(z * size + y) * size + x] = Math.round(v * 255);
      }
    }
  }
  return data;
}

export interface CloudVolume {
  options: CloudVolumeOptions;
  /** True while the pass pair is attached to the camera. */
  readonly enabled: boolean;
  setOptions(patch: CloudVolumePartial): void;
  setCenter(center: Vector3): void;
  setEnabled(enabled: boolean): void;
  setSunDirection(dir: Vector3): void;
  update(dt: number): void;
  dispose(): void;
}

interface VolumeTextures {
  weather: Texture;
  volume: RawTexture3D;
}

/**
 * Attach the playground-style cloud post-process chain to a camera. The depth
 * renderer is shared per scene (WeakMap) so Vael + Tethys never double
 * allocate; each planet owns its weather/volume textures + post-process pair.
 */
const DEPTHS = new WeakMap<Scene, DepthRenderer>();

function getDepth(scene: Scene, camera: Camera): DepthRenderer {
  let depth = DEPTHS.get(scene);
  if (!depth) {
    depth = scene.enableDepthRenderer(camera, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
    depth.useOnlyInActiveCamera = true;
    DEPTHS.set(scene, depth);
  }
  return depth;
}

function makeWeatherRaw(scene: Scene, seed: number): Texture {
  const data = makeWeatherData(seed);
  const tex = new RawTexture(
    data,
    128,
    128,
    Constants.TEXTUREFORMAT_RED,
    scene,
    false,
    false,
    Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
  tex.name = "cloud-weather-fallback";
  tex.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
  tex.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
  return tex;
}

function makeTextures(scene: Scene, seed: number): VolumeTextures {
  // Weather: start with the procedural fallback, swap to pebbles.png on load.
  const result: VolumeTextures = { weather: makeWeatherRaw(scene, seed), volume: null! };
  const loaded = new Texture(
    "/textures/clouds/pebbles.png",
    scene,
    false,
    false,
    Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    () => {
      result.weather.dispose();
      result.weather = loaded;
      result.weather.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
      result.weather.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    },
    () => {
      loaded.dispose();
    },
  );
  loaded.name = "cloud-weather";

  // Volume: 32^3 single-channel noise as a true 3D texture (sampler3D).
  const volumeData = makeVolumeNoiseData(seed);
  result.volume = new RawTexture3D(
    volumeData,
    32,
    32,
    32,
    Constants.TEXTUREFORMAT_RED,
    scene,
    false,
    false,
    Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    Constants.TEXTURETYPE_UNSIGNED_BYTE,
  );
  result.volume.name = "cloud-volume-noise";
  result.volume.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
  result.volume.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
  result.volume.wrapR = Constants.TEXTURE_WRAP_ADDRESSMODE;
  return result;
}

/**
 * Fetch the reference demo's greyNoise3D.bin (Shadertoy volume: 20-byte
 * "BIN\n" header + width/height/depth/channels int32s + raw bytes) and swap
 * it in as the 3D noise texture. On any failure the procedural 32^3 volume
 * created in makeTextures stays in place, so the deck keeps rendering.
 */
async function loadVolumeNoiseTexture(scene: Scene, result: VolumeTextures): Promise<void> {
  try {
    const response = await fetch("/textures/clouds/greyNoise3D.bin");
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const buffer = await response.arrayBuffer();
    const view = new DataView(buffer);
    const signature = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3),
    );
    if (signature !== "BIN\n" && signature !== "BIN\0") throw new Error("Invalid Shadertoy volume header.");
    const width = view.getInt32(4, true);
    const height = view.getInt32(8, true);
    const depth = view.getInt32(12, true);
    const channels = view.getInt32(16, true);
    if (width <= 0 || height <= 0 || depth <= 0 || channels !== 1) {
      throw new Error(`Unsupported Shadertoy volume size ${width}x${height}x${depth}x${channels}.`);
    }
    const byteLength = width * height * depth * channels;
    if (buffer.byteLength < 20 + byteLength) throw new Error("Shadertoy volume file is truncated.");
    const data = new Uint8Array(buffer, 20, byteLength);
    const next = new RawTexture3D(
      data,
      width,
      height,
      depth,
      Constants.TEXTUREFORMAT_RED,
      scene,
      false,
      false,
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    next.name = "cloud-volume-noise";
    next.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
    next.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    next.wrapR = Constants.TEXTURE_WRAP_ADDRESSMODE;
    result.volume.dispose();
    result.volume = next;
  } catch (error) {
    console.error("Failed to load volumetric cloud noise texture; using procedural fallback.", error);
  }
}

function defaultOptions(input: CloudVolumePartial & { center: Vector3; radius: number }): CloudVolumeOptions {
  return {
    center: input.center.clone(),
    radius: input.radius,
    baseHeight: input.baseHeight ?? 18,
    thickness: input.thickness ?? 14,
    coverage: input.coverage ?? 0.55,
    density: input.density ?? 0.55,
    absorption: input.absorption ?? 0.34,
    renderScale: input.renderScale ?? 0.5,
    marchSteps: input.marchSteps ?? 48,
    lightSteps: input.lightSteps ?? 8,
    windDirection: (input.windDirection ?? new Vector3(1, 0, 0.22)).clone(),
    windSpeed: input.windSpeed ?? 0.35,
    cloudScale: input.cloudScale ?? 1,
    detailScale: input.detailScale ?? 1,
    detailStrength: input.detailStrength ?? 0.25,
    sunColor: (input.sunColor ?? new Color3(1, 0.88, 0.58)).clone(),
    skyHorizonColor: (input.skyHorizonColor ?? new Color3(0.74, 0.9, 1)).clone(),
    cloudShadowColor: (input.cloudShadowColor ?? new Color3(0.36, 0.43, 0.56)).clone(),
    seed: input.seed ?? 1337,
  };
}

export function createCloudVolume(
  scene: Scene,
  camera: Camera,
  input: CloudVolumePartial & { center: Vector3; radius: number },
): CloudVolume {
  registerShaders();
  const options = defaultOptions(input);
  const depth = getDepth(scene, camera);
  const textures = makeTextures(scene, options.seed);
  void loadVolumeNoiseTexture(scene, textures);
  // FreeCamera.getDirection uses the camera's rotation; the forward axis is
  // -Z in Babylon's left-handed view space.
  const forwardAxis = new Vector3(0, 0, -1);
  const fallbackForward = new Vector3(0, 0, -1);
  const startedAt = performance.now();
  const sunDirection = new Vector3(0.6, 0.45, -0.8);
  let elapsed = 0;
  let enabled = true;

  const uniforms = [
    "iResolution",
    "iTime",
    "cameraMinZ",
    "cameraMaxZ",
    "depthIsPacked",
    "cloudBaseHeight",
    "cloudThickness",
    "coverage",
    "density",
    "absorption",
    "depthFadeDistance",
    "cloudScale",
    "detailScale",
    "detailStrength",
    "windSpeed",
    "tanHalfFov",
    "aspectRatio",
    "marchSteps",
    "lightSteps",
    "cameraPosition",
    "cameraForward",
    "cameraRight",
    "cameraUp",
    "windDirection",
    "sunDirection",
    "sunColor",
    "skyHorizonColor",
    "cloudShadowColor",
    "planetCenter",
    "planetRadius",
  ];
  const samplers = ["depthSampler", "weatherSampler", "volumeNoiseSampler"];
  const engine = scene.getEngine();
  const cloudPass = new PostProcess(
    "Adrift Clouds Raw",
    SHADER_NAME,
    uniforms,
    samplers,
    options.renderScale,
    camera,
    Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
    engine,
  );
  const denoisePass = new PostProcess(
    "Adrift Clouds Denoise",
    DENOISE_SHADER_NAME,
    ["iResolution"],
    [],
    options.renderScale,
    camera,
    Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
    engine,
  );

  const normalized = (v: Vector3, fallback: Vector3): Vector3 => {
    if (v.lengthSquared() < 1e-6) return fallback.clone();
    return v.clone().normalize();
  };

  cloudPass.onApply = (effect) => {
    const forward = normalized(camera.getDirection(forwardAxis), fallbackForward);
    // Right = forward x up (left-handed: x cross y = z, so z cross y = x).
    let right = Vector3.Cross(forward, Vector3.Up());
    if (right.lengthSquared() < 1e-6) right = Vector3.Right();
    else right.normalize();
    const up = Vector3.Cross(right, forward).normalize();
    const wind = normalized(options.windDirection, new Vector3(1, 0, 0.22));
    const fov = "fov" in camera ? (camera.fov as number) : Math.PI / 3;
    effect.setFloat2("iResolution", engine.getRenderWidth(), engine.getRenderHeight());
    effect.setFloat("iTime", (performance.now() - startedAt) / 1000);
    effect.setFloat("cameraMinZ", camera.minZ);
    effect.setFloat("cameraMaxZ", camera.maxZ);
    effect.setFloat("depthIsPacked", depth.isPacked ? 1 : 0);
    effect.setFloat("cloudBaseHeight", options.baseHeight);
    effect.setFloat("cloudThickness", Math.max(options.thickness, 0.01));
    effect.setFloat("coverage", options.coverage);
    effect.setFloat("density", options.density);
    effect.setFloat("absorption", options.absorption);
    effect.setFloat("depthFadeDistance", 2.5);
    effect.setFloat("cloudScale", options.cloudScale);
    effect.setFloat("detailScale", options.detailScale);
    effect.setFloat("detailStrength", options.detailStrength);
    effect.setFloat("windSpeed", options.windSpeed);
    effect.setFloat("tanHalfFov", Math.tan(fov * 0.5));
    effect.setFloat("aspectRatio", engine.getRenderWidth() / Math.max(engine.getRenderHeight(), 1));
    effect.setFloat("marchSteps", Math.max(1, Math.min(128, Math.round(options.marchSteps))));
    effect.setFloat("lightSteps", Math.max(1, Math.min(20, Math.round(options.lightSteps))));
    effect.setTexture("depthSampler", depth.getDepthMap());
    effect.setTexture("weatherSampler", textures.weather);
    effect.setTexture("volumeNoiseSampler", textures.volume);
    effect.setVector3("cameraPosition", camera.globalPosition);
    effect.setVector3("cameraForward", forward);
    effect.setVector3("cameraRight", right);
    effect.setVector3("cameraUp", up);
    effect.setVector3("windDirection", wind);
    effect.setVector3("sunDirection", sunDirection);
    effect.setColor3("sunColor", options.sunColor);
    effect.setColor3("skyHorizonColor", options.skyHorizonColor);
    effect.setColor3("cloudShadowColor", options.cloudShadowColor);
    effect.setVector3("planetCenter", options.center);
    effect.setFloat("planetRadius", options.radius);
  };
  denoisePass.onApply = (effect) => {
    const width = denoisePass.width > 0 ? denoisePass.width : engine.getRenderWidth();
    const height = denoisePass.height > 0 ? denoisePass.height : engine.getRenderHeight();
    effect.setFloat2("iResolution", width, height);
  };

  return {
    options,
    get enabled() {
      return enabled;
    },
    setOptions(patch: CloudVolumePartial): void {
      const scaleChanged = patch.renderScale !== undefined && patch.renderScale !== options.renderScale;
      Object.assign(options, patch);
      if (patch.center) options.center = patch.center.clone();
      if (patch.windDirection) options.windDirection = patch.windDirection.clone();
      if (patch.sunColor) options.sunColor = patch.sunColor.clone();
      if (patch.skyHorizonColor) options.skyHorizonColor = patch.skyHorizonColor.clone();
      if (patch.cloudShadowColor) options.cloudShadowColor = patch.cloudShadowColor.clone();
      if (scaleChanged && enabled) {
        // PostProcess bakes the render scale into its texture size at
        // construction; resize both passes so tier switches take effect.
        const w = Math.max(1, Math.floor(engine.getRenderWidth() * options.renderScale));
        const h = Math.max(1, Math.floor(engine.getRenderHeight() * options.renderScale));
        cloudPass.resize(w, h, camera, false);
        denoisePass.resize(w, h, camera, false);
      }
    },
    setCenter(center: Vector3): void {
      options.center.copyFrom(center);
    },
    setEnabled(next: boolean): void {
      if (next === enabled) return;
      enabled = next;
      if (next) {
        camera.attachPostProcess(cloudPass);
        camera.attachPostProcess(denoisePass);
      } else {
        camera.detachPostProcess(cloudPass);
        camera.detachPostProcess(denoisePass);
      }
    },
    setSunDirection(dir: Vector3): void {
      sunDirection.copyFrom(dir);
    },
    update(dt: number): void {
      elapsed += dt;
      void elapsed;
    },
    dispose(): void {
      camera.detachPostProcess(cloudPass);
      camera.detachPostProcess(denoisePass);
      cloudPass.dispose(camera);
      denoisePass.dispose(camera);
      textures.weather.dispose();
      textures.volume.dispose();
    },
  };
}
