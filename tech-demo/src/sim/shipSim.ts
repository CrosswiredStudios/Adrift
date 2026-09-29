/**
 * Newtonian ship with a flight-assist computer.
 *
 * The ship is a rigid body simulated in the body-fixed (rotating) frame of
 * its dominant body: gravity + Coriolis + centrifugal come from
 * sim/frames.ts, thrusters apply accelerations along the ship's axes, the
 * air (which co-rotates with the planet) adds drag and heating, and the
 * hull/landing gear collide with the exact terrain height field and float
 * on the ocean.
 *
 * Flight assist (on by default, toggled with T) makes this approachable
 * without taking the physics away:
 *  - rotation: stick = angular *rate* command, released = rotation stops;
 *    near a body, roll auto-levels to the local horizon;
 *  - near a surface (inside the atmosphere, or below the hover ceiling on
 *    airless bodies): thrusters cancel gravity and bleed off drift on any
 *    axis you aren't commanding, so the ship hovers like a drone. Lateral
 *    and vertical input become *velocity* commands (the vertical one limited
 *    close to the ground, so holding "down" lands gently); forward input
 *    stays raw thrust so the ship can build real speed;
 *  - in space: no damping at all, so coasting and orbits work.
 * With assist off every input is a raw force/torque. "Match velocity" (X)
 * brakes to rest relative to the surface frame in either mode.
 *
 * Axis conventions (ship local): +X right, +Y up, +Z forward (nose).
 * Positive rotation follows the right-hand rule, so nose-up is a negative
 * rotation about +X and right-wing-down is a negative rotation about +Z.
 */
import { Quaternion, Vector3 } from "@babylonjs/core";
import { bodyFrameAcceleration } from "./frames";
import { clamp } from "../common/math";

export interface ShipSpec {
  /** Thruster accelerations (m/s^2). */
  thrust: { forward: number; back: number; lateral: number; up: number; down: number };
  /** Multiplier on forward thrust while boosting. */
  boost: number;
  /** Angular acceleration per axis (rad/s^2): x pitch, y yaw, z roll. */
  angAccel: Vector3;
  /** Assisted max rotation rate per axis (rad/s). */
  maxRate: Vector3;
  /** Drag: a = -rho * (linear * v + quadratic * |v| v). */
  drag: { linear: number; quadratic: number; angular: number };
  /** Diagonal inertia per unit mass (m^2). */
  inertia: Vector3;
  /** Landing gear feet (ship local). */
  gear: Vector3[];
  /** Extra hull contact points (ship local) for crashes/scrapes. */
  hull: Vector3[];
  /** Impact speed above which the hull takes damage (m/s). */
  safeImpact: number;
  /** Assist hover ceiling above the surface on airless bodies (m). */
  hoverCeiling: number;
  /** Assist velocity commands at full stick near a surface (m/s). */
  assistSpeed: { lateral: number; up: number; down: number };
  /** Below this height (ship origin above ground, m) an idle assisted hover settles onto the gear. */
  touchdownHeight: number;
}

export const SKIFF: ShipSpec = {
  thrust: { forward: 30, back: 18, lateral: 14, up: 22, down: 14 },
  boost: 2.5,
  angAccel: new Vector3(3.2, 2.6, 4.2),
  maxRate: new Vector3(1.4, 1.1, 2.2),
  drag: { linear: 0.02, quadratic: 0.0012, angular: 0.6 },
  inertia: new Vector3(3.6, 6.5, 3.1),
  gear: [new Vector3(0, -1.45, 2.3), new Vector3(1.4, -1.45, -1.3), new Vector3(-1.4, -1.45, -1.3)],
  hull: [
    new Vector3(0, -0.85, 0.4),
    new Vector3(0, -0.4, 3.9),
    new Vector3(0, 0.1, -2.6),
    new Vector3(2.95, 0, -1.7),
    new Vector3(-2.95, 0, -1.7),
    new Vector3(0, 0.95, 1.2),
  ],
  safeImpact: 9,
  hoverCeiling: 1500,
  assistSpeed: { lateral: 25, up: 30, down: 20 },
  touchdownHeight: 2.4,
};

