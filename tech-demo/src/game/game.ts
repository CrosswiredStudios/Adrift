/**
 * Game composition root.
 *
 * Owns the engine/scene, the fixed-step loop, input, the event bus and the
 * world, and splits every frame into two halves:
 *
 *  - `simulate(dt)`: one fixed 60 Hz step. Reads input actions, advances
 *    physics and game rules. Never touches meshes or the camera.
 *  - `renderFrame(frameDt, alpha)`: copies the (interpolated) sim state onto
 *    meshes, moves the camera, updates visual-only effects, draws.
 *
 * Headless tests call `debug.step(seconds)`, which runs whole sim steps with
 * no rendering and no wall clock, so results are reproducible.
 */
import {
  Color3,
  Color4,
  DefaultRenderingPipeline,
  Engine,
  FreeCamera,
  ImageProcessingConfiguration,
  Quaternion,
  Scene,
  ShaderMaterial,
  Vector3,
} from "@babylonjs/core";
import { FixedStepLoop } from "../core/loop";
import { EventBus } from "../core/events";
import { InputSystem } from "../input/inputSystem";
import { atmosphereFactor, bodyAltitude, terrainHeightAt, isOverWater } from "../world/planets";
import { createShip, updateShip, FlightState, bankAngle, SteerState, EngineCommand } from "../flight/flight";
import { createSplash } from "../flight/shipFx";
import { updateHud } from "../app/hud";
import { TerrainHandle } from "../world/terrainMaterial";
import { makeStars } from "../app/starfield";
import { createLighting, daylightFactor, twilightFactor } from "../app/lighting";
import { createCameraRig } from "../app/cameraRig";
import { buildWorld } from "../app/world";
import { createQualityPolicy } from "../app/qualityPolicy";
import { CloudTier } from "../world/skyExtras";
import { Pose, copyPose, lerpPose, makePose } from "../common/pose";
import { createPauseMenu, PauseMenu } from "../ui/pauseMenu";
import { clamp } from "../common/math";

/** Events other systems can subscribe to. */
export interface GameEvents {
  paused: { paused: boolean };
  splash: { position: Vector3; speed: number };
  targetChanged: { name: string };
  qualityChanged: { tier: string };
}

export interface GameDom {
  canvas: HTMLCanvasElement;
  hud: HTMLElement;
  pause: HTMLElement;
}

/**
 * Mouse flight "virtual stick": pointer-lock mouse motion pushes the stick,
 * a spring pulls it back to center. Flick the mouse to turn, let go to stop.
 */
