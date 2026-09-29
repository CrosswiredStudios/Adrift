/**
 * Celestial bodies on rails.
 *
 * Every body's position, velocity and orientation are closed-form functions
 * of sim time: circular Kepler orbits around a parent plus a constant spin
 * (or tidal lock). Nothing here is integrated, so the solar system never
 * drifts, can be evaluated at any time (saves, time warp), and costs a few
 * trig calls per body per step.
 *
 * Frames and units:
 *  - SI units: meters, seconds, m^3/s^2 for `mu`.
 *  - The inertial frame has the root star at the origin; +Y is "system
 *    north" (orbital planes are defined relative to the XZ plane).
 *  - Body-fixed frame: origin at the body centre, rotating with the surface.
 *    Local +Y is the spin axis (north pole). Terrain, oceans, POIs and
 *    anything standing on a body live in this frame.
 *
 * Patched conics: the ship only feels the gravity of the body whose sphere
 * of influence (SOI) it is in. SOI radius follows Laplace:
 * r = a * (mu / mu_parent)^(2/5).
 */
import { Quaternion, Vector3 } from "@babylonjs/core";

export interface OrbitSpec {
  /** Parent body id. */
  parent: string;
  /** Circular orbit radius (m). */
  radius: number;
  /** Orbit period (s). Omit to derive it from the parent's mu (Kepler III). */
  period?: number;
  /** True anomaly at t = 0 (rad). */
  phase?: number;
  /** Orbital plane inclination to the system XZ plane (rad). */
  inclination?: number;
  /** Longitude of the ascending node (rad). */
  node?: number;
}

export interface SpinSpec {
  /** Sidereal day (s). Ignored when `tidallyLocked`. Negative = retrograde. */
  period: number;
  /** Axial tilt away from the system +Y axis (rad). */
  tilt?: number;
  /** Direction the tilt leans toward, measured around system +Y (rad). */
  tiltAzimuth?: number;
  /** Rotation angle at t = 0 (rad). */
  phase?: number;
  /** Keep the same face toward the parent (spin period = orbit period). */
  tidallyLocked?: boolean;
}

export interface BodySpec {
  id: string;
  name: string;
  /** Mean radius (m). */
  radius: number;
  /** Gravitational parameter G*M (m^3/s^2). */
  mu: number;
  orbit?: OrbitSpec;
  spin: SpinSpec;
}

const TAU = Math.PI * 2;

export class CelestialBody {
  readonly id: string;
  readonly name: string;
  readonly radius: number;
  readonly mu: number;
  parent: CelestialBody | null = null;
  readonly children: CelestialBody[] = [];
  /** Sphere-of-influence radius (m); Infinity for the root star. */
  soi = Infinity;
  /** Orbit period (s), 0 for the root. */
  orbitPeriod = 0;
  /** Spin angular speed about local +Y (rad/s). */
  spinRate = 0;

  // Orbit plane basis: e1 = ascending node direction, e2 = 90 deg ahead in
  // the direction of motion. Chosen so the orbital angular velocity points
  // along +orbitNormal, the same sense as a positive Babylon rotation about
  // that axis (prograde orbits and prograde spins agree).
  private readonly e1 = new Vector3(1, 0, 0);
  private readonly e2 = new Vector3(0, 0, -1);
  private readonly orbitNormal = new Vector3(0, 1, 0);
  /** Fixed tilt part of the orientation (spin axis direction). */
  private readonly tiltQ = Quaternion.Identity();
  /** Tidal lock: orientation at orbit angle 0 (local X toward the parent). */
  private readonly lockFrameQ = Quaternion.Identity();
  private readonly spinAxisI = new Vector3(0, 1, 0);

  // Scratch.
  private static readonly tmpQ = new Quaternion();
  private static readonly tmpV = new Vector3();

  constructor(readonly spec: BodySpec) {
    this.id = spec.id;
    this.name = spec.name;
    this.radius = spec.radius;
    this.mu = spec.mu;
  }