/** Per-step pilot input (from actions, an autopilot or a test). */
export interface ShipControls {
  /** x strafe right, y up, z forward; each in [-1, 1]. */
  thrust: Vector3;
  /** x pitch up, y yaw right, z roll right; each in [-1, 1]. */
  rotate: Vector3;
  boost: boolean;
  matchVelocity: boolean;
}

export function emptyControls(): ShipControls {
  return { thrust: Vector3.Zero(), rotate: Vector3.Zero(), boost: false, matchVelocity: false };
}

/** What the ship needs to know about the body it is flying around. */
export interface ShipEnvironment {
  mu: number;
  spinRate: number;
  /** Surface radius (m) along a unit body-frame direction. */
  surfaceRadius(x: number, y: number, z: number): number;
  /** Outward surface normal along a unit direction. */
  surfaceNormal(x: number, y: number, z: number): [number, number, number];
  /** Water surface radius along a unit direction, or null (dry body / land). */
  waterRadius(x: number, y: number, z: number): number | null;
  /** 0..1 air density at a height above the mean radius. */
  airDensity(altitude: number): number;
  /** Mean radius (m). */
  radius: number;
  /** True when the body has an atmosphere (assist hovers inside it). */
  atmosphereTop: number | null;
  /** Extra static colliders (launch pad, ruins...) in the body frame. */
  colliders?: StaticCollider[];
}

/** Oriented box collider in the body frame. */
export interface StaticCollider {
  center: Vector3;
  /** Box axes (unit, body frame). */
  axes: [Vector3, Vector3, Vector3];
  halfExtents: Vector3;
}

export interface ShipEvents {
  impact?(speed: number, damage: number, onWater: boolean): void;
  splash?(position: Vector3, speed: number): void;
}

export class ShipSim {
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  /** Attitude: ship local -> body frame. */
  readonly att = Quaternion.Identity();
  /** Angular velocity in ship local axes (rad/s). */
  readonly angVel = new Vector3();
  assist = true;
  landed = false;
  floating = false;
  /** Number of gear feet touching this step. */
  gearContacts = 0;
  /** 0..1 re-entry heating. */
  heat = 0;
  /** 0..1 hull integrity. */
  hull = 1;
  /** Air density at the ship (0..1+). */
  airDensity = 0;
  /** Height above the surface below (m). */
  altitude = 0;
  /** Velocity component along the local up (m/s). */
  verticalSpeed = 0;
  /** Thruster output this step (ship axes, fraction of max) for FX. */
  readonly thrustOut = new Vector3();

  private readonly tmp = {
    a: new Vector3(),
    g: new Vector3(),
    up: new Vector3(),
    fwd: new Vector3(),
    right: new Vector3(),
    q: new Quaternion(),
    qi: new Quaternion(),
    local: new Vector3(),
  };

  constructor(readonly spec: ShipSpec = SKIFF) {}

  /** Ship local axis in the body frame. */
  axis(local: Vector3, out = new Vector3()): Vector3 {
    return local.applyRotationQuaternionToRef(this.att, out);
  }

  /** Signed bank angle about the nose relative to the local horizon (rad, + right wing down). */
  bankAngle(): number {
    const up = this.pos.clone().normalize();
    const nose = this.axis(Vector3.Forward());
    const shipUp = this.axis(Vector3.Up());
    const rightH = Vector3.Cross(up, nose);
    if (rightH.lengthSquared() < 1e-6) return 0;
    rightH.normalize();
    const upH = Vector3.Cross(nose, rightH).normalize();
    return Math.atan2(Vector3.Dot(shipUp, rightH), Vector3.Dot(shipUp, upH));
  }

  /** Seconds the ship has been landed with idle controls. */
  private idleLanded = 0;
  /** True while resting (integration paused until an input or disturbance). */
  sleeping = false;

