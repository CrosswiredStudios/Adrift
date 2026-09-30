/**
 * Device input -> action state.
 *
 * Browser events (keyboard, mouse, pointer lock, gamepad) only update raw
 * device state here. Once per sim step, `beginStep()` folds that raw state
 * into action values (`button`, `pressed`, `axis`) that stay constant for
 * the whole step, so every system sees the same input and a replayed step
 * gives the same result. Edge events (a key pressed between two steps) are
 * reported on the first step after they happen, even if it was released
 * again before that step ran.
 *
 * "Immediate" actions (pause, quality) also fire a callback straight from
 * the DOM event, because they must work while the sim is frozen.
 */
import {
  AxisAction,
  AxisBinding,
  BindingMap,
  ButtonAction,
  ButtonBinding,
  defaultBindings,
} from "./bindings";

const DEADZONE = 0.15;

export interface ActionState {
  /** True while any binding for the action is held. */
  button(a: ButtonAction): boolean;
  /** True on the first sim step after the action was pressed. */
  pressed(a: ButtonAction): boolean;
  /** Combined axis value in [-1, 1] (mouse axes may exceed 1 for a fast flick). */
  axis(a: AxisAction): number;
}

export interface InputSystemOptions {
  /** Element that captures the pointer on click (the game canvas). */
  canvas?: HTMLCanvasElement;
  /** Event target for key listeners (defaults to window). */
  target?: Window;
  bindings?: BindingMap;
}

export class InputSystem implements ActionState {
  bindings: BindingMap;
  /** Physical keys currently down (KeyboardEvent.code). */
  readonly keys = new Set<string>();
  private readonly keysPressedSinceStep = new Set<string>();
  private readonly mouseButtons = new Set<number>();
  private readonly mousePressedSinceStep = new Set<number>();
  private mouseDX = 0;
  private mouseDY = 0;
  private padButtonsPrev: boolean[] = [];

  // Per-step snapshot.
  private stepButtons = new Map<ButtonAction, boolean>();
  private stepPressed = new Set<ButtonAction>();
  private stepAxes = new Map<AxisAction, number>();
  private stepMouseDX = 0;
  private stepMouseDY = 0;

  /** Synthetic overrides (tests, autopilot): these win over devices. */
  readonly overrideButtons = new Map<ButtonAction, boolean>();
  readonly overrideAxes = new Map<AxisAction, number>();
  private readonly overridePressed = new Set<ButtonAction>();

  private readonly immediate = new Map<ButtonAction, Set<() => void>>();
  private readonly disposers: (() => void)[] = [];
  /** True while the pointer is locked to the canvas (mouse-look active). */
  pointerLocked = false;
  /** Set false to keep canvas clicks from grabbing the pointer (menus). */
  allowPointerLock = true;
  /** Called when the pointer lock is released by the browser (e.g. Esc). */
  onPointerLockLost: (() => void) | null = null;

  constructor(opts: InputSystemOptions = {}) {
    this.bindings = opts.bindings ?? defaultBindings();
    const win = opts.target ?? (typeof window !== "undefined" ? window : undefined);
    if (win) this.attach(win, opts.canvas);
  }

  private listen<K extends keyof WindowEventMap | keyof DocumentEventMap>(
    t: Window | Document,
    type: K,
    fn: (e: K extends keyof WindowEventMap ? WindowEventMap[K] : Event) => void,
  ): void {
    t.addEventListener(type, fn as EventListener);
    this.disposers.push(() => t.removeEventListener(type, fn as EventListener));
  }

