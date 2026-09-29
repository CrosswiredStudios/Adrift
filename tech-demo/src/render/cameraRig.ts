/**
 * Camera rigs. Each produces a camera pose in the *body frame* of the body
 * being visited; the game converts it to render space (floating origin +
 * body rotation) and hands it to the Babylon camera as position + a full
 * rotation quaternion, so the view never depends on a world "up".
 *
 *  - chase:   behind and above the ship on a boom that follows its attitude.
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
  /** Damped copy of the ship's attitude (body frame). */
  private readonly att = Quaternion.Identity();
  private initialized = false;
  private fov = 62;

  /** Snap next update (after teleports / mode switches / SOI changes). */
  reset(): void {
    this.initialized = false;
  }

  /**
   * The camera rides on a boom fixed to a slightly lagged copy of the ship's
   * attitude, so it sits the same distance behind the ship at any speed (no
   * trailing along the velocity) and its up is the ship's up (no horizon
   * lock that could flip when you point at a planet). Same feel on the
   * ground and in space.
   */
  update(
    dt: number,
    shipPos: Vector3,
    shipAtt: Quaternion,
    shipVel: Vector3,
    boosting: boolean,
    out: CameraPose,
  ): CameraPose {
    if (!this.initialized) {
      this.att.copyFrom(shipAtt);
      this.initialized = true;
    }
    Quaternion.SlerpToRef(this.att, shipAtt, 1 - Math.exp(-8 * dt), this.att);
    this.att.normalize();
    const boom = CHASE_BOOM.applyRotationQuaternion(this.att);
    out.position.copyFrom(shipPos).addInPlace(boom);
    // Aim a little above the ship so it sits just below the centre of view.
    const fwd = shipPos
      .add(CHASE_AIM.applyRotationQuaternion(this.att))
      .subtractInPlace(out.position)
      .normalize();
    const upHint = Vector3.Up().applyRotationQuaternion(this.att);
    const right = Vector3.Cross(upHint, fwd).normalize();
    const up = Vector3.Cross(fwd, right).normalize();
    quatFromAxes(right, up, fwd, out.rotation);
    const speed = shipVel.length();
    const targetFov = 62 + Math.min(8, speed * 0.02) + (boosting ? 5 : 0);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-3 * dt));
    out.fov = (this.fov * Math.PI) / 180;
    return out;
  }
}

/** Chase boom (ship-local offset of the camera) and aim point. */
export const CHASE_BOOM = new Vector3(0, 3.6, -15);
const CHASE_AIM = new Vector3(0, 1.6, 20);

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
