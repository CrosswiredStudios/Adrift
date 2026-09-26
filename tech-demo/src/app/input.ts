/**
 * Keyboard + pointer input. Physical-key tokens (e.code) so WASD works on
 * non-QWERTY layouts; pointer deflection is an analog stick around canvas
 * center. The combined stick is eased inside the sim tick so __game.step
 * stays deterministic for tests.
 */
import { clamp, smoothstep } from "../common/math";
import type { SteerState } from "../flight/flight";

const KEY_TOKENS: Record<string, string> = {
  KeyW: "w",
  KeyA: "a",
  KeyS: "s",
  KeyD: "d",
  KeyQ: "q",
  KeyE: "e",
  KeyC: "c",
  KeyH: "h",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  Space: "space",
  ShiftLeft: "shift",
  ShiftRight: "shift",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
};
const HANDLED = new Set(Object.values(KEY_TOKENS));

function keyToken(e: KeyboardEvent): string {
  return KEY_TOKENS[e.code] ?? e.key.toLowerCase();
}

export interface InputState {
  input: Record<string, boolean>;
  pointer: { x: number; y: number };
  steer: SteerState;
  /** Smoothed pointer deflection (internal easing state). */
  eased: { x: number; y: number };
  onToggleQuality: () => void;
  onSelectTarget: (index: number) => void;
}

const clamp1 = (v: number): number => clamp(v, -1, 1);

export function createInput(
  canvas: HTMLCanvasElement,
  opts: Pick<InputState, "onToggleQuality" | "onSelectTarget">,
): InputState {
  const input: Record<string, boolean> = {};
  const pointer = { x: 0, y: 0 };
  const steer: SteerState = { pitch: 0, yaw: 0, roll: 0 };
  const eased = { x: 0, y: 0 };

  const clear = (): void => {
    for (const k of Object.keys(input)) input[k] = false;
  };

  addEventListener("keydown", (e) => {
    const token = keyToken(e);
    if (!HANDLED.has(token)) return;
    e.preventDefault();
    input[token] = true;
    if (e.repeat) return;
    if (token === "1") opts.onSelectTarget(0);
    if (token === "2") opts.onSelectTarget(1);
    if (token === "3") opts.onSelectTarget(2);
    if (token === "h") opts.onToggleQuality();
  });
  addEventListener("keyup", (e) => {
    const token = keyToken(e);
    if (HANDLED.has(token)) input[token] = false;
  });
  addEventListener("blur", clear);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clear();
  });

  addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let x = (e.clientX - cx) / (rect.width * 0.38);
    let y = (cy - e.clientY) / (rect.height * 0.38);
    const len = Math.hypot(x, y);
    const dead = 0.06;
    if (len <= dead) {
      x = 0;
      y = 0;
    } else {
      const mag = Math.pow(Math.min(1, (len - dead) / (1 - dead)), 1.4);
      x = (x / len) * mag;
      y = (y / len) * mag;
    }
    pointer.x = clamp1(x);
    pointer.y = clamp1(y);
  });

  return {
    input,
    pointer,
    steer,
    eased,
    onToggleQuality: opts.onToggleQuality,
    onSelectTarget: opts.onSelectTarget,
  };
}

/** Ease the combined keyboard+pointer stick. Call at the top of tick(). */
export function updateControls(s: InputState, dt: number): void {
  const f = 1 - Math.exp(-16 * dt);
  s.eased.x += (s.pointer.x - s.eased.x) * f;
  s.eased.y += (s.pointer.y - s.eased.y) * f;
  const keyPitch = (s.input["w"] ? 1 : 0) - (s.input["s"] ? 1 : 0);
  const keyYaw = (s.input["a"] ? 1 : 0) - (s.input["d"] ? 1 : 0);
  const keyRoll = (s.input["e"] ? 1 : 0) - (s.input["q"] ? 1 : 0);
  s.steer.pitch = clamp1(keyPitch + s.eased.y);
  s.steer.yaw = clamp1(keyYaw - s.eased.x);
  s.steer.roll = clamp1(keyRoll);
}

/** Daylight ramp shared by the sky, lighting, and atmosphere updates. */
export function daylightFactor(sunAbove: number): number {
  return smoothstep(-0.06, 0.3, sunAbove);
}
