/**
 * Camera rigs. Each produces a camera pose in the *body frame* of the body
 * being visited; the game converts it to render space (floating origin +
 * body rotation) and hands it to the Babylon camera as position + a full
 * rotation quaternion, so the view never depends on a world "up".
 *
 *  - chase:   behind and above the ship, damped, horizon-stable up.
 *  - cockpit: at the pilot's eye, locked to the ship.
 *  - onFoot:  first-person at the player's eye.
 */
import { Quaternion, Vector3 } from "@babylonjs/core";
import { quatFromAxes } from "../sim/shipSim";

export interface CameraPose {
  position: Vector3;
  /** Camera local -> body frame. */
  rotation: Quaternion;
  fov: number;
}

export class ChaseRig {
  private readonly pos = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private initialized = false;
  private fov = 62;

  /** Snap next update (after teleports / mode switches). */
  reset(): void {
    this.initialized = false;
  }

  /** Re-express the damped state in a new body frame (SOI change). */
  transfer(map: (p: Vector3) => Vector3, mapDir: (d: Vector3) => Vector3): void {
    this.pos.copyFrom(map(this.pos));
    this.up.copyFrom(mapDir(this.up));
  }

  update(
    dt: number,
    shipPos: Vector3,
    shipAtt: Quaternion,
    shipVel: Vector3,
    boosting: boolean,
    out: CameraPose,
  ): CameraPose {
    const speed = shipVel.length();
    const boom = 15 + Math.min(8, speed * 0.02);
    const shipUp = new Vector3(0, 1, 0).applyRotationQuaternion(shipAtt);
    const planetUp = shipPos.clone().normalize();
    const back = new Vector3(0, 3.6, -boom).applyRotationQuaternion(shipAtt);
    const want = shipPos.add(back);
    if (!this.initialized) {
      this.pos.copyFrom(want);
      this.up.copyFrom(Vector3.Lerp(planetUp, shipUp, 0.35).normalize());
      this.initialized = true;
    }
    const k = 1 - Math.exp(-7 * dt);
    this.pos.addInPlace(want.subtract(this.pos).scaleInPlace(k));
    // Keep the camera from dipping under the ship's local ground plane too far.
    const upTarget = Vector3.Lerp(planetUp, shipUp, 0.35).normalize();
    this.up.addInPlace(upTarget.subtract(this.up).scaleInPlace(1 - Math.exp(-5 * dt))).normalize();

    const target = shipPos.add(shipVel.scale(0.02));
    const fwd = target.subtract(this.pos).normalize();
    const right = Vector3.Cross(this.up, fwd).normalize();
    const up = Vector3.Cross(fwd, right).normalize();
    out.position.copyFrom(this.pos);
    quatFromAxes(right, up, fwd, out.rotation);
    const targetFov = 62 + Math.min(16, speed * 0.03) + (boosting ? 5 : 0);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-3 * dt));
    out.fov = (this.fov * Math.PI) / 180;
    return out;
  }
}

/** Pilot's eye in ship-local coordinates. */
export const COCKPIT_EYE = new Vector3(0, 0.62, 1.25);

export function cockpitPose(shipPos: Vector3, shipAtt: Quaternion, out: CameraPose): CameraPose {
  out.position.copyFrom(shipPos).addInPlace(COCKPIT_EYE.applyRotationQuaternion(shipAtt));
  out.rotation.copyFrom(shipAtt);
  out.fov = (70 * Math.PI) / 180;
  return out;
}

export function firstPersonPose(eye: Vector3, heading: Vector3, pitch: number, out: CameraPose): CameraPose {
  const up = eye.clone().normalize();
  const fwd = heading
    .scale(Math.cos(pitch))
    .addInPlace(up.scale(Math.sin(pitch)))
    .normalize();
  const right = Vector3.Cross(up, heading).normalize();
  const camUp = Vector3.Cross(fwd, right).normalize();
  out.position.copyFrom(eye);
  quatFromAxes(right, camUp, fwd, out.rotation);
  out.fov = (72 * Math.PI) / 180;
  return out;
}
