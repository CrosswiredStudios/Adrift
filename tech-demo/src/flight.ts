import { Mesh, Scene, Vector3, Quaternion, Color4, ParticleSystem, Texture } from "@babylonjs/core";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Body, atmosphereFactor, surfaceAltitude, surfaceRadius, isOverWater, waterSurfaceRadius } from "./planets";
import { buildShip, ShipRig } from "./shipBuilder";

export interface FlightState {
  velocity: Vector3;
  target: Body | null;
  /** Persistent arcade cruise speed (units/s): the ship flies along its nose at this speed. */
  cruise: number;
  /** 0..1 peak atmospheric density across bodies (for HUD/FX). */
  atmoDensity: number;
  /** 0..1 re-entry heat estimate. */
  heat: number;
  /** Vertical speed relative to the nearest surface (negative = descending). */
  verticalSpeed: number;
  /** Altitude above the nearest visible surface (terrain / sea level). */
  altitude: number;
  /** True while resting on a surface. */
  landed: boolean;
  /** True while the contact surface is water (riding the waves). */
  floating: boolean;
  /** Smoothed radius of the water surface the ship rides (bob damping). */
  floatR: number;
  rig: ShipRig | null;
}

/** Combined steering deflection per axis (-1..1), keyboard + pointer added together. */
export interface SteerState {
  /** +1 = nose up (W); cursor above screen center is +. */
  pitch: number;
  /** +1 = nose left (A); cursor right of screen center is -. */
  yaw: number;
  /** +1 = roll right (E), -1 = roll left (Q). */
  roll: number;
}

// --- Arcade tuning --------------------------------------------------------
const CLEARANCE = 1.2; // resting gap between ship and the surface
const PITCH_RATE = 1.8; // steering rates (rad/s)
const YAW_RATE = 1.3;
const ROLL_RATE = 2.6; // manual Q/E roll
const MAX_BANK = 0.62; // bank target at full yaw (~35 deg)
const BANK_K = 3.5; // bank error -> roll rate gain (1/s)
const BANK_RATE_MAX = 2.2; // auto-bank / auto-level roll rate cap (rad/s)
const TRACK_SPACE = 2.4; // velocity-tracking gain in vacuum (1/s)
const TRACK_ATMO = 4.0; // extra tracking gain per unit of atmosphere density
const GRAV_ATMO = 5; // extra gravity at full density (arcade weight near the surface)
const GRAV_MU = 32; // multiplier on the mu/r^2 term (surface gravity ~8-13 u/s^2)
const GRAV_MAX = 25; // per-body acceleration cap
const PITCH_HOLD_BAND = 0.5; // horizon-hold acts within ~29 deg of level
const PITCH_HOLD_K = 1.2; // elevation error -> pitch leveling rate (1/s)
const PITCH_HOLD_MAX = 0.5; // max auto-leveling pitch rate (rad/s)
const DRAG_K = 0.3; // atmospheric drag per unit density (1/s)
const SOFT_IMPACT = 12; // |vertical speed| below this = gentle touchdown
const BOUNCE = 0.35; // restitution for hard impacts (< 1: never gains energy)
const LANDED_ENTER = 6; // landed flag hysteresis (u/s)
const LANDED_EXIT = 8;
const SPEED_SOFT_MAX = 900; // cruise decays back to this above it
const SPEED_HARD_MAX = 1200;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- Water splash (one-shot spray on splashdown) ---------------------------
let splashSystem: ParticleSystem | null = null;
let splashEmitter: Vector3 | null = null;

function splashTexture(scene: Scene): Texture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.45, "rgba(228,244,255,0.5)");
  g.addColorStop(1, "rgba(205,232,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new Texture(c.toDataURL("image/png"), scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
}

/** Spray burst scaled by impact speed (called at the moment of water contact). */
function burstSplash(ship: Mesh, impactSpeed: number): void {
  const scene = ship.getScene();
  if (!splashSystem) {
    splashEmitter = ship.position.clone();
    const ps = new ParticleSystem("splash", 220, scene);
    ps.particleTexture = splashTexture(scene);
    ps.emitter = splashEmitter;
    ps.color1 = new Color4(0.93, 0.97, 1, 1);
    ps.color2 = new Color4(0.72, 0.88, 1, 0.9);
    ps.colorDead = new Color4(0.8, 0.9, 1, 0);
    ps.minSize = 0.6;
    ps.maxSize = 2.4;
    ps.minLifeTime = 0.3;
    ps.maxLifeTime = 0.9;
    ps.emitRate = 0;
    ps.blendMode = Constants.ALPHA_ADD;
    ps.gravity = new Vector3(0, -14, 0);
    ps.direction1 = new Vector3(-7, 8, -7);
    ps.direction2 = new Vector3(7, 15, 7);
    ps.minEmitPower = 4;
    ps.maxEmitPower = 13;
    ps.updateSpeed = 0.016;
    splashSystem = ps;
  }
  if (splashEmitter && splashSystem) {
    splashEmitter.copyFrom(ship.position);
    splashSystem.manualEmitCount = Math.max(4, Math.min(70, Math.round(5 + impactSpeed * 2)));
  }
}

