import { describe, expect, it } from "vitest";
import { Progression } from "./progression";
import { DISCOVERIES, DISCOVERY_REQUIRES, ITEMS, OBJECTIVES, RECIPES } from "../data/content";
import { POIS } from "../data/pois";

const poi = (id: string) => POIS.find((p) => p.id === id)!;

describe("content tables", () => {
  it("every reference resolves", () => {
    const items = new Set(ITEMS.map((i) => i.id));
    const discoveries = new Set(DISCOVERIES.map((d) => d.id));
    const pois = new Set(POIS.map((p) => p.id));
    for (const p of POIS) {
      for (const s of p.salvage ?? []) expect(items.has(s.item), `${p.id} salvage ${s.item}`).toBe(true);
      if (p.discovery) expect(discoveries.has(p.discovery), `${p.id} discovery`).toBe(true);
    }
    for (const r of RECIPES) {
      for (const i of r.inputs) expect(items.has(i.item), `${r.id} input ${i.item}`).toBe(true);
      if (r.output) expect(items.has(r.output.item)).toBe(true);
      if (r.requires) expect(discoveries.has(r.requires)).toBe(true);
    }
    for (const [d, need] of Object.entries(DISCOVERY_REQUIRES)) {
      expect(discoveries.has(d)).toBe(true);
      expect(items.has(need.item)).toBe(true);
    }
    for (const o of OBJECTIVES) {
      if (o.done.on === "salvaged") expect(pois.has(o.done.poi)).toBe(true);
      if (o.done.on === "discovered") expect(discoveries.has(o.done.id)).toBe(true);
      if (o.done.on === "crafted")
        expect(RECIPES.some((r) => r.id === (o.done as { recipe: string }).recipe)).toBe(true);
    }
  });

  it("ids are unique", () => {
    for (const list of [ITEMS, RECIPES, DISCOVERIES, OBJECTIVES, POIS]) {
      const ids = list.map((x) => x.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("Progression", () => {
  it("plays the whole objective chain", () => {
    const seen: (string | null)[] = [];
    const p = new Progression({ objective: (t) => seen.push(t) });
    expect(p.objective).toBe(OBJECTIVES[0].text);
    p.interact(poi("pod"));
    expect(p.count("scrap")).toBe(4);
    expect(p.count("powerCell")).toBe(1);
    p.notify({ on: "boarded" });
    p.interact(poi("ruin-shore"));
    expect(p.canCraft("relayKey")).toBe(false); // recipe unknown before the star map
    p.interact(poi("monolith-ridge"));
    p.interact(poi("debris-tethys"));
    expect(p.discoveries.has("ship-log")).toBe(true);
    expect(p.objective).toBe("Craft the relay key (Tab)");
    expect(p.craft("relayKey")).toBe(true);
    expect(p.count("navCore")).toBe(0);
    expect(p.count("relayKey")).toBe(1);
    p.interact(poi("ruin-cinder"));
    expect(p.count("relayKey")).toBe(0);
    expect(p.complete).toBe(true);
    expect(p.objective).toBeNull();
    expect(seen[seen.length - 1]).toBeNull();
  });

  it("salvage and scans happen once", () => {
    const p = new Progression();
    expect(p.interact(poi("pod"))).toBe(true);
    expect(p.interact(poi("pod"))).toBe(false);
    expect(p.count("scrap")).toBe(4);
    expect(p.promptFor(poi("pod"))).toBeNull();
    expect(p.promptFor(poi("ruin-shore"))).toBe("salvage + scan Shore ruins");
  });

  it("gated discoveries need their item", () => {
    const msgs: string[] = [];
    const p = new Progression({ message: (m) => msgs.push(m) });
    expect(p.interact(poi("ruin-cinder"))).toBe(false);
    expect(p.discoveries.has("relay")).toBe(false);
    expect(msgs[0]).toContain("Relay key");
  });

  it("out-of-order progress skips satisfied objectives", () => {
    const p = new Progression();
    p.interact(poi("monolith-ridge"));
    p.interact(poi("ruin-shore"));
    p.notify({ on: "boarded" });
    expect(p.objectiveIndex).toBe(0); // still: salvage the pod
    p.interact(poi("pod"));
    expect(p.objective).toBe("Fly to the debris on Tethys");
  });

  it("crafting consumes inputs and applies effects", () => {
    let repaired = 0;
    const p = new Progression({ repairHull: (a) => (repaired += a) });
    expect(p.craft("hullPatch")).toBe(false);
    p.add("scrap", 3);
    expect(p.craft("hullPatch")).toBe(true);
    expect(p.count("scrap")).toBe(1);
    expect(repaired).toBeCloseTo(0.35);
    expect(p.craft("hullPatch")).toBe(false);
  });

  it("round-trips through save/load", () => {
    const a = new Progression();
    a.interact(poi("pod"));
    a.notify({ on: "boarded" });
    a.interact(poi("ruin-shore"));
    const json = JSON.parse(JSON.stringify(a.save()));
    const b = new Progression();
    b.load(json);
    expect(b.save()).toEqual(a.save());
    expect(b.objective).toBe(a.objective);
  });
});
