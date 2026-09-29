/**
 * On-foot character controller for spherical worlds.
 *
 * Simulated in the dominant body's rotating frame like the ship, so
 * "standing still" on a spinning planet really is standing still. Gravity
 * (and its tiny Coriolis/centrifugal terms) come from sim/frames.ts, so
 * jumping on the moon feels floaty for free.
 *
 * Collision shape: a vertical capsule (aligned with the local up) sampled as
 * three spheres. It collides with the exact terrain height field and with
 * static boxes (launch pad, ruins, the parked ship). Ground within a small
 * step height snaps under the feet so walking downhill doesn't bounce; slopes
 * steeper than `maxSlope` can't be walked up. Deep water floats you at the
 * surface (swimming).
 */
import { Vector3 } from "@babylonjs/core";
import { bodyFrameAcceleration } from "./frames";
import { boxPenetration, type ShipEnvironment, type StaticCollider } from "./shipSim";
import { clamp } from "../common/math";

export interface CharacterSpec {
  radius: number;
  height: number;
  eyeHeight: number;
  walkSpeed: number;
  sprintSpeed: number;
  jumpSpeed: number;
  groundAccel: number;
  airAccel: number;
  /** Max walkable slope (1 - n.up). 0.3 ~ 45 degrees. */
  maxSlope: number;
  stepHeight: number;
}

export const EXPLORER: CharacterSpec = {
  radius: 0.35,
  height: 1.8,
  eyeHeight: 1.62,
  walkSpeed: 4.2,
  sprintSpeed: 7.5,
  jumpSpeed: 4.6,
  groundAccel: 28,
  airAccel: 3,
  maxSlope: 0.32,
  stepHeight: 0.45,
};

export interface CharacterControls {
  /** x strafe right, z forward, each [-1, 1]. */
  moveX: number;
  moveZ: number;
  /** Look deltas this step (rad): + right / + up. */
  lookX: number;
  lookY: number;
  jump: boolean;
  sprint: boolean;
}

export function emptyCharacterControls(): CharacterControls {
  return { moveX: 0, moveZ: 0, lookX: 0, lookY: 0, jump: false, sprint: false };
}

export class CharacterSim {
  /** Feet position (bottom of the capsule), body frame. */
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  /** Facing direction in the tangent plane (unit, body frame). */
  readonly heading = new Vector3(0, 0, 1);
  /** Look pitch (rad, + up). */
  pitch = 0;
  grounded = false;
  swimming = false;
  /** Slope under the feet (1 - n.up). */
  groundSlope = 0;
  /** Height of the feet above the ground below (m). */
  altitude = 0;

  constructor(readonly spec: CharacterSpec = EXPLORER) {}

  /** Local up (unit radial) at the current position. */
  up(out = new Vector3()): Vector3 {
    return out.copyFrom(this.pos).normalize();
  }

  /** Right vector in the tangent plane. */
  right(out = new Vector3()): Vector3 {
    const up = this.up();
    return Vector3.CrossToRef(up, this.heading, out).normalize();
  }

  /** Unit look direction (heading pitched by `pitch`). */
  lookDir(out = new Vector3()): Vector3 {
    const up = this.up();
    return out
      .copyFrom(this.heading)
      .scaleInPlace(Math.cos(this.pitch))
      .addInPlace(up.scale(Math.sin(this.pitch)))
      .normalize();
  }

  /** Eye position (body frame). */
  eye(out = new Vector3()): Vector3 {
    return out.copyFrom(this.pos).addInPlace(this.up().scale(this.spec.eyeHeight));
  }

  /** Stand on the ground along `dir` facing `heading`. */
  placeOnSurface(dir: Vector3, heading: Vector3, env: ShipEnvironment): void {
    const up = dir.clone().normalize();
    const r = env.surfaceRadius(up.x, up.y, up.z);
    this.pos.copyFrom(up.scale(r));
    this.vel.setAll(0);
    this.heading.copyFrom(heading.subtract(up.scale(Vector3.Dot(heading, up)))).normalize();
    this.pitch = 0;
    this.grounded = true;
  }

  step(dt: number, c: CharacterControls, env: ShipEnvironment, extra: StaticCollider[] = []): void {
    const s = this.spec;
    const up = this.up();

    // --- Look: yaw turns the heading about the local up, pitch is clamped.
    this.heading.subtractInPlace(up.scale(Vector3.Dot(this.heading, up)));
    if (this.heading.lengthSquared() < 1e-8) this.heading.copyFrom(anyTangent(up));
    this.heading.normalize();
    if (c.lookX !== 0) {
      const right = Vector3.Cross(up, this.heading);
      // + lookX turns right: rotate heading toward `right`.
      const a = c.lookX;
      this.heading
        .scaleInPlace(Math.cos(a))
        .addInPlace(right.scaleInPlace(Math.sin(a)))
        .normalize();
    }
    this.pitch = clamp(this.pitch + c.lookY, -1.45, 1.45);

    // --- Desired horizontal velocity.
    const right = Vector3.Cross(up, this.heading).normalize();
    const speed = c.sprint ? s.sprintSpeed : s.walkSpeed;
    let mx = c.moveX;
    let mz = c.moveZ;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) {
      mx /= ml;
      mz /= ml;
    }
    const want = this.heading.scale(mz * speed).addInPlace(right.scale(mx * speed));
    const vUp = Vector3.Dot(this.vel, up);
    const vTan = this.vel.subtract(up.scale(vUp));
    const accel = this.swimming ? 6 : this.grounded ? s.groundAccel : s.airAccel;
    const dv = want.subtract(vTan);
    const dvl = dv.length();
    const maxDv = accel * dt;
    if (dvl > maxDv) dv.scaleInPlace(maxDv / dvl);
    // In the air, only steer (never brake below the current speed).
    if (!this.grounded && !this.swimming && ml < 0.05) dv.setAll(0);
    this.vel.addInPlace(dv);

