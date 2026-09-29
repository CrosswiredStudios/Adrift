/**
 * Sky, aerial perspective and volumetric clouds as one post-process chain,
 * running on the HDR scene colour *before* bloom and tone mapping.
 *
 *   scene ─► [copy] ─► [clouds, low res] ─► [composite, full res] ─► HDR pipeline
 *              │                                 ▲
 *              └────── full-res scene colour ────┘
 *
 * - View rays are rebuilt from the camera's actual basis (right/up/forward
 *   from its world matrix), so a rolled camera stays registered with the
 *   scene.
 * - The clouds are raymarched at reduced resolution into their *own* target
 *   (premultiplied scattering + coverage) and composited at full resolution;
 *   the scene itself is never downsampled.
 * - Depth comes from one scene-wide depth texture (camera-space z, float)
 *   that contains every opaque mesh, so clouds and haze sit correctly in
 *   front of or behind the ship, trees and terrain.
 * - The atmosphere is single-scattered Rayleigh + Mie integrated along each
 *   ray (sky, sunsets, planet limbs from space, haze over distant terrain),
 *   for up to two bodies, with the same model the CPU uses to colour the
 *   sunlight (render/atmosphereModel.ts).
 */
import {
  Camera,
  Color3,
  Constants,
  Effect,
  Engine,
  Matrix,
  PassPostProcess,
  PostProcess,
  RawTexture3D,
  Scene,
  Texture,
  Vector3,
} from "@babylonjs/core";
import { ATMOSPHERE_GLSL, type AtmoParams } from "./atmosphereModel";
import {
  CLOUD_DENSITY_GLSL,
  CloudVolumeData,
  makeVolumeNoiseData,
  parseShadertoyVolume,
  type CloudParams,
} from "./cloudModel";

export const MAX_ATMO_BODIES = 2;

export interface AtmoBodyFrame {
  /** Body centre in render space. */
  center: Vector3;
  params: AtmoParams;
}

export interface CloudFrame {
  /** Body centre in render space. */
  center: Vector3;
  /** Render -> body rotation (3x3, row-major in a Matrix). */
  worldToBody: Matrix;
  params: CloudParams;
  /** Sun direction (toward the sun) in the body frame. */
  sunLocal: Vector3;
  /** Sunlight colour reaching the deck (HDR, already atmosphere-attenuated). */
  sunColor: Color3;
  /** Ambient sky light on the clouds (HDR). */
  ambient: Color3;
  time: number;
}

export interface PlanetaryFrame {
  /** Unit vector toward the star (render space). */
  sunDir: Vector3;
  /** Star illuminance for sky scattering (HDR). */
  sunIlluminance: Color3;
  /** Ordered far -> near. */
  bodies: AtmoBodyFrame[];
  clouds: CloudFrame | null;
}

export type SkyQuality = "ultra" | "high" | "balanced" | "lite";

const QUALITY: Record<SkyQuality, { cloudSteps: number; lightSteps: number; atmoSteps: number }> = {
  ultra: { cloudSteps: 64, lightSteps: 6, atmoSteps: 16 },
  high: { cloudSteps: 48, lightSteps: 5, atmoSteps: 14 },
  balanced: { cloudSteps: 28, lightSteps: 4, atmoSteps: 10 },
  lite: { cloudSteps: 0, lightSteps: 0, atmoSteps: 8 },
};
/** Cloud buffer resolution relative to the screen. */
const CLOUD_SCALE = 0.5;

const CAMERA_GLSL = `
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamFwd;
uniform vec2 uTanHalf; // tan(fov/2) * aspect, tan(fov/2)
uniform sampler2D uDepth;
vec3 viewRay(vec2 uv) {
  vec2 s = uv * 2.0 - 1.0;
  return uCamFwd + uCamRight * (s.x * uTanHalf.x) + uCamUp * (s.y * uTanHalf.y);
}
/** Distance along the (unnormalized) view ray to the scene, or 1e20 for sky. */
float sceneT(vec2 uv, vec3 ray) {
  float z = texture2D(uDepth, uv).r;
  if (z <= 0.0) return 1e20;
  return z * length(ray); // ray has unit forward component
}
float ign(vec2 px) { return fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y)); }
`;

