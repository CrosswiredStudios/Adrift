import { Mesh, Scene, Vector3, Quaternion } from "@babylonjs/core";
import { Body } from "./planets";

export interface FlightState {
  velocity: Vector3;
  assist: boolean;
  target: Body | null;
}

export function createShip(scene: Scene): Mesh {
  const ship = Mesh.CreateBox("ship", 2, scene);
  const nose = Mesh.CreateCylinder("nose", 2, 0, 1.4, 4, 1, scene);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 1.5;
  nose.parent = ship;
  return ship;
}

export function updateShip(
  ship: Mesh, state: FlightState, bodies: Body[], input: Record<string, boolean>, dt: number
): void {
  const forward = new Vector3(0, 0, 1).applyRotationQuaternion(ship.rotationQuaternion ?? Quaternion.Identity());
  const thrust = (input["w"] ? 60 : 0) + (input["s"] ? -30 : 0);
  const boost = input["shift"] ? 3 : 1;
  state.velocity.addInPlace(forward.scale(thrust * boost * dt));

  const yaw = (input["arrowleft"] ? 1 : 0) + (input["arrowright"] ? -1 : 0);
  const pitch = (input["arrowup"] ? 1 : 0) + (input["arrowdown"] ? -1 : 0);
  const roll = (input["a"] ? 1 : 0) + (input["d"] ? -1 : 0);
  const q = ship.rotationQuaternion ?? Quaternion.Identity();
  const dq = Quaternion.RotationYawPitchRoll(yaw * dt, pitch * dt, roll * dt);
  ship.rotationQuaternion = dq.multiply(q);

  for (const body of bodies) {
    const toShip = ship.position.subtract(body.mesh.position);
    const r = Math.max(toShip.length(), body.radius * 1.02);
    state.velocity.addInPlace(toShip.normalize().scale(-body.mu / (r * r) * dt));
  }

  if (state.assist) state.velocity.scaleInPlace(Math.pow(0.4, dt));
  ship.position.addInPlace(state.velocity.scale(dt));
}
