
const {
  Camera,
  Constants,
  Color3,
  Vector3,
  Effect,
  RawTexture,
  RawTexture3D,
  Texture,
  PostProcess,
  Scene,
  SkyMaterial
} = BABYLON

export interface VolumetricCloudOptions {
  enabled: boolean;
  weatherTextureUrl: string | null;
  volumeNoiseUrl: string | null;
  renderScale: number;
  cloudBaseHeight: number;
  cloudThickness: number;
  coverage: number;
  density: number;
  absorption: number;
  depthFadeDistance: number;
  cloudScale: number;
  detailScale: number;
  detailStrength: number;
  windDirection: Vector3;
  windSpeed: number;
  marchSteps: number;
  lightSteps: number;
  sunColor: Color3;
  skyHorizonColor: Color3;
  cloudShadowColor: Color3;
}

export type VolumetricCloudPluginOptions = Partial<VolumetricCloudOptions>;

const SHADER_NAME = 'VolumetricClouds';
const DENOISE_SHADER_NAME = 'VolumetricCloudsDenoise';
const SHADERTOY_WEATHER_TEXTURE_URL =
  '/clouds/pebbles.png';
const SHADERTOY_GREY_NOISE_3D_URL =
  '/clouds/greyNoise3D.bin';

const DEFAULT_OPTIONS: VolumetricCloudOptions = {
  enabled: true,
  weatherTextureUrl: SHADERTOY_WEATHER_TEXTURE_URL,
  volumeNoiseUrl: SHADERTOY_GREY_NOISE_3D_URL,
  renderScale: 0.82,
  cloudBaseHeight: 30,
  cloudThickness: 30,
  coverage: 0.78,
  density: 0.4,
  absorption: 0.34,
  depthFadeDistance: 2.5,
  cloudScale: 1,
  detailScale: 1,
  detailStrength: 0.2,
  windDirection: new Vector3(1, 0, 0.22),
  windSpeed: 3,
  marchSteps: 112,
  lightSteps: 16,
  sunColor: new Color3(1, 0.88, 0.58),
  skyHorizonColor: new Color3(0.74, 0.9, 1),
  cloudShadowColor: new Color3(0.36, 0.43, 0.56),
};

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
    vec4 depthSample = texture(depthSampler, uv);
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
  
  // Adapted from Shadertoy 4dSBDt bufferA: weather-map driven cloud density.
  // The original samples iChannel0/iChannel2; this plugin keeps the same shape
  // logic but generates both weather and volume noise procedurally.
  float weatherMap(vec2 p) {
    return texture(weatherSampler, p).x;
  }
  
  float shaderToyMeterScale() {
    return 600.0 / max(cloudThickness, 0.001);
  }
  
  vec3 toShaderToyCloudPoint(vec3 p, float height01) {
    float meterScale = shaderToyMeterScale();
    return vec3(p.x * meterScale, 800.0 + height01 * 600.0, p.z * meterScale);
  }
  
  float cloudDensity(vec3 p) {
    float h = clamp((p.y - cloudBaseHeight) / max(cloudThickness, 0.001), 0.0, 1.0);
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
  
  bool intersectCloudSlab(vec3 ro, vec3 rd, out float tNear, out float tFar) {
    float y0 = cloudBaseHeight;
    float y1 = cloudBaseHeight + cloudThickness;
    if (abs(rd.y) < 0.0001) {
      tNear = 0.0;
      tFar = 0.0;
      return ro.y >= y0 && ro.y <= y1;
    }
    float t0 = (y0 - ro.y) / rd.y;
    float t1 = (y1 - ro.y) / rd.y;
    tNear = min(t0, t1);
    tFar = max(t0, t1);
    tNear = max(tNear, 0.0);
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
    vec3 sceneColor = texture(textureSampler, vUV).rgb;
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
      float maxDistance = min(min(tFar, 240.0), farthestSceneDistance);
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
          float height01 = clamp((p.y - cloudBaseHeight) / max(cloudThickness, 0.001), 0.0, 1.0);
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
  
  vec3 YCoCgToRGB(vec3 ycocg) {
    float y = ycocg.x;
    float co = ycocg.y - (0.5 * 256.0 / 255.0);
    float cg = ycocg.z - (0.5 * 256.0 / 255.0);
    return vec3(y + co - cg, y + cg, y - co - cg);
  }
  
  vec4 sampleColor(vec2 offset) {
    return texture(textureSampler, vUV + offset / iResolution);
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
    vec4 center = texture(textureSampler, vUV);
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

function cloneOptions(options: VolumetricCloudPluginOptions = {}): VolumetricCloudOptions {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    windDirection: (options.windDirection ?? DEFAULT_OPTIONS.windDirection).clone(),
    sunColor: (options.sunColor ?? DEFAULT_OPTIONS.sunColor).clone(),
    skyHorizonColor: (options.skyHorizonColor ?? DEFAULT_OPTIONS.skyHorizonColor).clone(),
    cloudShadowColor: (options.cloudShadowColor ?? DEFAULT_OPTIONS.cloudShadowColor).clone(),
  };
}

function normalized(value: Vector3, fallback: Vector3): Vector3 {
  if (value.lengthSquared() < 0.000001) {
    return fallback.clone();
  }
  return value.clone().normalize();
}

export class VolumetricCloudsPlugin {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly skyMaterial: SkyMaterial;
  readonly postProcess: PostProcess;
  readonly options: VolumetricCloudOptions;

  private readonly startedAt = performance.now();
  private readonly fallbackForward = new Vector3(0, 0, 1);
  private readonly cameraForwardAxis = new Vector3(0, 0, 1);
  private readonly worldUp = Vector3.Up();
  private readonly cloudPostProcess: PostProcess;
  private readonly denoisePostProcess: PostProcess;
  private readonly depthRenderer;
  private weatherTexture: Texture;
  private volumeNoiseTexture: RawTexture3D;
  private isAttached = true;

  constructor(scene: Scene, camera: Camera, skyMaterial: SkyMaterial, options: VolumetricCloudPluginOptions = {}) {
    this.scene = scene;
    this.camera = camera;
    this.skyMaterial = skyMaterial;
    this.options = cloneOptions(options);
    this.weatherTexture = this.createFallbackWeatherTexture();
    this.volumeNoiseTexture = this.createVolumeNoiseTexture(new Uint8Array([128]), 1, 1, 1);
    this.depthRenderer = scene.enableDepthRenderer(camera, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
    this.depthRenderer.useOnlyInActiveCamera = true;

    this.cloudPostProcess = new PostProcess(
      'Volumetric Clouds Raw',
      SHADER_NAME,
      [
        'iResolution',
        'iTime',
        'cameraMinZ',
        'cameraMaxZ',
        'depthIsPacked',
        'cloudBaseHeight',
        'cloudThickness',
        'coverage',
        'density',
        'absorption',
        'depthFadeDistance',
        'cloudScale',
        'detailScale',
        'detailStrength',
        'windSpeed',
        'tanHalfFov',
        'aspectRatio',
        'marchSteps',
        'lightSteps',
        'cameraPosition',
        'cameraForward',
        'cameraRight',
        'cameraUp',
        'windDirection',
        'sunDirection',
        'sunColor',
        'skyHorizonColor',
        'cloudShadowColor',
      ],
      ['depthSampler', 'weatherSampler', 'volumeNoiseSampler'],
      this.options.renderScale,
      camera,
      Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      scene.getEngine(),
    );
    this.denoisePostProcess = new PostProcess(
      'Volumetric Clouds Spatial Denoise',
      DENOISE_SHADER_NAME,
      ['iResolution'],
      [],
      this.options.renderScale,
      camera,
      Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      scene.getEngine(),
    );
    this.postProcess = this.denoisePostProcess;

    this.cloudPostProcess.onApply = (effect) => {
      this.applyUniforms(effect);
    };
    this.denoisePostProcess.onApply = (effect) => {
      this.applyDenoiseUniforms(effect);
    };
    this.setEnabled(this.options.enabled);
    this.loadWeatherTexture(this.options.weatherTextureUrl);
    void this.loadVolumeNoiseTexture(this.options.volumeNoiseUrl);
  }

  setOptions(options: VolumetricCloudPluginOptions): void {
    Object.assign(this.options, options);
    if (options.windDirection) {
      this.options.windDirection = options.windDirection.clone();
    }
    if (options.sunColor) {
      this.options.sunColor = options.sunColor.clone();
    }
    if (options.skyHorizonColor) {
      this.options.skyHorizonColor = options.skyHorizonColor.clone();
    }
    if (options.cloudShadowColor) {
      this.options.cloudShadowColor = options.cloudShadowColor.clone();
    }
    if (options.weatherTextureUrl !== undefined) {
      this.options.weatherTextureUrl = options.weatherTextureUrl;
      this.loadWeatherTexture(options.weatherTextureUrl);
    }
    if (options.volumeNoiseUrl !== undefined) {
      this.options.volumeNoiseUrl = options.volumeNoiseUrl;
      void this.loadVolumeNoiseTexture(options.volumeNoiseUrl);
    }
    if (options.enabled !== undefined) {
      this.setEnabled(options.enabled);
    }
  }

  setEnabled(enabled: boolean): void {
    this.options.enabled = enabled;
    if (enabled && !this.isAttached) {
      this.camera.attachPostProcess(this.cloudPostProcess);
      this.camera.attachPostProcess(this.denoisePostProcess);
      this.isAttached = true;
      return;
    }
    if (!enabled && this.isAttached) {
      this.camera.detachPostProcess(this.cloudPostProcess);
      this.camera.detachPostProcess(this.denoisePostProcess);
      this.isAttached = false;
    }
  }

  dispose(): void {
    if (this.isAttached) {
      this.camera.detachPostProcess(this.cloudPostProcess);
      this.camera.detachPostProcess(this.denoisePostProcess);
      this.isAttached = false;
    }
    this.cloudPostProcess.dispose(this.camera);
    this.denoisePostProcess.dispose(this.camera);
    this.weatherTexture.dispose();
    this.volumeNoiseTexture.dispose();
  }

  private createFallbackWeatherTexture(): RawTexture {
    const data = new Uint8Array([
      168, 210,
      232, 188,
    ]);
    const texture = RawTexture.CreateLuminanceTexture(
      data,
      2,
      2,
      this.scene,
      false,
      false,
      Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
    );
    texture.name = 'Fallback weather texture';
    texture.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
    texture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    return texture;
  }

  private loadWeatherTexture(url: string | null): void {
    if (!url) {
      return;
    }

    const previousTexture = this.weatherTexture;
    const texture = new Texture(
      url,
      this.scene,
      false,
      false,
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
      () => {
        previousTexture.dispose();
      },
      (_message, exception) => {
        console.error(`Failed to load volumetric cloud weather texture from ${url}.`, exception);
        texture.dispose();
      },
    );
    texture.name = 'Shadertoy weather texture';
    texture.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
    texture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    texture.updateSamplingMode(Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
    this.weatherTexture = texture;
  }

  private createVolumeNoiseTexture(data: Uint8Array, width: number, height: number, depth: number): RawTexture3D {
    const texture = new RawTexture3D(
      data,
      width,
      height,
      depth,
      Constants.TEXTUREFORMAT_RED,
      this.scene,
      false,
      false,
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    texture.name = 'Shadertoy Grey noise3D';
    texture.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
    texture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
    texture.wrapR = Constants.TEXTURE_WRAP_ADDRESSMODE;
    texture.updateSamplingMode(Constants.TEXTURE_TRILINEAR_SAMPLINGMODE);
    return texture;
  }

  private async loadVolumeNoiseTexture(url: string | null): Promise<void> {
    if (!url) {
      return;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const buffer = await response.arrayBuffer();
      const view = new DataView(buffer);
      const signature = String.fromCharCode(
        view.getUint8(0),
        view.getUint8(1),
        view.getUint8(2),
        view.getUint8(3),
      );
      if (signature !== 'BIN\n' && signature !== 'BIN\0') {
        throw new Error('Invalid Shadertoy volume header.');
      }

      const width = view.getInt32(4, true);
      const height = view.getInt32(8, true);
      const depth = view.getInt32(12, true);
      const channels = view.getInt32(16, true);
      if (width <= 0 || height <= 0 || depth <= 0 || channels !== 1) {
        throw new Error(`Unsupported Shadertoy volume size ${width}x${height}x${depth}x${channels}.`);
      }

      const byteLength = width * height * depth * channels;
      const headerLength = 20;
      if (buffer.byteLength < headerLength + byteLength) {
        throw new Error('Shadertoy volume file is truncated.');
      }

      const data = new Uint8Array(buffer, headerLength, byteLength);
      const nextTexture = this.createVolumeNoiseTexture(data, width, height, depth);
      const previousTexture = this.volumeNoiseTexture;
      this.volumeNoiseTexture = nextTexture;
      previousTexture.dispose();
    } catch (error) {
      console.error(`Failed to load volumetric cloud noise texture from ${url}.`, error);
    }
  }

  private applyDenoiseUniforms(effect: Effect): void {
    const engine = this.scene.getEngine();
    const width = this.denoisePostProcess.width > 0 ? this.denoisePostProcess.width : engine.getRenderWidth();
    const height = this.denoisePostProcess.height > 0 ? this.denoisePostProcess.height : engine.getRenderHeight();

    effect.setFloat2('iResolution', width, height);
  }

  private applyUniforms(effect: Effect): void {
    const engine = this.scene.getEngine();
    const forward = normalized(this.camera.getDirection(this.cameraForwardAxis), this.fallbackForward);
    let right = Vector3.Cross(this.worldUp, forward);
    if (right.lengthSquared() < 0.000001) {
      right = Vector3.Right();
    } else {
      right.normalize();
    }
    const up = Vector3.Cross(forward, right).normalize();
    const sunDirection = normalized(this.skyMaterial.sunPosition, new Vector3(0.6, 0.45, -0.8));
    const windDirection = normalized(this.options.windDirection, DEFAULT_OPTIONS.windDirection);
    const fov = 'fov' in this.camera ? this.camera.fov : Math.PI / 3;

    effect.setFloat2('iResolution', engine.getRenderWidth(), engine.getRenderHeight());
    effect.setFloat('iTime', (performance.now() - this.startedAt) / 1000);
    effect.setFloat('cameraMinZ', this.camera.minZ);
    effect.setFloat('cameraMaxZ', this.camera.maxZ);
    effect.setFloat('depthIsPacked', this.depthRenderer.isPacked ? 1 : 0);
    effect.setFloat('cloudBaseHeight', this.options.cloudBaseHeight);
    effect.setFloat('cloudThickness', Math.max(this.options.cloudThickness, 0.01));
    effect.setFloat('coverage', this.options.coverage);
    effect.setFloat('density', this.options.density);
    effect.setFloat('absorption', this.options.absorption);
    effect.setFloat('depthFadeDistance', Math.max(0.01, this.options.depthFadeDistance));
    effect.setFloat('cloudScale', this.options.cloudScale);
    effect.setFloat('detailScale', this.options.detailScale);
    effect.setFloat('detailStrength', this.options.detailStrength);
    effect.setFloat('windSpeed', this.options.windSpeed);
    effect.setFloat('tanHalfFov', Math.tan(fov * 0.5));
    effect.setFloat('aspectRatio', engine.getRenderWidth() / Math.max(engine.getRenderHeight(), 1));
    effect.setFloat('marchSteps', Math.max(1, Math.min(128, Math.round(this.options.marchSteps))));
    effect.setFloat('lightSteps', Math.max(1, Math.min(20, Math.round(this.options.lightSteps))));
    effect.setTexture('depthSampler', this.depthRenderer.getDepthMap());
    effect.setTexture('weatherSampler', this.weatherTexture);
    effect.setTexture('volumeNoiseSampler', this.volumeNoiseTexture);
    effect.setVector3('cameraPosition', this.camera.globalPosition);
    effect.setVector3('cameraForward', forward);
    effect.setVector3('cameraRight', right);
    effect.setVector3('cameraUp', up);
    effect.setVector3('windDirection', windDirection);
    effect.setVector3('sunDirection', sunDirection);
    effect.setColor3('sunColor', this.options.sunColor);
    effect.setColor3('skyHorizonColor', this.options.skyHorizonColor);
    effect.setColor3('cloudShadowColor', this.options.cloudShadowColor);
  }
}



