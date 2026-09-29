/**
 * Scene lighting driven by the real star and the air around the camera.
 *
 * - Sun: a directional light aimed from the star to the camera, coloured
 *   and dimmed by the same atmosphere model the sky pass draws (red
 *   sunsets, nothing below the horizon: the planet blocks it).
 * - Sky fill: a hemispheric light whose "up" is the local vertical of the
 *   body the camera is on, tinted by the scattered sky while it is day,
 *   fading to faint starlight at night or in space.
 */
import { Color3, DirectionalLight, HemisphericLight, Scene, Vector3 } from "@babylonjs/core";
import { sunTransmittance, type AtmoParams } from "./atmosphereModel";

export const STARLIGHT = new Color3(0.3, 0.38, 0.52);

export interface LightingInput {
  /** Unit vector toward the star (render space = inertial axes). */
  toSun: Vector3;
  /** Local up at the camera (render space), or null in deep space. */
  up: Vector3 | null;
  /** Atmosphere of the body the camera is in/near, with the camera position relative to its centre. */
  atmo: { params: AtmoParams; camRel: Vector3; skyColor: Color3 } | null;
  /** Star colour and base intensity. */
  starColor: Color3;
  starIntensity: number;
}

export interface LightingState {
  /** 0..1 how much of the sun reaches the camera (after air + planet shadow). */
  sunVisibility: number;
  /** Sun elevation at the camera (-1..1 as sin), 1 in space. */
  sunElevation: number;
  /** 0..1 sky brightness around the camera (hides stars). */
  skyBrightness: number;
  sunColor: Color3;
  ambient: Color3;
}

export class Lighting {
  readonly sun: DirectionalLight;
  readonly hemi: HemisphericLight;
  readonly state: LightingState = {
    sunVisibility: 1,
    sunElevation: 1,
    skyBrightness: 0,
    sunColor: new Color3(1, 1, 1),
    ambient: STARLIGHT.clone(),
  };

  constructor(scene: Scene) {
    this.hemi = new HemisphericLight("sky-fill", new Vector3(0, 1, 0), scene);
    this.hemi.intensity = 0.15;
    this.hemi.diffuse = STARLIGHT.clone();
    this.hemi.groundColor = new Color3(0.02, 0.025, 0.035);
    this.hemi.specular = Color3.Black();
    this.sun = new DirectionalLight("sun", new Vector3(0, -1, 0), scene);
    this.sun.intensity = 3;
  }

  update(i: LightingInput): LightingState {
    const s = this.state;
    this.sun.direction.copyFrom(i.toSun).scaleInPlace(-1);
    let T: [number, number, number] = [1, 1, 1];
    s.sunElevation = i.up ? Vector3.Dot(i.up, i.toSun) : 1;
    let sky = 0;
    if (i.atmo) {
      const p = i.atmo.camRel;
      T = sunTransmittance(i.atmo.params, p.x, p.y, p.z, i.toSun.x, i.toSun.y, i.toSun.z);
      const alt = p.length() - i.atmo.params.groundRadius;
      const thick = Math.exp(-Math.max(alt, 0) / (i.atmo.params.hR * 1.6));
      // Sky brightness follows the sun's height (soft through twilight).
      const day = smooth(-0.12, 0.25, s.sunElevation);
      sky = thick * day;
    }
    s.skyBrightness = sky;
    const vis = (T[0] + T[1] + T[2]) / 3;
    s.sunVisibility = vis;
    s.sunColor.set(i.starColor.r * T[0], i.starColor.g * T[1], i.starColor.b * T[2]);
    this.sun.diffuse.copyFrom(s.sunColor);
    this.sun.specular.copyFrom(s.sunColor);
    this.sun.intensity = i.starIntensity;
    this.sun.setEnabled(vis > 0.002);

    // Ambient: scattered sky colour by day, faint starlight at night / in space.
    if (i.up) this.hemi.direction.copyFrom(i.up);
    const skyTint = i.atmo ? i.atmo.skyColor : STARLIGHT;
    const twilight = i.atmo ? smooth(0.35, 0.0, Math.abs(s.sunElevation)) * Math.min(1, sky + 0.2) : 0;
    const ambient = Color3.Lerp(STARLIGHT, skyTint, Math.min(1, sky));
    ambient.addInPlace(new Color3(1.0, 0.6, 0.38).scale(twilight * 0.35));
    s.ambient.copyFrom(ambient);
    this.hemi.diffuse.copyFrom(ambient);
    this.hemi.intensity = 0.12 + sky * 0.55 + twilight * 0.25;
    return s;
  }
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