  /** Resolve parent links, periods, SOI and frame bases. Called by the system. */
  init(parent: CelestialBody | null): void {
    this.parent = parent;
    const o = this.spec.orbit;
    if (parent && o) {
      parent.children.push(this);
      this.orbitPeriod = o.period ?? TAU * Math.sqrt(o.radius ** 3 / parent.mu);
      this.soi = o.radius * Math.pow(this.mu / parent.mu, 0.4);
      const inc = o.inclination ?? 0;
      const node = o.node ?? 0;
      // Ascending node direction in the XZ plane, then tilt the plane about it.
      this.e1.set(Math.cos(node), 0, Math.sin(node));
      new Vector3(0, 1, 0).applyRotationQuaternionToRef(
        Quaternion.RotationAxis(this.e1, inc),
        this.orbitNormal,
      );
      Vector3.CrossToRef(this.orbitNormal, this.e1, this.e2);
      this.e2.normalize();
    }
    const s = this.spec.spin;
    if (s.tidallyLocked && this.orbitPeriod > 0) {
      this.spinRate = TAU / this.orbitPeriod;
      this.spinAxisI.copyFrom(this.orbitNormal);
      // Frame with local X = -e1 (toward the parent at angle 0), Y = normal.
      // Spinning it about local Y by the orbit angle keeps X on the parent.
      const fx = this.e1.scale(-1);
      const fy = this.orbitNormal;
      quatFromBasis(fx, fy, Vector3.Cross(fx, fy), this.lockFrameQ);
    } else {
      this.spinRate = s.period !== 0 ? TAU / s.period : 0;
      const tilt = s.tilt ?? 0;
      const az = s.tiltAzimuth ?? 0;
      const tiltAxis = new Vector3(Math.cos(az), 0, Math.sin(az));
      Quaternion.RotationAxisToRef(tiltAxis, tilt, this.tiltQ);
      new Vector3(0, 1, 0).applyRotationQuaternionToRef(this.tiltQ, this.spinAxisI);
    }
  }

  /** Orbit angle (rad) at time t. */
  orbitAngle(t: number): number {
    if (!this.orbitPeriod) return 0;
    return (this.spec.orbit?.phase ?? 0) + (TAU * t) / this.orbitPeriod;
  }

  /** Inertial position at time t. */
  positionAt(t: number, out = new Vector3()): Vector3 {
    if (!this.parent || !this.spec.orbit) return out.set(0, 0, 0);
    this.parent.positionAt(t, out);
    const a = this.spec.orbit.radius;
    const th = this.orbitAngle(t);
    const c = Math.cos(th) * a;
    const s = Math.sin(th) * a;
    out.x += this.e1.x * c + this.e2.x * s;
    out.y += this.e1.y * c + this.e2.y * s;
    out.z += this.e1.z * c + this.e2.z * s;
    return out;
  }

  /** Inertial velocity at time t. */
  velocityAt(t: number, out = new Vector3()): Vector3 {
    if (!this.parent || !this.spec.orbit) return out.set(0, 0, 0);
    this.parent.velocityAt(t, out);
    const a = this.spec.orbit.radius;
    const w = TAU / this.orbitPeriod;
    const th = this.orbitAngle(t);
    const c = Math.cos(th) * a * w;
    const s = Math.sin(th) * a * w;
    out.x += -this.e1.x * s + this.e2.x * c;
    out.y += -this.e1.y * s + this.e2.y * c;
    out.z += -this.e1.z * s + this.e2.z * c;
    return out;
  }

  /**
   * Orientation (body-fixed -> inertial) at time t. For a tidally locked
   * body, local +X always points at the parent.
   */
  rotationAt(t: number, out = new Quaternion()): Quaternion {
    if (this.spec.spin.tidallyLocked && this.parent && this.orbitPeriod) {
      Quaternion.RotationAxisToRef(Vector3.UpReadOnly, this.orbitAngle(t), CelestialBody.tmpQ);
      this.lockFrameQ.multiplyToRef(CelestialBody.tmpQ, out);
      return out;
    }
    const angle = (this.spec.spin.phase ?? 0) + this.spinRate * t;
    const spin = CelestialBody.tmpQ;
    Quaternion.RotationAxisToRef(Vector3.UpReadOnly, angle, spin);
    this.tiltQ.multiplyToRef(spin, out);
    return out;
  }