const CLOUD_FRAGMENT = `
precision highp float;
precision highp sampler3D;
varying vec2 vUV;
uniform vec2 uRes;
uniform sampler3D uCloudVol;
uniform vec3 uBodyCenter;
uniform mat4 uWorldToBody;
uniform float uPlanetRadius;
uniform float uCloudBase;
uniform float uCloudThickness;
uniform float uCoverage;
uniform float uExtinction;
uniform float uWindRate;
uniform float uTime;
uniform vec3 uSunLocal;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uSteps;
uniform float uLightSteps;
${CAMERA_GLSL}
${CLOUD_DENSITY_GLSL}

float hg(float mu, float g) {
  float g2 = g * g;
  return 0.0795775 * (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5);
}

bool slab(vec3 o, vec3 d, out float t0, out float t1) {
  float rb = uPlanetRadius + uCloudBase;
  float rt = rb + uCloudThickness;
  float b = dot(o, d);
  float c = dot(o, o) - rt * rt;
  float h = b * b - c;
  if (h < 0.0) return false;
  h = sqrt(h);
  float a0 = -b - h;
  float a1 = -b + h;
  if (a1 <= 0.0) return false;
  float ci = dot(o, o) - rb * rb;
  float hi = b * b - ci;
  t0 = max(a0, 0.0);
  t1 = a1;
  if (hi > 0.0) {
    hi = sqrt(hi);
    float i0 = -b - hi;
    float i1 = -b + hi;
    if (i0 > t0) t1 = min(t1, i0);        // looking down through the deck: stop at the base
    else if (i1 > t0) t0 = max(t0, i1);   // below the deck looking up: start at the base
  }
  return t1 > t0;
}

void main() {
  vec3 ray = viewRay(vUV);
  vec3 dirW = normalize(ray);
  // Conservative scene distance: farthest of 4 subsamples, so thin foreground
  // edges don't cut holes in the low-res cloud buffer.
  vec2 px = 0.5 / uRes;
  float tScene = max(max(sceneT(vUV + vec2(px.x, px.y), ray), sceneT(vUV + vec2(-px.x, px.y), ray)),
                     max(sceneT(vUV + vec2(px.x, -px.y), ray), sceneT(vUV + vec2(-px.x, -px.y), ray)));
  vec3 o = (uWorldToBody * vec4(uCamPos - uBodyCenter, 0.0)).xyz;
  vec3 d = normalize((uWorldToBody * vec4(dirW, 0.0)).xyz);
  float t0;
  float t1;
  vec3 scatter = vec3(0.0);
  float T = 1.0;
  if (uSteps > 0.5 && slab(o, d, t0, t1)) {
    t1 = min(t1, min(tScene, t0 + 6000.0));
    if (t1 > t0) {
      float dt = (t1 - t0) / uSteps;
      float t = t0 + ign(gl_FragCoord.xy) * dt;
      float mu = dot(d, uSunLocal);
      float phase = mix(hg(mu, 0.6), hg(mu, -0.25), 0.25);
      for (int i = 0; i < 96; i++) {
        if (float(i) >= uSteps || T < 0.02) break;
        vec3 p = o + d * t;
        float den = cloudDensity(p);
        if (den > 0.002) {
          // Light march toward the sun through the deck.
          float ld = uCloudThickness / max(uLightSteps, 1.0);
          float od = 0.0;
          for (int j = 0; j < 8; j++) {
            if (float(j) >= uLightSteps) break;
            od += cloudDensity(p + uSunLocal * ld * (float(j) + 0.5)) * ld;
          }
          float lightT = exp(-od * uExtinction) + 0.25 * exp(-od * uExtinction * 0.2);
          float h = clamp((length(p) - uPlanetRadius - uCloudBase) / uCloudThickness, 0.0, 1.0);
          vec3 L = uSunColor * lightT * phase * 6.0 + uAmbient * (0.45 + 0.55 * h);
          float sigma = den * uExtinction;
          float a = 1.0 - exp(-sigma * dt);
          scatter += T * L * a;
          T *= 1.0 - a;
        }
        t += dt;
      }
    }
  }
  gl_FragColor = vec4(scatter, 1.0 - T);
}`;