/** Nearest body measured by height above its visible surface. */
function nearestBody(bodies: Body[], position: Vector3): Body | null {
  let nearest: Body | null = null;
  let nearestAlt = Infinity;
  for (const b of bodies) {
    const alt = surfaceAltitude(b, position);
    if (alt < nearestAlt) { nearestAlt = alt; nearest = b; }
  }
  return nearest;
}

/**
 * Signed bank angle about the ship's nose relative to the local horizon
 * (radians; + = right wing down). Exposed for the HUD/tests and mirrored by
 * the roll controller so both always agree on which way is "level".
 */
export function bankAngle(ship: Mesh, bodies: Body[]): number {
  const q = ship.rotationQuaternion ?? Quaternion.Identity();
  const nose = new Vector3(0, 0, 1).applyRotationQuaternion(q);
  const up = new Vector3(0, 1, 0).applyRotationQuaternion(q);
  const nearest = nearestBody(bodies, ship.position);
  if (!nearest) return 0;
  const planetUp = ship.position.subtract(nearest.center).normalize();
  // rightH matches the ship's right wing when level; upH points to the horizon sky.
  const rightH = Vector3.Cross(planetUp, nose);
  if (rightH.lengthSquared() < 1e-6) return 0;
  rightH.normalize();
  const upH = Vector3.Cross(nose, rightH).normalize();
  return Math.atan2(Vector3.Dot(up, rightH), Vector3.Dot(up, upH));
}

export function createShip(scene: Scene): Mesh {
  const rig = buildShip(scene);
  const ship = rig.root;
  (ship as Mesh & { __rig?: ShipRig }).__rig = rig;
  return ship;
}

export function getRig(ship: Mesh): ShipRig | null {
  return (ship as Mesh & { __rig?: ShipRig }).__rig ?? null;
}