  /** Angular velocity of the body frame, in inertial axes (rad/s). */
  angularVelocityInertial(out = new Vector3()): Vector3 {
    return out.copyFrom(this.spinAxisI).scaleInPlace(this.spinRate);
  }

  /** Angular velocity in body-fixed axes: always along local +Y. */
  angularVelocityLocal(out = new Vector3()): Vector3 {
    return out.set(0, this.spinRate, 0);
  }

  /** Surface gravity (m/s^2) at the mean radius. */
  get surfaceGravity(): number {
    return this.mu / (this.radius * this.radius);
  }

  /** Circular orbit speed at radius r (m/s). */
  circularSpeed(r: number): number {
    return Math.sqrt(this.mu / r);
  }

  /** Escape speed at radius r (m/s). */
  escapeSpeed(r: number): number {
    return Math.sqrt((2 * this.mu) / r);
  }

  /** Direction from this body's centre toward the root star, inertial. */
  sunDirection(t: number, out = new Vector3()): Vector3 {
    let root: CelestialBody = this;
    while (root.parent) root = root.parent;
    root.positionAt(t, out);
    this.positionAt(t, CelestialBody.tmpV);
    out.subtractInPlace(CelestialBody.tmpV);
    const l = out.length();
    return l > 0 ? out.scaleInPlace(1 / l) : out.set(1, 0, 0);
  }
}

/**
 * Quaternion (float64) of the rotation taking the identity axes onto the
 * orthonormal basis (x, y, z). Babylon matrices are float32, so building
 * the quaternion through Matrix would cost ~7 digits of precision.
 */
export function quatFromBasis(x: Vector3, y: Vector3, z: Vector3, out = new Quaternion()): Quaternion {
  // Rotation matrix (column-vector convention) with the basis as columns.
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

/** A whole planetary system: bodies by id, resolved hierarchy. */
export class CelestialSystem {
  readonly bodies: CelestialBody[];
  readonly byId = new Map<string, CelestialBody>();
  readonly root: CelestialBody;

  constructor(specs: BodySpec[]) {
    this.bodies = specs.map((s) => new CelestialBody(s));
    for (const b of this.bodies) this.byId.set(b.id, b);
    const roots = this.bodies.filter((b) => !b.spec.orbit);
    if (roots.length !== 1) throw new Error("CelestialSystem needs exactly one root body (no orbit)");
    this.root = roots[0];
    // Parents first so periods/SOI resolve in order.
    const done = new Set<CelestialBody>();
    const visit = (b: CelestialBody): void => {
      if (done.has(b)) return;
      const pid = b.spec.orbit?.parent;
      const parent = pid ? this.byId.get(pid) : null;
      if (pid && !parent) throw new Error(`Body ${b.id}: unknown parent ${pid}`);
      if (parent) visit(parent);
      b.init(parent ?? null);
      done.add(b);
    };
    for (const b of this.bodies) visit(b);
  }

  get(id: string): CelestialBody {
    const b = this.byId.get(id);
    if (!b) throw new Error(`Unknown body ${id}`);
    return b;
  }

  /**
   * Body whose SOI contains an inertial point (deepest in the hierarchy).
   * `current` adds 2% hysteresis so a ship on the boundary doesn't flip
   * frames every step.
   */
  dominantBody(t: number, pointI: Vector3, current?: CelestialBody | null): CelestialBody {
    let b = this.root;
    const tmp = new Vector3();
    for (;;) {
      let next: CelestialBody | null = null;
      for (const c of b.children) {
        c.positionAt(t, tmp);
        const d = Vector3.Distance(tmp, pointI);
        const limit = c === current ? c.soi * 1.02 : c.soi;
        if (d < limit) {
          next = c;
          break;
        }
      }
      if (!next) return b;
      b = next;
    }
  }
}