  step(dt: number, c: ShipControls, env: ShipEnvironment, events: ShipEvents = {}): void {
    const idle = c.thrust.lengthSquared() < 0.0025 && c.rotate.lengthSquared() < 0.0025 && !c.matchVelocity;
    if (this.sleeping) {
      if (idle) {
        this.thrustOut.setAll(0);
        this.heat *= Math.exp(-dt * 2.5);
        return;
      }
      this.sleeping = false;
      this.idleLanded = 0;
    }
    const sub = 2;
    const h = dt / sub;
    for (let i = 0; i < sub; i++) this.substep(h, c, env, events);
    // Rest: once settled on the gear with hands off, freeze the body (it is
    // static in the body-fixed frame) instead of letting contact jitter creep.
    if (this.landed && idle && !this.floating) {
      this.idleLanded += dt;
      if (this.idleLanded > 0.75 && this.vel.length() < 0.25 && this.angVel.length() < 0.1) {
        this.sleeping = true;
        this.vel.setAll(0);
        this.angVel.setAll(0);
      }
    } else this.idleLanded = 0;
  }

  /** Wake a sleeping ship (teleports, external pushes). */
  wake(): void {
    this.sleeping = false;
    this.idleLanded = 0;
  }

  private substep(dt: number, c: ShipControls, env: ShipEnvironment, events: ShipEvents): void {
    const t = this.tmp;
    const s = this.spec;
    const r = this.pos.length();
    const up = t.up.copyFrom(this.pos).scaleInPlace(1 / Math.max(r, 1e-6));
    const surfR = env.surfaceRadius(up.x, up.y, up.z);
    const water = env.waterRadius(up.x, up.y, up.z);
    const groundR = water !== null ? Math.max(surfR, water) : surfR;
    this.altitude = r - groundR;
    this.verticalSpeed = Vector3.Dot(this.vel, up);
    this.airDensity = env.airDensity(r - env.radius);

    // --- Environment acceleration (gravity + frame pseudo-forces).
    const g = bodyFrameAcceleration(env.mu, env.spinRate, this.pos, this.vel, t.g);

    // --- Thrusters (ship frame).
    Quaternion.InverseToRef(this.att, t.qi);
    const gLocal = g.applyRotationQuaternionToRef(t.qi, new Vector3());
    const vLocal = this.vel.applyRotationQuaternionToRef(t.qi, new Vector3());
    const nearSurface =
      env.atmosphereTop !== null ? r - env.radius < env.atmosphereTop : this.altitude < s.hoverCeiling;
    const aLocal = t.local.set(0, 0, 0);
    const maxPos = [s.thrust.lateral, s.thrust.up, s.thrust.forward * (c.boost ? s.boost : 1)];
    const maxNeg = [s.thrust.lateral, s.thrust.down, s.thrust.back];
    const input = [c.thrust.x, c.thrust.y, c.thrust.z];
    const gl = [gLocal.x, gLocal.y, gLocal.z];
    const vl = [vLocal.x, vLocal.y, vLocal.z];
    const out = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const u = input[k];
      let a = 0;
      const hovering = this.assist && nearSurface && !this.restingOnGround();
      if (Math.abs(u) > 0.05 && hovering && k < 2) {
        // Velocity command; descent slows near the ground (~0.6 m/s per m).
        let vCmd =
          k === 0 ? u * s.assistSpeed.lateral : u > 0 ? u * s.assistSpeed.up : u * s.assistSpeed.down;
        if (k === 1 && vCmd < 0) vCmd = Math.max(vCmd, -Math.max(2.5, this.altitude * 0.6));
        a = (vCmd - vl[k]) / 0.6 - gl[k];
      } else if (Math.abs(u) > 0.05) {
        a = u > 0 ? u * maxPos[k] : u * maxNeg[k];
        if (hovering) a -= gl[k];
      } else if (c.matchVelocity) {
        a = -vl[k] / 0.35 - gl[k];
      } else if (hovering) {
        // Hover + drift damping (drone feel). Just above the ground with no
        // vertical input, let it settle onto the gear instead of hovering on
        // a contact bounce.
        a = -gl[k] - vl[k] / 0.8;
        if (this.altitude < s.touchdownHeight && Math.abs(input[1]) <= 0.05) {
          const upLocal = up.applyRotationQuaternionToRef(t.qi, new Vector3());
          const upK = k === 0 ? upLocal.x : k === 1 ? upLocal.y : upLocal.z;
          a -= upK * 1.5; // ~1.5 m/s^2 net sink along the local vertical
        }
      }
      a = clamp(a, -maxNeg[k], maxPos[k]);
      out[k] = a >= 0 ? a / maxPos[k] : a / -maxNeg[k];
      if (k === 0) aLocal.x = a;
      else if (k === 1) aLocal.y = a;
      else aLocal.z = a;
    }
    this.thrustOut.set(out[0], out[1], out[2]);
    const aThrust = aLocal.applyRotationQuaternionToRef(this.att, t.a);