export function updateShip(
  ship: Mesh, state: FlightState, bodies: Body[], input: Record<string, boolean>,
  steer: SteerState, dt: number
): void {
  const rig = state.rig ?? getRig(ship);
  if (rig && !state.rig) state.rig = rig;

  const q0 = ship.rotationQuaternion ?? Quaternion.Identity();
  const nose0 = new Vector3(0, 0, 1).applyRotationQuaternion(q0);
  const up0 = new Vector3(0, 1, 0).applyRotationQuaternion(q0);
  const right0 = Vector3.Cross(up0, nose0).normalize();

  // Nearest body (by height above the visible surface) + atmosphere density.
  let density = 0;
  let nearest: Body | null = null;
  let nearestAlt = Infinity;
  for (const b of bodies) {
    const f = atmosphereFactor(b, ship.position);
    if (f > density) density = f;
    const alt = surfaceAltitude(b, ship.position);
    if (alt < nearestAlt) { nearestAlt = alt; nearest = b; }
  }
  state.atmoDensity = density;
  state.altitude = nearestAlt;

  // --- Speed: persistent arcade cruise, throttle / boost / brake.
  const boosting = !!input["shift"];
  const thrusting = !!input["arrowup"];
  const braking = !!input["space"] || !!input["c"];
  let cruise = state.cruise;
  if (braking) {
    cruise -= 200 * dt; // full brake always works, even while thrusting
  } else {
    if (thrusting) cruise += (boosting ? 260 : 60) * dt;
    if (input["arrowdown"]) cruise -= 90 * dt;
  }
  if (cruise > SPEED_SOFT_MAX && !(boosting && thrusting)) {
    cruise = Math.max(SPEED_SOFT_MAX, cruise - 150 * dt); // soft cap decay
  }
  state.cruise = clamp(cruise, 0, SPEED_HARD_MAX);

  // --- Steering: analog stick -> body-axis rotation rates.
  // Mild authority falloff at extreme speed keeps 1200 u/s from twitching.
  const auth = 1 - 0.35 * clamp((state.velocity.length() - 400) / 800, 0, 1);
  let q = ship.rotationQuaternion ?? Quaternion.Identity();
  const planetUp = nearest ? ship.position.subtract(nearest.center).normalize() : null;

  if (steer.pitch !== 0) {
    // +pitch = nose up. Positive rotation about +right pitches the nose
    // down (right-hand rule), so negate.
    q = Quaternion.RotationAxis(right0, -steer.pitch * PITCH_RATE * auth * dt).multiply(q);
  }
  let nose1 = new Vector3(0, 0, 1).applyRotationQuaternion(q);
  let up1 = new Vector3(0, 1, 0).applyRotationQuaternion(q);
  if (steer.yaw !== 0) {
    // Yaw about the local horizon-vertical (body axis as fallback when the
    // nose is near vertical): turns stay flat instead of coning the nose
    // down once banked. +yaw = nose left, hence the negative angle.
    const yawAxis = planetUp && Math.abs(nose1.dot(planetUp)) < 0.95 ? planetUp : up1;
    q = Quaternion.RotationAxis(yawAxis, -steer.yaw * YAW_RATE * auth * dt).multiply(q);
    nose1 = new Vector3(0, 0, 1).applyRotationQuaternion(q);
    up1 = new Vector3(0, 1, 0).applyRotationQuaternion(q);
  }

  // Horizon hold: with the pitch stick released near level, gently pitch back
  // toward the local horizon so hands-off flight hugs the planet's curvature
  // instead of flying straight off into space. Deliberate climbs/dives
  // (|elevation| beyond the band) keep their attitude.
  if (planetUp && Math.abs(steer.pitch) < 0.01) {
    const elevation = Math.asin(clamp(nose1.dot(planetUp), -1, 1));
    const noseHoriz = nose1.subtract(planetUp.scale(nose1.dot(planetUp)));
    if (Math.abs(elevation) < PITCH_HOLD_BAND && noseHoriz.lengthSquared() > 0.01) {
      const levelRate = clamp(elevation * PITCH_HOLD_K, -PITCH_HOLD_MAX, PITCH_HOLD_MAX);
      if (Math.abs(levelRate) > 1e-4) {
        const levelAxis = Vector3.Cross(planetUp, noseHoriz).normalize();
        q = Quaternion.RotationAxis(levelAxis, levelRate * dt).multiply(q);
        nose1 = new Vector3(0, 0, 1).applyRotationQuaternion(q);
        up1 = new Vector3(0, 1, 0).applyRotationQuaternion(q);
      }
    }
  }

  // --- Roll: manual Q/E wins; otherwise bank into turns / auto-level.
  // One horizon-referenced bank controller replaces the old per-frame
  // accumulate-roll while yawing (barrel rolls) + slerp snap-back (wobble).
  if (nearest && planetUp) {
    const noseDotUp = Math.abs(nose1.dot(planetUp));
    if (Math.abs(steer.roll) > 0.01) {
      // Manual roll: direct rate, leveling paused while held.
      q = Quaternion.RotationAxis(nose1, -steer.roll * ROLL_RATE * auth * dt).multiply(q);
    } else if (noseDotUp < 0.9) {
      const rightH = Vector3.Cross(planetUp, nose1);
      if (rightH.lengthSquared() > 1e-6) {
        rightH.normalize();
        const upH = Vector3.Cross(nose1, rightH).normalize();
        const bank = Math.atan2(Vector3.Dot(up1, rightH), Vector3.Dot(up1, upH));
        // Yaw left (positive stick) banks left; yaw 0 = target 0 = smooth
        // auto-level. No banking while sitting on the ground.
        const targetBank = state.landed ? 0 : -steer.yaw * MAX_BANK;
        const rollRate = clamp((targetBank - bank) * BANK_K, -BANK_RATE_MAX, BANK_RATE_MAX);
        if (Math.abs(rollRate) > 1e-4) {
          q = Quaternion.RotationAxis(nose1, -rollRate * auth * dt).multiply(q);
        }
      }
    }
  }
  ship.rotationQuaternion = q;

  // --- Velocity: fly along the nose; gravity and drag still bite.
  const nose = new Vector3(0, 0, 1).applyRotationQuaternion(q);
  const desired = nose.scale(state.cruise);
  // Exponential tracking (framerate-proof): tight in atmosphere, drifty in vacuum.
  const track = 1 - Math.exp(-(TRACK_SPACE + TRACK_ATMO * density) * dt);
  state.velocity.copyFrom(Vector3.Lerp(state.velocity, desired, track));

  // Gravity: dt-correct acceleration toward each body (arcade strength near
  // the surface, mu/r^2 in the far field, capped against slingshot spikes).
  for (const body of bodies) {
    const toShip = ship.position.subtract(body.center);
    const dist = Math.max(toShip.length(), 1e-6);
    const r = Math.max(dist, body.radius * 1.02);
    const dir = toShip.scale(1 / dist);
    const f = atmosphereFactor(body, ship.position);
    const accel = Math.min(GRAV_ATMO * f + (GRAV_MU * body.mu) / (r * r), GRAV_MAX);
    state.velocity.addInPlace(dir.scale(-accel * dt));
  }

  // Light atmospheric drag (top speed a bit lower in thick air).
  if (density > 0.001) {
    state.velocity.scaleInPlace(Math.exp(-DRAG_K * density * dt));
  }

  // Re-entry heat ~ density * speed^2 normalized (glows on fast thick-air dives).
  const heatSpeed = state.velocity.length();
  const heatTarget = Math.min(1, density * (heatSpeed / 60) * (heatSpeed / 60));
  state.heat += (heatTarget - state.heat) * Math.min(1, dt * 2.5);

  ship.position.addInPlace(state.velocity.clone().scale(dt));

  // --- Ground contact: rest on the *visible* surface (terrain / sea / pad).
  // Over water the surface is the wave field (CPU mirror of the ocean shader),
  // so the ship floats, bobs and splashes down onto what the player sees.
  if (nearest) {
    const toShipNow = ship.position.subtract(nearest.center);
    const distNow = Math.max(toShipNow.length(), 1e-6);
    const dirNow = toShipNow.scale(1 / distNow);
    const surfNow = surfaceRadius(nearest, dirNow);
    const overWater = isOverWater(nearest, dirNow);
    let restR = surfNow;
    if (overWater) {
      const waveR = waterSurfaceRadius(nearest, dirNow);
      const k = state.floatR > 1 ? 1 - Math.exp(-5 * dt) : 1;
      state.floatR += (waveR - state.floatR) * k;
      restR = Math.max(restR, state.floatR);
    } else {
      state.floatR = 0;
    }
    state.floating = overWater;
    state.altitude = distNow - restR;
    state.verticalSpeed = state.velocity.dot(dirNow); // negative = descending
    if (distNow < restR + CLEARANCE) {
      ship.position.copyFrom(nearest.center).addInPlace(dirNow.scale(restR + CLEARANCE));
      const vN = state.verticalSpeed;
      if (vN < 0) {
        if (overWater && vN < -1.5) burstSplash(ship, -vN);
        if (vN > -SOFT_IMPACT) {
          // Gentle touchdown: kill the normal component, scrub the slide.
          state.velocity.addInPlace(dirNow.scale(-vN));
          state.velocity.scaleInPlace(Math.max(0, 1 - 2.5 * dt));
        } else {
          // Hard impact: bounce (restitution < 1, never gains energy) + scrub.
          state.velocity.addInPlace(dirNow.scale(-vN * (1 + BOUNCE)));
          state.velocity.scaleInPlace(0.55);
        }
      }
      const contactSpeed = state.velocity.length();
      if (contactSpeed < LANDED_ENTER) state.landed = true;
      else if (contactSpeed > LANDED_EXIT) state.landed = false;
      // Settle upright on the ground, but only with hands off the stick so
      // pitching up to take off is never fought by the leveler.
      const handsOff = Math.abs(steer.pitch) < 0.01 && Math.abs(steer.yaw) < 0.01
        && Math.abs(steer.roll) < 0.01;
      if (state.landed && handsOff) {
        // Keep the nose on the tangent plane, up = surface normal.
        const cur = ship.rotationQuaternion ?? Quaternion.Identity();
        const fwdNow = new Vector3(0, 0, 1).applyRotationQuaternion(cur);
        const tangent = fwdNow.subtract(dirNow.scale(fwdNow.dot(dirNow)));
        if (tangent.lengthSquared() > 0.01) {
          tangent.normalize();
          // NB: FromLookDirectionLH aims the local -Z at the given vector, so
          // negate to point the ship's nose (+Z) along the tangent.
          const target = Quaternion.FromLookDirectionLH(tangent.scale(-1), dirNow);
          ship.rotationQuaternion = Quaternion.Slerp(cur, target, 1 - Math.exp(-4 * dt));
        }
      }
    } else {
      state.landed = false;
    }
  } else {
    state.verticalSpeed = 0;
    state.landed = false;
    state.floating = false;
    state.floatR = 0;
  }

  if (rig) {
    // Engine FX follow throttle input, not airspeed (no glow while coasting).
    const thrustFx = braking ? 0.1 : thrusting ? (boosting ? 1 : 0.65) : 0.15;
    rig.setThrust(thrustFx);
    rig.setHeat(state.heat);
    rig.update(dt);
  }
}
