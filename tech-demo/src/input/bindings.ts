/**
 * Input actions and their default bindings. Gameplay code only ever reads
 * actions ("thrustForward", "jump"), never keys, so controls can be rebound,
 * driven by a gamepad, or synthesized by tests and autopilots without
 * touching the simulation.
 *
 * Keys use `KeyboardEvent.code` (physical position), so WASD stays WASD on
 * AZERTY/QWERTZ layouts.
 */

/** Digital actions: true while held; edges are reported per sim step. */
export type ButtonAction =
  | "pause"
  | "quality"
  | "interact"
  | "inventory"
  | "toggleAssist"
  | "matchVelocity"
  | "landingMode"
  | "boost"
  | "jump"
  | "sprint"
  | "target1"
  | "target2"
  | "target3"
  | "target4"
  | "cameraToggle"
  | "orbitLines";

/** Analog actions in [-1, 1] (keys give -1/0/+1; sticks and mouse are analog). */
export type AxisAction =
  | "thrustZ" // + forward (main engine), - retro
  | "thrustX" // + strafe right
  | "thrustY" // + up (vertical thrusters)
  | "pitch" // + nose up
  | "yaw" // + nose right
  | "roll" // + roll right
  | "moveX" // + strafe right (on foot)
  | "moveZ" // + forward (on foot)
  | "lookX" // mouse / stick look, + right: per-step delta in radians (not clamped)
  | "lookY"; // + up. The ship reads these as a virtual stick (see shipControls).

export type ButtonBinding =
  { kind: "key"; code: string } | { kind: "mouse"; button: number } | { kind: "pad"; button: number };

export type AxisBinding =
  /** Two keys make an axis: `neg` gives -1, `pos` gives +1. */
  | { kind: "keys"; neg: string; pos: string }
  /** Gamepad stick axis (standard mapping index), optional inversion. */
  | { kind: "padAxis"; axis: number; invert?: boolean; scale?: number }
  /** Gamepad button pair (triggers/bumpers) as an axis. */
  | { kind: "padButtons"; neg: number; pos: number }
  /** Pointer-lock mouse motion; `scale` converts pixels to axis units. */
  | { kind: "mouse"; axis: "x" | "y"; invert?: boolean; scale?: number };

export interface BindingMap {
  buttons: Record<ButtonAction, ButtonBinding[]>;
  axes: Record<AxisAction, AxisBinding[]>;
}

const key = (code: string): ButtonBinding => ({ kind: "key", code });
const pad = (button: number): ButtonBinding => ({ kind: "pad", button });

/** Default bindings (keyboard + mouse + standard-mapping gamepad). */
export function defaultBindings(): BindingMap {
  return {
    buttons: {
      pause: [key("Escape"), pad(9)],
      quality: [key("KeyH")],
      interact: [key("KeyF"), pad(2)],
      inventory: [key("Tab"), pad(8)],
      toggleAssist: [key("KeyT"), pad(3)],
      matchVelocity: [key("KeyX"), pad(1)],
      landingMode: [key("KeyL"), pad(12)],
      boost: [key("ShiftLeft"), key("ShiftRight"), pad(10)],
      jump: [key("Space"), pad(0)],
      sprint: [key("ShiftLeft"), key("ShiftRight"), pad(10)],
      target1: [key("Digit1")],
      target2: [key("Digit2")],
      target3: [key("Digit3")],
      target4: [key("Digit4")],
      cameraToggle: [key("KeyV"), pad(11)],
      orbitLines: [key("KeyO")],
    },
    axes: {
      thrustZ: [
        { kind: "keys", neg: "KeyS", pos: "KeyW" },
        { kind: "padButtons", neg: 6, pos: 7 },
      ],
      thrustX: [
        { kind: "keys", neg: "KeyA", pos: "KeyD" },
        { kind: "padAxis", axis: 0 },
      ],
      thrustY: [
        { kind: "keys", neg: "KeyC", pos: "Space" },
        { kind: "padButtons", neg: 4, pos: 5 },
      ],
      pitch: [
        { kind: "keys", neg: "ArrowDown", pos: "ArrowUp" },
        { kind: "padAxis", axis: 3, invert: true },
      ],
      yaw: [
        { kind: "keys", neg: "ArrowLeft", pos: "ArrowRight" },
        { kind: "padAxis", axis: 2 },
      ],
      roll: [{ kind: "keys", neg: "KeyQ", pos: "KeyE" }],
      moveX: [
        { kind: "keys", neg: "KeyA", pos: "KeyD" },
        { kind: "padAxis", axis: 0 },
      ],
      moveZ: [
        { kind: "keys", neg: "KeyS", pos: "KeyW" },
        { kind: "padAxis", axis: 1, invert: true },
      ],
      lookX: [
        { kind: "mouse", axis: "x", scale: 0.0022 },
        { kind: "keys", neg: "ArrowLeft", pos: "ArrowRight" },
        { kind: "padAxis", axis: 2, scale: 0.05 },
      ],
      lookY: [
        { kind: "mouse", axis: "y", invert: true, scale: 0.0022 },
        { kind: "keys", neg: "ArrowDown", pos: "ArrowUp" },
        { kind: "padAxis", axis: 3, invert: true, scale: 0.05 },
      ],
    },
  };
}

/** Human-readable label for a binding (pause-menu controls list). */
export function describeBinding(b: ButtonBinding | AxisBinding, posFirst = false): string {
  const k = (code: string): string =>
    code
      .replace(/^Key/, "")
      .replace(/^Digit/, "")
      .replace(/^Arrow/, "")
      .replace(/(Left|Right)$/, (m) => (code.startsWith("Arrow") ? m : ""));
  switch (b.kind) {
    case "key":
      return k(b.code);
    case "mouse":
      return "button" in b ? `Mouse ${b.button}` : `Mouse ${b.axis.toUpperCase()}`;
    case "pad":
      return `Pad ${b.button}`;
    case "keys":
      return posFirst ? `${k(b.pos)}/${k(b.neg)}` : `${k(b.neg)}/${k(b.pos)}`;
    case "padAxis":
      return `Stick ${b.axis}`;
    case "padButtons":
      return posFirst ? `Pad ${b.pos}/${b.neg}` : `Pad ${b.neg}/${b.pos}`;
  }
}