    // --- Aerodynamic drag (the atmosphere co-rotates with the body frame).
    const speed = this.vel.length();
    const rho = this.airDensity;
    const dragK = rho * (s.drag.linear + s.drag.quadratic * speed);

    // Integrate velocity (drag applied implicitly so it can't overshoot).
    this.vel.addInPlace(g.scale(dt)).addInPlace(aThrust.scale(dt));
    this.vel.scaleInPlace(1 / (1 + dragK * dt));
    this.pos.addInPlace(this.vel.scale(dt));

    // --- Rotation.
    const rate = this.angVel;
    const cmd = new Vector3(-c.rotate.x, c.rotate.y, -c.rotate.z);
    if (this.assist) {
      const target = new Vector3(cmd.x * s.maxRate.x, cmd.y * s.maxRate.y, cmd.z * s.maxRate.z);
      // Auto-level roll to the local horizon near bodies (not while rolling or nose-vertical).
      const nose = this.axis(Vector3.Forward(), t.fwd);
      if (nearSurface && Math.abs(c.rotate.z) < 0.05 && Math.abs(Vector3.Dot(nose, up)) < 0.9) {
        // Bank into turns a little, like an aircraft.
        const want = -c.rotate.y * 0.45;
        target.z = clamp((this.bankAngle() - want) * 2.2, -s.maxRate.z, s.maxRate.z);
      }
      const k = 6;
      rate.x += clamp((target.x - rate.x) * k, -s.angAccel.x, s.angAccel.x) * dt;
      rate.y += clamp((target.y - rate.y) * k, -s.angAccel.y, s.angAccel.y) * dt;
      rate.z += clamp((target.z - rate.z) * k, -s.angAccel.z, s.angAccel.z) * dt;
    } else {
      rate.x += cmd.x * s.angAccel.x * dt;
      rate.y += cmd.y * s.angAccel.y * dt;
      rate.z += cmd.z * s.angAccel.z * dt;
    }
    if (rho > 0) rate.scaleInPlace(1 / (1 + rho * s.drag.angular * dt));
    this.integrateAttitude(dt);

    // --- Contacts.
    this.collide(dt, env, events);

