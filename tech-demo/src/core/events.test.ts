import { describe, expect, it } from "vitest";
import { EventBus } from "./events";

interface Ev {
  ping: { n: number };
  other: string;
}

describe("EventBus", () => {
  it("delivers typed payloads and unsubscribes", () => {
    const bus = new EventBus<Ev>();
    const got: number[] = [];
    const off = bus.on("ping", (p) => got.push(p.n));
    bus.emit("ping", { n: 1 });
    off();
    bus.emit("ping", { n: 2 });
    expect(got).toEqual([1]);
  });

  it("once fires a single time and listeners may unsubscribe during emit", () => {
    const bus = new EventBus<Ev>();
    let count = 0;
    bus.once("other", () => count++);
    bus.emit("other", "a");
    bus.emit("other", "b");
    expect(count).toBe(1);
  });
});
