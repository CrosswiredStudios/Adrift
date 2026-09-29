import { Mesh, Scene, Vector3, Quaternion } from "@babylonjs/core";
import type { Pose } from "../common/pose";
import { IWorldBody, nearestWorldBody } from "../world/worldBody";
import { buildShip, ShipRig } from "./shipBuilder";
import { clamp } from "../common/math";
import { DEFAULT_TUNING, FlightTuning } from "./flightTuning";

export interface FlightState {
  velocity: Vector3;
  target: IWorldBody | null;
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
  /** Body whose sea `floatR` tracks (the value is meaningless across bodies). */
  floatBody?: IWorldBody | null;
  rig: ShipRig | null;
}

/** Combined steering deflection per axis (-1..1). */
export interface SteerState {
  /** +1 = nose up. */
  pitch: number;
  /** +1 = nose left. */
  yaw: number;
  /** +1 = roll right, -1 = roll left. */
  roll: number;
}

/** Engine commands for one sim step (from input actions, an autopilot or a test). */
export interface EngineCommand {
  throttleUp: boolean;
  throttleDown: boolean;
  brake: boolean;
  boost: boolean;
}

/** One-shot effects the flight model asks for (keeps particles out of physics). */
export interface FlightFx {
  splash(position: Vector3, impactSpeed: number): void;
}

// --- Arcade tuning --------------------------------------------------------
// Values live in flightTuning.ts (DEFAULT_TUNING); updateShip takes an
// optional override so tests/variants can tune without editing physics.

/** Nearest body measured by height above its visible surface. */
function nearestBody<T extends IWorldBody>(bodies: T[], position: Vector3): T | null {
  return nearestWorldBody(bodies, position);
}

/**
 * Signed bank angle about the ship's nose relative to the local horizon
 * (radians; + = right wing down). Exposed for the HUD/tests and mirrored by
 * the roll controller so both always agree on which way is "level".
 */
