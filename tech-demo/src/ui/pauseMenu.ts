/**
 * Pause overlay. Built from the live binding map, so the controls list can't
 * drift from the actual controls.
 */
import { AxisAction, BindingMap, ButtonAction, describeBinding } from "../input/bindings";

export interface PauseMenuButton {
  id: string;
  label: string;
  onClick: () => void;
}

export interface PauseMenu {
  readonly visible: boolean;
  setVisible(on: boolean): void;
  /** Rebuild the controls list (after a rebind). */
  refreshControls(bindings: BindingMap): void;
  /** Show a short status line (e.g. "Saved"). */
  setStatus(text: string): void;
}

/** `posFirst`: list the positive key first, matching the label's word order. */
const CONTROL_ROWS: { label: string; axes?: AxisAction[]; buttons?: ButtonAction[]; posFirst?: boolean }[] = [
  { label: "Ship: thrust fwd/back", axes: ["thrustZ"], posFirst: true },
  { label: "Ship: strafe", axes: ["thrustX"] },
  { label: "Ship: up/down", axes: ["thrustY"], posFirst: true },
  { label: "Ship: pitch / yaw", axes: ["pitch", "yaw"] },
  { label: "Ship: roll", axes: ["roll"] },
  { label: "Ship: boost", buttons: ["boost"] },
  { label: "Ship: flight assist", buttons: ["toggleAssist"] },
  { label: "Ship: match velocity / hover (hold)", buttons: ["matchVelocity"] },
  { label: "Ship: landing mode", buttons: ["landingMode"] },
  { label: "On foot: move", axes: ["moveZ", "moveX"], posFirst: true },
  { label: "On foot: jump / sprint", buttons: ["jump", "sprint"] },
  { label: "Interact / board / exit", buttons: ["interact"] },
  { label: "Inventory", buttons: ["inventory"] },
  { label: "Targets", buttons: ["target1", "target2", "target3", "target4"] },
  { label: "Camera", buttons: ["cameraToggle"] },
  { label: "Quality tier", buttons: ["quality"] },
  { label: "Pause", buttons: ["pause"] },
];

export function createPauseMenu(
  root: HTMLElement,
  buttons: PauseMenuButton[],
  bindings: BindingMap,
): PauseMenu {
  root.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "pause-panel";
  const h = document.createElement("h1");
  h.textContent = "Paused";
  panel.appendChild(h);
  const row = document.createElement("div");
  row.className = "pause-buttons";
  for (const b of buttons) {
    const el = document.createElement("button");
    el.id = b.id;
    el.type = "button";
    el.textContent = b.label;
    el.addEventListener("click", b.onClick);
    row.appendChild(el);
  }
  panel.appendChild(row);
  const status = document.createElement("p");
  status.className = "pause-status";
  panel.appendChild(status);
  const table = document.createElement("table");
  table.className = "pause-controls";
  panel.appendChild(table);
  const hint = document.createElement("p");
  hint.className = "pause-hint";
  hint.textContent = "Click the view to capture the mouse (mouse look / steering). Esc releases it.";
  panel.appendChild(hint);
  root.appendChild(panel);

  let visible = false;
  const refreshControls = (map: BindingMap): void => {
    table.innerHTML = "";
    for (const r of CONTROL_ROWS) {
      const parts: string[] = [];
      const list = (bs: string[]): string => [...new Set(bs)].join(", ");
      for (const a of r.axes ?? []) parts.push(list(map.axes[a].map((b) => describeBinding(b, r.posFirst))));
      for (const b of r.buttons ?? []) parts.push(list(map.buttons[b].map((x) => describeBinding(x))));
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = r.label;
      const td2 = document.createElement("td");
      td2.textContent = parts.join(" · ");
      tr.append(td1, td2);
      table.appendChild(tr);
    }
  };
  refreshControls(bindings);
  return {
    get visible() {
      return visible;
    },
    setVisible(on: boolean) {
      visible = on;
      root.classList.toggle("visible", on);
      if (!on) status.textContent = "";
    },
    refreshControls,
    setStatus(text: string) {
      status.textContent = text;
    },
  };
}
