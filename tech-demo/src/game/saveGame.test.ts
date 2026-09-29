import { describe, expect, it } from "vitest";
import { Vector3 } from "@babylonjs/core";
import { SimWorld } from "../sim/world";
import { VESPER_DRIFT } from "../data/system";
import { Progression } from "./progression";
import { POIS } from "../data/pois";
import { SAVE_VERSION, applySave, captureSave, migrate } from "./saveGame";

describe("save games", () => {
  it("round-trips the sim and progression through JSON", () => {
    const a = new SimWorld(VESPER_DRIFT, "vael");
    const pa = new Progression();
    a.time = 1234.5;
    a.mode = "ship";
    a.shipBody = a.system.get("tethys");
    a.ship.pos.set(10, 1_600_000 / 1000, 3);
    a.ship.vel.set(1, 2, 3);
    a.ship.hull = 0.6;
    a.ship.assist = false;
    a.player.heading.set(0, 0, 1);
    pa.interact(POIS.find((p) => p.id === "pod")!);

    const json = JSON.parse(JSON.stringify(captureSave(a, pa)));
    const b = new SimWorld(VESPER_DRIFT, "vael");
    const pb = new Progression();
    applySave(migrate(json), b, pb);

    expect(b.time).toBe(1234.5);
    expect(b.mode).toBe("ship");
    expect(b.shipBody.id).toBe("tethys");
    expect(Vector3.Distance(b.ship.pos, a.ship.pos)).toBe(0);
    expect(Vector3.Distance(b.ship.vel, a.ship.vel)).toBe(0);
    expect(b.ship.hull).toBe(0.6);
    expect(b.ship.assist).toBe(false);
    expect(pb.count("scrap")).toBe(4);
    expect(pb.objective).toBe(pa.objective);
  });

  it("rejects newer or broken saves", () => {
    const sim = new SimWorld(VESPER_DRIFT, "vael");
    const good = captureSave(sim, new Progression());
    expect(() => migrate({ ...good, version: SAVE_VERSION + 1 })).toThrow();
    expect(() => migrate({ ...good, ship: { ...good.ship, pos: [0, Number.NaN, 0] } })).toThrow();
    expect(() => migrate(null)).toThrow();
    expect(migrate(JSON.parse(JSON.stringify(good))).version).toBe(SAVE_VERSION);
  });
});