export class VirtualStick {
  x = 0;
  y = 0;
  constructor(
    public gain = 1.6,
    public spring = 4,
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

export class Game {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: FreeCamera;
  readonly pipeline: DefaultRenderingPipeline;
  readonly input: InputSystem;
  readonly events = new EventBus<GameEvents>();
  readonly loop: FixedStepLoop;
  /** Sim clock (seconds since the game started). */
  time = 0;
  paused = false;

  // World + ship (legacy world until the frames/scale phase lands).
  readonly world: ReturnType<typeof buildWorld>;
  readonly shipPose: Pose;
  private readonly prevShipPose: Pose;
  private readonly renderShipPose: Pose;
  readonly shipMesh;
  readonly shipRig;
  readonly flight: FlightState;
  readonly steer: SteerState = { pitch: 0, yaw: 0, roll: 0 };
  readonly engineCmd: EngineCommand = { throttleUp: false, throttleDown: false, brake: false, boost: false };
  readonly mouseStick = new VirtualStick();

  private readonly lighting;
  private readonly starfield;
  readonly quality;
  private readonly cameraRig;
  private readonly pauseMenu: PauseMenu;
  readonly cloudObstruction = { density: 0, veil: 0 };
  private readonly dom: GameDom;

  constructor(dom: GameDom) {
    this.dom = dom;
    const engine = new Engine(dom.canvas, true, { stencil: true, antialias: true });
    this.engine = engine;
    const scene = new Scene(engine);
    this.scene = scene;
    scene.clearColor = new Color4(0, 0, 0, 1);

    const sunDir = new Vector3(-1, -0.3, 0.4).normalize();
    this.lighting = createLighting(scene, sunDir);

    const camera = new FreeCamera("chase", new Vector3(0, 610, 640), scene);
    camera.maxZ = 60000;
    camera.minZ = 0.1;
    this.camera = camera;
    this.pipeline = createPipeline(scene, camera);

    this.starfield = makeStars(scene);
    this.world = buildWorld(scene, sunDir);
    const { sol, pad, padDir, tethys } = this.world;

    const { mesh, rig } = createShip(scene);
    this.shipMesh = mesh;
    this.shipRig = rig;
    const glowLayer = scene.getGlowLayerByName("main-glow");
    glowLayer?.addExcludedMesh(this.starfield.mesh);
    glowLayer?.addExcludedMesh(sol.core);
    glowLayer?.addExcludedMesh(sol.corona);

    // Ship rests on the pad (pad top ~1.2 above ground = flight contact height),
    // upright, nose on the horizon. FromLookDirectionLH aims local -Z, so negate.
    const spawnFwd = Vector3.Cross(padDir, new Vector3(0, 0, 1)).normalize();
    this.shipPose = makePose(
      pad.position.add(padDir.scale(4)),
      Quaternion.FromLookDirectionLH(spawnFwd.scale(-1), padDir),
    );
    this.prevShipPose = makePose();
    this.renderShipPose = makePose();
    copyPose(this.shipPose, this.prevShipPose);
    copyPose(this.shipPose, this.renderShipPose);
    mesh.position.copyFrom(this.shipPose.position);
    mesh.rotationQuaternion = this.shipPose.rotationQuaternion.clone();

    this.flight = {
      velocity: new Vector3(0, 0, 0),
      target: tethys,
      cruise: 0,
      atmoDensity: 1,
      heat: 0,
      verticalSpeed: 0,
      altitude: 1.2,
      landed: true,
      floating: false,
      floatR: 0,
      rig,
    };

    this.quality = createQualityPolicy(this.pipeline, this.world.bodies);
    this.quality.apply();

    // Input: immediate actions work while paused.
    this.input = new InputSystem({ canvas: dom.canvas });
    this.input.onImmediate("pause", () => this.setPaused(!this.paused));
    this.input.onImmediate("quality", () => {
      this.quality.toggle();
      this.quality.apply();
      this.events.emit("qualityChanged", { tier: this.quality.tier });
    });

    this.pauseMenu = createPauseMenu(
      dom.pause,
      [{ id: "resume", label: "Resume", onClick: () => this.setPaused(false) }],
      this.input.bindings,
    );

    const splash = createSplash(scene);
    this.events.on("splash", (e) => splash.burstAt(e.position, e.speed));

    this.cameraRig = createCameraRig(
      camera,
      this.renderShipPose,
      this.flight,
      this.world.bodies,
      () => this.engineCmd.boost && this.engineCmd.throttleUp,
      padDir.clone(),
    );

    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogColor = new Color3(0.92, 0.94, 0.97);
    scene.fogDensity = 0;

    this.loop = new FixedStepLoop((dt) => this.simulate(dt));
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

  /** One fixed simulation step. */
  simulate(dt: number): void {
    const input = this.input;
    input.beginStep();
    copyPose(this.shipPose, this.prevShipPose);

    const bodies = this.world.bodies;
    for (let i = 0; i < 4; i++) {
      if (input.pressed(`target${i + 1}` as "target1") && bodies[i]) {
        this.flight.target = bodies[i];
        this.events.emit("targetChanged", { name: bodies[i].name });
      }
    }

    // Controls -> steering + engine commands.
    this.mouseStick.update(input.axis("lookX"), -input.axis("lookY"), dt);
    this.steer.pitch = clamp(input.axis("pitch") - this.mouseStick.y, -1, 1);
    this.steer.yaw = clamp(-input.axis("yaw") - this.mouseStick.x, -1, 1);
    this.steer.roll = clamp(input.axis("roll"), -1, 1);
    const thrust = input.axis("thrustZ");
    this.engineCmd.throttleUp = thrust > 0.3;
    this.engineCmd.throttleDown = false;
    this.engineCmd.brake = thrust < -0.3 || input.axis("thrustY") < -0.3;
    this.engineCmd.boost = input.button("boost");

    updateShip(this.shipPose, this.flight, bodies, this.engineCmd, this.steer, dt, undefined, {
      splash: (position, speed) => this.events.emit("splash", { position: position.clone(), speed }),
    });

    const host = this.hostBody();
    for (const b of bodies) {
      b.surface?.update(dt, this.lighting.sun.direction, b === host);
      b.vegetation?.update(dt);
    }
    this.world.sol.update(dt);
    this.time += dt;
  }

  /** Body whose air the ship is deepest in (sky colour / lighting host). */
  hostBody(): (typeof this.world.bodies)[number] {
    let host = this.world.vael;
    let best = -1;
    for (const b of this.world.bodies) {
      const d = atmosphereFactor(b, this.shipPose.position);
      if (d > best) {
        best = d;
        host = b;
      }
    }
    return host;
  }

  /** Visual update + draw for one rendered frame. */
  renderFrame(frameDt: number, alpha: number): void {
    lerpPose(this.prevShipPose, this.shipPose, alpha, this.renderShipPose);
    this.shipMesh.position.copyFrom(this.renderShipPose.position);
    this.shipMesh.rotationQuaternion!.copyFrom(this.renderShipPose.rotationQuaternion);
    this.shipRig.update(frameDt);

    const { bodies, sol } = this.world;
    const shipPos = this.renderShipPose.position;
    const atmo = Math.max(...bodies.map((b) => atmosphereFactor(b, shipPos)));
    const host = this.hostBody();
    const sun = this.lighting.sun;
    const sunAboveRaw = shipPos.subtract(host.center).normalize().dot(sun.direction.scale(-1));
    const daylight = daylightFactor(sunAboveRaw);
    const twilight = twilightFactor(sunAboveRaw, atmo);
    this.scene.clearColor = Color4.FromColor3(
      Color3.Lerp(Color3.Black(), host.skyColor.scale(0.35), atmo * 0.5 * daylight),
      1,
    );
    this.lighting.update(host, atmo, daylight, twilight, this.flight.altitude);
    this.pipeline.imageProcessing.exposure = 1.1 - atmo * 0.2;

    if (!this.paused) this.cameraRig.update(frameDt);
    const sunToward = sun.direction.scale(-1);
    const solTowardView = sol.body.center.subtract(this.camera.position).normalize();
    for (const b of bodies) {
      const alt = bodyAltitude(b, shipPos);
      const toShip = shipPos.subtract(b.center);
      const sunAbove = toShip.lengthSquared() > 1e-6 ? toShip.normalize().dot(sunToward) : 1;
      b.atmosphere?.update(alt, sun.direction, daylightFactor(sunAbove), solTowardView);
    }
    const sky = Math.max(...bodies.map((b) => b.atmosphere?.skyFactor ?? 0));
    this.starfield.setBrightness(Math.max((1 - sky) ** 3, (1 - daylight) * 0.85, 0.02));
    this.updateCloudObstruction(frameDt);
    updateHud(this.dom.hud, this.renderShipPose, this.flight, bodies);
    this.scene.render();
  }

  /** In-cloud whiteout: sample the deck's CPU density at the camera. */
  private updateCloudObstruction(dt: number): void {
    let density = 0;
    for (const b of this.world.bodies) {
      const deck = b.surface?.cloudDeck;
      if (!deck || deck.tier === "lite") continue;
      density = Math.max(density, deck.sample(this.camera.position, this.time));
    }
    this.cloudObstruction.density = density;
    const target = density <= 0.01 ? 0 : Math.min(1, density * 1.6);
    const rate = target > this.cloudObstruction.veil ? 3.5 : 1.2;
    this.cloudObstruction.veil += (target - this.cloudObstruction.veil) * Math.min(1, rate * dt);
    this.scene.fogDensity = this.cloudObstruction.veil * 0.028;
  }

  start(): void {
    this.engine.runRenderLoop(() => {
      const frameDt = Math.min(this.engine.getDeltaTime() / 1000, 0.25);
      const alpha = this.paused ? 1 : this.loop.advance(frameDt);
      this.renderFrame(frameDt, alpha);
    });
    addEventListener("resize", () => this.engine.resize());
  }

  /** Deterministically advance `seconds` of sim (tests/tools). Works while paused. */
  step(seconds: number): void {
    this.loop.stepFor(seconds);
    copyPose(this.shipPose, this.prevShipPose);
  }

  describeTerrain(t: TerrainHandle | null): object | null {
    if (!t) return null;
    const tex = t.textures;
    return {
      fallbacks: [...tex.fallbacks],
      ready: [tex.baseColor, tex.baseNormal, tex.rockColor, tex.rockNormal].every((x) => x.isReady()),
      look: t.look,
    };
  }

  setCloudTier(tier?: string): string {
    if (tier !== undefined) this.quality.setTier(tier as CloudTier);
    else this.quality.toggle();
    this.quality.apply();
    return this.quality.tier;
  }

  setOceanDebug(mode: number): void {
    for (const b of this.world.bodies) {
      const o = b.surface?.ocean;
      if (!o) continue;
      for (const mesh of [o.shell, o.patch])
        (mesh.material as ShaderMaterial | null)?.setFloat("uDebugMode", mode);
    }
  }

  probe(dir: number[]): object {
    const vael = this.world.vael;
    const d = new Vector3(dir[0], dir[1], dir[2]).normalize();
    return {
      h: terrainHeightAt(vael, d),
      water: isOverWater(vael, d),
      waterLevel: vael.waterLevel,
      seaRadius: vael.radius * (1 + vael.waterLevel * vael.relief),
    };
  }

  bankDeg(): number {
    return (bankAngle(this.shipPose, this.world.bodies) * 180) / Math.PI;
  }
}

function createPipeline(scene: Scene, camera: FreeCamera): DefaultRenderingPipeline {
  // HDR pipeline: ACES tone mapping, bloom, FXAA, vignette + grain.
  const pipeline = new DefaultRenderingPipeline("hdr", true, scene, [camera]);
  pipeline.samples = 4;
  pipeline.bloomEnabled = true;
  pipeline.bloomThreshold = 1.0;
  pipeline.bloomWeight = 0.25;
  pipeline.bloomKernel = 32;
  pipeline.bloomScale = 0.5;
  pipeline.fxaaEnabled = true;
  pipeline.sharpenEnabled = true;
  pipeline.sharpen.edgeAmount = 0.15;
  pipeline.grainEnabled = true;
  pipeline.grain.intensity = 6;
  pipeline.grain.animated = true;
  pipeline.imageProcessingEnabled = true;
  pipeline.imageProcessing.toneMappingEnabled = true;
  pipeline.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  pipeline.imageProcessing.contrast = 1.08;
  pipeline.imageProcessing.vignetteEnabled = true;
  pipeline.imageProcessing.vignetteWeight = 0.8;
  return pipeline;
}
