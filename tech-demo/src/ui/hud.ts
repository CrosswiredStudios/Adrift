/**
 * Heads-up display (DOM overlay): telemetry, interaction prompt, toasts,
 * current objective, discovery lore card and the inventory/crafting panel. The game builds a plain `HudModel` each frame; this
 * module only formats it, so the HUD can be restyled or replaced without
 * touching game logic.
 */

export interface HudTarget {
  name: string;
  distance: number;
  /** Relative speed along the line of sight (m/s, - = closing). */
  rangeRate: number;
  selected: boolean;
}

export interface HudModel {
  mode: "ship" | "onFoot";
  bodyName: string;
  /** Height above the surface (m). */
  altitude: number;
  /** Speed relative to the surface (m/s). */
  speed: number;
  verticalSpeed: number;
  /** Orbital (inertial, body-relative) speed (m/s). */
  orbitalSpeed?: number;
  assist?: boolean;
  /** Assisted handling: 1 = hover, 0 = space. */
  hover?: number;
  /** Space throttle (-0.25..1). */
  throttle?: number;
  heat?: number;
  hull?: number;
  landed?: boolean;
  floating?: boolean;
  air: number;
  /** Local solar time 0..24 h at the player's position. */
  localHour: number;
  targets: HudTarget[];
  prompt: string | null;
  objective: string | null;
  vitals?: { oxygen: number; power: number; health: number } | null;
}

export interface InventoryModel {
  items: { name: string; count: number }[];
  recipes: { id: string; name: string; description: string; inputs: string; canCraft: boolean }[];
  discoveries: string[];
}

const bar = (frac: number, width = 10): string => {
  const f = Math.min(1, Math.max(0, frac));
  const n = Math.round(f * width);
  return `[${"#".repeat(n)}${"-".repeat(width - n)}]`;
};

const dist = (m: number): string =>
  m >= 10000
    ? `${(m / 1000).toFixed(0)} km`
    : m >= 1000
      ? `${(m / 1000).toFixed(1)} km`
      : `${m.toFixed(0)} m`;

export class Hud {
  private readonly telemetry: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly objective: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly lore: HTMLElement;
  private readonly inventory: HTMLElement;
  private inventoryKey = "";
  private loreTimer: ReturnType<typeof setTimeout> | undefined;

  /** `onCraft` is called when a recipe button in the inventory panel is clicked. */
  constructor(
    root: HTMLElement,
    private readonly onCraft: (recipeId: string) => void = () => undefined,
  ) {
    root.innerHTML = "";
    this.telemetry = el(root, "div", "hud-telemetry");
    this.prompt = el(root, "div", "hud-prompt");
    this.toasts = el(root, "div", "hud-toasts");
    this.objective = el(root, "div", "hud-objective");
    this.crosshair = el(root, "div", "hud-crosshair");
    this.lore = el(root, "div", "hud-lore");
    this.inventory = el(root, "div", "hud-inventory");
  }

  update(m: HudModel): void {
    const hh = Math.floor(m.localHour);
    const mm = Math.floor((m.localHour - hh) * 60);
    const clock = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    const lines: string[] = [];
    if (m.mode === "ship") {
      lines.push(
        `SHIP  ${!m.assist ? "MANUAL" : (m.hover ?? 1) >= 0.5 ? "HOVER" : `SPACE  thr ${Math.round((m.throttle ?? 0) * 100)}%`}${m.landed ? "  LANDED" : m.floating ? "  AFLOAT" : ""}   ${m.bodyName} ${clock}`,
      );
      lines.push(
        `alt ${dist(Math.max(0, m.altitude))}  spd ${m.speed.toFixed(1)} m/s  v/s ${m.verticalSpeed.toFixed(1)}  orb ${(m.orbitalSpeed ?? 0).toFixed(0)}`,
      );
      lines.push(
        `air ${bar(m.air)} heat ${bar(m.heat ?? 0)} hull ${bar(m.hull ?? 1)}${(m.heat ?? 0) > 0.6 ? " HEAT!" : ""}`,
      );
    } else {
      lines.push(`ON FOOT   ${m.bodyName} ${clock}`);
      lines.push(`alt ${m.altitude.toFixed(1)} m  spd ${m.speed.toFixed(1)} m/s`);
      if (m.vitals) {
        lines.push(`O2 ${bar(m.vitals.oxygen)} pwr ${bar(m.vitals.power)} hp ${bar(m.vitals.health)}`);
      }
    }
    for (const t of m.targets) {
      const rate =
        Math.abs(t.rangeRate) > 0.5
          ? `  ${t.rangeRate < 0 ? "closing" : "opening"} ${Math.abs(t.rangeRate).toFixed(0)} m/s`
          : "";
      lines.push(
        `${t.selected ? ">" : " "} ${t.name.padEnd(7)} ${dist(t.distance)}${t.selected ? rate : ""}`,
      );
    }
    this.telemetry.textContent = lines.join("\n");
    this.prompt.textContent = m.prompt ?? "";
    this.prompt.classList.toggle("visible", !!m.prompt);
    this.objective.textContent = m.objective ? `Objective: ${m.objective}` : "";
    this.crosshair.classList.toggle("visible", m.mode === "onFoot");
  }

  /** Discovery card: title + lore, fades after a while. */
  showLore(title: string, text: string, seconds = 12): void {
    this.lore.innerHTML = "";
    el(this.lore, "h2", "hud-lore-title").textContent = title;
    el(this.lore, "p", "hud-lore-text").textContent = text;
    this.lore.classList.add("visible");
    clearTimeout(this.loreTimer);
    this.loreTimer = setTimeout(() => this.lore.classList.remove("visible"), seconds * 1000);
  }

  /** Inventory/crafting panel (null = closed). Rebuilt only when its content changes. */
  setInventory(m: InventoryModel | null): void {
    const key = m ? JSON.stringify(m) : "";
    if (key === this.inventoryKey) return;
    this.inventoryKey = key;
    this.inventory.classList.toggle("visible", !!m);
    this.inventory.innerHTML = "";
    if (!m) return;
    el(this.inventory, "h2", "").textContent = "Inventory";
    const items = el(this.inventory, "ul", "inv-items");
    if (m.items.length === 0) el(items, "li", "inv-empty").textContent = "Empty";
    for (const i of m.items) el(items, "li", "").textContent = `${i.count} x ${i.name}`;
    el(this.inventory, "h2", "").textContent = "Crafting";
    for (const r of m.recipes) {
      const row = el(this.inventory, "div", "inv-recipe");
      const b = el(row, "button", "") as HTMLButtonElement;
      b.type = "button";
      b.textContent = r.name;
      b.disabled = !r.canCraft;
      b.dataset.recipe = r.id;
      b.addEventListener("click", () => this.onCraft(r.id));
      el(row, "div", "inv-desc").textContent = `${r.description}  Needs: ${r.inputs}`;
    }
    if (m.discoveries.length) {
      el(this.inventory, "h2", "").textContent = "Discoveries";
      const list = el(this.inventory, "ul", "inv-discoveries");
      for (const d of m.discoveries) el(list, "li", "").textContent = d;
    }
    el(this.inventory, "p", "inv-hint").textContent = "Tab to close";
  }

  /** Short message that fades out. */
  toast(text: string, seconds = 4): void {
    const t = el(this.toasts, "div", "hud-toast");
    t.textContent = text;
    setTimeout(() => t.classList.add("fade"), seconds * 1000);
    setTimeout(() => t.remove(), seconds * 1000 + 800);
  }
}

function el(parent: HTMLElement, tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}
