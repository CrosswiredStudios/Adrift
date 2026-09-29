/**
 * Smooth chase camera. Damped position boom, roll-damped horizon-stable up
 * vector (banking no longer whips the world around), time-based atmospheric
 * shake, and speed-driven FOV kick.
 */
import { FreeCamera, Quaternion, Vector3 } from "@babylonjs/core";
import type { Pose } from "../common/pose";
import { IWorldBody, nearestWorldBody } from "../world/worldBody";
import type { FlightState } from "../flight/flight";
import { clamp } from "../common/math";

export interface CameraRig {
  camera: FreeCamera;
  update(dt: number): void;
}

export function createCameraRig<T extends IWorldBody>(
  camera: FreeCamera,
  ship: Pose,
  state: FlightState,
  bodies: T[],
  isBoosting: () => boolean,
  spawnUp: Vector3,
): CameraRig {
  const rot0 = ship.rotationQuaternion ?? Quaternion.Identity();
  const camPos = ship.position.add(new Vector3(0, 3.4, -13).applyRotationQuaternion(rot0));
  camera.position.copyFrom(camPos);
  const camUp = spawnUp.clone();
  let camFov = 60;
  camera.fov = (camFov / 180) * Math.PI;

  const clamp1 = (v: number): number => clamp(v, -1, 1);

  return {
    camera,
    update(dt: number): void {
      const rot = ship.rotationQuaternion ?? Quaternion.Identity();
      const speed = state.velocity.length();

      // Damped boom that eases out a little with speed.
      const boom = 13 + Math.min(6, speed * 0.008);
      const back = new Vector3(0, 3.4, -boom).applyRotationQuaternion(rot);
      camPos.copyFrom(Vector3.Lerp(camPos, ship.position.add(back), 1 - Math.exp(-8 * dt)));
      camera.position.copyFrom(camPos);

      // Smooth atmospheric shake: time-based, fades out at low speed (no idle jitter).
      const atmo = Math.max(...bodies.map((b) => b.atmosphereAt(ship.position)));
      const shake = clamp1((atmo - 0.3) / 0.7) * clamp1(speed / 300) * 0.4;
      if (shake > 0.002) {
        const t = performance.now() / 1000;
        camera.position.addInPlace(
          new Vector3(1, 0, 0).applyRotationQuaternion(rot).scale(Math.sin(t * 37.7) * shake * 0.5),
        );
        camera.position.addInPlace(
          new Vector3(0, 1, 0).applyRotationQuaternion(rot).scale(Math.sin(t * 29.3 + 1.7) * shake * 0.5),
        );
      }

      // Follow the ship's yaw/pitch, but only ~1/3 of its roll, heavily damped.
      const nearest = nearestWorldBody(bodies, ship.position) ?? bodies[0];
      const planetUp = ship.position.subtract(nearest.center).normalize();
      const shipUp = new Vector3(0, 1, 0).applyRotationQuaternion(rot);
      const upTarget = Vector3.Lerp(planetUp, shipUp, 0.35);
      if (upTarget.lengthSquared() < 1e-4) upTarget.copyFrom(shipUp);
      upTarget.normalize();
      camUp.copyFrom(Vector3.Lerp(camUp, upTarget, 1 - Math.exp(-6 * dt)));
      camUp.normalize();
      camera.upVector.copyFrom(camUp);
      camera.setTarget(ship.position.add(state.velocity.scale(0.03))); // slight look-ahead

      const targetFov = 60 + Math.min(18, speed * 0.06) + (isBoosting() ? 5 : 0);
      camFov += (targetFov - camFov) * (1 - Math.exp(-3 * dt));
      camera.fov = (camFov / 180) * Math.PI;
    },
  };
}
