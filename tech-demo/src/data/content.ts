/**
 * Game content as data: items, recipes, discoveries and the objective chain.
 *
 * Nothing here knows about rendering or physics. POIs (data/pois.ts) refer
 * to these ids; game/progression.ts interprets them. Adding a new item,
 * recipe or story beat is a data change, checked by data/content.test.ts.
 */

export interface ItemDef {
  id: string;
  name: string;
  description: string;
}

export interface RecipeDef {
  id: string;
  name: string;
  description: string;
  inputs: { item: string; count: number }[];
  /** Item produced (optional: some recipes only have an effect). */
  output?: { item: string; count: number };
  /** Immediate effect when crafted. */
  effect?: { kind: "repairHull"; amount: number };
  /** Discovery required before the recipe is known. */
  requires?: string;
}

export interface DiscoveryDef {
  id: string;
  title: string;
  /** Lore shown when scanned. */
  text: string;
}

/** What completes an objective (matched against progression events). */
export type ObjectiveTrigger =
  | { on: "salvaged"; poi: string }
  | { on: "discovered"; id: string }
  | { on: "crafted"; recipe: string }
  | { on: "boarded" }
  | { on: "arrived"; body: string };

export interface ObjectiveDef {
  id: string;
  text: string;
  done: ObjectiveTrigger;
}

export const ITEMS: ItemDef[] = [
  { id: "scrap", name: "Scrap", description: "Twisted hull plating. Good for patches." },
  { id: "powerCell", name: "Power cell", description: "A charged cell from the pod's emergency bus." },
  { id: "alloy", name: "Glyph alloy", description: "A pale metal that hums faintly under the scanner." },
  {
    id: "navCore",
    name: "Nav core",
    description: "The research vessel's navigation computer, cracked but alive.",
  },
  {
    id: "relayKey",
    name: "Relay key",
    description: "Alloy lattice tuned to the relay glyphs, powered and addressed.",
  },
];

export const RECIPES: RecipeDef[] = [
  {
    id: "hullPatch",
    name: "Hull patch",
    description: "Weld scrap over the worst of the damage (+35% hull).",
    inputs: [{ item: "scrap", count: 2 }],
    effect: { kind: "repairHull", amount: 0.35 },
  },
  {
    id: "relayKey",
    name: "Relay key",
    description: "Shape glyph alloy to the relay pattern and wake it with the nav core.",
    inputs: [
      { item: "alloy", count: 4 },
      { item: "powerCell", count: 1 },
      { item: "navCore", count: 1 },
    ],
    output: { item: "relayKey", count: 1 },
    requires: "star-map",
  },
];

export const DISCOVERIES: DiscoveryDef[] = [
  {
    id: "glyphs-basic",
    title: "Shore glyphs",
    text: "Concentric rings cut into the stone. The scanner pairs the innermost with the moon and the outermost with the second planet: a route, not a prayer.",
  },
  {
    id: "star-map",
    title: "Ridge monolith",
    text: "Light pours out of the monolith into a map of the system. A relay burns on Cinder, and a thread of debris still circles Tethys. You know how to key the relay now.",
  },
  {
    id: "ship-log",
    title: "Research vessel log",
    text: "'Jump solution drifted 0.3%. Moon ahead, too close.' The last entry is yours. The nav core survived the impact.",
  },
  {
    id: "relay",
    title: "Relay foundations",
    text: "The key seats in the lattice and the relay wakes. Far above, something old turns to listen. The rescue call is away.",
  },
];

/** The main thread of the demo, in order. */
export const OBJECTIVES: ObjectiveDef[] = [
  { id: "salvage-pod", text: "Salvage the escape pod", done: { on: "salvaged", poi: "pod" } },
  { id: "board", text: "Reach the skiff on the survey pad", done: { on: "boarded" } },
  { id: "shore", text: "Scan the shore ruins", done: { on: "discovered", id: "glyphs-basic" } },
  { id: "monolith", text: "Find the ridge monolith", done: { on: "discovered", id: "star-map" } },
  { id: "tethys", text: "Fly to the debris on Tethys", done: { on: "salvaged", poi: "debris-tethys" } },
  { id: "craft-key", text: "Craft the relay key (Tab)", done: { on: "crafted", recipe: "relayKey" } },
  { id: "relay", text: "Wake the relay on Cinder", done: { on: "discovered", id: "relay" } },
];

/** Items a POI's scan needs before its discovery unlocks (consumed). */
export const DISCOVERY_REQUIRES: Record<string, { item: string; count: number }> = {
  relay: { item: "relayKey", count: 1 },
};

export const itemName = (id: string): string => ITEMS.find((i) => i.id === id)?.name ?? id;
