import { Constants } from "@babylonjs/core/Engines/constants";
import { DynamicTexture, Mesh, Scene, ShaderMaterial, Vector3 } from "@babylonjs/core";

/**
 * Night-lights + cloud shells for one planet (SRP: sky extras live here,
 * ground + ocean assembly lives in planetSurface.ts). Extracted verbatim
 * from buildPlanetSurface so the visuals are byte-identical.
 */

export interface NightLightsInput {
  seed: number;
  radius: number;
}

export interface NightLights {
  material: ShaderMaterial;
  /** Parents the overlay shell to the ground mesh. */
  attachTo(ground: Mesh): void;
  update(sunDir: Vector3): void;
}

/**
 * Night-side city lights: emissive speckle texture masked to land, shown on
 * the dark side. ShaderMaterial (not StandardMaterial): the emissive-texture
 * define silently stayed unsampled, which rendered a flat warm layer over
 * the whole ocean.
 */
export function buildNightLights(scene: Scene, name: string, input: NightLightsInput): NightLights {
  const size = 512;
  const tex = new DynamicTexture(`${name}-night`, { width: size, height: size }, scene, true);
  const ctx = tex.getContext();
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size, size);
  let s = input.seed;
  const rand = (): number => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  for (let i = 0; i < 2600; i++) {
    const x = rand() * size,
      y = rand() * size;
    const warm = rand();
    ctx.fillStyle = warm > 0.7 ? "rgba(255,190,120,0.9)" : "rgba(255,230,170,0.75)";
    const r = rand() * 1.6 + 0.4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  tex.update();
  tex.hasAlpha = false;
  const nightMat = new ShaderMaterial(
    `${name}-night-mat`,
    scene,
    {
      vertexSource: `
          precision highp float;
          attribute vec3 position;
          attribute vec3 normal;
          attribute vec2 uv;
          uniform mat4 worldViewProjection;
          varying vec2 vUv;
          varying vec3 vN;
          void main() {
            vUv = uv;
            vN = normalize(normal);
            gl_Position = worldViewProjection * vec4(position, 1.0);
          }`,
      fragmentSource: `
          precision highp float;
          varying vec2 vUv;
          varying vec3 vN;
          uniform sampler2D uNightTex;
          uniform vec3 uSunToward;
          uniform float uGlow;
          void main() {
            vec3 up = normalize(vN);
            float day = smoothstep(-0.12, 0.22, dot(up, uSunToward));
            vec3 c = texture2D(uNightTex, vUv).rgb * uGlow * (1.0 - day);
            gl_FragColor = vec4(c, 1.0);
          }`,
    },
    {
      attributes: ["position", "normal", "uv"],
      uniforms: ["worldViewProjection", "uSunToward", "uGlow"],
      samplers: ["uNightTex"],
      needAlphaBlending: true,
      needAlphaTesting: false,
    },
  );
  nightMat.alphaMode = Constants.ALPHA_ADD; // black texels add nothing over the sea
  nightMat.setTexture("uNightTex", tex);
  nightMat.setFloat("uGlow", 1.0);
  nightMat.setVector3("uSunToward", new Vector3(0, 1, 0));
  return {
    material: nightMat,
    attachTo: (ground: Mesh) => {
      // Night lights overlay: slightly larger transparent shell with emissive speckle.
      const night = Mesh.CreateSphere(`${name}-night-shell`, 64, input.radius * 2 * 1.002, scene);
      night.material = nightMat;
      night.parent = ground;
      night.isPickable = false;
    },
    update: (sunDir: Vector3) => {
      // Additive city glow, driven per fragment by the sun's angle (dark side only).
      nightMat.setVector3("uSunToward", sunDir.scale(-1));
    },
  };
}

export interface CloudsInput {
  radius: number;
  relief: number;
  segments: number;
  coverage: number;
}

export interface Clouds {
  mesh: Mesh;
  update(dt: number, sunDir: Vector3): void;
}

