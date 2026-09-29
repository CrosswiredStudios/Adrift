import { describe, expect, it } from "vitest";
import { InputSystem } from "./inputSystem";

describe("InputSystem", () => {
  it("maps keys to actions and axes per sim step", () => {
    const input = new InputSystem();
    input.setKey("KeyW", true);
    input.setKey("KeyA", true);
    input.beginStep();
    expect(input.axis("thrustZ")).toBe(1);
    expect(input.axis("thrustX")).toBe(-1);
    expect(input.axis("moveZ")).toBe(1);
    input.setKey("KeyW", false);
    input.beginStep();
    expect(input.axis("thrustZ")).toBe(0);
  });

  it("reports a press on the next step even if released before it", () => {
    const input = new InputSystem();
    input.setKey("KeyF", true);
    input.setKey("KeyF", false);
    input.beginStep();
    expect(input.pressed("interact")).toBe(true);
    input.beginStep();
    expect(input.pressed("interact")).toBe(false);
  });

  it("fires immediate callbacks for pause even between steps", () => {
    const input = new InputSystem();
    let paused = 0;
    input.onImmediate("pause", () => paused++);
    input.setKey("Escape", true);
    expect(paused).toBe(1);
  });

  it("overrides beat devices and releaseAll clears held keys", () => {
    const input = new InputSystem();
    input.setAxis("pitch", 0.5);
    input.setButton("boost", true);
    input.setKey("ArrowDown", true);
    input.beginStep();
    expect(input.axis("pitch")).toBe(0.5);
    expect(input.button("boost")).toBe(true);
    expect(input.pressed("boost")).toBe(true);
    input.clearOverrides();
    input.beginStep();
    expect(input.axis("pitch")).toBe(-1);
    input.releaseAll();
    input.beginStep();
    expect(input.axis("pitch")).toBe(0);
  });

  it("mouse motion feeds look axes once per step", () => {
    const input = new InputSystem();
    input.addMouseDelta(100, -50);
    input.beginStep();
    expect(input.axis("lookX")).toBeCloseTo(0.22, 5);
    expect(input.axis("lookY")).toBeCloseTo(0.11, 5);
    input.beginStep();
    expect(input.axis("lookX")).toBe(0);
  });
});
