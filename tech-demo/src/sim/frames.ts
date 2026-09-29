/**
 * Reference-frame transforms between the inertial frame and a body's
 * rotating body-fixed frame (see celestial.ts for the conventions).
 *
 *   r_I = P + R r_B
 *   v_I = V + w_I x (R r_B) + R v_B
 *
 * where P, V are the body's inertial position/velocity, R its orientation
 * (body -> inertial) and w_I its angular velocity in inertial axes.
 *
 * The ship, the player and everything else that moves are simulated in the
 * body-fixed frame of their dominant body, so ground contact is trivial
 * (the terrain is static there) and a landed ship rides the planet's spin
 * for free. When the dominant body changes, the state is carried across
 * exactly through the inertial frame.
 */
import { Quaternion, Vector3 } from "@babylonjs/core";
import type { CelestialBody } from "./celestial";

export interface BodyFrameSnapshot {
  body: CelestialBody;
  t: number;
  position: Vector3;
  velocity: Vector3;
  rotation: Quaternion;
  rotationInv: Quaternion;
  angularVelocity: Vector3;
}

/** Evaluate a body's frame once for time t (reuse for many transforms). */
export function snapshotFrame(body: CelestialBody, t: number, out?: BodyFrameSnapshot): BodyFrameSnapshot {
  const f = out ?? {
    body,
    t,
    position: new Vector3(),
    velocity: new Vector3(),
    rotation: new Quaternion(),
    rotationInv: new Quaternion(),
    angularVelocity: new Vector3(),
  };
  f.body = body;
  f.t = t;
  body.positionAt(t, f.position);
  body.velocityAt(t, f.velocity);
  body.rotationAt(t, f.rotation);
  Quaternion.InverseToRef(f.rotation, f.rotationInv);
  body.angularVelocityInertial(f.angularVelocity);
  return f;
}

const tmpA = new Vector3();
const tmpB = new Vector3();

/** Body-fixed position -> inertial position. */
export function pointToInertial(f: BodyFrameSnapshot, rB: Vector3, out = new Vector3()): Vector3 {
  rB.applyRotationQuaternionToRef(f.rotation, out);
  return out.addInPlace(f.position);
}

/** Inertial position -> body-fixed position. */
export function pointToBody(f: BodyFrameSnapshot, rI: Vector3, out = new Vector3()): Vector3 {
  rI.subtractToRef(f.position, tmpA);
  return tmpA.applyRotationQuaternionToRef(f.rotationInv, out);
}

/** Body-fixed direction -> inertial direction (rotation only). */
export function dirToInertial(f: BodyFrameSnapshot, dB: Vector3, out = new Vector3()): Vector3 {
  return dB.applyRotationQuaternionToRef(f.rotation, out);
}

/** Inertial direction -> body-fixed direction (rotation only). */
export function dirToBody(f: BodyFrameSnapshot, dI: Vector3, out = new Vector3()): Vector3 {
  return dI.applyRotationQuaternionToRef(f.rotationInv, out);
}

/** Body-fixed state -> inertial velocity. */
export function velocityToInertial(
  f: BodyFrameSnapshot,
  rB: Vector3,
  vB: Vector3,
  out = new Vector3(),
): Vector3 {
  rB.applyRotationQuaternionToRef(f.rotation, tmpA); // R r_B
  Vector3.CrossToRef(f.angularVelocity, tmpA, tmpB); // w x R r_B
  vB.applyRotationQuaternionToRef(f.rotation, out); // R v_B
  return out.addInPlace(tmpB).addInPlace(f.velocity);
}

/** Inertial state -> body-fixed velocity. */
export function velocityToBody(f: BodyFrameSnapshot, rI: Vector3, vI: Vector3, out = new Vector3()): Vector3 {
  rI.subtractToRef(f.position, tmpA); // relative position (inertial axes)
  Vector3.CrossToRef(f.angularVelocity, tmpA, tmpB); // w x r
  vI.subtractToRef(f.velocity, out).subtractInPlace(tmpB);
  return out.applyRotationQuaternionToRef(f.rotationInv, out);
}

/** Body-fixed attitude -> inertial attitude. */
export function attitudeToInertial(f: BodyFrameSnapshot, qB: Quaternion, out = new Quaternion()): Quaternion {
  return f.rotation.multiplyToRef(qB, out);
}

/** Inertial attitude -> body-fixed attitude. */
export function attitudeToBody(f: BodyFrameSnapshot, qI: Quaternion, out = new Quaternion()): Quaternion {
  return f.rotationInv.multiplyToRef(qI, out);
}

/**
 * Re-express a body-fixed state in another body's frame (SOI change).
 * Position, velocity and attitude are exact; nothing is integrated.
 */
export function transferState(
  from: BodyFrameSnapshot,
  to: BodyFrameSnapshot,
  pos: Vector3,
  vel: Vector3,
  att: Quaternion,
): void {
  const rI = pointToInertial(from, pos, new Vector3());
  const vI = velocityToInertial(from, pos, vel, new Vector3());
  const qI = attitudeToInertial(from, att, new Quaternion());
  pointToBody(to, rI, pos);
  velocityToBody(to, rI, vI, vel);
  attitudeToBody(to, qI, att);
}

/**
 * Acceleration felt in a body's rotating frame: point-mass gravity of that
 * body plus the Coriolis and centrifugal terms of the frame's spin.
 * `w` is the frame angular velocity in body axes (0, spinRate, 0).
 */
export function bodyFrameAcceleration(
  mu: number,
  spinRate: number,
  r: Vector3,
  v: Vector3,
  out = new Vector3(),
): Vector3 {
  const d2 = r.lengthSquared();
  const d = Math.sqrt(d2);
  const g = d > 1e-6 ? -mu / (d2 * d) : 0;
  out.copyFrom(r).scaleInPlace(g);
  if (spinRate !== 0) {
    const w = spinRate;
    // Coriolis: -2 w x v with w = (0, w, 0): w x v = (w*vz, 0, -w*vx)
    out.x += -2 * w * v.z;
    out.z += 2 * w * v.x;
    // Centrifugal: -w x (w x r) = w^2 (rx, 0, rz)
    out.x += w * w * r.x;
    out.z += w * w * r.z;
  }
  return out;
}