  private attach(win: Window, canvas?: HTMLCanvasElement): void {
    this.listen(win, "keydown", (e) => {
      if (this.isBoundKey(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.keysPressedSinceStep.add(e.code);
      this.fireImmediate({ kind: "key", code: e.code });
    });
    this.listen(win, "keyup", (e) => {
      this.keys.delete(e.code);
    });
    this.listen(win, "blur", () => this.releaseAll());
    this.listen(win.document, "visibilitychange", () => {
      if (win.document.hidden) this.releaseAll();
    });
    this.listen(win, "mousedown", (e) => {
      this.mouseButtons.add(e.button);
      this.mousePressedSinceStep.add(e.button);
    });
    this.listen(win, "mouseup", (e) => this.mouseButtons.delete(e.button));
    this.listen(win, "mousemove", (e) => {
      if (!this.pointerLocked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    if (canvas) {
      const onClick = (): void => {
        if (this.allowPointerLock && !this.pointerLocked) {
          // requestPointerLock returns a promise in modern browsers; failures
          // (e.g. headless, iframe policy) are harmless.
          const r = canvas.requestPointerLock?.() as unknown;
          if (r instanceof Promise) r.catch(() => undefined);
        }
      };
      canvas.addEventListener("click", onClick);
      this.disposers.push(() => canvas.removeEventListener("click", onClick));
      this.listen(win.document, "pointerlockchange", () => {
        const was = this.pointerLocked;
        this.pointerLocked = win.document.pointerLockElement === canvas;
        this.mouseDX = 0;
        this.mouseDY = 0;
        if (was && !this.pointerLocked) this.onPointerLockLost?.();
      });
    }
  }

  /** Release the pointer (menus, pause). */
  exitPointerLock(): void {
    if (typeof document !== "undefined" && document.pointerLockElement) document.exitPointerLock();
  }

  private isBoundKey(code: string): boolean {
    for (const list of Object.values(this.bindings.buttons))
      for (const b of list) if (b.kind === "key" && b.code === code) return true;
    for (const list of Object.values(this.bindings.axes))
      for (const b of list) if (b.kind === "keys" && (b.neg === code || b.pos === code)) return true;
    return false;
  }

  /** Clear every held key/button (focus loss must not leave thrusters stuck on). */
  releaseAll(): void {
    this.keys.clear();
    this.mouseButtons.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  /** Register a callback fired directly from the DOM event (works while paused). */
  onImmediate(action: ButtonAction, fn: () => void): () => void {
    let set = this.immediate.get(action);
    if (!set) {
      set = new Set();
      this.immediate.set(action, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  private fireImmediate(b: ButtonBinding): void {
    for (const [action, fns] of this.immediate) {
      const list = this.bindings.buttons[action];
      const hit = list.some(
        (x) =>
          (x.kind === "key" && b.kind === "key" && x.code === b.code) ||
          (x.kind === "pad" && b.kind === "pad" && x.button === b.button),
      );
      if (hit) for (const fn of [...fns]) fn();
    }
  }

  /** Simulate a key press/release (tests). Goes through the same path as DOM events. */
  setKey(code: string, down: boolean): void {
    if (down) {
      if (!this.keys.has(code)) {
        this.keys.add(code);
        this.keysPressedSinceStep.add(code);
        this.fireImmediate({ kind: "key", code });
      }
    } else this.keys.delete(code);
  }

  /** Force an action on/off regardless of devices (tests, autopilot). `undefined` clears. */
  setButton(a: ButtonAction, down: boolean | undefined): void {
    if (down === undefined) this.overrideButtons.delete(a);
    else {
      if (down && !this.overrideButtons.get(a)) this.overridePressed.add(a);
      this.overrideButtons.set(a, down);
    }
  }

  /** Force an axis value (tests, autopilot). `undefined` clears the override. */
  setAxis(a: AxisAction, v: number | undefined): void {
    if (v === undefined) this.overrideAxes.delete(a);
    else this.overrideAxes.set(a, v);
  }

  /** Clear every synthetic override. */
  clearOverrides(): void {
    this.overrideButtons.clear();
    this.overrideAxes.clear();
    this.overridePressed.clear();
  }

  /** Add raw mouse motion (tests; pointer-lock mousemove does this). */
  addMouseDelta(dx: number, dy: number): void {
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  private readGamepad(): { buttons: boolean[]; values: number[]; axes: number[] } | null {
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    const pads = nav?.getGamepads?.() ?? [];
    for (const p of pads) {
      if (p && p.connected && p.mapping === "standard") {
        return {
          buttons: p.buttons.map((b) => b.pressed),
          values: p.buttons.map((b) => b.value),
          axes: p.axes.map((a) =>
            Math.abs(a) < DEADZONE ? 0 : (a - Math.sign(a) * DEADZONE) / (1 - DEADZONE),
          ),
        };
      }
    }
    return null;
  }

  private buttonHeld(b: ButtonBinding, pad: ReturnType<InputSystem["readGamepad"]>): boolean {
    switch (b.kind) {
      case "key":
        return this.keys.has(b.code) || this.keysPressedSinceStep.has(b.code);
      case "mouse":
        return this.mouseButtons.has(b.button) || this.mousePressedSinceStep.has(b.button);
      case "pad":
        return !!pad?.buttons[b.button];
    }
  }

  private buttonPressed(b: ButtonBinding, pad: ReturnType<InputSystem["readGamepad"]>): boolean {
    switch (b.kind) {
      case "key":
        return this.keysPressedSinceStep.has(b.code);
      case "mouse":
        return this.mousePressedSinceStep.has(b.button);
      case "pad":
        return !!pad?.buttons[b.button] && !this.padButtonsPrev[b.button];
    }
  }

  private axisValue(b: AxisBinding, pad: ReturnType<InputSystem["readGamepad"]>): number {
    switch (b.kind) {
      case "keys":
        return (this.keys.has(b.pos) ? 1 : 0) - (this.keys.has(b.neg) ? 1 : 0);
      case "padAxis": {
        const v = pad?.axes[b.axis] ?? 0;
        return (b.invert ? -v : v) * (b.scale ?? 1);
      }
      case "padButtons":
        return (pad?.values[b.pos] ?? 0) - (pad?.values[b.neg] ?? 0);
      case "mouse": {
        const d = b.axis === "x" ? this.stepMouseDX : this.stepMouseDY;
        return (b.invert ? -d : d) * (b.scale ?? 1);
      }
    }
  }

  /**
   * Snapshot devices into action state for the next sim step. Call exactly
   * once at the top of every fixed step.
   */
  beginStep(): void {
    const pad = this.readGamepad();
    this.stepMouseDX = this.mouseDX;
    this.stepMouseDY = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;

    this.stepButtons.clear();
    this.stepPressed.clear();
    for (const [action, list] of Object.entries(this.bindings.buttons) as [ButtonAction, ButtonBinding[]][]) {
      let held = false;
      let pressed = false;
      for (const b of list) {
        held ||= this.buttonHeld(b, pad);
        pressed ||= this.buttonPressed(b, pad);
      }
      const o = this.overrideButtons.get(action);
      if (o !== undefined) held = o;
      if (this.overridePressed.has(action)) pressed = true;
      this.stepButtons.set(action, held);
      if (pressed) this.stepPressed.add(action);
    }
    this.stepAxes.clear();
    for (const [action, list] of Object.entries(this.bindings.axes) as [AxisAction, AxisBinding[]][]) {
      let v = 0;
      for (const b of list) v += this.axisValue(b, pad);
      const o = this.overrideAxes.get(action);
      const isMouseLike = action === "lookX" || action === "lookY";
      this.stepAxes.set(action, o !== undefined ? o : isMouseLike ? v : Math.max(-1, Math.min(1, v)));
    }
    this.keysPressedSinceStep.clear();
    this.mousePressedSinceStep.clear();
    this.overridePressed.clear();
    this.padButtonsPrev = pad?.buttons ?? [];
  }

  button(a: ButtonAction): boolean {
    return this.stepButtons.get(a) ?? false;
  }

  pressed(a: ButtonAction): boolean {
    return this.stepPressed.has(a);
  }

  axis(a: AxisAction): number {
    return this.stepAxes.get(a) ?? 0;
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
  }
}
