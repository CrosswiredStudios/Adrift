import {
  Scene,
  Mesh,
  Vector3,
  Color3,
  PBRMaterial,
  StandardMaterial,
  PointLight,
  ParticleSystem,
  Texture,
  GlowLayer,
  ConeParticleEmitter,
} from "@babylonjs/core";

export interface ShipRig {
  root: Mesh;
  engineGlow: StandardMaterial[];
  engineLights: PointLight[];
  exhaust: ParticleSystem[];
  heatMat: StandardMaterial | null;
  setThrust: (amount: number) => void;
  /** Lateral thrust -1..1 (+ = pushing right): fires the opposite wingtip jet. */
  setSideThrust: (amount: number) => void;
  setHeat: (amount: number) => void;
  update: (dt: number) => void;
}

function hullMaterial(scene: Scene, name: string): PBRMaterial {
  const m = new PBRMaterial(`${name}-hull`, scene);
  m.albedoColor = new Color3(0.62, 0.64, 0.68);
  m.metallic = 0.85;
  m.roughness = 0.38;
  m.environmentIntensity = 1.0;
  m.directIntensity = 1.0;
  return m;
}

function darkMaterial(scene: Scene, name: string): PBRMaterial {
  const m = new PBRMaterial(`${name}-dark`, scene);
  m.albedoColor = new Color3(0.12, 0.13, 0.15);
  m.metallic = 0.6;
  m.roughness = 0.55;
  m.environmentIntensity = 0.7;
  return m;
}

function glassMaterial(scene: Scene, name: string): PBRMaterial {
  const m = new PBRMaterial(`${name}-glass`, scene);
  m.albedoColor = new Color3(0.05, 0.12, 0.18);
  m.metallic = 0.1;
  m.roughness = 0.05;
  m.environmentIntensity = 1.6;
  m.directIntensity = 1.2;
  m.alpha = 0.9;
  return m;
}

function glowMaterial(scene: Scene, name: string, color: Color3, intensity: number): StandardMaterial {
  const m = new StandardMaterial(`${name}-glow`, scene);
  m.emissiveColor = color.scale(intensity);
  m.diffuseColor = new Color3(0, 0, 0);
  m.disableLighting = true;
  return m;
}