    // --- Heating: ~ rho * v^3, eased.
    const heatTarget = Math.min(1, rho * (speed / 180) ** 3);
    this.heat += (heatTarget - this.heat) * Math.min(1, dt * 2.5);
  }

  private integrateAttitude(dt: number): void {
    const w = this.angVel;
    const mag = w.length();
    if (mag < 1e-9) return;
    const dq = Quaternion.RotationAxisToRef(w.scale(1 / mag), mag * dt, this.tmp.q);
    this.att.multiplyToRef(dq, this.att);
    this.att.normalize();
  }

  private restingOnGround(): boolean {
    return this.landed;
  }

  /**
   * Rigid-body contact against terrain, water and static colliders:
   * detection, one positional push-out, then a few sequential-impulse
   * iterations (normal + Coulomb friction with accumulated clamping).
   */
  private collide(dt: number, env: ShipEnvironment, events: ShipEvents): void {
    const s = this.spec;
    const I = s.inertia;
    const points = s.gear.concat(s.hull);
    let gearTouch = 0;
    let wet = false;
    let maxImpact = 0;
    let impactOnWater = false;
    const P = new Vector3();
    const qi = Quaternion.Inverse(this.att);
    interface Contact {
      arm: Vector3;
      n: Vector3;
      pen: number;
      gear: boolean;
      bias: number;
      jn: number;
      jt: Vector3;
    }
    const contacts: Contact[] = [];

    for (let pi = 0; pi < points.length; pi++) {
      const isGear = pi < s.gear.length;
      const arm = points[pi].applyRotationQuaternion(this.att);
      this.pos.addToRef(arm, P);
      const r = P.length();
      const dx = P.x / r;
      const dy = P.y / r;
      const dz = P.z / r;
      const ground = env.surfaceRadius(dx, dy, dz);
      const water = env.waterRadius(dx, dy, dz);

      // Water: buoyancy spring + damping on submerged points (floats level).
      if (water !== null && r < water && water > ground) {
        wet = true;
        const depth = Math.min(water - r, 2);
        const up = new Vector3(dx, dy, dz);
        const vn = Vector3.Dot(this.pointVelocity(arm), up);
        if (vn < -2 && isGear) events.splash?.(P.clone(), -vn);
        if (-vn > maxImpact && -vn > s.safeImpact * 2) {
          maxImpact = -vn;
          impactOnWater = true;
        }
        // Each submerged point carries a share of the weight: ~1 m draft at rest.
        const accel = (depth * 30 - vn * 6) / points.length;
        this.applyImpulse(arm, up.scale(accel * dt), qi, I);
        this.vel.scaleInPlace(1 / (1 + 0.35 * dt));
        this.angVel.scaleInPlace(1 / (1 + 0.8 * dt));
        continue;
      }

      // Terrain (radial distance ~ normal distance on gentle slopes) and
      // static boxes (pad, ruins): keep the deeper contact.
      const n = new Vector3();
      let pen = ground - r;
      if (pen > -0.02) {
        const [nx, ny, nz] = env.surfaceNormal(dx, dy, dz);
        pen *= nx * dx + ny * dy + nz * dz;
        n.set(nx, ny, nz);
      }
      if (env.colliders) {
        const hit = boxPenetration(P, env.colliders);
        if (hit && hit.depth > pen) {
          pen = hit.depth;
          n.copyFrom(hit.normal);
        }
      }
      if (pen <= 0) continue;
      if (isGear) gearTouch++;
      const vn = Vector3.Dot(this.pointVelocity(arm), n);
      if (-vn > maxImpact) {
        maxImpact = -vn;
        impactOnWater = false;
      }
      contacts.push({ arm, n, pen, gear: isGear, bias: vn < -4 ? -0.3 * vn : 0, jn: 0, jt: Vector3.Zero() });
    }

    // Push out of the ground once (max penetration along each normal).
    const push = new Vector3();
    for (const c of contacts) {
      const need = c.pen - Vector3.Dot(push, c.n);
      if (need > 0.002) push.addInPlace(c.n.scale(need * 0.8));
    }
    this.pos.addInPlace(push);

    // Sequential impulses.
    for (let iter = 0; iter < 6; iter++) {
      for (const c of contacts) {
        const vp = this.pointVelocity(c.arm);
        const vn = Vector3.Dot(vp, c.n);
        const kn = this.effectiveMassInv(c.arm, c.n, qi, I);
        let dj = (-vn + c.bias) / kn;
        const old = c.jn;
        c.jn = Math.max(0, old + dj);
        dj = c.jn - old;
        if (dj !== 0) this.applyImpulse(c.arm, c.n.scale(dj), qi, I);
        // Friction.
        const vp2 = this.pointVelocity(c.arm);
        const vt = vp2.subtract(c.n.scale(Vector3.Dot(vp2, c.n)));
        const vtLen = vt.length();
        if (vtLen > 1e-6) {
          const tdir = vt.scale(1 / vtLen);
          const kt = this.effectiveMassInv(c.arm, tdir, qi, I);
          const mu = c.gear ? 0.9 : 0.5;
          const want = c.jt.subtract(tdir.scale(vtLen / kt));
          const maxF = mu * c.jn;
          const len = want.length();
          const clamped = len > maxF ? want.scale(maxF / len) : want;
          const delta = clamped.subtract(c.jt);
          c.jt.copyFrom(clamped);
          this.applyImpulse(c.arm, delta, qi, I);
        }
      }
    }

    this.gearContacts = gearTouch;
    this.floating = wet;
    this.landed = gearTouch >= 2 && this.vel.length() < 0.8 && this.angVel.length() < 0.4;
    if (maxImpact > s.safeImpact) {
      const damage = Math.min(1, (maxImpact - s.safeImpact) / 45);
      this.hull = Math.max(0, this.hull - damage);
      events.impact?.(maxImpact, damage, impactOnWater);
    }
  }

  /** Velocity of a point on the ship (arm in the body frame). */
  private pointVelocity(arm: Vector3): Vector3 {
    const wBody = this.angVel.applyRotationQuaternion(this.att);
    return this.vel.add(Vector3.Cross(wBody, arm));
  }

  /** 1/m + n . ((I^-1 (r x n)) x r), everything per unit mass. */
  private effectiveMassInv(armBody: Vector3, dirBody: Vector3, qi: Quaternion, I: Vector3): number {
    const rl = armBody.applyRotationQuaternion(qi);
    const nl = dirBody.applyRotationQuaternion(qi);
    const rxn = Vector3.Cross(rl, nl);
    const t = new Vector3(rxn.x / I.x, rxn.y / I.y, rxn.z / I.z);
    return 1 + Vector3.Dot(Vector3.Cross(t, rl), nl);
  }

  /** Apply an impulse (per unit mass, body frame) at a body-frame arm. */
  private applyImpulse(armBody: Vector3, impulseBody: Vector3, qi: Quaternion, I: Vector3): void {
    this.vel.addInPlace(impulseBody);
    const rl = armBody.applyRotationQuaternion(qi);
    const jl = impulseBody.applyRotationQuaternion(qi);
    const tq = Vector3.Cross(rl, jl);
    this.angVel.x += tq.x / I.x;
    this.angVel.y += tq.y / I.y;
    this.angVel.z += tq.z / I.z;
  }

  /** Place the ship at rest on the surface (gear on the ground). */
  placeOnSurface(dir: Vector3, heading: Vector3, env: ShipEnvironment, clearance = 0.05): void {
    const up = dir.clone().normalize();
    const r = env.surfaceRadius(up.x, up.y, up.z);
    const fwd = heading.subtract(up.scale(Vector3.Dot(heading, up))).normalize();
    const right = Vector3.Cross(up, fwd); // same handedness as identity (y x z = x)
    quatFromAxes(right, up, fwd, this.att);
    const footDrop = -Math.min(...this.spec.gear.map((g) => g.y));
    this.pos.copyFrom(up.scale(r + footDrop + clearance));
    this.vel.setAll(0);
    this.angVel.setAll(0);
    this.landed = true;
    this.sleeping = false;
    this.idleLanded = 0;
  }
}