const COMPOSITE_FRAGMENT = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler; // clouds (premultiplied)
uniform sampler2D uScene;
uniform vec3 uSunDir;
uniform vec3 uSunE;
uniform float uAtmoSteps;
uniform float uCount;
uniform vec3 uCenter[${MAX_ATMO_BODIES}];
uniform vec4 uRadii[${MAX_ATMO_BODIES}];   // groundR, topR, hR, hM
uniform vec4 uBeta[${MAX_ATMO_BODIES}];    // betaR.rgb, betaM
uniform vec2 uMie[${MAX_ATMO_BODIES}];     // betaMExt, g
${CAMERA_GLSL}
${ATMOSPHERE_GLSL}

void atmosphere(int k, vec3 camPos, vec3 dir, float tMax, inout vec3 col) {
  vec3 o = camPos - uCenter[k];
  vec4 R = uRadii[k];
  vec2 top = raySphere(o, dir, R.y);
  if (top.x > top.y || top.y <= 0.0) return;
  float t0 = max(top.x, 0.0);
  float t1 = top.y;
  vec2 g = raySphere(o, dir, R.x);
  if (g.x < g.y && g.x > 0.0) t1 = min(t1, g.x);
  t1 = min(t1, tMax);
  if (t1 <= t0) return;
  vec3 betaR = uBeta[k].rgb;
  float betaM = uBeta[k].a;
  float betaMExt = uMie[k].x;
  float mu = dot(dir, uSunDir);
  float pR = phaseRayleigh(mu);
  float pM = phaseMie(mu, uMie[k].y);
  float dt = (t1 - t0) / uAtmoSteps;
  float odR = 0.0;
  float odM = 0.0;
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  for (int i = 0; i < 24; i++) {
    if (float(i) >= uAtmoSteps) break;
    vec3 p = o + dir * (t0 + (float(i) + 0.5) * dt);
    float h = max(length(p) - R.x, 0.0);
    float dR = exp(-h / R.z) * dt;
    float dM = exp(-h / R.w) * dt;
    odR += dR;
    odM += dM;
    // Sunlight reaching p: blocked by the planet, attenuated by the air above.
    vec2 gs = raySphere(p, uSunDir, R.x);
    if (gs.x < gs.y && gs.x > 0.0) continue;
    vec2 ts = raySphere(p, uSunDir, R.y);
    float ls = ts.y / 4.0;
    float lR = 0.0;
    float lM = 0.0;
    for (int j = 0; j < 4; j++) {
      float hl = max(length(p + uSunDir * ls * (float(j) + 0.5)) - R.x, 0.0);
      lR += exp(-hl / R.z) * ls;
      lM += exp(-hl / R.w) * ls;
    }
    vec3 tau = betaR * (odR + lR) + betaMExt * (odM + lM);
    vec3 att = exp(-tau);
    sumR += att * dR;
    sumM += att * dM;
  }
  vec3 inscatter = uSunE * (sumR * betaR * pR + sumM * betaM * pM);
  vec3 trans = exp(-(betaR * odR + betaMExt * odM));
  col = col * trans + inscatter;
}

