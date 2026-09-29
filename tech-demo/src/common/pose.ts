import { Quaternion, Vector3 } from "@babylonjs/core";

/**
 * Position + orientation of a simulated object. The simulation owns poses;
 * meshes only copy (and interpolate) them for rendering, so physics never
 * depends on the scene graph.
 */
export interface Pose {
  position: Vector3;
  rotationQuaternion: Quaternion;
}

export function makePose(position = Vector3.Zero(), rotation = Quaternion.Identity()): Pose {
  return { position: position.clone(), rotationQuaternion: rotation.clone() };
}

export function copyPose(from: Pose, to: Pose): void {
  to.position.copyFrom(from.position);
  to.rotationQuaternion.copyFrom(from.rotationQuaternion);
}

/** Interpolate two poses into `out` (lerp position, slerp rotation). */
export function lerpPose(a: Pose, b: Pose, t: number, out: Pose): void {
  Vector3.LerpToRef(a.position, b.position, t, out.position);
  Quaternion.SlerpToRef(a.rotationQuaternion, b.rotationQuaternion, t, out.rotationQuaternion);
}
