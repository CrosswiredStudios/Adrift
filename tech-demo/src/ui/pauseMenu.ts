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

const CONTROL_ROWS: { label: string; axes?: AxisAction[]; buttons?: ButtonAction[] }[] = [
  { label: "Ship: thrust fwd/back", axes: ["thrustZ"] },
  { label: "Ship: strafe", axes: ["thrustX"] },
  { label: "Ship: up/down", axes: ["thrustY"] },
  { label: "Ship: pitch / yaw", axes: ["pitch", "yaw"] },
  { label: "Ship: roll", axes: ["roll"] },
  { label: "Ship: boost", buttons: ["boost"] },
  { label: "Ship: flight assist", buttons: ["toggleAssist"] },
  { label: "Ship: match velocity", buttons: ["matchVelocity"] },
  { label: "On foot: move", axes: ["moveZ", "moveX"] },
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
      for (const a of r.axes ?? []) parts.push(map.axes[a].map(describeBinding).join(", "));
      for (const b of r.buttons ?? []) parts.push(map.buttons[b].map(describeBinding).join(", "));
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