void main() {
  vec3 ray = viewRay(vUV);
  vec3 dir = normalize(ray);
  float tScene = sceneT(vUV, ray);
  vec3 col = texture2D(uScene, vUV).rgb;
  // Clouds sit in front of whatever is behind them (their buffer already
  // stopped at the scene depth).
  vec4 cloud = texture2D(textureSampler, vUV);
  col = col * (1.0 - cloud.a) + cloud.rgb;
  for (int k = 0; k < ${MAX_ATMO_BODIES}; k++) {
    if (float(k) >= uCount) break;
    atmosphere(k, uCamPos, dir, tScene, col);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class PlanetaryPass {
  readonly copy: PassPostProcess;
  readonly clouds: PostProcess;
  readonly composite: PostProcess;
  private quality: SkyQuality = "ultra";
  private frame: PlanetaryFrame | null = null;
  private volumeTex: RawTexture3D;
  /** CPU copy of the exact bytes on the GPU (for cloudDensityAt). */
  volume: CloudVolumeData;

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    private readonly depth: () => Texture,
  ) {
    const engine = scene.getEngine() as Engine;
    Effect.ShadersStore["adriftCloudsFragmentShader"] = CLOUD_FRAGMENT;
    Effect.ShadersStore["adriftCompositeFragmentShader"] = COMPOSITE_FRAGMENT;
    const camUniforms = ["uCamPos", "uCamRight", "uCamUp", "uCamFwd", "uTanHalf"];
    const hdr = Constants.TEXTURETYPE_HALF_FLOAT;

    this.volume = new CloudVolumeData(makeVolumeNoiseData(1337));
    this.volumeTex = this.makeVolumeTexture(this.volume);
    void this.loadVolume();

    this.copy = new PassPostProcess(
      "planetary-scene",
      1,
      camera,
      Texture.BILINEAR_SAMPLINGMODE,
      engine,
      false,
      hdr,
    );
    this.clouds = new PostProcess(
      "planetary-clouds",
      "adriftClouds",
      [
        ...camUniforms,
        "uRes",
        "uBodyCenter",
        "uWorldToBody",
        "uPlanetRadius",
        "uCloudBase",
        "uCloudThickness",
        "uCoverage",
        "uExtinction",
        "uWindRate",
        "uTime",
        "uSunLocal",
        "uSunColor",
        "uAmbient",
        "uSteps",
        "uLightSteps",
      ],
      ["uDepth", "uCloudVol"],
      CLOUD_SCALE,
      camera,
      Texture.BILINEAR_SAMPLINGMODE,
      engine,
      false,
      null,
      hdr,
    );
    this.composite = new PostProcess(
      "planetary-composite",
      "adriftComposite",
      [...camUniforms, "uSunDir", "uSunE", "uAtmoSteps", "uCount", "uCenter", "uRadii", "uBeta", "uMie"],
      ["uDepth", "uScene"],
      1,
      camera,
      Texture.BILINEAR_SAMPLINGMODE,
      engine,
      false,
      null,
      hdr,
    );

    this.clouds.onApply = (e) => {
      this.bindCamera(e);
      const f = this.frame?.clouds;
      const q = QUALITY[this.quality];
      e.setFloat2(
        "uRes",
        this.clouds.width || engine.getRenderWidth(),
        this.clouds.height || engine.getRenderHeight(),
      );
      e.setTexture("uDepth", this.depth());
      e.setTexture("uCloudVol", this.volumeTex);
      e.setFloat("uSteps", f ? q.cloudSteps : 0);
      e.setFloat("uLightSteps", q.lightSteps);
      if (!f) return;
      e.setVector3("uBodyCenter", f.center);
      e.setMatrix("uWorldToBody", f.worldToBody);
      e.setFloat("uPlanetRadius", f.params.radius);
      e.setFloat("uCloudBase", f.params.base);
      e.setFloat("uCloudThickness", f.params.thickness);
      e.setFloat("uCoverage", f.params.coverage);
      e.setFloat("uExtinction", f.params.extinction);
      e.setFloat("uWindRate", f.params.windRate);
      e.setFloat("uTime", f.time);
      e.setVector3("uSunLocal", f.sunLocal);
      e.setColor3("uSunColor", f.sunColor);
      e.setColor3("uAmbient", f.ambient);
    };

    const centers = new Float32Array(MAX_ATMO_BODIES * 3);
    const radii = new Float32Array(MAX_ATMO_BODIES * 4);
    const betas = new Float32Array(MAX_ATMO_BODIES * 4);
    const mies = new Float32Array(MAX_ATMO_BODIES * 2);
    this.composite.onApply = (e) => {
      this.bindCamera(e);
      e.setTexture("uDepth", this.depth());
      e.setTextureFromPostProcess("uScene", this.copy);
      const f = this.frame;
      const bodies = f?.bodies ?? [];
      const n = Math.min(bodies.length, MAX_ATMO_BODIES);
      for (let k = 0; k < n; k++) {
        const b = bodies[k];
        centers.set([b.center.x, b.center.y, b.center.z], k * 3);
        radii.set([b.params.groundRadius, b.params.topRadius, b.params.hR, b.params.hM], k * 4);
        betas.set([...b.params.betaR, b.params.betaM], k * 4);
        mies.set([b.params.betaMExt, b.params.mieG], k * 2);
      }
      e.setFloat("uCount", n);
      e.setFloat("uAtmoSteps", QUALITY[this.quality].atmoSteps);
      e.setArray3("uCenter", Array.from(centers));
      e.setArray4("uRadii", Array.from(radii));
      e.setArray4("uBeta", Array.from(betas));
      e.setArray2("uMie", Array.from(mies));
      e.setVector3("uSunDir", f?.sunDir ?? Vector3.Up());
      e.setColor3("uSunE", f?.sunIlluminance ?? Color3.Black());
    };
  }

  private bindCamera(e: Effect): void {
    const cam = this.camera;
    const m = cam.getWorldMatrix();
    const right = Vector3.TransformNormal(Vector3.Right(), m).normalize();
    const up = Vector3.TransformNormal(Vector3.Up(), m).normalize();
    const fwd = Vector3.TransformNormal(Vector3.Forward(), m).normalize();
    const engine = this.scene.getEngine();
    const aspect = engine.getRenderWidth() / Math.max(1, engine.getRenderHeight());
    const t = Math.tan(cam.fov * 0.5);
    e.setVector3("uCamPos", cam.globalPosition);
    e.setVector3("uCamRight", right);
    e.setVector3("uCamUp", up);
    e.setVector3("uCamFwd", fwd);
    e.setFloat2("uTanHalf", t * aspect, t);
  }

  private makeVolumeTexture(v: CloudVolumeData): RawTexture3D {
    const tex = new RawTexture3D(
      v.data,
      v.size,
      v.size,
      v.size,
      Constants.TEXTUREFORMAT_RED,
      this.scene,
      false,
      false,
      Texture.TRILINEAR_SAMPLINGMODE,
      Constants.TEXTURETYPE_UNSIGNED_BYTE,
    );
    tex.wrapU = tex.wrapV = tex.wrapR = Texture.WRAP_ADDRESSMODE;
    tex.name = "cloud-volume";
    return tex;
  }

  private async loadVolume(): Promise<void> {
    try {
      const res = await fetch("/textures/clouds/greyNoise3D.bin");
      if (!res.ok) throw new Error(String(res.status));
      const { size, data } = parseShadertoyVolume(await res.arrayBuffer());
      const next = new CloudVolumeData(data, size);
      const tex = this.makeVolumeTexture(next);
      this.volumeTex.dispose();
      this.volumeTex = tex;
      this.volume = next;
    } catch {
      // Keep the procedural volume: CPU and GPU still share the same bytes.
    }
  }

  setQuality(q: SkyQuality): void {
    // Step counts only: the cloud buffer keeps its fixed half resolution
    // (a PostProcess ratio can't be changed after creation).
    this.quality = q;
  }

  update(frame: PlanetaryFrame): void {
    this.frame = frame;
  }
}