/** Quaternion whose local X/Y/Z map onto the given orthonormal axes. */
export function quatFromAxes(x: Vector3, y: Vector3, z: Vector3, out = new Quaternion()): Quaternion {
  const m00 = x.x,
    m01 = y.x,
    m02 = z.x;
  const m10 = x.y,
    m11 = y.y,
    m12 = z.y;
  const m20 = x.z,
    m21 = y.z,
    m22 = z.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    out.set((m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s);
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out.set(0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s);
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out.set((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s);
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out.set((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s);
  }
  return out.normalize();
}

/** Deepest penetration of a point into any static box, with the exit normal. */
export function boxPenetration(
  p: Vector3,
  boxes: StaticCollider[],
): { depth: number; normal: Vector3 } | null {
  let best: { depth: number; normal: Vector3 } | null = null;
  for (const b of boxes) {
    const d = p.subtract(b.center);
    let minDepth = Infinity;
    let axisIdx = -1;
    let sign = 1;
    const ext = [b.halfExtents.x, b.halfExtents.y, b.halfExtents.z];
    let inside = true;
    for (let i = 0; i < 3; i++) {
      const proj = Vector3.Dot(d, b.axes[i]);
      const depth = ext[i] - Math.abs(proj);
      if (depth <= 0) {
        inside = false;
        break;
      }
      if (depth < minDepth) {
        minDepth = depth;
        axisIdx = i;
        sign = proj >= 0 ? 1 : -1;
      }
    }
    if (!inside || axisIdx < 0) continue;
    if (!best || minDepth > best.depth) best = { depth: minDepth, normal: b.axes[axisIdx].scale(sign) };
  }
  return best;
}
