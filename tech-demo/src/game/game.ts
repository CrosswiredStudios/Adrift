/**
 * Game composition root.
 *
 * Builds the engine, scene and render passes, the terrain worker pool, the
 * simulation (SimWorld) and one BodyView per celestial body, and splits
 * each frame into:
 *
 *  - `simulate(dt)`: one fixed 60 Hz step: input actions -> controls ->
 *    SimWorld.step() -> game rules. No meshes or cameras are touched.
 *  - `renderFrame(dt, alpha)`: interpolate the sim state, place everything
 *    in render space around the camera (floating origin: the camera is
 *    always at 0,0,0), update visual-only effects, draw.
 *
 * Render space = inertial axes, translated so the camera sits at the
 * origin. Bodies are positioned by their root nodes; everything on a body
 * is built in its body-fixed frame and rides along.
 */
import {
  Color3,
  Color4,
  DefaultRenderingPipeline,
  Engine,
  FreeCamera,
  ImageProcessingConfiguration,
  Matrix,
  Mesh,
  Quaternion,
  Scene,
  ShaderMaterial,
  TransformNode,
  Vector3,
  type Material,
} from "@babylonjs/core";
import { FixedStepLoop } from "../core/loop";
import { EventBus } from "../core/events";
import { InputSystem } from "../input/inputSystem";
import { VESPER_DRIFT, type BodyDef } from "../data/system";
import { POIS, poiDirection } from "../data/pois";
import { SimWorld, type ControlMode } from "../sim/world";
import {
  snapshotFrame,
  pointToInertial,
  pointToBody,
  velocityToInertial,
  dirToBody,
  type BodyFrameSnapshot,
} from "../sim/frames";
import { quatFromAxes } from "../sim/shipSim";
import { TerrainWorkerPool, createTerrainWorker } from "../terrain/workerPool";
import { BodyView, biomePalette } from "../world/bodyView";
import { buildProps, type Interactable, type PlacedPoi } from "../world/props";
import { buildShip, type ShipRig } from "../ship/shipBuilder";
import { createSplash } from "../ship/shipFx";
import { createSceneTargets, type SceneTargets } from "../render/sceneTargets";
import { PlanetaryPass, type SkyQuality, type AtmoBodyFrame, type CloudFrame } from "../render/planetaryPass";
import { Lighting } from "../render/lighting";
import { makeStars, type Starfield } from "../render/starfield";
import { ChaseRig, cockpitPose, firstPersonPose, type CameraPose } from "../render/cameraRig";
import { sunTransmittance } from "../render/atmosphereModel";
import { cloudDensityAt } from "../render/cloudModel";
import { Hud, type HudModel, type HudTarget, type InventoryModel } from "../ui/hud";
import { DISCOVERIES, itemName } from "../data/content";
import { createPauseMenu, type PauseMenu } from "../ui/pauseMenu";
import { clamp } from "../common/math";
import { Progression } from "./progression";
import { applySave, captureSave, saveStore } from "./saveGame";

export interface GameEvents {
  paused: { paused: boolean };
  modeChanged: { mode: ControlMode };
  splash: { bodyId: string; position: Vector3; speed: number };
  shipImpact: { speed: number; damage: number };
  soiChanged: { entity: string; from: string; to: string };
  interacted: { poiId: string; kind: string; acted: boolean };
  discovered: { id: string; title: string; text: string };
  objectiveChanged: { text: string | null };
  saved: { ok: boolean };
  loaded: { ok: boolean };
  targetChanged: { id: string };
  qualityChanged: { tier: SkyQuality };
  toast: { text: string };
}

export interface GameDom {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  pause: HTMLElement;
}

export interface GameOptions {
  /** Terrain worker count (0 = run jobs on the main thread). */
  workers?: number;
}

/**
 * Mouse flight "virtual stick": pointer-lock motion pushes the stick, a
 * spring pulls it back to centre. Flick to turn, let go to stop.
 */
export class VirtualStick {
  x = 0;
  y = 0;
  constructor(
    public gain = 9,
    public spring = 3.5,
  ) {}
  update(dx: number, dy: number, dt: number): void {
    this.x = clamp(this.x + dx * this.gain, -1, 1);
    this.y = clamp(this.y + dy * this.gain, -1, 1);
    const k = Math.exp(-this.spring * dt);
    this.x *= k;
    this.y *= k;
  }
  reset(): void {
    this.x = 0;
    this.y = 0;
  }
}