/** Detailed procedural ship: hull, canopy, wings, nacelles, glow strips, engines. */
export function buildShip(scene: Scene): ShipRig {
  const hull = hullMaterial(scene, "ship");
  const dark = darkMaterial(scene, "ship");
  const glass = glassMaterial(scene, "ship");

  const root = Mesh.CreateBox("ship", 2, scene);
  root.isVisible = false; // invisible collision/transform root

  const add = (mesh: Mesh, mat: PBRMaterial | StandardMaterial, pos: Vector3): Mesh => {
    mesh.position.copyFrom(pos);
    mesh.material = mat;
    mesh.parent = root;
    return mesh;
  };

  // Main fuselage: stretched octahedron-ish hull via scaled sphere + tapered nose.
  const fuselage = Mesh.CreateSphere("ship-fuselage", 16, 2, scene);
  fuselage.scaling.set(0.85, 0.62, 2.4);
  add(fuselage, hull, new Vector3(0, 0, 0.4));

  const nose = Mesh.CreateCylinder("ship-nose", 1.1, 0.12, 1.6, 8, 1, scene);
  nose.rotation.x = Math.PI / 2;
  add(nose, hull, new Vector3(0, -0.05, 3.1));

  // Canopy: flattened glossy bubble.
  const canopy = Mesh.CreateSphere("ship-canopy", 16, 1, scene);
  canopy.scaling.set(0.55, 0.42, 1.3);
  add(canopy, glass, new Vector3(0, 0.55, 1.4));

  // Spine + belly keel.
  const spine = Mesh.CreateBox("ship-spine", 1, scene);
  spine.scaling.set(0.35, 0.28, 2.6);
  add(spine, dark, new Vector3(0, 0.42, -0.6));

  const keel = Mesh.CreateBox("ship-keel", 1, scene);
  keel.scaling.set(0.3, 0.5, 1.4);
  add(keel, dark, new Vector3(0, -0.55, -0.4));

  // Swept wings.
  for (const side of [-1, 1]) {
    const wing = Mesh.CreateBox("ship-wing", 1, scene);
    wing.scaling.set(2.4, 0.12, 1.3);
    wing.position.set(side * 1.7, -0.1, -0.9);
    wing.rotation.z = side * -0.1;
    wing.rotation.y = side * -0.45;
    wing.material = hull;
    wing.parent = root;

    const tip = Mesh.CreateBox("ship-wingtip", 1, scene);
    tip.scaling.set(0.18, 0.5, 0.9);
    tip.position.set(side * 2.9, 0.05, -1.7);
    tip.rotation.y = side * -0.45;
    tip.material = dark;
    tip.parent = root;

    // Engine nacelle under each wing.
    const nacelle = Mesh.CreateCylinder("ship-nacelle", 0.55, 0.62, 2.6, 12, 1, scene);
    nacelle.rotation.x = Math.PI / 2;
    add(nacelle, dark, new Vector3(side * 1.55, -0.35, -0.9));

    const nozzleRing = Mesh.CreateTorus("ship-nozzle-ring", 1.24, 0.18, 24, scene);
    add(nozzleRing, hull, new Vector3(side * 1.55, -0.35, -2.25));
  }

  // Twin vertical tails.
  for (const side of [-1, 1]) {
    const tail = Mesh.CreateBox("ship-tail", 1, scene);
    tail.scaling.set(0.12, 1.3, 1.0);
    tail.position.set(side * 0.75, 0.85, -1.9);
    tail.rotation.z = side * -0.28;
    tail.rotation.x = -0.25;
    tail.material = hull;
    tail.parent = root;
  }

  // Emissive strips: cockpit trim, wing edges, tail tips (picked up by GlowLayer).
  const stripMat = glowMaterial(scene, "ship-strip", new Color3(0.2, 0.8, 1.0), 2.2);
  const stripPositions = [
    new Vector3(0, 0.28, 2.2),
    new Vector3(0, 0.28, 1.2),
    new Vector3(-2.85, 0.05, -1.7),
    new Vector3(2.85, 0.05, -1.7),
  ];
  for (const p of stripPositions) {
    const s = Mesh.CreateBox("ship-strip", 1, scene);
    s.scaling.set(0.08, 0.08, 0.7);
    s.position.copyFrom(p);
    s.material = stripMat;
    s.parent = root;
  }
  // Nav lights: red port / green starboard.
  const navL = glowMaterial(scene, "ship-nav-l", new Color3(1, 0.15, 0.1), 3);
  const navR = glowMaterial(scene, "ship-nav-r", new Color3(0.15, 1, 0.3), 3);
  const navLm = Mesh.CreateSphere("ship-nav-l", 8, 0.16, scene);
  navLm.position.set(-2.95, 0.1, -1.7);
  navLm.material = navL;
  navLm.parent = root;
  const navRm = Mesh.CreateSphere("ship-nav-r", 8, 0.16, scene);
  navRm.position.set(2.95, 0.1, -1.7);
  navRm.material = navR;
  navRm.parent = root;

  // Engine glow discs + lights.
  const engineGlow: StandardMaterial[] = [];
  const engineLights: PointLight[] = [];
  const exhaust: ParticleSystem[] = [];
  for (const side of [-1, 1]) {
    const gm = glowMaterial(scene, `ship-engine-${side}`, new Color3(0.4, 0.7, 1.0), 3.5);
    const disc = Mesh.CreateDisc(`ship-engine-glow-${side}`, 0.5, 24, scene);
    disc.position.set(side * 1.55, -0.35, -2.28);
    disc.material = gm;
    disc.parent = root;
    engineGlow.push(gm);

    const pl = new PointLight(`ship-engine-light-${side}`, new Vector3(side * 1.55, -0.35, -2.6), scene);
    pl.diffuse = new Color3(0.4, 0.7, 1.0);
    pl.intensity = 0.0;
    pl.range = 30;
    pl.parent = root;
    engineLights.push(pl);

    // Exhaust plume particles, emitted from a node on the ship in ship space
    // (isLocal): the plume stays attached to the nozzles, which also keeps it
    // correct under the floating origin.
    const nozzle = new Mesh(`ship-nozzle-${side}`, scene);
    nozzle.parent = root;
    nozzle.position.set(side * 1.55, -0.35, -2.4);
    nozzle.isPickable = false;
    const ps = new ParticleSystem(`ship-exhaust-${side}`, 400, scene);
    ps.particleTexture = makeGlowTexture(scene, `exhaust-tex-${side}`);
    ps.emitter = nozzle;
    ps.isLocal = true;
    ps.particleEmitterType = new ConeParticleEmitter(0.25, Math.PI / 10);
    ps.direction1 = new Vector3(-0.4, -0.4, -6);
    ps.direction2 = new Vector3(0.4, 0.4, -9);
    ps.minEmitPower = 6;
    ps.maxEmitPower = 12;
    ps.minLifeTime = 0.25;
    ps.maxLifeTime = 0.6;
    ps.minSize = 0.35;
    ps.maxSize = 1.1;
    ps.emitRate = 0;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.color1 = new Color3(0.5, 0.8, 1.0).toColor4(1);
    ps.color2 = new Color3(0.2, 0.4, 1.0).toColor4(0.6);
    ps.colorDead = new Color3(0.05, 0.1, 0.3).toColor4(0);
    ps.gravity = new Vector3(0, 0, 0);
    ps.start();
    exhaust.push(ps);
  }

  // Wingtip side jets (RCS): short puffs blowing outward when strafing.
  const sideJets: ParticleSystem[] = [];
  for (const side of [-1, 1]) {
    const tip = new Mesh(`ship-rcs-${side}`, scene);
    tip.parent = root;
    tip.position.set(side * 3.0, 0, -1.7);
    tip.isPickable = false;
    const ps = new ParticleSystem(`ship-rcs-${side}`, 120, scene);
    ps.particleTexture = makeGlowTexture(scene, `rcs-tex-${side}`);
    ps.emitter = tip;
    ps.isLocal = true;
    ps.particleEmitterType = new ConeParticleEmitter(0.1, Math.PI / 12);
    ps.direction1 = new Vector3(side * 5, -0.3, -0.3);
    ps.direction2 = new Vector3(side * 8, 0.3, 0.3);
    ps.minEmitPower = 4;
    ps.maxEmitPower = 7;
    ps.minLifeTime = 0.1;
    ps.maxLifeTime = 0.25;
    ps.minSize = 0.2;
    ps.maxSize = 0.55;
    ps.emitRate = 0;
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.color1 = new Color3(0.75, 0.9, 1.0).toColor4(0.9);
    ps.color2 = new Color3(0.4, 0.6, 1.0).toColor4(0.5);
    ps.colorDead = new Color3(0.05, 0.1, 0.3).toColor4(0);
    ps.gravity = new Vector3(0, 0, 0);
    ps.start();
    sideJets.push(ps);
  }

  // Re-entry heat shell: transparent fresnel-ish overlay toggled by heat.
  const heatMat = glowMaterial(scene, "ship-heat", new Color3(1.0, 0.35, 0.08), 0.0);
  heatMat.alpha = 0.0;
  const heatShell = Mesh.CreateSphere("ship-heat-shell", 12, 3.4, scene);
  heatShell.scaling.set(0.9, 0.7, 1.6);
  heatShell.material = heatMat;
  heatShell.parent = root;
  heatShell.isPickable = false;

  // Landing gear: nose strut + two mains (feet match SKIFF.gear in sim/shipSim.ts).
  for (const [x, z] of [
    [0, 2.3],
    [1.4, -1.3],
    [-1.4, -1.3],
  ]) {
    const strut = Mesh.CreateCylinder("ship-gear-strut", 1.0, 0.12, 0.16, 8, 1, scene);
    add(strut, dark, new Vector3(x, -0.95, z));
    const foot = Mesh.CreateCylinder("ship-gear-foot", 0.08, 0.5, 0.5, 12, 1, scene);
    add(foot, dark, new Vector3(x, -1.41, z));
  }
  // Hatch marker on the port side (where the pilot boards / exits).
  const hatchMat = glowMaterial(scene, "ship-hatch", new Color3(0.9, 0.7, 0.25), 1.6);
  const hatch = Mesh.CreateBox("ship-hatch", 1, scene);
  hatch.scaling.set(0.05, 0.5, 0.9);
  hatch.position.set(-0.86, -0.1, 0.4);
  hatch.material = hatchMat;
  hatch.parent = root;

  let thrust = 0;
  const setThrust = (amount: number): void => {
    thrust = Math.min(1, Math.max(0, amount));
    for (const gm of engineGlow) gm.emissiveColor = new Color3(0.4, 0.7, 1.0).scale(0.6 + thrust * 3.2);
    for (const pl of engineLights) pl.intensity = thrust * 60;
    for (const ps of exhaust) ps.emitRate = thrust * 320;
  };
  const setSideThrust = (amount: number): void => {
    const a = Math.min(1, Math.max(-1, amount));
    // Pushing right fires the left (-X) jet, and vice versa.
    sideJets[0].emitRate = Math.max(0, a) * 260;
    sideJets[1].emitRate = Math.max(0, -a) * 260;
  };
  const setHeat = (amount: number): void => {
    const heat = Math.min(1, Math.max(0, amount));
    heatMat.alpha = heat * 0.55;
    heatMat.emissiveColor = new Color3(1.0, 0.3 + heat * 0.1, 0.06).scale(heat * 3.0);
  };
  let clock = 0;
  const update = (dt: number): void => {
    // Flicker the engine glow slightly with thrust.
    clock += dt;
    const flick = 1 + Math.sin(clock * 40) * 0.06 * thrust;
    for (const gm of engineGlow) {
      const b = 0.6 + thrust * 3.2;
      gm.emissiveColor = new Color3(0.4, 0.7, 1.0).scale(b * flick);
    }
  };

  // Ensure glow layer picks up emissives.
  let glow = scene.getGlowLayerByName?.("main-glow") as GlowLayer | undefined;
  if (!glow) {
    glow = new GlowLayer("main-glow", scene, { mainTextureRatio: 0.5, blurKernelSize: 64 });
    glow.intensity = 0.7;
  }

  setThrust(0);
  setHeat(0);
  return { root, engineGlow, engineLights, exhaust, heatMat, setThrust, setSideThrust, setHeat, update };
}

function makeGlowTexture(scene: Scene, name: string): Texture {
  const size = 64;
  const tex = Texture.CreateFromBase64String(
    radialGlowDataUrl(size),
    name,
    scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  tex.hasAlpha = true;
  return tex;
}

function radialGlowDataUrl(size: number): string {
  // Build a small radial-gradient sprite via canvas at runtime.
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(180,220,255,0.7)");
  g.addColorStop(1, "rgba(0,40,120,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas.toDataURL("image/png");
}
