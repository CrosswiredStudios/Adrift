/**
 * Ship one-shot effects: the splashdown spray. The particle system is
 * created lazily and reused. The emitter is a node parented to the body
 * the splash happened on, in its body-fixed frame, and the particles are
 * simulated in the emitter's local space, so the spray stays put on the
 * water under the floating origin and the planet's spin.
 */
import {
  Color4,
  Constants,
  Mesh,
  ParticleSystem,
  Scene,
  Texture,
  TransformNode,
  Vector3,
} from "@babylonjs/core";

export interface SplashHandle {
  /** Spray burst at a body-frame position, scaled by impact speed. */
  burstAt(positionBody: Vector3, impactSpeed: number, bodyRoot: TransformNode): void;
  dispose(): void;
}
function splashTexture(scene: Scene): Texture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("splashTexture: 2d canvas context unavailable");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(0.45, "rgba(228,244,255,0.5)");
  g.addColorStop(1, "rgba(205,232,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new Texture(c.toDataURL("image/png"), scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
}

/** Create a splash handle bound to a scene. Call burst() on water contact. */
export function createSplash(scene: Scene): SplashHandle {
  let system: ParticleSystem | null = null;
  const emitter = new Mesh("splash-emitter", scene);
  emitter.isPickable = false;

  return {
    burstAt(positionBody: Vector3, impactSpeed: number, bodyRoot: TransformNode): void {
      emitter.parent = bodyRoot;
      emitter.position.copyFrom(positionBody);
      // Local +Y at the splash = the surface up.
      const up = positionBody.clone().normalize();
      const ref = Math.abs(up.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
      const x = Vector3.Cross(ref, up).normalize();
      const z = Vector3.Cross(x, up).normalize();
      emitter.rotationQuaternion = null;
      emitter.rotation = Vector3.RotationFromAxis(x, up, z);
      if (!system) {
        const ps = new ParticleSystem("splash", 220, scene);
        ps.particleTexture = splashTexture(scene);
        ps.emitter = emitter;
        ps.isLocal = true;
        ps.color1 = new Color4(0.93, 0.97, 1, 1);
        ps.color2 = new Color4(0.72, 0.88, 1, 0.9);
        ps.colorDead = new Color4(0.8, 0.9, 1, 0);
        ps.minSize = 0.6;
        ps.maxSize = 2.4;
        ps.minLifeTime = 0.3;
        ps.maxLifeTime = 0.9;
        ps.emitRate = 0;
        ps.blendMode = Constants.ALPHA_ADD;
        ps.gravity = new Vector3(0, -12, 0);
        ps.direction1 = new Vector3(-7, 8, -7);
        ps.direction2 = new Vector3(7, 15, 7);
        ps.minEmitPower = 4;
        ps.maxEmitPower = 13;
        ps.updateSpeed = 0.016;
        ps.start();
        system = ps;
      }
      system.manualEmitCount = Math.max(4, Math.min(70, Math.round(5 + impactSpeed * 2)));
    },
    dispose(): void {
      system?.dispose();
      system = null;
      emitter.dispose();
    },
  };
}