const QUALITY_TIERS: SkyQuality[] = ["ultra", "high", "balanced", "lite"];
/** Keyboard look rate on foot (rad/s). */
const KEY_LOOK_RATE = 2.2;
/** Directional sun intensity (PBR units) and sky-scattering illuminance. */
const SUN_INTENSITY = 3.2;
const SKY_ILLUMINANCE = new Color3(22, 22, 21);
/** Target keys 1..4. */
const TARGET_IDS = ["vael", "tethys", "cinder", "vesper"];

export class Game {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: FreeCamera;
  readonly pipeline: DefaultRenderingPipeline;
  readonly targets: SceneTargets;
  readonly planetary: PlanetaryPass;
  readonly lighting: Lighting;
  readonly starfield: Starfield;
  readonly pool: TerrainWorkerPool;
  readonly sim: SimWorld;
  readonly views = new Map<string, BodyView>();
  readonly interactables: Interactable[] = [];
  readonly placedPois = new Map<string, PlacedPoi>();
  readonly input: InputSystem;
  readonly events = new EventBus<GameEvents>();
  readonly loop: FixedStepLoop;
  readonly hud: Hud;
  private readonly pauseMenu: PauseMenu;
  readonly shipRoot: TransformNode;
  readonly shipRig: ShipRig;
  readonly mouseStick = new VirtualStick();
  paused = false;
  cameraMode: "chase" | "cockpit" = "chase";
  qualityTier: SkyQuality = "ultra";
  selectedTarget = "tethys";
  readonly progression: Progression;
  inventoryOpen = false;
  readonly cloudVeil = { density: 0, veil: 0 };

  // Interpolation state (body frame of the respective body).
  private readonly prevShip = { pos: new Vector3(), att: Quaternion.Identity(), body: "" };
  private readonly prevPlayer = { pos: new Vector3(), heading: new Vector3(), pitch: 0, body: "" };
  private readonly chase = new ChaseRig();
  private readonly camPose: CameraPose = {
    position: new Vector3(),
    rotation: Quaternion.Identity(),
    fov: 1.2,
  };
  private readonly frames = new Map<string, BodyFrameSnapshot>();
  private lastRenderTime = 0;
  nearestInteractable: Interactable | null = null;