export function bankAngle(ship: Pose, bodies: IWorldBody[]): number {
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

export function createShip(scene: Scene): { mesh: Mesh; rig: ShipRig } {
  const rig = buildShip(scene);
  return { mesh: rig.root, rig };
}

export function updateShip<T extends IWorldBody>(
  ship: Pose,
  state: FlightState,
  bodies: T[],
  engine: EngineCommand,
  steer: SteerState,
  dt: number,
  tuning: FlightTuning = DEFAULT_TUNING,
  fx?: FlightFx,
): void {
  const rig = state.rig;

  const q0 = ship.rotationQuaternion ?? Quaternion.Identity();
  const nose0 = new Vector3(0, 0, 1).applyRotationQuaternion(q0);
  const up0 = new Vector3(0, 1, 0).applyRotationQuaternion(q0);
  const right0 = Vector3.Cross(up0, nose0).normalize();

  // Nearest body (by height above the visible surface) + atmosphere density.
  let density = 0;
  let nearest: T | null = null;
  let nearestAlt = Infinity;
  for (const b of bodies) {
    const f = b.atmosphereAt(ship.position);
    if (f > density) density = f;
    const alt = b.surfaceAltitudeAt(ship.position);
    if (alt < nearestAlt) {
      nearestAlt = alt;
      nearest = b;
    }
  }
  state.atmoDensity = density;
  state.altitude = nearestAlt;

  // --- Speed: persistent arcade cruise, throttle / boost / brake.
  const boosting = engine.boost;
  const thrusting = engine.throttleUp;
  const braking = engine.brake;
  let cruise = state.cruise;
  if (braking) {
    cruise -= 200 * dt; // full brake always works, even while thrusting
  } else {
    if (thrusting) cruise += (boosting ? 260 : 60) * dt;
    if (engine.throttleDown) cruise -= 90 * dt;
  }
  if (cruise > tuning.speedSoftMax && !(boosting && thrusting)) {
    cruise = Math.max(tuning.speedSoftMax, cruise - 150 * dt); // soft cap decay
  }
  state.cruise = clamp(cruise, 0, tuning.speedHardMax);

  // --- Steering: analog stick -> body-axis rotation rates.
  // Mild authority falloff at extreme speed keeps 1200 u/s from twitching.
  const auth = 1 - 0.35 * clamp((state.velocity.length() - 400) / 800, 0, 1);
  let q = ship.rotationQuaternion ?? Quaternion.Identity();
  const planetUp = nearest ? ship.position.subtract(nearest.center).normalize() : null;

  if (steer.pitch !== 0) {
    // +pitch = nose up. Positive rotation about +right pitches the nose
    // down (right-hand rule), so negate.
    q = Quaternion.RotationAxis(right0, -steer.pitch * tuning.pitchRate * auth * dt).multiply(q);
  }
  let nose1 = new Vector3(0, 0, 1).applyRotationQuaternion(q);
  let up1 = new Vector3(0, 1, 0).applyRotationQuaternion(q);
  if (steer.yaw !== 0) {
    // Yaw about the local horizon-vertical (body axis as fallback when the
    // nose is near vertical): turns stay flat instead of coning the nose
    // down once banked. +yaw = nose left, hence the negative angle.
    const yawAxis = planetUp && Math.abs(nose1.dot(planetUp)) < 0.95 ? planetUp : up1;
    q = Quaternion.RotationAxis(yawAxis, -steer.yaw * tuning.yawRate * auth * dt).multiply(q);
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
    if (Math.abs(elevation) < tuning.pitchHoldBand && noseHoriz.lengthSquared() > 0.01) {
      const levelRate = clamp(elevation * tuning.pitchHoldK, -tuning.pitchHoldMax, tuning.pitchHoldMax);
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
      q = Quaternion.RotationAxis(nose1, -steer.roll * tuning.rollRate * auth * dt).multiply(q);
    } else if (noseDotUp < 0.9) {
      const rightH = Vector3.Cross(planetUp, nose1);
      if (rightH.lengthSquared() > 1e-6) {
        rightH.normalize();
        const upH = Vector3.Cross(nose1, rightH).normalize();
        const bank = Math.atan2(Vector3.Dot(up1, rightH), Vector3.Dot(up1, upH));
        // Yaw left (positive stick) banks left; yaw 0 = target 0 = smooth
        // auto-level. No banking while sitting on the ground.
        const targetBank = state.landed ? 0 : -steer.yaw * tuning.maxBank;
        const rollRate = clamp((targetBank - bank) * tuning.bankK, -tuning.bankRateMax, tuning.bankRateMax);
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
  const track = 1 - Math.exp(-(tuning.trackSpace + tuning.trackAtmo * density) * dt);
  state.velocity.copyFrom(Vector3.Lerp(state.velocity, desired, track));

  // Gravity: dt-correct acceleration toward each body (arcade strength near
  // the surface, mu/r^2 in the far field, capped against slingshot spikes).
  for (const body of bodies) {
    const toShip = ship.position.subtract(body.center);
    const dist = Math.max(toShip.length(), 1e-6);
    const r = Math.max(dist, body.radius * 1.02);
    const dir = toShip.scale(1 / dist);
    const f = body.atmosphereAt(ship.position);
    const accel = Math.min(tuning.gravAtmo * f + (tuning.gravMu * body.mu) / (r * r), tuning.gravMax);
    state.velocity.addInPlace(dir.scale(-accel * dt));
  }

  // Light atmospheric drag (top speed a bit lower in thick air).
  if (density > 0.001) {
    state.velocity.scaleInPlace(Math.exp(-tuning.dragK * density * dt));
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
    const surfNow = nearest.surfaceRadiusAt(dirNow);
    const overWater = nearest.isOverWaterAt(dirNow);
    // The float height is only valid for the body whose sea it tracks. Arriving
    // over another body's water would otherwise inherit the previous planet's
    // waterline and snap the ship to a phantom altitude until the tracker decays.
    if (state.floatBody !== nearest) {
      state.floatR = 0;
      state.floatBody = nearest;
    }
    let restR = surfNow;
    if (overWater) {
      const waveR = nearest.waterSurfaceRadiusAt(dirNow);
      const k = state.floatR > 1 ? 1 - Math.exp(-5 * dt) : 1;
      state.floatR += (waveR - state.floatR) * k;
      restR = Math.max(restR, state.floatR);
    } else {
      state.floatR = 0;
    }
    state.floating = overWater;
    state.altitude = distNow - restR;
    state.verticalSpeed = state.velocity.dot(dirNow); // negative = descending
    if (distNow < restR + tuning.clearance) {
      ship.position.copyFrom(nearest.center).addInPlace(dirNow.scale(restR + tuning.clearance));
      const vN = state.verticalSpeed;
      if (vN < 0) {
        if (overWater && vN < -1.5) fx?.splash(ship.position, -vN);
        if (vN > -tuning.softImpact) {
          // Gentle touchdown: kill the normal component, scrub the slide.
          state.velocity.addInPlace(dirNow.scale(-vN));
          state.velocity.scaleInPlace(Math.max(0, 1 - 2.5 * dt));
        } else {
          // Hard impact: bounce (restitution < 1, never gains energy) + scrub.
          state.velocity.addInPlace(dirNow.scale(-vN * (1 + tuning.bounce)));
          state.velocity.scaleInPlace(0.55);
        }
      }
      const contactSpeed = state.velocity.length();
      if (contactSpeed < tuning.landedEnter) state.landed = true;
      else if (contactSpeed > tuning.landedExit) state.landed = false;
      // Settle upright on the ground, but only with hands off the stick so
      // pitching up to take off is never fought by the leveler.
      const handsOff =
        Math.abs(steer.pitch) < 0.01 && Math.abs(steer.yaw) < 0.01 && Math.abs(steer.roll) < 0.01;
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
  }
}
