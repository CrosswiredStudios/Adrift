/**
 * Player progression: inventory, discoveries, salvaged sites, crafting and
 * the objective chain. Pure game rules over the content tables — no
 * rendering, physics or DOM — so it is unit tested directly and saved as
 * plain JSON.
 *
 * The game feeds it facts ("interacted with the pod", "boarded the skiff",
 * "arrived at Tethys"); it answers with messages to show and advances the
 * current objective when a matching trigger fires.
 */
import {
  DISCOVERIES,
  DISCOVERY_REQUIRES,
  OBJECTIVES,
  RECIPES,
  itemName,
  type ObjectiveTrigger,
  type RecipeDef,
} from "../data/content";
import type { PoiDef } from "../data/pois";

export interface ProgressionState {
  inventory: Record<string, number>;
  discoveries: string[];
  salvaged: string[];
  crafted: string[];
  facts: string[];
  objective: number;
}

export interface ProgressionHooks {
  /** Short message for the player (toast). */
  message?(text: string): void;
  /** A discovery was unlocked: show its lore. */
  discovered?(id: string, title: string, text: string): void;
  /** Objective advanced (null = chain complete). */
  objective?(text: string | null): void;
  /** Recipe effect: repair the ship hull by a fraction. */
  repairHull?(amount: number): void;
}

export class Progression {
  readonly inventory = new Map<string, number>();
  readonly discoveries = new Set<string>();
  readonly salvaged = new Set<string>();
  readonly crafted = new Set<string>();
  /** Every trigger that has fired (see triggerKey). */
  readonly facts = new Set<string>();
  objectiveIndex = 0;

  constructor(public hooks: ProgressionHooks = {}) {}

  get objective(): string | null {
    return OBJECTIVES[this.objectiveIndex]?.text ?? null;
  }

  get complete(): boolean {
    return this.objectiveIndex >= OBJECTIVES.length;
  }

  count(item: string): number {
    return this.inventory.get(item) ?? 0;
  }

  add(item: string, n: number): void {
    this.inventory.set(item, this.count(item) + n);
  }

  /** Remove items; false (and no change) if there aren't enough. */
  take(item: string, n: number): boolean {
    if (this.count(item) < n) return false;
    const left = this.count(item) - n;
    if (left > 0) this.inventory.set(item, left);
    else this.inventory.delete(item);
    return true;
  }

  /** Prompt text for a POI the player is standing at (null = nothing to do). */
  promptFor(poi: PoiDef): string | null {
    const verbs: string[] = [];
    if (poi.salvage && !this.salvaged.has(poi.id)) verbs.push("salvage");
    if (poi.discovery && !this.discoveries.has(poi.discovery)) verbs.push("scan");
    return verbs.length ? `${verbs.join(" + ")} ${poi.name}` : null;
  }

  /** Use a POI: salvage it and/or scan its discovery. Returns true if anything happened. */
  interact(poi: PoiDef): boolean {
    let acted = false;
    if (poi.salvage && !this.salvaged.has(poi.id)) {
      this.salvaged.add(poi.id);
      for (const s of poi.salvage) this.add(s.item, s.count);
      this.hooks.message?.(
        `Salvaged ${poi.salvage.map((s) => `${s.count}x ${itemName(s.item)}`).join(", ")}`,
      );
      this.fire({ on: "salvaged", poi: poi.id });
      acted = true;
    }
    if (poi.discovery && !this.discoveries.has(poi.discovery)) {
      const need = DISCOVERY_REQUIRES[poi.discovery];
      if (need && this.count(need.item) < need.count) {
        this.hooks.message?.(`${poi.name}: needs ${itemName(need.item)}`);
        return acted;
      }
      if (need) this.take(need.item, need.count);
      this.discover(poi.discovery);
      acted = true;
    }
    return acted;
  }

  discover(id: string): void {
    if (this.discoveries.has(id)) return;
    const d = DISCOVERIES.find((x) => x.id === id);
    if (!d) throw new Error(`Unknown discovery ${id}`);
    this.discoveries.add(id);
    this.hooks.discovered?.(id, d.title, d.text);
    this.fire({ on: "discovered", id });
  }

  /** Recipes the player knows (discovery gates). */
  knownRecipes(): RecipeDef[] {
    return RECIPES.filter((r) => !r.requires || this.discoveries.has(r.requires));
  }

  canCraft(id: string): boolean {
    const r = this.knownRecipes().find((x) => x.id === id);
    return !!r && r.inputs.every((i) => this.count(i.item) >= i.count);
  }

  craft(id: string): boolean {
    if (!this.canCraft(id)) return false;
    const r = RECIPES.find((x) => x.id === id)!;
    for (const i of r.inputs) this.take(i.item, i.count);
    if (r.output) this.add(r.output.item, r.output.count);
    if (r.effect?.kind === "repairHull") this.hooks.repairHull?.(r.effect.amount);
    this.crafted.add(id);
    this.hooks.message?.(`Crafted ${r.name}`);
    this.fire({ on: "crafted", recipe: id });
    return true;
  }

  /** External facts from the game (boarding, arrivals). */
  notify(t: ObjectiveTrigger): void {
    this.fire(t);
  }

  /**
   * Record a fact and advance the objective chain. Facts are remembered, so
   * doing things out of order (scanning the monolith before the shore) is
   * fine: satisfied objectives are skipped when the chain reaches them.
   */
  private fire(t: ObjectiveTrigger): void {
    this.facts.add(triggerKey(t));
    const cur = OBJECTIVES[this.objectiveIndex];
    if (cur && this.facts.has(triggerKey(cur.done))) this.advance();
  }

  private advance(): void {
    while (
      this.objectiveIndex < OBJECTIVES.length &&
      this.facts.has(triggerKey(OBJECTIVES[this.objectiveIndex].done))
    ) {
      this.objectiveIndex++;
    }
    this.hooks.objective?.(this.objective);
  }

  /** Back to a fresh game. */
  reset(): void {
    this.inventory.clear();
    this.discoveries.clear();
    this.salvaged.clear();
    this.crafted.clear();
    this.facts.clear();
    this.objectiveIndex = 0;
  }

  save(): ProgressionState {
    return {
      inventory: Object.fromEntries(this.inventory),
      discoveries: [...this.discoveries],
      salvaged: [...this.salvaged],
      crafted: [...this.crafted],
      facts: [...this.facts],
      objective: this.objectiveIndex,
    };
  }

  load(s: ProgressionState): void {
    this.inventory.clear();
    for (const [k, v] of Object.entries(s.inventory)) if (v > 0) this.inventory.set(k, v);
    this.discoveries.clear();
    for (const d of s.discoveries) this.discoveries.add(d);
    this.salvaged.clear();
    for (const p of s.salvaged) this.salvaged.add(p);
    this.crafted.clear();
    for (const c of s.crafted ?? []) this.crafted.add(c);
    this.facts.clear();
    for (const f of s.facts ?? []) this.facts.add(f);
    this.objectiveIndex = Math.max(0, Math.min(OBJECTIVES.length, s.objective | 0));
    this.hooks.objective?.(this.objective);
  }
}

/** Canonical string for a trigger ("salvaged:pod", "boarded", ...). */
export function triggerKey(t: ObjectiveTrigger): string {
  switch (t.on) {
    case "salvaged":
      return `salvaged:${t.poi}`;
    case "discovered":
      return `discovered:${t.id}`;
    case "crafted":
      return `crafted:${t.recipe}`;
    case "arrived":
      return `arrived:${t.body}`;
    case "boarded":
      return "boarded";
  }
}