  constructor(dom: GameDom, opts: GameOptions = {}) {
    const engine = new Engine(dom.canvas, false, {
      stencil: true,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    this.engine = engine;
    // Size the drawing buffer to the laid-out canvas before any render target
    // copies its size.
    engine.resize();
    const scene = new Scene(engine);
    this.scene = scene;
    scene.clearColor = new Color4(0, 0, 0, 1);
    scene.skipPointerMovePicking = true;
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = new Color3(0.8, 0.83, 0.88);
    scene.fogDensity = 0;
    // Logarithmic depth everywhere: one frustum spans centimetres (cockpit)
    // to hundreds of kilometres (other planets, the star).
    const useLogDepth = (m: Material): void => {
      if ("useLogarithmicDepth" in m) (m as { useLogarithmicDepth: boolean }).useLogarithmicDepth = true;
    };
    scene.onNewMaterialAddedObservable.add(useLogDepth);

    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    camera.minZ = 0.05;
    camera.maxZ = 2.0e6;
    camera.rotationQuaternion = Quaternion.Identity();
    camera.inputs.clear();
    this.camera = camera;

    this.targets = createSceneTargets(scene, camera);
    // The planetary pass must come before the HDR pipeline in the chain.
    this.planetary = new PlanetaryPass(scene, camera, this.targets.depth);
    this.planetary.copy.samples = 4;
    this.pipeline = createPipeline(scene, camera);
    this.lighting = new Lighting(scene);
    this.starfield = makeStars(scene, camera.maxZ);

    // Terrain workers: shapes + palettes go to every worker once.
    const hw = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 4) : 4;
    const workers = opts.workers ?? Math.max(1, Math.min(4, hw - 1));
    const canWork = typeof Worker !== "undefined" && workers > 0;
    this.pool = new TerrainWorkerPool(canWork ? createTerrainWorker : null, workers);
    const bodies: Record<
      string,
      { shape: NonNullable<BodyDef["terrain"]>; palette: ReturnType<typeof biomePalette> }
    > = {};
    for (const d of VESPER_DRIFT)
      if (d.terrain && d.surface) bodies[d.id] = { shape: d.terrain, palette: biomePalette(d) };
    this.pool.init({ kind: "init", bodies });

    // Simulation + one view per body.
    this.sim = new SimWorld(VESPER_DRIFT, "vael");
    for (const d of VESPER_DRIFT) {
      const env = this.sim.env(this.sim.system.get(d.id));
      const view = new BodyView(scene, d, this.pool, this.targets, env.waves);
      this.views.set(d.id, view);
      if (d.terrain) {
        const props = buildProps(scene, d.id, d.terrain, view.root);
        env.colliders.push(...props.colliders);
        this.interactables.push(...props.interactables);
        for (const [id, placed] of props.placed) this.placedPois.set(id, placed);
      }
    }

    // Ship visual.
    this.shipRig = buildShip(scene);
    this.shipRoot = this.shipRig.root;
    this.shipRoot.rotationQuaternion = Quaternion.Identity();
    const glowLayer = scene.getGlowLayerByName("main-glow");
    glowLayer?.addExcludedMesh(this.starfield.mesh);
    const star = this.views.get("vesper")?.star;
    if (star) {
      glowLayer?.addExcludedMesh(star.core);
      glowLayer?.addExcludedMesh(star.corona);
    }
    this.spawn();

    // Input: immediate actions work while paused.
    this.input = new InputSystem({ canvas: dom.canvas });
    this.input.onImmediate("pause", () => this.setPaused(!this.paused));
    this.input.onImmediate("quality", () => this.cycleQuality());
    this.input.onPointerLockLost = () => {
      // Browsers release pointer lock on Esc without delivering the key.
      if (!this.paused) this.setPaused(true);
    };

    this.hud = new Hud(dom.hud, (recipe) => this.craft(recipe));
    this.pauseMenu = createPauseMenu(
      dom.pause,
      [
        { id: "resume", label: "Resume", onClick: () => this.setPaused(false) },
        {
          id: "save",
          label: "Save",
          onClick: () => this.pauseMenu.setStatus(this.save() ? "Saved" : "Could not save"),
        },
        {
          id: "load",
          label: "Load",
          onClick: () => {
            const ok = this.load();
            this.pauseMenu.setStatus(ok ? "Loaded" : "No save found");
            if (ok) this.setPaused(false);
          },
        },
      ],
      this.input.bindings,
    );

    // Progression: content rules -> events -> HUD.
    this.progression = new Progression({
      message: (text) => this.events.emit("toast", { text }),
      discovered: (id, title, text) => this.events.emit("discovered", { id, title, text }),
      objective: (text) => this.events.emit("objectiveChanged", { text }),
      repairHull: (amount) => {
        this.sim.ship.hull = Math.min(1, this.sim.ship.hull + amount);
      },
    });
    this.events.on("discovered", (e) => this.hud.showLore(e.title, e.text));
    this.events.on("objectiveChanged", (e) =>
      this.events.emit("toast", { text: e.text ? `New objective: ${e.text}` : "All objectives complete" }),
    );

    // Events.
    const splash = createSplash(scene);
    this.events.on("splash", (e) => {
      const view = this.views.get(e.bodyId);
      if (view) splash.burstAt(e.position, e.speed, view.root);
    });
    this.events.on("toast", (e) => this.hud.toast(e.text));
    this.sim.events = {
      splash: (bodyId, position, speed) => this.events.emit("splash", { bodyId, position, speed }),
      shipImpact: (speed, damage) => {
        this.events.emit("shipImpact", { speed, damage });
        this.events.emit("toast", {
          text: `Hard impact: ${speed.toFixed(0)} m/s, hull -${(damage * 100).toFixed(0)}%`,
        });
      },
      soiChange: (entity, from, to) => {
        this.events.emit("soiChanged", { entity, from, to });
        if (entity === "ship") {
          this.events.emit("toast", { text: `Entering ${this.sim.defs.get(to)?.name ?? to} space` });
          this.progression.notify({ on: "arrived", body: to });
        }
      },
      modeChange: (mode) => {
        this.chase.reset();
        this.mouseStick.reset();
        this.events.emit("modeChanged", { mode });
      },
    };

    this.loop = new FixedStepLoop((dt) => this.simulate(dt));
    this.capturePrev();
  }

  /** Initial placement: player at the crash site, skiff on the survey pad. */
  spawn(): void {
    const vael = this.sim.system.get("vael");
    const env = this.sim.env(vael);
    const shape = this.sim.defs.get("vael")!.terrain!;
    const start = POIS.find((p) => p.id === "start")!;
    // Ship on the pad deck (0.4 m above the pad origin, see world/props.ts).
    const pad = this.placedPois.get("pad")!;
    const padUp = pad.up;
    const padTop = pad.origin.add(padUp.scale(0.4));
    const fwd = pad.forward;
    const right = Vector3.Cross(padUp, fwd);
    quatFromAxes(right, padUp, fwd, this.sim.ship.att);
    this.sim.ship.pos.copyFrom(padTop).addInPlace(padUp.scale(1.45 + 0.03));
    this.sim.ship.vel.setAll(0);
    this.sim.ship.angVel.setAll(0);
    this.sim.ship.landed = true;
    // Player at the crash site, facing the pad.
    const sd = poiDirection(start, shape.radius);
    const startDir = new Vector3(sd[0], sd[1], sd[2]);
    const toPad = padTop.subtract(startDir.scale(shape.radius));
    this.sim.player.placeOnSurface(startDir, toPad, env);
    this.sim.mode = "onFoot";
    this.sim.playerBody = vael;
    this.sim.shipBody = vael;
  }

  private capturePrev(): void {
    this.prevShip.pos.copyFrom(this.sim.ship.pos);
    this.prevShip.att.copyFrom(this.sim.ship.att);
    this.prevShip.body = this.sim.shipBody.id;
    this.prevPlayer.pos.copyFrom(this.sim.player.pos);
    this.prevPlayer.heading.copyFrom(this.sim.player.heading);
    this.prevPlayer.pitch = this.sim.player.pitch;
    this.prevPlayer.body = this.sim.playerBody.id;
  }

  setPaused(on: boolean): void {
    if (on === this.paused) return;
    this.paused = on;
    this.input.releaseAll();
    this.input.allowPointerLock = !on;
    if (on) this.input.exitPointerLock();
    this.pauseMenu.setVisible(on);
    this.loop.resetAccumulator();
    this.events.emit("paused", { paused: on });
  }

  cycleQuality(tier?: SkyQuality): SkyQuality {
    const i = QUALITY_TIERS.indexOf(this.qualityTier);
    this.qualityTier = tier ?? QUALITY_TIERS[(i + 1) % QUALITY_TIERS.length];
    const t = this.qualityTier;
    const best = t === "ultra" || t === "high";
    this.pipeline.bloomEnabled = best;
    this.pipeline.grainEnabled = best;
    this.planetary.copy.samples = t === "ultra" ? 4 : 1;
    this.planetary.setQuality(t);
    for (const v of this.views.values()) v.ocean?.setQuality(best);
    this.targets.setRefractionEnabled(best);
    this.events.emit("qualityChanged", { tier: t });
    return t;
  }

  // --- Simulation ------------------------------------------------------------

  /** One fixed simulation step. */
  simulate(dt: number): void {
    const input = this.input;
    input.beginStep();
    this.capturePrev();
    const sim = this.sim;

    for (let i = 0; i < TARGET_IDS.length; i++) {
      if (input.pressed(`target${i + 1}` as "target1")) {
        this.selectedTarget = TARGET_IDS[i];
        this.events.emit("targetChanged", { id: TARGET_IDS[i] });
      }
    }
    if (input.pressed("cameraToggle") && sim.mode === "ship") {
      this.cameraMode = this.cameraMode === "chase" ? "cockpit" : "chase";
      this.chase.reset();
    }
    if (input.pressed("toggleAssist") && sim.mode === "ship") {
      sim.ship.assist = !sim.ship.assist;
      this.events.emit("toast", { text: `Flight assist ${sim.ship.assist ? "on" : "off"}` });
    }
    if (input.pressed("interact")) this.interact();
    if (input.pressed("inventory")) this.setInventoryOpen(!this.inventoryOpen);

    if (sim.mode === "ship") {
      this.mouseStick.update(input.axis("lookX"), -input.axis("lookY"), dt);
      const c = sim.shipControls;
      c.thrust.set(input.axis("thrustX"), input.axis("thrustY"), input.axis("thrustZ"));
      c.rotate.set(
        clamp(input.axis("pitch") - this.mouseStick.y, -1, 1),
        clamp(input.axis("yaw") + this.mouseStick.x, -1, 1),
        clamp(input.axis("roll"), -1, 1),
      );
      c.boost = input.button("boost");
      c.matchVelocity = input.button("matchVelocity");
    } else {
      const c = sim.playerControls;
      c.moveX = input.axis("moveX");
      c.moveZ = input.axis("moveZ");
      c.lookX = input.axis("lookX") + input.axis("yaw") * KEY_LOOK_RATE * dt;
      c.lookY = input.axis("lookY") + input.axis("pitch") * KEY_LOOK_RATE * dt;
      c.jump = input.pressed("jump");
      c.sprint = input.button("sprint");
    }
    sim.step(dt);
    this.updateInteractionTarget();
  }

  /** Board/exit the ship, or use the nearest point of interest. */
  interact(): void {
    const sim = this.sim;
    if (sim.mode === "ship") {
      if (sim.exitShip()) this.events.emit("toast", { text: "Stepped out" });
      else this.events.emit("toast", { text: "Land or float to step out" });
      return;
    }
    if (sim.board()) {
      this.events.emit("toast", { text: "Boarded the skiff" });
      this.progression.notify({ on: "boarded" });
      return;
    }
    const it = this.nearestInteractable;
    if (it) {
      const acted = this.progression.interact(it.poi);
      if (!acted && !this.progression.promptFor(it.poi))
        this.events.emit("toast", { text: `${it.poi.name}: nothing new here` });
      this.events.emit("interacted", { poiId: it.poi.id, kind: it.poi.kind, acted });
    }
  }

  /** Craft a recipe from the inventory panel. */
  craft(recipe: string): boolean {
    const ok = this.progression.craft(recipe);
    if (!ok) this.events.emit("toast", { text: "Missing materials" });
    return ok;
  }

  setInventoryOpen(on: boolean): void {
    this.inventoryOpen = on;
    if (on) this.input.exitPointerLock();
  }

  /** Save to local storage. */
  save(): boolean {
    const ok = saveStore.write(captureSave(this.sim, this.progression));
    this.events.emit("saved", { ok });
    return ok;
  }

  /** Load from local storage (false if there is no valid save). */
  load(): boolean {
    const data = saveStore.read();
    if (!data) {
      this.events.emit("loaded", { ok: false });
      return false;
    }
    applySave(data, this.sim, this.progression);
    this.input.releaseAll();
    this.mouseStick.reset();
    this.chase.reset();
    this.capturePrev();
    this.loop.resetAccumulator();
    this.events.emit("modeChanged", { mode: this.sim.mode });
    this.events.emit("loaded", { ok: true });
    return true;
  }

  private updateInteractionTarget(): void {
    const sim = this.sim;
    this.nearestInteractable = null;
    if (sim.mode !== "onFoot") return;
    const eye = sim.player.eye();
    let best = Infinity;
    for (const it of this.interactables) {
      if (it.bodyId !== sim.playerBody.id) continue;
      const d = Vector3.Distance(eye, it.position);
      if (d < it.radius && d < best) {
        best = d;
        this.nearestInteractable = it;
      }
    }
  }

  /** Snap the chase camera next frame (after teleports). */
  resetCamera(): void {
    this.chase.reset();
    // A teleport has no "previous" state to interpolate from.
    this.capturePrev();
  }

  /** Deterministically advance `seconds` of sim (tests/tools). Works while paused. */
  step(seconds: number): void {
    this.loop.stepFor(seconds);
  }

  // --- Rendering ---------------------------------------------------------------

  private frame(bodyId: string, t: number): BodyFrameSnapshot {
    const snap = snapshotFrame(this.sim.system.get(bodyId), t, this.frames.get(bodyId));
    this.frames.set(bodyId, snap);
    return snap;
  }

  /** Visual update + draw for one rendered frame. */
  renderFrame(frameDt: number, alpha: number): void {
    const sim = this.sim;
    const step = this.loop.step;
    const tR = Math.max(0, sim.time - step + alpha * step);
    this.lastRenderTime = tR;
    for (const def of VESPER_DRIFT) this.frame(def.id, tR);

    // Interpolated ship (in its body frame).
    const shipBody = sim.shipBody.id;
    const a = this.prevShip.body === shipBody ? alpha : 1;
    const shipPos = Vector3.Lerp(this.prevShip.pos, sim.ship.pos, a);
    const shipAtt = Quaternion.Slerp(this.prevShip.att, sim.ship.att, a);
    const shipFrame = this.frames.get(shipBody)!;

    // Camera pose in the focus body's frame.
    const focusId = sim.mode === "ship" ? shipBody : sim.playerBody.id;
    const focusFrame = this.frames.get(focusId)!;
    if (sim.mode === "ship") {
      if (this.cameraMode === "cockpit") cockpitPose(shipPos, shipAtt, this.camPose);
      else {
        const boosting = sim.shipControls.boost && sim.shipControls.thrust.z > 0.3;
        this.chase.update(this.paused ? 0 : frameDt, shipPos, shipAtt, sim.ship.vel, boosting, this.camPose);
      }
    } else {
      const pa = this.prevPlayer.body === sim.playerBody.id ? alpha : 1;
      const p = sim.player;
      const pos = Vector3.Lerp(this.prevPlayer.pos, p.pos, pa);
      const eye = pos.add(pos.clone().normalize().scale(p.spec.eyeHeight));
      const heading = Vector3.Lerp(this.prevPlayer.heading, p.heading, pa).normalize();
      const pitch = this.prevPlayer.pitch + (p.pitch - this.prevPlayer.pitch) * pa;
      firstPersonPose(eye, heading, pitch, this.camPose);
    }
    // Floating origin: the camera sits at (0,0,0) in render space.
    const camI = pointToInertial(focusFrame, this.camPose.position);
    this.camera.position.setAll(0);
    this.camera.rotationQuaternion!.copyFrom(focusFrame.rotation.multiply(this.camPose.rotation));
    this.camera.fov = this.camPose.fov;

    for (const [id, view] of this.views) {
      const f = this.frames.get(id)!;
      view.setPose(f.position.subtract(camI), f.rotation);
      view.setTime(tR);
    }
    const shipI = pointToInertial(shipFrame, shipPos);
    this.shipRoot.position.copyFrom(shipI.subtract(camI));
    this.shipRoot.rotationQuaternion!.copyFrom(shipFrame.rotation.multiply(shipAtt));
    const out = sim.ship.thrustOut;
    const piloting = sim.mode === "ship";
    this.shipRig.setThrust(piloting ? Math.max(0, out.z) * 0.85 + Math.abs(out.y) * 0.25 + 0.1 : 0);
    this.shipRig.setHeat(sim.ship.heat);
    this.shipRig.update(frameDt);
    const cockpit = piloting && this.cameraMode === "cockpit";
    for (const m of this.shipRoot.getChildMeshes()) m.isVisible = !cockpit;

    // Lighting from the real star, through the air around the camera.
    const starPos = this.frames.get("vesper")!.position;
    const toSun = starPos.subtract(camI).normalize();
    const focusDef = sim.defs.get(focusId)!;
    const focusView = this.views.get(focusId)!;
    const camRelFocus = camI.subtract(focusFrame.position);
    const nearFocus = focusDef.kind !== "star" && camRelFocus.length() < 60000;
    const rc = focusDef.atmosphere?.rayleighColor;
    const skyColor = rc ? new Color3(rc.r * 0.55, rc.g * 0.62, rc.b * 0.8) : Color3.Black();
    const light = this.lighting.update({
      toSun,
      up: nearFocus ? camRelFocus.clone().normalize() : null,
      atmo: focusView.atmo ? { params: focusView.atmo, camRel: camRelFocus, skyColor } : null,
      starColor: VESPER_DRIFT[0].star!.color,
      starIntensity: SUN_INTENSITY,
    });
    this.starfield.setBrightness(Math.max(0.02, 1 - light.skyBrightness * 1.1));

    // Sky + clouds: the two nearest atmospheres (drawn far -> near).
    const atmoBodies: (AtmoBodyFrame & { dist: number })[] = [];
    for (const [id, view] of this.views) {
      if (!view.atmo) continue;
      const center = this.frames.get(id)!.position.subtract(camI);
      atmoBodies.push({ center, params: view.atmo, dist: center.length() });
    }
    atmoBodies.sort((x, y) => x.dist - y.dist);
    let cloudFrame: CloudFrame | null = null;
    const cp = focusView.clouds;
    if (cp && camRelFocus.length() < 30000) {
      const inv = Quaternion.Inverse(focusFrame.rotation);
      const deckR = cp.radius + cp.base + cp.thickness * 0.5;
      const deck = camRelFocus.clone().normalize().scale(deckR);
      const T = focusView.atmo
        ? sunTransmittance(focusView.atmo, deck.x, deck.y, deck.z, toSun.x, toSun.y, toSun.z)
        : [1, 1, 1];
      cloudFrame = {
        center: focusFrame.position.subtract(camI),
        worldToBody: Matrix.FromQuaternionToRef(inv, new Matrix()),
        params: cp,
        sunLocal: toSun.applyRotationQuaternion(inv),
        sunColor: new Color3(T[0], T[1], T[2]).scale(SUN_INTENSITY),
        ambient: light.ambient.scale(0.25 + light.skyBrightness * 0.9),
        time: tR,
        hazeScale: focusView.atmo?.hM ?? 150,
      };
    }
    this.planetary.update({
      sunDir: toSun,
      sunIlluminance: SKY_ILLUMINANCE,
      bodies: atmoBodies.slice(0, 2).reverse(),
      clouds: cloudFrame,
      sea:
        focusView.seaRadius !== null
          ? { center: focusFrame.position.subtract(camI), radius: focusView.seaRadius }
          : null,
    });

    // Terrain LOD, oceans, vegetation per body (camera in each body frame).
    for (const [id, view] of this.views) {
      const f = this.frames.get(id)!;
      const camLocal = pointToBody(f, camI);
      view.terrain?.update([camLocal.x, camLocal.y, camLocal.z]);
      if (view.ocean) {
        const sunLocal = dirToBody(f, toSun);
        const daylight = clamp((Vector3.Dot(camLocal.clone().normalize(), sunLocal) + 0.1) * 3, 0, 1);
        view.ocean.update({
          camLocal,
          sunDirLocal: sunLocal.scale(-1),
          sunTint: light.sunColor,
          sunIntensity: SUN_INTENSITY * (id === focusId ? light.sunVisibility : 1),
          daylight,
          isHost: id === focusId,
        });
      }
      view.vegetation?.update(this.paused ? 0 : frameDt, camLocal, id === focusId);
    }
    this.targets.setRefractionFilter((m) => m.metadata?.terrainBody === focusId);

    // In-cloud whiteout, from the same density field the clouds draw.
    let density = 0;
    if (cp) {
      const camLocal = pointToBody(focusFrame, camI);
      density = cloudDensityAt(this.planetary.volume, cp, camLocal.x, camLocal.y, camLocal.z, tR);
    }
    this.cloudVeil.density = density;
    const target = density <= 0.01 ? 0 : Math.min(1, density * 1.6);
    const rate = target > this.cloudVeil.veil ? 3.5 : 1.2;
    this.cloudVeil.veil += (target - this.cloudVeil.veil) * Math.min(1, rate * frameDt);
    this.scene.fogDensity = this.cloudVeil.veil * 0.03;
    this.scene.fogColor.copyFrom(
      light.ambient.scale(1.4).add(light.sunColor.scale(0.25 * light.sunVisibility)),
    );

    this.hud.update(this.hudModel(camI));
    this.hud.setInventory(this.inventoryOpen ? this.inventoryModel() : null);
    this.scene.render();
  }

  /** Local solar time (h) at a body-frame position: 12:00 with the sun overhead. */
  localHour(bodyId: string, posBody: Vector3): number {
    const f = this.frames.get(bodyId) ?? this.frame(bodyId, this.sim.time);
    const up = posBody.clone().normalize();
    const sunL = dirToBody(f, this.frames.get("vesper")!.position.subtract(f.position).normalize());
    // East = spin direction = +Y x up.
    const east = Vector3.Cross(new Vector3(0, 1, 0), up);
    const e = east.lengthSquared() > 1e-8 ? Vector3.Dot(sunL, east.normalize()) : 0;
    // Morning: the sun is in the east.
    const angle = Math.atan2(-e, Vector3.Dot(sunL, up));
    return (((12 + (angle / Math.PI) * 12) % 24) + 24) % 24;
  }

  private hudModel(camI: Vector3): HudModel {
    const sim = this.sim;
    const ship = sim.ship;
    const shipFrame = this.frames.get(sim.shipBody.id)!;
    const targets: HudTarget[] = [];
    const focusPosI = sim.mode === "ship" ? pointToInertial(shipFrame, ship.pos) : camI;
    const focusVelI =
      sim.mode === "ship" ? velocityToInertial(shipFrame, ship.pos, ship.vel) : Vector3.Zero();
    for (const id of TARGET_IDS) {
      const f = this.frames.get(id)!;
      const rel = f.position.subtract(focusPosI);
      const d = rel.length();
      targets.push({
        name: sim.defs.get(id)!.name,
        distance: Math.max(0, d - sim.defs.get(id)!.radius),
        rangeRate: d > 0 ? Vector3.Dot(f.velocity.subtract(focusVelI), rel) / d : 0,
        selected: id === this.selectedTarget,
      });
    }
    let prompt: string | null = null;
    if (sim.mode === "onFoot") {
      if (sim.canBoard()) prompt = "[F] Board the skiff";
      else if (this.nearestInteractable) {
        const what = this.progression.promptFor(this.nearestInteractable.poi);
        prompt = what ? `[F] ${what[0].toUpperCase()}${what.slice(1)}` : this.nearestInteractable.poi.name;
      }
    } else if (sim.canExit()) prompt = "[F] Step out";
    if (sim.mode === "ship") {
      const vI = velocityToInertial(shipFrame, ship.pos, ship.vel).subtract(shipFrame.velocity);
      return {
        mode: "ship",
        bodyName: sim.shipBody.name,
        altitude: ship.altitude,
        speed: ship.vel.length(),
        verticalSpeed: ship.verticalSpeed,
        orbitalSpeed: vI.length(),
        assist: ship.assist,
        hover: ship.hoverFactor,
        throttle: ship.throttle,
        heat: ship.heat,
        hull: ship.hull,
        landed: ship.landed,
        floating: ship.floating,
        air: Math.min(1, ship.airDensity),
        localHour: this.localHour(sim.shipBody.id, ship.pos),
        targets,
        prompt,
        objective: this.progression.objective,
      };
    }
    const p = sim.player;
    return {
      mode: "onFoot",
      bodyName: sim.playerBody.name,
      altitude: p.altitude,
      speed: p.vel.length(),
      verticalSpeed: 0,
      air: sim.env(sim.playerBody).airDensity(p.pos.length() - sim.playerBody.radius),
      localHour: this.localHour(sim.playerBody.id, p.pos),
      targets,
      prompt,
      objective: this.progression.objective,
    };
  }

  private inventoryModel(): InventoryModel {
    const p = this.progression;
    return {
      items: [...p.inventory].map(([id, count]) => ({ name: itemName(id), count })),
      recipes: p.knownRecipes().map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        inputs: r.inputs.map((i) => `${i.count}x ${itemName(i.item)} (${p.count(i.item)})`).join(", "),
        canCraft: p.canCraft(r.id),
      })),
      discoveries: [...p.discoveries].map((id) => DISCOVERIES.find((d) => d.id === id)?.title ?? id),
    };
  }

  start(): void {
    this.engine.runRenderLoop(() => {
      const frameDt = Math.min(this.engine.getDeltaTime() / 1000, 0.25);
      const alpha = this.paused ? 1 : this.loop.advance(frameDt);
      this.renderFrame(frameDt, alpha);
    });
    addEventListener("resize", () => this.engine.resize());
  }

  /** Render-time clock (for tests/tools). */
  renderTime(): number {
    return this.lastRenderTime;
  }

  setOceanDebug(mode: number): void {
    for (const v of this.views.values())
      for (const m of v.ocean?.materials ?? []) (m as ShaderMaterial).setFloat("uDebugMode", mode);
  }

  shipMeshes(): Mesh[] {
    return this.shipRoot.getChildMeshes() as Mesh[];
  }
}

function createPipeline(scene: Scene, camera: FreeCamera): DefaultRenderingPipeline {
  const pipeline = new DefaultRenderingPipeline("hdr", true, scene, [camera]);
  pipeline.samples = 1; // MSAA happens on the scene pass (planetary copy)
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 1.0;
  pipeline.bloomWeight = 0.3;
  pipeline.bloomKernel = 48;
  pipeline.bloomScale = 0.5;
  pipeline.fxaaEnabled = true;
  pipeline.sharpenEnabled = true;
  pipeline.sharpen.edgeAmount = 0.12;
  pipeline.grainEnabled = true;
  pipeline.grain.intensity = 5;
  pipeline.grain.animated = true;
  pipeline.imageProcessingEnabled = true;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.contrast = 1.06;
  pipeline.imageProcessing.exposure = 1.0;
  pipeline.imageProcessing.vignetteEnabled = true;
  pipeline.imageProcessing.vignetteWeight = 0.8;
  return pipeline;
}
