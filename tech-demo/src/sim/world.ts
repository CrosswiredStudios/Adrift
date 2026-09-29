/**
 * SimWorld: the whole simulation state, independent of rendering.
 *
 * Owns the clock, the celestial system on rails, the ship and the player,
 * the control mode, and per-body environments (terrain, water, air,
 * static colliders) that the physics query. `step(dt)` advances everything
 * by one fixed step; nothing here touches Babylon's scene graph, so the
 * whole game can be simulated headless (tests, saves, time warp).
 *
 * Every mobile object lives in the body-fixed frame of its dominant body;
 * when it crosses a sphere-of-influence boundary its state is transferred
 * exactly to the new body's frame.
 */
import { Quaternion, Vector3 } from "@babylonjs/core";
import { CelestialBody, CelestialSystem } from "./celestial";
import { snapshotFrame, transferState, pointToInertial, velocityToInertial } from "./frames";
import {
  ShipSim,
  SKIFF,
  emptyControls,
  type ShipControls,
  type ShipEnvironment,
  type StaticCollider,
} from "./shipSim";
import { CharacterSim, emptyCharacterControls, type CharacterControls } from "./character";
import { terrainNormal, terrainRadius, seaRadius as shapeSeaRadius, hasOcean } from "../terrain/heightField";
import type { BodyDef } from "../data/system";
import { buildWaveSet, cpuWaveHeightAt, type WaveSet } from "../ocean/oceanWaves";

export type ControlMode = "onFoot" | "ship";

export interface WorldEvents {
  splash?(bodyId: string, positionBody: Vector3, speed: number): void;
  shipImpact?(speed: number, damage: number): void;
  soiChange?(entity: "ship" | "player", from: string, to: string): void;
  modeChange?(mode: ControlMode): void;
}

export interface BodyEnvironment extends ShipEnvironment {
  def: BodyDef;
  body: CelestialBody;
  waves: WaveSet | null;
  colliders: StaticCollider[];
}

/** Interaction radius around the ship's hatch (m). */
export const BOARD_RADIUS = 4.5;
/** Hatch position in ship-local coordinates (port side, behind the canopy). */
export const HATCH_LOCAL = new Vector3(-1.6, -0.4, 0.4);

export class SimWorld {
  readonly system: CelestialSystem;
  readonly defs = new Map<string, BodyDef>();
  readonly envs = new Map<string, BodyEnvironment>();
  time = 0;

  readonly ship = new ShipSim(SKIFF);
  shipBody: CelestialBody;
  readonly player = new CharacterSim();
  playerBody: CelestialBody;
  mode: ControlMode = "onFoot";

  readonly shipControls: ShipControls = emptyControls();
  readonly playerControls: CharacterControls = emptyCharacterControls();
  events: WorldEvents = {};

  constructor(defs: BodyDef[], startBody: string) {
    this.system = new CelestialSystem(defs);
    for (const d of defs) {
      this.defs.set(d.id, d);
      this.envs.set(d.id, this.makeEnv(d, this.system.get(d.id)));
    }
    this.shipBody = this.system.get(startBody);
    this.playerBody = this.shipBody;
  }

  private makeEnv(def: BodyDef, body: CelestialBody): BodyEnvironment {
    const shape = def.terrain;
    const waves =
      def.ocean && shape && hasOcean(shape)
        ? buildWaveSet({ seaState: def.ocean.seaState }, shape.seed)
        : null;
    const sea = shape && hasOcean(shape) ? shapeSeaRadius(shape) : null;
    const atmo = def.atmosphere ?? null;
    const p = new Vector3();
    const env: BodyEnvironment = {
      def,
      body,
      waves,
      colliders: [],
      mu: body.mu,
      spinRate: body.spinRate,
      radius: body.radius,
      surfaceRadius: shape ? (x, y, z) => terrainRadius(shape, x, y, z) : () => body.radius,
      surfaceNormal: shape ? (x, y, z) => terrainNormal(shape, x, y, z, 0.6) : (x, y, z) => [x, y, z],
      waterRadius:
        sea !== null && waves
          ? (x, y, z) => {
              p.set(x * sea, y * sea, z * sea);
              return sea + cpuWaveHeightAt(waves, p, this.time);
            }
          : () => null,
      airDensity: atmo
        ? (alt) => (alt >= atmo.height ? 0 : Math.exp(-Math.max(alt, 0) / atmo.rayleighScale) * atmo.drag)
        : () => 0,
      atmosphereTop: atmo ? atmo.height : null,
    };
    env.colliders = [];
    (env as ShipEnvironment).colliders = env.colliders;
    return env;
  }

  env(body: CelestialBody): BodyEnvironment {
    const e = this.envs.get(body.id);
    if (!e) throw new Error(`no environment for ${body.id}`);
    return e;
  }

