/**
 * Fixed-timestep simulation loop.
 *
 * The simulation always advances in exact `step` increments (60 Hz by
 * default) no matter how fast the browser renders. The renderer then draws
 * the state interpolated between the last two sim steps (`alpha`), so motion
 * stays smooth at any refresh rate and the physics produce the same result
 * on a 30 Hz laptop and a 144 Hz monitor.
 *
 * `advance(frameDt)` is called once per rendered frame. It accumulates real
 * time, runs as many whole sim steps as fit (capped, so a long hitch can't
 * cause a death spiral), and returns the leftover fraction for
 * interpolation. `stepFor(seconds)` is the deterministic entry point that
 * headless tests use: it runs whole steps with no wall clock involved.
 */
export interface FixedStepOptions {
  /** Sim step length in seconds (default 1/60). */
  step?: number;
  /** Most sim steps one frame may run before dropping time (default 8). */
  maxStepsPerFrame?: number;
}

export class FixedStepLoop {
  readonly step: number;
  readonly maxStepsPerFrame: number;
  /** Real-time multiplier (1 = real time; 0 freezes the sim). */
  timeScale = 1;
  private accumulator = 0;
  /** Total sim steps taken since creation. */
  steps = 0;
  /** Sim time dropped because a frame needed more than maxStepsPerFrame. */
  droppedTime = 0;

  constructor(
    private readonly simulate: (dt: number) => void,
    opts: FixedStepOptions = {},
  ) {
    this.step = opts.step ?? 1 / 60;
    this.maxStepsPerFrame = opts.maxStepsPerFrame ?? 8;
  }

  /**
   * Feed one rendered frame's real elapsed time. Runs 0..maxStepsPerFrame
   * sim steps and returns the interpolation factor in [0, 1).
   */
  advance(frameDt: number): number {
    const dt = Math.max(0, frameDt) * this.timeScale;
    this.accumulator += dt;
    let n = 0;
    while (this.accumulator >= this.step && n < this.maxStepsPerFrame) {
      this.simulate(this.step);
      this.accumulator -= this.step;
      this.steps++;
      n++;
    }
    if (n === this.maxStepsPerFrame && this.accumulator >= this.step) {
      // Too far behind (tab was hidden, debugger pause...): drop the backlog
      // instead of trying to catch up for seconds.
      const whole = Math.floor(this.accumulator / this.step) * this.step;
      this.droppedTime += whole;
      this.accumulator -= whole;
    }
    return this.accumulator / this.step;
  }

  private manualAccumulator = 0;

  /**
   * Deterministically run `seconds` of simulation in whole steps. Fractions
   * of a step carry over to the next call, so stepFor(1/120) twice runs one
   * step. Used by tests and tools; ignores timeScale and the wall clock.
   */
  stepFor(seconds: number): number {
    this.manualAccumulator += Math.max(0, seconds);
    const n = Math.floor(this.manualAccumulator / this.step + 1e-7);
    this.manualAccumulator = Math.max(0, this.manualAccumulator - n * this.step);
    for (let i = 0; i < n; i++) {
      this.simulate(this.step);
      this.steps++;
    }
    return n;
  }

  /** Forget any partial step (e.g. after loading a save or unpausing). */
  resetAccumulator(): void {
    this.accumulator = 0;
  }
}
