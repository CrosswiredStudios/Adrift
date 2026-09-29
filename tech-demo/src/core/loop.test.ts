import { describe, expect, it } from "vitest";
import { FixedStepLoop } from "./loop";

describe("FixedStepLoop", () => {
  it("runs whole fixed steps and returns the leftover fraction", () => {
    const dts: number[] = [];
    const loop = new FixedStepLoop((dt) => dts.push(dt), { step: 0.01 });
    const a1 = loop.advance(0.025);
    expect(dts.length).toBe(2);
    expect(a1).toBeCloseTo(0.5, 6);
    loop.advance(0.005);
    expect(dts.length).toBe(3);
    expect(dts.every((d) => d === 0.01)).toBe(true);
  });

  it("gives the same step count regardless of frame pacing", () => {
    const count = (frame: number, frames: number): number => {
      let n = 0;
      const loop = new FixedStepLoop(() => n++, { step: 1 / 60, maxStepsPerFrame: 100 });
      for (let i = 0; i < frames; i++) loop.advance(frame);
      return n;
    };
    // 2 seconds at 30, 60 and 144 fps -> 120 steps (+-1 for the leftover).
    expect(Math.abs(count(1 / 30, 60) - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(count(1 / 60, 120) - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(count(1 / 144, 288) - 120)).toBeLessThanOrEqual(1);
  });

  it("drops the backlog after a long hitch instead of spiralling", () => {
    let n = 0;
    const loop = new FixedStepLoop(() => n++, { step: 0.01, maxStepsPerFrame: 5 });
    loop.advance(10);
    expect(n).toBe(5);
    expect(loop.droppedTime).toBeGreaterThan(9.8);
    loop.advance(0.01);
    expect(n).toBe(6);
  });

  it("stepFor is deterministic and ignores timeScale", () => {
    let n = 0;
    const loop = new FixedStepLoop(() => n++, { step: 1 / 60 });
    loop.timeScale = 0;
    expect(loop.stepFor(1)).toBe(60);
    expect(n).toBe(60);
    expect(loop.advance(1)).toBe(0);
    expect(n).toBe(60);
  });

  it("stepFor carries fractional steps across calls", () => {
    let n = 0;
    const loop = new FixedStepLoop(() => n++, { step: 1 / 60 });
    for (let i = 0; i < 360; i++) loop.stepFor(1 / 120);
    expect(n).toBe(180);
    for (let i = 0; i < 90; i++) loop.stepFor(1 / 30);
    expect(n).toBe(360);
  });
});
