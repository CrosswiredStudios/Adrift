import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "@babylonjs/core";
import { CHASE_BOOM, ChaseRig, type CameraPose } from "./cameraRig";

const pose = (): CameraPose => ({ position: new Vector3(), rotation: Quaternion.Identity(), fov: 1 });

describe("ChaseRig", () => {
  it("stays the same distance behind the ship at any speed", () => {
    const rig = new ChaseRig();
    const out = pose();
    const att = Quaternion.Identity();
    const pos = new Vector3(0, 5000, 0);
    const vel = new Vector3(0, 0, 900);
    for (let i = 0; i < 120; i++) {
      pos.addInPlace(vel.scale(1 / 60));
      rig.update(1 / 60, pos, att, vel, true, out);
    }
    expect(Vector3.Distance(out.position, pos)).toBeCloseTo(CHASE_BOOM.length(), 3);
  });

  it("follows the ship's attitude with no flip when pointing straight down", () => {
    const rig = new ChaseRig();
    const out = pose();
    const pos = new Vector3(0, 3000, 0);
    // Nose (+Z) turned to point straight down at the planet (-Y).
    const att = Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI / 2);
    for (let i = 0; i < 120; i++) rig.update(1 / 60, pos, att, Vector3.Zero(), false, out);
    const camFwd = new Vector3(0, 0, 1).applyRotationQuaternion(out.rotation);
    const camUp = new Vector3(0, 1, 0).applyRotationQuaternion(out.rotation);
    expect(Number.isFinite(camFwd.x + camUp.x)).toBe(true);
    expect(camFwd.y).toBeLessThan(-0.95); // looking down with the ship
    const shipUp = new Vector3(0, 1, 0).applyRotationQuaternion(att);
    expect(Vector3.Dot(camUp, shipUp)).toBeGreaterThan(0.95);
  });
});
