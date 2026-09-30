/**
 * Save games: a versioned JSON snapshot of the simulation and progression.
 *
 * Everything that matters is sim state (body-frame positions of the ship
 * and player, which body each is in, and the clock that drives the rails),
 * so a save is small and independent of rendering. Bodies on rails are not
 * saved at all: they are a function of `time`.
 *
 * Bump SAVE_VERSION when the format changes and add a migration in
 * `migrate()`; unknown/newer versions are rejected rather than half-loaded.
 */
import { Quaternion, Vector3 } from "@babylonjs/core";
import type { SimWorld, ControlMode } from "../sim/world";
import type { Progression, ProgressionState } from "./progression";

export const SAVE_VERSION = 1;
export const SAVE_KEY = "adrift.save";

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

export interface SaveData {
  version: number;
  savedAt: string;
  time: number;
  mode: ControlMode;
  ship: {
    body: string;
    pos: V3;
    vel: V3;
    att: Q4;
    angVel: V3;
    assist: boolean;
    hull: number;
    landed: boolean;
  };
  player: { body: string; pos: V3; vel: V3; heading: V3; pitch: number };
  progression: ProgressionState;
}

const v3 = (v: Vector3): V3 => [v.x, v.y, v.z];
const q4 = (q: Quaternion): Q4 => [q.x, q.y, q.z, q.w];

export function captureSave(sim: SimWorld, progression: Progression): SaveData {
  const s = sim.ship;
  const p = sim.player;
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    time: sim.time,
    mode: sim.mode,
    ship: {
      body: sim.shipBody.id,
      pos: v3(s.pos),
      vel: v3(s.vel),
      att: q4(s.att),
      angVel: v3(s.angVel),
      assist: s.assist,
      hull: s.hull,
      landed: s.landed,
    },
    player: {
      body: sim.playerBody.id,
      pos: v3(p.pos),
      vel: v3(p.vel),
      heading: v3(p.heading),
      pitch: p.pitch,
    },
    progression: progression.save(),
  };
}

/** Validate + upgrade raw JSON to the current format (throws on bad data). */
export function migrate(raw: unknown): SaveData {
  if (!raw || typeof raw !== "object") throw new Error("Save is not an object");
  const d = raw as Partial<SaveData>;
  if (typeof d.version !== "number") throw new Error("Save has no version");
  if (d.version > SAVE_VERSION)
    throw new Error(`Save version ${d.version} is newer than this build (${SAVE_VERSION})`);
  // (Future: if (d.version === 1) { ...upgrade to 2... })
  const finite = (a: unknown, n: number): boolean =>
    Array.isArray(a) && a.length === n && a.every((x) => typeof x === "number" && Number.isFinite(x));
  if (
    typeof d.time !== "number" ||
    !d.ship ||
    !d.player ||
    !d.progression ||
    !finite(d.ship.pos, 3) ||
    !finite(d.ship.vel, 3) ||
    !finite(d.ship.att, 4) ||
    !finite(d.player.pos, 3) ||
    !finite(d.player.heading, 3)
  ) {
    throw new Error("Save is missing fields");
  }
  return d as SaveData;
}

/** Restore a snapshot into a live sim + progression. */
export function applySave(data: SaveData, sim: SimWorld, progression: Progression): void {
  const shipBody = sim.system.get(data.ship.body);
  const playerBody = sim.system.get(data.player.body);
  sim.time = data.time;
  sim.mode = data.mode;
  sim.shipBody = shipBody;
  sim.playerBody = playerBody;
  const s = sim.ship;
  s.pos.fromArray(data.ship.pos);
  s.vel.fromArray(data.ship.vel);
  s.att.set(...data.ship.att).normalize();
  s.angVel.fromArray(data.ship.angVel ?? [0, 0, 0]);
  s.assist = data.ship.assist;
  s.hull = data.ship.hull;
  s.landed = data.ship.landed;
  s.heat = 0;
  s.wake();
  const p = sim.player;
  p.pos.fromArray(data.player.pos);
  p.vel.fromArray(data.player.vel ?? [0, 0, 0]);
  p.heading.fromArray(data.player.heading);
  p.pitch = data.player.pitch ?? 0;
  progression.load(data.progression);
}

/** localStorage wrapper that never throws (private mode, quota, disabled storage). */
export const saveStore = {
  write(data: SaveData): boolean {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
      return true;
    } catch {
      return false;
    }
  },
  read(): SaveData | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      return raw ? migrate(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  },
  has(): boolean {
    try {
      return localStorage.getItem(SAVE_KEY) !== null;
    } catch {
      return false;
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
  },
};
