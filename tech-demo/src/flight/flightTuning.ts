/**
 * Arcade flight tuning. Single home for every magic number in the flight
 * model so handling, gravity, and contact response can be tuned (or
 * overridden per ship) without editing physics code. Values are the
 * verified tech-demo tuning — change with care and re-run controls.spec.ts.
 */
export interface FlightTuning {
  /** Resting gap between ship and the surface. */
  clearance: number;
  /** Steering rates (rad/s). */
  pitchRate: number;
  yawRate: number;
  /** Manual Q/E roll rate (rad/s). */
  rollRate: number;
  /** Bank target at full yaw (~35 deg). */
  maxBank: number;
  /** Bank error -> roll rate gain (1/s). */
  bankK: number;
  /** Auto-bank / auto-level roll rate cap (rad/s). */
  bankRateMax: number;
  /** Velocity-tracking gain in vacuum (1/s). */
  trackSpace: number;
  /** Extra tracking gain per unit of atmosphere density. */
  trackAtmo: number;
  /** Extra gravity at full density (arcade weight near the surface). */
  gravAtmo: number;
  /** Multiplier on the mu/r^2 term (surface gravity ~8-13 u/s^2). */
  gravMu: number;
  /** Per-body acceleration cap. */
  gravMax: number;
  /** Horizon-hold acts within this elevation of level (~29 deg). */
  pitchHoldBand: number;
  /** Elevation error -> pitch leveling rate (1/s). */
  pitchHoldK: number;
  /** Max auto-leveling pitch rate (rad/s). */
  pitchHoldMax: number;
  /** Atmospheric drag per unit density (1/s). */
  dragK: number;
  /** |vertical speed| below this = gentle touchdown. */
  softImpact: number;
  /** Restitution for hard impacts (< 1: never gains energy). */
  bounce: number;
  /** Landed flag hysteresis (u/s). */
  landedEnter: number;
  landedExit: number;
  /** Cruise decays back to this above it. */
  speedSoftMax: number;
  /** Absolute cruise cap (boost). */
  speedHardMax: number;
}

export const DEFAULT_TUNING: FlightTuning = {
  clearance: 1.2,
  pitchRate: 1.8,
  yawRate: 1.3,
  rollRate: 2.6,
  maxBank: 0.62,
  bankK: 3.5,
  bankRateMax: 2.2,
  trackSpace: 2.4,
  trackAtmo: 4.0,
  gravAtmo: 5,
  gravMu: 32,
  gravMax: 25,
  pitchHoldBand: 0.5,
  pitchHoldK: 1.2,
  pitchHoldMax: 0.5,
  dragK: 0.3,
  softImpact: 12,
  bounce: 0.35,
  landedEnter: 6,
  landedExit: 8,
  speedSoftMax: 900,
  speedHardMax: 1200,
};