/** Cloud deck: separate sphere with procedural FBM alpha shader, slow rotation. */
export function buildClouds(scene: Scene, name: string, input: CloudsInput): Clouds {
  const cloudR = input.radius * (1 + input.relief * 1.6 + 0.004);
  const clouds = Mesh.CreateSphere(`${name}-clouds`, Math.max(48, input.segments >> 1), cloudR * 2, scene);
  const cloudMat = new ShaderMaterial(
    `${name}-cloud-mat`,
    scene,
    {
      vertexSource: `
          precision highp float;
          attribute vec3 position;
          attribute vec3 normal;
          attribute vec2 uv;
          uniform mat4 worldViewProjection;
          uniform mat4 world;
          varying vec3 vNormalW;
          varying vec3 vPosW;
          varying vec2 vUv;
          void main() {
            vec4 wp = world * vec4(position, 1.0);
            vPosW = wp.xyz;
            vNormalW = normalize(mat3(world) * normal);
            vUv = uv;
            gl_Position = worldViewProjection * vec4(position, 1.0);
          }`,
      fragmentSource: `
          precision highp float;
          varying vec3 vNormalW;
          varying vec3 vPosW;
          varying vec2 vUv;
          uniform vec3 sunDirection;
          uniform vec3 cameraPosition;
          uniform float time;
          uniform float coverage;
          uniform vec3 planetCenter;
          float hash(vec3 p) {
            p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
            p *= 17.0;
            return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
          }
          float vnoise(vec3 p) {
            vec3 i = floor(p); vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float n000 = hash(i); float n100 = hash(i + vec3(1,0,0));
            float n010 = hash(i + vec3(0,1,0)); float n110 = hash(i + vec3(1,1,0));
            float n001 = hash(i + vec3(0,0,1)); float n101 = hash(i + vec3(1,0,1));
            float n011 = hash(i + vec3(0,1,1)); float n111 = hash(i + vec3(1,1,1));
            return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
                       mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
          }
          float fbm(vec3 p) {
            float s = 0.0; float a = 0.5;
            for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
            return s;
          }
          void main() {
            vec3 dir = normalize(vPosW - planetCenter);
            vec3 p = dir * 6.0 + vec3(time * 0.004, 0.0, time * 0.002);
            float d = fbm(p + fbm(p * 1.7) * 0.8);
            float alpha = smoothstep(1.0 - coverage - 0.25, 1.0 - coverage + 0.35, d);
            vec3 N = normalize(vNormalW);
            vec3 L = normalize(-sunDirection);
            float ndl = clamp(dot(N, L), 0.0, 1.0);
            float dayMix = smoothstep(-0.18, 0.3, dot(N, L));
            vec3 V = normalize(cameraPosition - vPosW);
            float silver = pow(clamp(dot(reflect(-L, N), V), 0.0, 1.0), 8.0);
            vec3 col = mix(vec3(0.05,0.06,0.09), vec3(1.02,1.0,0.98) * (0.25 + 0.95 * ndl), dayMix);
            col += vec3(1.0, 0.95, 0.9) * silver * 0.35 * dayMix;
            // Fade clouds seen edge-on (just above the deck, or from space): the shell
            // surface must never draw a hard line across the ground.
            float rim = abs(dot(N, V));
            alpha *= mix(0.06, 1.0, smoothstep(0.02, 0.62, rim));
            // ...and thin the deck out toward the night side, where a dark veil over
            // still-lit ground is what reads as a hard terminator edge.
            alpha *= mix(0.2, 1.0, dayMix);
            gl_FragColor = vec4(col, alpha * 0.92);
          }`,
    },
    {
      attributes: ["position", "normal", "uv"],
      uniforms: [
        "world",
        "worldViewProjection",
        "sunDirection",
        "cameraPosition",
        "time",
        "coverage",
        "planetCenter",
      ],
      needAlphaBlending: true,
      needAlphaTesting: false,
    },
  );
  cloudMat.backFaceCulling = false;
  cloudMat.disableDepthWrite = false;
  cloudMat.setFloat("coverage", input.coverage);
  cloudMat.setVector3("planetCenter", new Vector3(0, 0, 0));
  clouds.material = cloudMat;

  let cloudTime = 0;
  return {
    mesh: clouds,
    update: (dt: number, sunDir: Vector3) => {
      clouds.rotation.y += dt * 0.004;
      cloudMat.setVector3("sunDirection", sunDir);
      const cam = scene.activeCamera;
      if (cam) cloudMat.setVector3("cameraPosition", cam.position);
      cloudTime += dt;
      cloudMat.setFloat("time", cloudTime);
    },
  };
}