    // --- Gravity + frame pseudo-forces.
    const g = bodyFrameAcceleration(env.mu, env.spinRate, this.pos, this.vel);
    if (this.grounded) {
      // Standing: only the tangential part of gravity matters (sliding on
      // too-steep slopes is handled below); don't accumulate a fall speed.
      this.vel.addInPlace(g.scale(dt));
    } else this.vel.addInPlace(g.scale(dt));

    // --- Jump.
    if (c.jump && (this.grounded || this.swimming)) {
      this.vel.addInPlace(up.scale(this.swimming ? s.jumpSpeed * 0.6 : s.jumpSpeed));
      this.grounded = false;
    }

    // --- Water.
    const dirNow = this.up();
    const water = env.waterRadius(dirNow.x, dirNow.y, dirNow.z);
    const ground0 = env.surfaceRadius(dirNow.x, dirNow.y, dirNow.z);
    const r0 = this.pos.length();
    this.swimming = water !== null && water > ground0 + 1.2 && r0 < water - 1.1;
    if (water !== null && r0 < water - 1.1 && water > ground0 + 1.2) {
      // Float with the chest at the surface.
      const depth = water - 1.3 - r0;
      this.vel.addInPlace(dirNow.scale((depth * 30 - Vector3.Dot(this.vel, dirNow) * 4) * dt));
      this.vel.scaleInPlace(1 / (1 + 1.5 * dt));
    }

    // --- Move.
    this.pos.addInPlace(this.vel.scale(dt));

    // --- Terrain contact.
    const u = this.up();
    const r = this.pos.length();
    const ground = env.surfaceRadius(u.x, u.y, u.z);
    const n = env.surfaceNormal(u.x, u.y, u.z);
    const slope = 1 - (n[0] * u.x + n[1] * u.y + n[2] * u.z);
    this.groundSlope = slope;
    const vUpNow = Vector3.Dot(this.vel, u);
    const gap = r - ground;
    const wasGrounded = this.grounded;
    this.grounded = false;
    if (gap < 0.02 || (wasGrounded && gap < s.stepHeight && vUpNow <= 0.5)) {
      // On (or snapped down to) the ground.
      this.pos.copyFrom(u.scale(ground));
      if (slope <= s.maxSlope) {
        this.grounded = true;
        if (vUpNow < 0) this.vel.subtractInPlace(u.scale(vUpNow));
      } else {
        // Too steep: slide along the surface, can't stand.
        const nv = new Vector3(n[0], n[1], n[2]);
        const into = Vector3.Dot(this.vel, nv);
        if (into < 0) this.vel.subtractInPlace(nv.scale(into));
      }
    }

    // --- Static colliders (three spheres along the capsule).
    const boxes = (env.colliders ?? []).concat(extra);
    if (boxes.length) {
      for (const h of [s.radius, s.height * 0.5, s.height - s.radius]) {
        const center = this.pos.add(u.scale(h));
        const hit = sphereBox(center, s.radius, boxes);
        if (!hit) continue;
        this.pos.addInPlace(hit.normal.scale(hit.depth));
        const into = Vector3.Dot(this.vel, hit.normal);
        if (into < 0) this.vel.subtractInPlace(hit.normal.scale(into));
        if (Vector3.Dot(hit.normal, u) > 0.7) this.grounded = true;
      }
    }
    if (this.grounded && ml < 0.05) {
      // Friction: stop quickly when no input.
      const vu = Vector3.Dot(this.vel, u);
      const vt = this.vel.subtract(u.scale(vu));
      vt.scaleInPlace(Math.max(0, 1 - 10 * dt));
      this.vel.copyFrom(vt).addInPlace(u.scale(Math.max(0, vu)));
    }
    this.altitude = this.pos.length() - env.surfaceRadius(u.x, u.y, u.z);
  }
}

function anyTangent(up: Vector3): Vector3 {
  const ref = Math.abs(up.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  return Vector3.Cross(ref, up).normalize();
}

/** Sphere vs oriented boxes: deepest push-out. */
export function sphereBox(
  c: Vector3,
  radius: number,
  boxes: StaticCollider[],
): { depth: number; normal: Vector3 } | null {
  let best: { depth: number; normal: Vector3 } | null = null;
  for (const b of boxes) {
    const d = c.subtract(b.center);
    const ext = [b.halfExtents.x, b.halfExtents.y, b.halfExtents.z];
    // Closest point on the box (in box coordinates).
    const local = [0, 0, 0];
    for (let i = 0; i < 3; i++) local[i] = clamp(Vector3.Dot(d, b.axes[i]), -ext[i], ext[i]);
    const closest = b.center
      .add(b.axes[0].scale(local[0]))
      .addInPlace(b.axes[1].scale(local[1]))
      .addInPlace(b.axes[2].scale(local[2]));
    const delta = c.subtract(closest);
    const dist = delta.length();
    let hit: { depth: number; normal: Vector3 } | null = null;
    if (dist > 1e-6) {
      if (dist < radius) hit = { depth: radius - dist, normal: delta.scale(1 / dist) };
    } else {
      // Centre inside the box: push out through the nearest face.
      const inside = boxPenetration(c, [b]);
      if (inside) hit = { depth: inside.depth + radius, normal: inside.normal };
    }
    if (hit && (!best || hit.depth > best.depth)) best = hit;
  }
  return best;
}
