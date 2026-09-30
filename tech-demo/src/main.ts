/**
 * Entry point: find the DOM, build the game, expose the debug API, run.
 * All composition lives in game/game.ts.
 */
import "./style.css";
import { Game } from "./game/game";
import { installDebugApi } from "./debug/debugApi";

const byId = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} element`);
  return el as T;
};

const game = new Game({
  canvas: byId<HTMLCanvasElement>("scene"),
  hud: byId("hud"),
  pause: byId("pause"),
});
installDebugApi(game);
game.start();