  /** Box collider around the ship (for the player walking around it), body frame. */
  shipCollider(): StaticCollider {
    const s = this.ship;
    const ax = s.axis(Vector3.Right());
    const ay = s.axis(Vector3.Up());
    const az = s.axis(Vector3.Forward());
    return {
      center: s.pos.add(ay.scale(-0.2)),
      axes: [ax, ay, az],
      halfExtents: new Vector3(1.1, 0.8, 3.0),
    };
  }

  /** Hatch position (body frame). */
  hatchPosition(out = new Vector3()): Vector3 {
    return this.ship.pos.addToRef(HATCH_LOCAL.applyRotationQuaternion(this.ship.att), out);
  }

  /** Can the player board right now? */
  canBoard(): boolean {
    if (this.mode !== "onFoot" || this.playerBody !== this.shipBody) return false;
    const eye = this.player.eye();
    return Vector3.Distance(eye, this.hatchPosition()) < BOARD_RADIUS;
  }

  /** Can the pilot step out right now (slow, on the ground or water)? */
  canExit(): boolean {
    return this.mode === "ship" && (this.ship.landed || this.ship.floating) && this.ship.vel.length() < 1.5;
  }

  board(): boolean {
    if (!this.canBoard()) return false;
    this.mode = "ship";
    this.ship.wake();
    this.events.modeChange?.("ship");
    return true;
  }

  exitShip(): boolean {
    if (!this.canExit()) return false;
    // Step out next to the hatch, on the ground.
    const env = this.env(this.shipBody);
    const out = this.ship.pos.add(this.ship.axis(new Vector3(-3.4, 0, 0.4)));
    const dir = out.normalize();
    const heading = this.ship.axis(Vector3.Forward());
    this.playerBody = this.shipBody;
    this.player.placeOnSurface(dir, heading, env);
    const water = env.waterRadius(dir.x, dir.y, dir.z);
    if (water !== null && water > this.player.pos.length()) this.player.pos.copyFrom(dir.scale(water - 1.2));
    this.mode = "onFoot";
    this.events.modeChange?.("onFoot");
    return true;
  }

  /** Advance the simulation by one fixed step. */
  step(dt: number): void {
    const shipEnv = this.env(this.shipBody);
    const shipControls = this.mode === "ship" ? this.shipControls : emptyControls();
    this.ship.step(dt, shipControls, shipEnv, {
      splash: (pos, speed) => this.events.splash?.(this.shipBody.id, pos, speed),
      impact: (speed, damage) => this.events.shipImpact?.(speed, damage),
    });

    if (this.mode === "onFoot") {
      const env = this.env(this.playerBody);
      const extra = this.playerBody === this.shipBody ? [this.shipCollider()] : [];
      this.player.step(dt, this.playerControls, env, extra);
    } else {
      // The pilot rides along (for SOI bookkeeping and saves).
      this.player.pos.copyFrom(this.ship.pos);
      this.player.vel.copyFrom(this.ship.vel);
      this.playerBody = this.shipBody;
    }

    this.time += dt;
    this.updateSoi();
  }

  private updateSoi(): void {
    // Ship.
    const f = snapshotFrame(this.shipBody, this.time);
    const shipI = pointToInertial(f, this.ship.pos);
    const next = this.system.dominantBody(this.time, shipI, this.shipBody);
    if (next !== this.shipBody) {
      const to = snapshotFrame(next, this.time);
      transferState(f, to, this.ship.pos, this.ship.vel, this.ship.att);
      const from = this.shipBody.id;
      this.shipBody = next;
      this.ship.wake();
      this.events.soiChange?.("ship", from, next.id);
    }
    if (this.mode === "onFoot") {
      const pf = snapshotFrame(this.playerBody, this.time);
      const pI = pointToInertial(pf, this.player.pos);
      const pn = this.system.dominantBody(this.time, pI, this.playerBody);
      if (pn !== this.playerBody) {
        const to = snapshotFrame(pn, this.time);
        const q = Quaternion.Identity();
        transferState(pf, to, this.player.pos, this.player.vel, q);
        const from = this.playerBody.id;
        this.playerBody = pn;
        this.events.soiChange?.("player", from, pn.id);
      }
    }
  }

  /** The body the camera/controlled entity is in. */
  focusBody(): CelestialBody {
    return this.mode === "ship" ? this.shipBody : this.playerBody;
  }

  /** Inertial position + velocity of the ship. */
  shipInertial(outPos = new Vector3(), outVel = new Vector3()): { pos: Vector3; vel: Vector3 } {
    const f = snapshotFrame(this.shipBody, this.time);
    pointToInertial(f, this.ship.pos, outPos);
    velocityToInertial(f, this.ship.pos, this.ship.vel, outVel);
    return { pos: outPos, vel: outVel };
  }

  /** Altitude of the ship above the mean radius of its body. */
  shipAltitude(): number {
    return this.ship.pos.length() - this.shipBody.radius;
  }
}
