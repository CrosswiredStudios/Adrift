import { Mesh } from "@babylonjs/core";
import { Body, surfaceAltitude } from "./planets";
import { FlightState } from "./flight";

function bar(frac: number, width = 12): string {
  const f = Math.min(1, Math.max(0, frac));
  const filled = Math.round(f * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

export function updateHud(el: HTMLElement, ship: Mesh, state: FlightState, bodies: Body[]): void {
  const speed = state.velocity.length();
  const lines = bodies.map((b) => {
    const alt = surfaceAltitude(b, ship.position);
    const dist = ship.position.subtract(b.center).length();
    const mark = state.target === b ? ">" : " ";
    return `${mark} ${b.name}: alt ${alt.toFixed(0)} dist ${dist.toFixed(0)}`;
  });
  const heatWarn = state.heat > 0.55 ? "  *** HEAT ***" : state.heat > 0.25 ? "  (warming)" : "";
  const landed = state.landed ? "  LANDED" : "";
  el.textContent =
    `speed ${speed.toFixed(1)}  v/s ${state.verticalSpeed.toFixed(1)}  alt ${state.altitude.toFixed(0)}  thr ${state.cruise.toFixed(0)}${landed}\n` +
    `atmo ${bar(state.atmoDensity)} heat ${bar(state.heat)}${heatWarn}\n${lines.join("\n")}`;
}
