import { Mesh } from "@babylonjs/core";
import { Body, bodyAltitude } from "./planets";
import { FlightState } from "./flight";

export function updateHud(el: HTMLElement, ship: Mesh, state: FlightState, bodies: Body[]): void {
  const speed = state.velocity.length();
  const lines = bodies.map((b) => {
    const alt = bodyAltitude(b, ship.position);
    const dist = ship.position.subtract(b.mesh.position).length();
    const mark = state.target === b ? ">" : " ";
    return `${mark} ${b.name}: alt ${alt.toFixed(0)} dist ${dist.toFixed(0)}`;
  });
  el.textContent = `speed ${speed.toFixed(1)} assist ${state.assist ? "on" : "off"}\n${lines.join("\n")}`;
}
