import { Engine, Scene, Vector3, Color3, Color4, HemisphericLight, DirectionalLight, Mesh, Quaternion, StandardMaterial, FreeCamera } from "@babylonjs/core";
import { makePlanet, atmosphereFactor, Body } from "./planets";
import { createShip, updateShip, FlightState } from "./flight";
import { updateHud } from "./hud";

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLElement;
const engine = new Engine(canvas, true);
const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 1);

new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
const sun = new DirectionalLight("sun", new Vector3(-1, -0.3, 0.4), scene);

const vael = makePlanet(scene, {
  name: "Vael Prime", position: new Vector3(0, 0, 0), radius: 600,
  color: new Color3(0.25, 0.45, 0.3), atmosphereHeight: 90,
  atmosphereColor: new Color3(0.35, 0.6, 1), skyColor: new Color3(0.5, 0.75, 1), mu: 90000
});
const tethys = makePlanet(scene, {
  name: "Tethys", position: new Vector3(6000, 800, -2500), radius: 160,
  color: new Color3(0.55, 0.55, 0.58), atmosphereHeight: 4,
  atmosphereColor: new Color3(0.4, 0.4, 0.45), skyColor: new Color3(0, 0, 0), mu: 8000
});
const bodies: Body[] = [vael, tethys];

const pad = Mesh.CreateBox("pad", 8, scene);
pad.position = new Vector3(0, vael.radius + 4, 620);
const padMat = new StandardMaterial("pad-mat", scene);
padMat.emissiveColor = new Color3(0.2, 0.8, 1);
pad.material = padMat;

const ship = createShip(scene);
ship.position.copyFrom(pad.position).addInPlace(new Vector3(0, 4, 0));
ship.rotationQuaternion = Quaternion.Identity();
const state: FlightState = { velocity: new Vector3(0, 0, 0), assist: true, target: tethys };

const camera = new FreeCamera("chase", new Vector3(0, vael.radius + 10, 640), scene);
camera.maxZ = 60000;
camera.minZ = 0.1;

const input: Record<string, boolean> = {};
addEventListener("keydown", (e) => {
  input[e.key.toLowerCase()] = true;
  if (e.key === "1") state.target = vael;
  if (e.key === "2") state.target = tethys;
  if (e.key.toLowerCase() === "l") state.assist = !state.assist;
});
addEventListener("keyup", (e) => { input[e.key.toLowerCase()] = false; });

let dragging = false, px = 0, py = 0;
canvas.addEventListener("pointerdown", (e) => { dragging = true; px = e.clientX; py = e.clientY; });
addEventListener("pointerup", () => { dragging = false; });
addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = (e.clientX - px) / 200, dy = (e.clientY - py) / 200;
  px = e.clientX; py = e.clientY;
  const q = ship.rotationQuaternion ?? Quaternion.Identity();
  ship.rotationQuaternion = Quaternion.RotationYawPitchRoll(-dx, -dy, 0).multiply(q);
});

engine.runRenderLoop(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
  updateShip(ship, state, bodies, input, dt);

  const atmo = Math.max(...bodies.map((b) => atmosphereFactor(b, ship.position)));
  scene.clearColor = Color4.FromColor3(Color3.Lerp(Color3.Black(), vael.skyColor, atmo), 1);
  sun.intensity = 1.2 - atmo * 0.2;

  const back = new Vector3(0, 3, -12).applyRotationQuaternion(ship.rotationQuaternion ?? Quaternion.Identity());
  camera.position.copyFrom(ship.position).addInPlace(back);
  camera.setTarget(ship.position);

  updateHud(hud, ship, state, bodies);
  scene.render();
});
addEventListener("resize", () => engine.resize());
